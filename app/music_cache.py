from __future__ import annotations

import asyncio
import contextlib
import hashlib
import json
import logging
import shutil
import threading
import time
from typing import TYPE_CHECKING

from app.music_diagnostics import log_music_failure
from app.music_models import MusicTrack
from app.music_normalization import MusicNormalization, current_measurement, media_version
from app.music_sources import MusicSourceError, youtube_url

if TYPE_CHECKING:
    from app.db import Database
    from app.events import Events
    from app.music_sources import MusicSources
    from app.music_store import MusicStore

MAX_CACHE_ITEMS = 10000
DISK_RESERVE = 256_000_000
MAX_RECORDING_METADATA_BYTES = 16000
MAX_MANIFEST_BYTES = MAX_RECORDING_METADATA_BYTES + 1000
PROGRESS_INTERVAL = 0.5
DOWNLOAD_WORKERS = 2
QUEUE_PREFETCH = 5
MAX_REQUIRED_DOWNLOADS = 8


def cache_key(track: dict) -> str:
    value = (
        "upload:" + track["upload_id"]
        if track.get("upload_id")
        else f"{track['provider']}:{track['source_id']}:{track.get('youtube_id') or ''}"
    )
    return hashlib.sha256(value.encode()).hexdigest()


class MusicCache:
    def __init__(self, db: Database, sources: MusicSources, store: MusicStore, events: Events) -> None:
        self.db, self.sources, self.store, self.events = db, sources, store, events
        self.root = sources.settings.data_dir / "music-cache"
        self.entries: dict[str, dict] = {}
        self.manifest_sizes = {}
        self.states: dict[str, dict] = {}
        self.wake = asyncio.Event()
        self.task: asyncio.Task | None = None
        self.used = 0
        self.closed = False
        self.limit_reached = False
        self.priorities: list[str] = []
        self.priority_tracks: list[dict] = []
        self.required: dict[str, dict] = {}
        self.waiters: dict[str, set[asyncio.Event]] = {}
        self.active_downloads: dict[str, asyncio.Task] = {}
        self.reservations: dict[str, int] = {}
        self.budget = None
        self.paused = set()
        self.aliases = {}
        self.recordings = {}
        self.progress_at = {}
        self.pause_write = None
        self.paused_revision = 0
        self.metadata_lock = threading.RLock()
        self.normalization = MusicNormalization(self)

    async def start(self) -> None:
        await asyncio.to_thread(self.load)
        self.task = asyncio.create_task(self.run())
        self.refresh()
        self.normalization.start()

    def load(self) -> None:
        self.paused = set(self.db.setting("music_downloads_paused", []))
        self.root.mkdir(parents=True, exist_ok=True)
        for path in self.root.iterdir():
            if path.suffix == ".part":
                path.unlink(missing_ok=True)
            elif path.suffix == ".json" and len(self.entries) < MAX_CACHE_ITEMS:
                try:
                    if path.stat().st_size > MAX_MANIFEST_BYTES:
                        continue
                    entry = json.loads(path.read_text())
                    key = cache_key(MusicTrack.model_validate(entry["original"]).model_dump())
                    entry["track"] = MusicTrack.model_validate(entry["track"]).model_dump()
                    audio = self.root / (key + ".audio")
                    if (
                        path.stem == key
                        and entry["container"] in ({"mp3"} if entry["track"].get("upload_id") else {"webm", "m4a"})
                        and 0 < audio.stat().st_size == entry["bytes"]
                    ):
                        entry["normalization"] = current_measurement(entry, media_version(audio))
                        self.entries[key] = entry
                        self.manifest_sizes[key] = path.stat().st_size
                        self.used += entry["bytes"]
                except (ValueError, KeyError, OSError, TypeError):
                    continue
        aliases = self.db.setting("music_recording_aliases", {})
        self.aliases = {alias: target for alias, target in aliases.items() if target in self.entries}
        self.remove_orphans()

    def remove_orphans(self) -> None:
        for path in self.root.iterdir():
            if path.suffix in {".audio", ".json"} and path.stem not in self.entries:
                path.unlink(missing_ok=True)

    def refresh(self) -> None:
        self.wake.set()
        self.normalization.wake.set()

    def prioritize(self, tracks: list[dict]) -> None:
        tracks = tracks[: QUEUE_PREFETCH + 1]
        priorities = list(dict.fromkeys(self.entry_key(track) for track in tracks))
        if priorities != self.priorities:
            self.priorities = priorities
            self.priority_tracks = [dict(track) for track in tracks]
            self.refresh()

    def status(self, track: dict) -> dict:
        key = self.entry_key(track)
        if key in self.entries:
            return {
                "state": "cached",
                "bytes": self.entries[key]["bytes"],
                "normalization": self.normalization.status(key, self.entries[key]),
                **(self.recording(track) or {}),
            }
        if track.get("upload_id"):
            return {"state": "failed", "error": "Uploaded MP3 is missing. Upload it again in Edit playlist song."}
        if key in self.paused:
            return {"state": "cancelled", "error": "Download paused until retry or explicit playback."}
        if key in self.states:
            return dict(self.states[key])
        if self.limit_reached:
            return {"state": "failed", "error": "The music cache supports up to 10,000 distinct playlist songs."}
        return {"state": "queued"}

    def recording(self, track: dict) -> dict | None:
        if track.get("upload_id"):
            return {"upload_name": track.get("upload_name"), "source_url": None}
        entry = self.entries.get(self.entry_key(track))
        matched = entry["track"] if entry else track
        identity = matched.get("youtube_id")
        if not identity:
            return None
        return {
            "youtube_id": identity,
            "youtube_title": matched.get("youtube_title") or matched["title"],
            "source_url": youtube_url(identity),
        }

    async def replace(self, old: dict, _new: dict) -> None:
        old_key = self.entry_key(old)
        wanted = set(await self.plan())
        self.refresh()
        if old_key in wanted or old.get("upload_id"):
            return
        active = self.active_downloads.get(old_key)
        if active:
            active.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await active
            if old_key in await self.plan():
                self.refresh()
                return
        await self.remove_entry(old_key)
        self.states.pop(old_key, None)
        self.refresh()
        self.notify()

    def entry_key(self, track: dict) -> str:
        key = cache_key(track)
        if track.get("upload_id"):
            return key
        if key in self.aliases:
            return self.aliases[key]
        identity = track.get("youtube_id") or (track["source_id"] if track["provider"] == "youtube" else None)
        if identity:
            for candidate, entry in tuple(self.entries.items()):
                recording = entry["track"]
                if recording.get("upload_id"):
                    continue
                actual = recording.get("youtube_id") or (
                    recording["source_id"] if recording["provider"] == "youtube" else None
                )
                if identity == actual:
                    self.aliases[key] = candidate
                    return candidate
        if key not in self.entries and track["provider"] == "spotify" and track.get("youtube_id"):
            automatic = cache_key({**track, "youtube_id": None})
            entry = self.entries.get(automatic)
            if entry and entry["track"]["youtube_id"] == track["youtube_id"]:
                return automatic
        return key

    async def retry_verified(self, tracks: list[dict]) -> None:
        for track in tracks:
            key = self.entry_key(track)
            entry = self.entries.get(key)
            if entry:
                try:
                    stored = await asyncio.to_thread(lambda key=key: (self.root / (key + ".audio")).stat().st_size)
                except FileNotFoundError:
                    stored = 0
                if stored != entry["bytes"]:
                    await self.remove_entry(key)
                elif entry.get("normalization", {}).get("state") == "failed":
                    version = await asyncio.to_thread(media_version, self.root / (key + ".audio"))
                    pending = current_measurement({}, version)
                    if await self.normalization.persist(key, entry, version, pending):
                        self.normalization.enqueue(key)
        self.retry(tracks)

    def retry(self, tracks: list[dict]) -> None:
        for track in tracks:
            key = self.entry_key(track)
            self.paused.discard(key)
            if self.states.get(key, {}).get("state") == "failed":
                self.states.pop(key, None)
        self.persist_paused()
        self.refresh()

    def persist_paused(self) -> None:
        self.paused_revision += 1
        if not self.pause_write or self.pause_write.done():
            self.pause_write = asyncio.create_task(self.write_paused())

    async def write_paused(self) -> None:
        while True:
            revision, values = self.paused_revision, sorted(self.paused)
            await self.db.run(self.db.set_setting, "music_downloads_paused", values)
            await self.db.run(self.db.set_setting, "music_recording_aliases", dict(self.aliases))
            if revision == self.paused_revision:
                return

    async def cancel_download(self, key: str) -> None:
        if key in self.required or self.priorities[:1] == [key]:
            message = "This recording is required for playback."
            raise ValueError(message)
        if key in self.entries:
            return
        self.paused.add(key)
        self.persist_paused()
        await self.pause_write
        if key in self.required or self.priorities[:1] == [key] or key in self.entries:
            self.paused.discard(key)
            self.persist_paused()
            return
        task = self.active_downloads.get(key)
        if task:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
        if key in self.entries:
            self.paused.discard(key)
            self.persist_paused()
        self.states.pop(key, None)
        self.notify(key)
        self.refresh()

    def progress(self, key: str, done: int, total: int | None) -> None:
        if key in self.paused:
            return
        changed = self.states.get(key, {}).get("state") != "downloading"
        self.states[key] = {"state": "downloading", "downloaded_bytes": done, "total_bytes": total}
        now = time.monotonic()
        if now - self.progress_at.get(key, 0) >= PROGRESS_INTERVAL:
            self.progress_at[key] = now
            self.notify(key, counts_changed=changed)

    async def share_recording(self, track: dict, key: str) -> dict | None:
        identity = track.get("youtube_id") or track["source_id"]
        existing = self.recordings.get(identity)
        if existing and existing != key:
            task = self.active_downloads.get(existing)
            if task:
                try:
                    await asyncio.shield(task)
                except asyncio.CancelledError:
                    if asyncio.current_task().cancelling():
                        raise
            entry = self.entries.get(existing)
            if entry:
                self.aliases[key] = existing
                self.persist_paused()
                await self.pause_write
                return {**entry, "reuse": existing}
        for candidate, entry in tuple(self.entries.items()):
            if entry["track"].get("upload_id"):
                continue
            if (entry["track"].get("youtube_id") or entry["track"]["source_id"]) == identity:
                self.aliases[key] = candidate
                self.persist_paused()
                await self.pause_write
                return {**entry, "reuse": candidate}
        self.recordings[identity] = key
        return None

    def notify(self, key: str | None = None, *, counts_changed: bool = True) -> None:
        for waiters in self.waiters.values():
            for waiter in waiters:
                waiter.set()
        data = {"ids": ["music:" + key] if key else [], "counts_changed": counts_changed}
        if key and not counts_changed:
            entry = self.entries.get(key)
            data["download_update"] = (
                {"normalization": self.normalization.status(key, entry)}
                if entry
                else {name: value for name, value in self.states.get(key, {}).items() if name != "state"}
            )
        self.events.publish("music_cache", data)

    async def plan(self) -> dict[str, dict]:
        result = {self.entry_key(track): track for track in [*self.required.values(), *self.priority_tracks]}
        self.limit_reached = False
        for page in (self.store.cache_page, self.store.liked_cache_page):
            after = ""
            while rows := await self.db.run(page, after):
                for row in rows:
                    for value in json.loads(row["tracks"]):
                        track = MusicTrack.model_validate(value).model_dump()
                        result[self.entry_key(track)] = track
                        if len(result) >= MAX_CACHE_ITEMS:
                            self.limit_reached = True
                            return result
                after = rows[-1]["id"]
        return result

    async def run(self) -> None:
        try:
            while not self.closed:
                await self.wake.wait()
                self.wake.clear()
                try:
                    tracks = await self.plan()
                    await self.collect(set(tracks))
                    await self.make_room()
                    self.states = {key: value for key, value in self.states.items() if key in tracks}
                    await self.prune(set(tracks))
                    ordered = dict.fromkeys([*self.required, *(key for key in self.priorities if key in tracks)])
                    ordered.update(dict.fromkeys(tracks))
                    for key in ordered:
                        if self.wake.is_set() or len(self.active_downloads) >= DOWNLOAD_WORKERS:
                            break
                        if (
                            key not in self.entries
                            and key not in self.active_downloads
                            and key not in self.paused
                            and self.states.get(key, {}).get("state") != "failed"
                            and not await self.launch(key, tracks[key])
                        ):
                            break
                except (OSError, ValueError, RuntimeError):
                    logging.getLogger("app.music").warning(
                        "Playlist cache update failed; retry by updating a playlist."
                    )
        finally:
            for task in self.active_downloads.values():
                task.cancel()
            await asyncio.gather(*self.active_downloads.values(), return_exceptions=True)
            self.active_downloads.clear()
            self.reservations.clear()

    async def make_room(self) -> None:
        urgent = {
            key
            for key in self.required
            if key not in self.entries
            and key not in self.active_downloads
            and self.states.get(key, {}).get("state") != "failed"
        }
        if not urgent or len(self.active_downloads) < DOWNLOAD_WORKERS:
            return
        for key, task in tuple(self.active_downloads.items()):
            if key not in self.required:
                task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await task
                self.active_downloads.pop(key, None)
                self.states.pop(key, None)
                break

    async def ensure(self, track: dict) -> dict:
        key = self.entry_key(track)
        if key not in self.priorities:
            self.prioritize([track, *self.priority_tracks])
        if len(self.required) >= MAX_REQUIRED_DOWNLOADS and key not in self.required:
            message = "The music downloader is busy. Try again shortly."
            raise MusicSourceError(message)
        if key not in self.required:
            self.retry([track])
        waiter = asyncio.Event()
        self.waiters.setdefault(key, set()).add(waiter)
        self.required[key] = dict(track)
        self.refresh()
        try:
            async with asyncio.timeout(300):
                while not self.closed:
                    waiter.clear()
                    if local := await self.local(track):
                        return local
                    if track.get("upload_id"):
                        raise MusicSourceError(self.status(track)["error"])
                    state = self.states.get(key, {})
                    if state.get("state") == "failed":
                        raise MusicSourceError(state["error"])
                    await waiter.wait()
        except TimeoutError:
            message = "Downloading this recording took too long. Try another recording or retry later."
            raise MusicSourceError(message, reason="download_timeout") from None
        finally:
            self.waiters[key].discard(waiter)
            if not self.waiters[key]:
                self.waiters.pop(key)
                self.required.pop(key, None)
            self.refresh()
        message = "The music downloader is shutting down."
        raise MusicSourceError(message)

    async def collect(self, wanted: set[str]) -> None:
        for key, task in tuple(self.active_downloads.items()):
            if key not in wanted:
                task.cancel()
            if task.done() or key not in wanted:
                try:
                    with contextlib.suppress(asyncio.CancelledError):
                        await task
                finally:
                    if self.active_downloads.get(key) is task:
                        self.active_downloads.pop(key, None)

    async def launch(self, key: str, track: dict) -> bool:
        if track.get("upload_id"):
            self.states[key] = self.status(track)
            self.notify(key)
            return True
        free = await asyncio.to_thread(shutil.disk_usage, self.root)
        reserved = sum(self.reservations.values())
        available = min(
            (
                self.budget.limit - self.budget.media.storage.used()
                if self.budget
                else self.sources.settings.music_cache_max_bytes
            )
            - self.used
            - reserved,
            free.free - DISK_RESERVE - reserved,
        )
        if available <= 0 and reserved:
            return False
        try:
            self.require_space(available)
        except MusicSourceError as error:
            self.states[key] = {"state": "failed", "error": str(error)}
            self.notify(key)
            return True
        limit = min(available, self.sources.settings.max_import_bytes)
        if self.budget:
            allocation = await asyncio.to_thread(
                self.budget.reserve, "music:" + key, self.sources.settings.max_import_bytes + MAX_MANIFEST_BYTES
            )
            limit = max(0, allocation - MAX_MANIFEST_BYTES)
            if not limit:
                self.budget.release("music:" + key)
                if self.budget.reservations:
                    return False
                self.states[key] = {
                    "state": "failed",
                    "error": "Media storage is full. Free space in Storage or increase the media limit.",
                }
                self.notify(key)
                return True
        self.reservations[key] = limit
        task = asyncio.create_task(self.download(key, track, limit))
        self.active_downloads[key] = task
        task.add_done_callback(lambda _task: self.completed(key, _task))
        return True

    def completed(self, key: str, task: asyncio.Task) -> None:
        if self.active_downloads.get(key) is task:
            self.reservations.pop(key, None)
        self.refresh()

    async def remove_entry(self, key: str) -> None:
        def remove() -> bool:
            try:
                with self.metadata_lock:
                    (self.root / (key + ".audio")).unlink(missing_ok=True)
                    (self.root / (key + ".json")).unlink(missing_ok=True)
            except OSError:
                return False
            return True

        if await asyncio.to_thread(remove):
            entry = self.entries.pop(key, None)
            self.manifest_sizes.pop(key, None)
            if entry:
                self.used -= entry["bytes"]
                self.aliases = {alias: target for alias, target in self.aliases.items() if target != key}
                self.recordings = {identity: target for identity, target in self.recordings.items() if target != key}

    async def prune(self, wanted: set[str]) -> None:
        for key, entry in tuple(self.entries.items()):
            if key not in wanted and not entry["track"].get("upload_id"):
                await self.remove_entry(key)

    async def download(self, key: str, track: dict, byte_limit: int) -> None:
        self.states[key] = {"state": "downloading"}
        self.notify(key)
        path = self.root / (key + ".part")
        try:
            entry = await self.sources.download(track, path, byte_limit)
            if entry.get("reuse"):
                self.states.pop(key, None)
                return
            entry["completed_at"] = time.time()
            self.require_space(entry["bytes"] if entry["bytes"] <= byte_limit else 0)
            entry["original"] = track
            task = asyncio.create_task(asyncio.to_thread(self.commit, key, entry))
            cancelled = False
            while not task.done():
                try:
                    await asyncio.shield(task)
                except asyncio.CancelledError:
                    cancelled = True
            task.result()
            self.entries[key] = entry
            self.used += entry["bytes"]
            self.states.pop(key, None)
            self.normalization.enqueue(key)
            if cancelled:
                raise asyncio.CancelledError
        except MusicSourceError as error:
            log_music_failure(track, error, "cache")
            self.states[key] = {"state": "failed", "error": str(error)}
        except OSError as error:
            log_music_failure(track, error, "cache")
            self.states[key] = {
                "state": "failed",
                "error": "Download failed: check available disk space and retry.",
            }
        finally:
            await asyncio.to_thread(path.unlink, missing_ok=True)
            self.reservations.pop(key, None)
            if self.budget:
                self.budget.release("music:" + key)
            self.progress_at.pop(key, None)
            self.notify(key)

    @staticmethod
    def require_space(available: int) -> None:
        if available <= 0:
            message = "Media storage is full. Remove unused files in Storage or increase the media limit."
            raise MusicSourceError(message, reason="storage_limit")

    def commit(self, key: str, entry: dict) -> None:
        with self.metadata_lock:
            target = self.root / (key + ".audio")
            (self.root / (key + ".part")).replace(target)
            entry["normalization"] = current_measurement({}, media_version(target))
            self.write_manifest(key, entry)

    def write_manifest(self, key: str, entry: dict) -> None:
        temporary = self.root / (key + ".json.part")
        try:
            content = json.dumps(entry, allow_nan=False).encode()
            if len(content) > MAX_MANIFEST_BYTES:
                message = "Recording metadata is too large."
                raise OSError(message)
            temporary.write_bytes(content)
            temporary.replace(self.root / (key + ".json"))
            self.manifest_sizes[key] = (self.root / (key + ".json")).stat().st_size
        finally:
            temporary.unlink(missing_ok=True)

    async def local(self, track: dict) -> dict | None:
        key = self.entry_key(track)
        entry = self.entries.get(key)
        if not entry:
            return None
        path = self.root / (key + ".audio")
        try:
            size, version = await asyncio.to_thread(lambda: (path.stat().st_size, media_version(path)))
        except FileNotFoundError:
            size = 0
        if self.entries.get(key) is not entry:
            return await self.local(track)
        if size != entry["bytes"]:
            removed = self.entries.pop(key, None)
            if removed:
                self.used -= removed["bytes"]
            self.refresh()
            return None
        if entry["track"]["duration"] > self.sources.settings.max_source_seconds:
            message = "This cached recording exceeds the configured source duration limit."
            raise MusicSourceError(message, reason="duration_limit")
        matched = entry["track"]
        metadata = {
            **track,
            "youtube_id": matched.get("youtube_id"),
            "youtube_title": matched.get("youtube_title"),
            "duration": matched["duration"],
        }
        entry["normalization"] = current_measurement(entry, version)
        self.normalization.enqueue(key)
        measured = entry["normalization"]
        normalization = {
            "media_version": version,
            "gain_db": measured["gain_db"] if measured["state"] == "ready" else 0.0,
        }
        return {"stream": str(path), "container": entry["container"], "track": metadata, "normalization": normalization}

    async def close(self) -> None:
        await self.normalization.close()
        if self.pause_write:
            await self.pause_write
        self.closed = True
        self.notify()
        if self.task:
            self.task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self.task
