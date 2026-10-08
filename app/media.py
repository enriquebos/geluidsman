from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import math
import os
import shutil
import sys
import time
from contextvars import ContextVar
from pathlib import Path
from typing import TYPE_CHECKING

import numpy as np

from app.captions import parse
from app.channels import ChannelImports
from app.db import DATABASE_ERRORS, Database, new_id
from app.network import DownloadProxy, public_addresses, validate_url

if TYPE_CHECKING:
    from collections.abc import AsyncIterator, Sequence

    from app.config import Settings
    from app.events import Events
    from app.types import JsonObject


PROGRESS_INTERVAL_SECONDS = 0.5
SUMMARY_CACHE_SECONDS = 5
MIN_UPLOAD_SECONDS = 0.1


class MediaError(ValueError):
    pass


async def process(args: Sequence[str | Path | float], deadline_seconds: float = 300) -> bytes:
    creationflags = 0x08000000 if os.name == "nt" else 0
    proc = await asyncio.create_subprocess_exec(
        *map(str, args), stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, creationflags=creationflags
    )
    try:
        out, _ = await asyncio.wait_for(proc.communicate(), deadline_seconds)
    except BaseException:
        if proc.returncode is None:
            proc.kill()
        await proc.communicate()
        raise
    if proc.returncode:
        msg = "Media processing failed. The source may be corrupt or unsupported."
        raise MediaError(msg)
    return out


class Media:
    def __init__(self, settings: Settings, db: Database, events: Events) -> None:
        self.base_settings, self.db, self.events = settings, db, events
        self.operation = ContextVar("operation_settings", default=None)
        self.root = settings.data_dir / "media"
        self.root.mkdir(parents=True, exist_ok=True)
        self.lock = asyncio.Lock()
        self.summary_lock = asyncio.Lock()
        self.summary_until = 0.0
        self.summary_cache = {}
        self.tasks = set()
        self.busy = False
        self.channels = ChannelImports(self)
        self.clean_orphans()

    @property
    def settings(self) -> Settings:
        snapshot = self.operation.get()
        if snapshot is not None:
            return snapshot
        overrides = self.db.setting("app_settings", {})
        return self.base_settings.model_copy(
            update={key: value for key, value in overrides.items() if key != "audit_retention_days"}
        )

    def clean_orphans(self) -> None:
        ids = {x["media_id"] or x["id"] for x in self.db.sources()} | {x["id"] for x in self.db.clips()}
        for folder in self.root.iterdir():
            if folder.is_dir() and folder.name not in ids:
                shutil.rmtree(folder)

    def dependencies(self) -> list[str]:
        return [
            name
            for name in (self.settings.ffmpeg_path, self.settings.ffprobe_path, self.settings.js_runtime)
            if not shutil.which(name)
        ]

    def used_bytes(self) -> int:
        total = 0
        pending = [self.root]
        while pending:
            try:
                with os.scandir(pending.pop()) as entries:
                    for entry in entries:
                        try:
                            if entry.is_dir(follow_symlinks=False):
                                pending.append(entry.path)
                            elif entry.is_file():
                                total += entry.stat().st_size
                        except FileNotFoundError:
                            continue
            except FileNotFoundError:
                continue
        return total

    async def summary(self) -> dict:
        async with self.summary_lock:
            if time.monotonic() >= self.summary_until:
                used_bytes, dependencies = await asyncio.gather(
                    asyncio.to_thread(self.used_bytes), asyncio.to_thread(self.dependencies)
                )
                self.summary_cache = {"used_bytes": used_bytes, "missing_dependencies": dependencies}
                self.summary_until = time.monotonic() + SUMMARY_CACHE_SECONDS
            return dict(self.summary_cache)

    def update_job(
        self, job_id: str, status: str, progress: float = 0, error: str | None = None, source_id: str | None = None
    ) -> None:
        previous = self.db.one("SELECT status FROM jobs WHERE id=?", (job_id,))
        self.db.execute(
            "UPDATE jobs SET status=?,progress=?,error=?,source_id=COALESCE(?,source_id) WHERE id=?",
            (status, progress, error, source_id, job_id),
        )
        if status in ("complete", "failed", "interrupted"):
            job = self.db.one("SELECT * FROM jobs WHERE id=?", (job_id,))
            if job:
                details = self.db.import_details(job)
                if status != "complete":
                    details["stage"] = previous["status"] if previous else "unknown"
                self.db.audit(
                    job["actor_id"],
                    "video.import",
                    source_id or job_id,
                    details["title"],
                    outcome=status,
                    details=details,
                )
                self.events.publish("audit")
        self.events.publish("jobs")

    def import_url(self, url: str, source_id: str | None = None, actor_id: str | None = None) -> str:
        validate_url(url)
        self.ensure_import_available()
        self.busy = True
        job_id = self.db.add_job(url, actor_id)
        self.db.audit(
            actor_id, "video.refresh" if source_id else "video.import", source_id or job_id, url, outcome="requested"
        )
        if source_id:
            self.db.execute("UPDATE jobs SET source_id=? WHERE id=?", (source_id, job_id))
        task = asyncio.create_task(self.import_job(job_id, url, source_id))
        self.tasks.add(task)
        task.add_done_callback(self.tasks.discard)
        self.events.publish("jobs")
        return job_id

    def ensure_import_available(self) -> None:
        if self.busy:
            msg = "Another import is running. Wait for it to finish."
            raise MediaError(msg)
        if self.dependencies():
            raise MediaError("Missing media dependencies: " + ", ".join(self.dependencies()))
        if self.used_bytes() >= self.settings.max_storage_bytes:
            msg = "Media storage is full. Delete unused sources or sounds."
            raise MediaError(msg)

    def prepare_import(self, job_id: str, source_id: str | None) -> tuple[str | None, Path, str]:
        job = self.db.one("SELECT actor_id FROM jobs WHERE id=?", (job_id,))
        folder = self.root / new_id()
        folder.mkdir()
        return (job["actor_id"] if job else None), folder, source_id or folder.name

    async def import_job(self, job_id: str, url: str, source_id: str | None = None) -> None:
        operation_token = self.operation.set(self.settings)
        actor_id, folder, source_id = self.prepare_import(job_id, source_id)
        committed = False
        try:
            async with self.lock:
                parsed = validate_url(url)
                await asyncio.to_thread(
                    public_addresses, parsed.hostname, parsed.port or (443 if parsed.scheme == "https" else 80)
                )
                self.update_job(job_id, "downloading")
                available = self.settings.max_storage_bytes - self.used_bytes()
                limit = min(self.settings.max_import_bytes, max(1, available))
                with DownloadProxy(limit, self.settings.import_timeout_seconds) as proxy:
                    info = await self.download(url, folder, proxy)
                    if proxy.block_reason:
                        raise MediaError(proxy.block_reason)
                self.update_job(job_id, "processing", 0.92)
                download = folder / info["file"]
                await self.convert_source(download, folder)
                duration = await self.duration(folder / "video.mp4")
                if not 0 < duration <= self.settings.max_source_seconds:
                    msg = "Source exceeds the configured duration limit."
                    raise MediaError(msg)
                await self.make_peaks(folder / "audio.m4a", folder / "peaks.json", duration)
                await self.make_thumbnail(folder / "video.mp4", folder / "thumbnail.jpg")
                for file in folder.glob("download*"):
                    file.unlink(missing_ok=True)
                if (
                    self.used_bytes() > self.settings.max_storage_bytes
                    or sum(p.stat().st_size for p in folder.iterdir()) > self.settings.max_import_bytes
                ):
                    msg = "Converted media exceeds the configured storage limit."
                    raise MediaError(msg)
                tracks = await self.caption_tracks(info, folder, duration)
                previous = self.db.one("SELECT media_id FROM sources WHERE id=?", (source_id,))
                self.db.save_source(
                    {
                        "id": source_id,
                        "url": url,
                        "title": info["title"],
                        "duration": duration,
                        "media_id": folder.name,
                    },
                    tracks,
                    actor_id,
                )
                committed = True
                if previous:
                    shutil.rmtree(self.root / (previous["media_id"] or source_id), ignore_errors=True)
                self.update_job(job_id, "complete", 1, source_id=source_id)
                self.events.publish("library")
        except asyncio.CancelledError:
            self.update_job(job_id, "interrupted", error="Import interrupted. Retry to start again.")
            if not committed:
                shutil.rmtree(folder, ignore_errors=True)
            raise
        except (ValueError, OSError, TimeoutError, *DATABASE_ERRORS) as exc:
            self.report_import_error(job_id, exc)
            if not committed:
                shutil.rmtree(folder, ignore_errors=True)
        finally:
            self.operation.reset(operation_token)
            self.busy = False

    def report_import_error(self, job_id: str, exc: Exception) -> None:
        logging.getLogger("app.media").error("Video import failed for job %s", job_id, exc_info=exc)
        error = str(exc) if isinstance(exc, ValueError) else "Import failed. Check media dependencies and retry."
        self.update_job(job_id, "failed", error=error)

    async def download(self, url: str, folder: Path, proxy: DownloadProxy, *, channel: bool = False) -> JsonObject:
        env = os.environ.copy()

        for key in ("DISCORD_TOKEN", "DISCORD_CLIENT_SECRET", "AUTH_ENCRYPTION_KEY"):
            env.pop(key, None)
        for key in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"):
            env[key] = proxy.url
        env["NO_PROXY"] = env["no_proxy"] = ""
        env["PATH"] = str(Path(shutil.which(self.settings.ffmpeg_path)).parent) + os.pathsep + env.get("PATH", "")
        proc = await asyncio.create_subprocess_exec(
            sys.executable,
            "-m",
            "app.download_worker",
            url,
            str(folder),
            proxy.url,
            str(self.settings.max_source_seconds),
            str(self.settings.max_import_bytes),
            self.settings.js_runtime,
            *([str(self.settings.max_channel_videos)] if channel else []),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
            limit=32_000_000,
            env=env,
            creationflags=0x08000000 if os.name == "nt" else 0,
        )
        info = None
        try:
            info = await asyncio.wait_for(self.read_download(proc), self.settings.import_timeout_seconds)
        except TimeoutError as exc:
            msg = "Import timed out. Retry or choose a shorter source."
            raise MediaError(msg) from exc
        finally:
            if proc.returncode is None:
                proc.kill()
            await proc.wait()
        if not info or proc.returncode:
            msg = "Download failed. The source may be unavailable or exceed the size limit."
            raise MediaError(msg)
        return info

    async def caption_tracks(self, info: JsonObject, folder: Path, duration: float) -> list[dict]:
        tracks = info.get("captions", [])
        for track in tracks:
            if track["status"] == "downloaded":
                try:
                    track["cues"] = await asyncio.to_thread(parse, folder / track["file"], duration)
                    track["status"] = "ready" if track["cues"] else "missing"
                except (ValueError, OSError, KeyError, TypeError):
                    track.update(status="failed", error="Caption track could not be parsed.", cues=[])
        return tracks

    async def read_download(self, proc: asyncio.subprocess.Process) -> JsonObject | None:
        info, last = None, 0
        while line := await proc.stdout.readline():
            try:
                data = json.loads(line)
            except ValueError:
                continue
            if data.get("title"):
                job = self.db.one("SELECT id FROM jobs WHERE status='downloading'")
                if job:
                    self.db.execute("UPDATE jobs SET title=? WHERE id=?", (data["title"], job["id"]))
            if data.get("diagnostic"):
                logging.getLogger("app.downloader").error("Downloader diagnostic: %s", data["diagnostic"])
            if data.get("error"):
                raise MediaError(data["error"])
            if data.get("complete"):
                info = data
            if "progress" in data and time.monotonic() - last > PROGRESS_INTERVAL_SECONDS:
                jobs = self.db.one("SELECT id FROM jobs WHERE status='downloading'")
                if jobs:
                    self.update_job(jobs["id"], "downloading", data["progress"])
                last = time.monotonic()
        await proc.wait()
        return info

    def ffmpeg(self, *args: str | Path | float) -> list[str | Path | float]:
        return [
            self.settings.ffmpeg_path,
            "-hide_banner",
            "-loglevel",
            "error",
            "-nostdin",
            "-y",
            "-protocol_whitelist",
            "file,pipe",
            *args,
        ]

    async def convert_source(self, source: Path, folder: Path) -> None:
        await process(
            self.ffmpeg(
                "-i",
                source,
                "-map",
                "0:v:0?",
                "-map",
                "0:a:0",
                "-vf",
                "scale=-2:720",
                "-c:v",
                "libx264",
                "-preset",
                "veryfast",
                "-crf",
                "25",
                "-c:a",
                "aac",
                "-b:a",
                "128k",
                "-movflags",
                "+faststart",
                folder / "video.mp4",
            ),
            self.settings.import_timeout_seconds,
        )
        await process(self.ffmpeg("-i", folder / "video.mp4", "-vn", "-c:a", "copy", folder / "audio.m4a"))

    async def duration(self, file: Path) -> float:
        out = await process(
            [
                self.settings.ffprobe_path,
                "-v",
                "error",
                "-protocol_whitelist",
                "file,pipe",
                "-show_entries",
                "format=duration",
                "-of",
                "json",
                file,
            ]
        )
        return float(json.loads(out)["format"]["duration"])

    async def make_thumbnail(self, source: Path, destination: Path) -> None:
        with contextlib.suppress(MediaError):
            await process(self.ffmpeg("-i", source, "-frames:v", "1", "-vf", "scale=480:-2", destination))

    async def make_peaks(self, source: Path, destination: Path, duration: float) -> None:
        out = await process(self.ffmpeg("-i", source, "-vn", "-ac", "1", "-ar", "1000", "-f", "f32le", "pipe:1"))
        samples = np.frombuffer(out, dtype="<f4")
        bins = min(200000, max(1000, int(duration * 100)))
        padded = np.pad(samples, (0, (-len(samples)) % bins))
        peaks = np.max(np.abs(padded.reshape(bins, -1)), axis=1) if len(samples) else np.zeros(bins)
        await asyncio.to_thread(
            destination.write_text,
            json.dumps({"duration": duration, "peaks": peaks.round(4).tolist()}),
            encoding="utf8",
        )

    async def create_clip(self, source: JsonObject, values: JsonObject) -> str:
        async with self.lock:
            source = self.db.one("SELECT * FROM sources WHERE id=?", (source["id"],))
            if not source:
                message = "Source was deleted while waiting to extract this sound."
                raise MediaError(message)
            if values["end"] > source["duration"]:
                message = "The source changed. Choose a selection within its current duration."
                raise MediaError(message)
            folder = self.root / new_id()
            folder.mkdir()
            try:
                await process(
                    self.ffmpeg(
                        "-i",
                        self.root / (source.get("media_id") or source["id"]) / "audio.m4a",
                        "-ss",
                        values["start"],
                        "-t",
                        values["end"] - values["start"],
                        "-af",
                        "aresample=48000,apad",
                        "-vn",
                        "-ac",
                        "2",
                        "-ar",
                        "48000",
                        "-c:a",
                        "pcm_s16le",
                        folder / "sound.wav",
                    )
                )
                await process(
                    self.ffmpeg("-i", folder / "sound.wav", "-c:a", "aac", "-b:a", "128k", folder / "preview.m4a")
                )
                self.check_storage()
                self.db.change(
                    "INSERT INTO clips(id,source_id,name,emoji,tags,start,end,volume,created_at,creator_id) "
                    "VALUES (?,?,?,?,?,?,?,?,?,?)",
                    (
                        folder.name,
                        source["id"],
                        values["name"],
                        values["emoji"],
                        json.dumps(values["tags"]),
                        values["start"],
                        values["end"],
                        values["volume"],
                        time.time(),
                        values.get("creator_id"),
                    ),
                    values.get("creator_id"),
                    "sound.create",
                    resource_id=folder.name,
                    name=values["name"],
                )
            except BaseException:
                shutil.rmtree(folder, ignore_errors=True)
                raise
            else:
                return folder.name

    async def upload_clip(self, chunks: AsyncIterator[bytes], filename: str, values: JsonObject) -> str:
        suffix = Path(filename).suffix.lower()
        if suffix not in (".mp3", ".ogg"):
            message = "Choose an .mp3 or .ogg audio file."
            raise MediaError(message)
        if not all(shutil.which(path) for path in (self.settings.ffmpeg_path, self.settings.ffprobe_path)):
            message = "Audio uploads require FFmpeg and FFprobe. Ask an administrator to install them."
            raise MediaError(message)
        async with self.lock:
            folder = self.root / new_id()
            folder.mkdir()
            original = folder / ("upload" + suffix)
            try:
                budget = min(
                    20 * 1024 * 1024,
                    self.settings.max_import_bytes,
                    self.settings.max_storage_bytes - await asyncio.to_thread(self.used_bytes),
                )
                await asyncio.wait_for(self.write_upload(chunks, original, budget), 60)
                info = json.loads(
                    await process(
                        [
                            self.settings.ffprobe_path,
                            "-v",
                            "error",
                            "-protocol_whitelist",
                            "file,pipe",
                            "-show_format",
                            "-show_streams",
                            "-of",
                            "json",
                            original,
                        ],
                        30,
                    )
                )
                duration = self.validate_upload(info)
                await process(
                    self.ffmpeg(
                        "-i",
                        original,
                        "-map",
                        "0:a:0",
                        "-t",
                        duration,
                        "-vn",
                        "-ac",
                        "2",
                        "-ar",
                        "48000",
                        "-c:a",
                        "pcm_s16le",
                        folder / "sound.wav",
                    ),
                    60,
                )
                await process(
                    self.ffmpeg("-i", folder / "sound.wav", "-c:a", "aac", "-b:a", "128k", folder / "preview.m4a"), 60
                )
                original.unlink()
                await asyncio.to_thread(self.check_storage)
                self.db.change(
                    "INSERT INTO clips(id,source_id,name,emoji,tags,start,end,volume,created_at,creator_id) "
                    "VALUES (?,?,?,?,?,?,?,?,?,?)",
                    (
                        folder.name,
                        None,
                        values["name"],
                        values["emoji"],
                        json.dumps(values["tags"]),
                        0,
                        duration,
                        values["volume"],
                        time.time(),
                        values["creator_id"],
                    ),
                    values["creator_id"],
                    "sound.create",
                    resource_id=folder.name,
                    name=values["name"],
                )
                self.summary_until = 0
            except TimeoutError as error:
                shutil.rmtree(folder, ignore_errors=True)
                message = "Audio upload or conversion timed out. Try a smaller file."
                raise MediaError(message) from error
            except BaseException:
                shutil.rmtree(folder, ignore_errors=True)
                raise
            else:
                return folder.name

    def validate_upload(self, info: dict) -> float:
        try:
            duration = float(info.get("format", {}).get("duration", 0))
        except (TypeError, ValueError) as error:
            message = "The audio file must have a known duration."
            raise MediaError(message) from error
        streams = info.get("streams", [])
        if (
            info.get("format", {}).get("format_name") not in ("mp3", "ogg")
            or not streams
            or any(stream.get("codec_type") != "audio" for stream in streams)
        ):
            message = "The file must contain MP3 or Ogg audio without video."
            raise MediaError(message)
        if not math.isfinite(duration) or not MIN_UPLOAD_SECONDS <= duration <= self.settings.max_clip_seconds:
            message = f"Sounds must be between 0.1 and {self.settings.max_clip_seconds:g} seconds."
            raise MediaError(message)
        return duration

    @staticmethod
    async def write_upload(chunks: AsyncIterator[bytes], path: Path, budget: int) -> None:
        size = 0
        with path.open("wb") as output:
            async for chunk in chunks:
                size += len(chunk)
                if size > budget:
                    message = "Audio upload exceeds the 20 MB upload limit or available media storage."
                    raise MediaError(message)
                await asyncio.to_thread(output.write, chunk)
        if not size:
            message = "Choose a non-empty audio file."
            raise MediaError(message)

    def check_storage(self) -> None:
        if self.used_bytes() > self.settings.max_storage_bytes:
            message = "Media storage is full. Delete unused sources or sounds."
            raise MediaError(message)

    async def close(self) -> None:
        for task in tuple(self.tasks):
            task.cancel()
        await asyncio.gather(*self.tasks, return_exceptions=True)
