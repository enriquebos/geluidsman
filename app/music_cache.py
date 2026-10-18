from __future__ import annotations

import asyncio
import contextlib
import hashlib
import json
import logging
import shutil
from typing import TYPE_CHECKING

from app.music_diagnostics import log_music_failure
from app.music_models import MusicTrack
from app.music_sources import MusicSourceError, youtube_url

if TYPE_CHECKING:
    from app.db import Database
    from app.events import Events
    from app.music_sources import MusicSources
    from app.music_store import MusicStore

MAX_CACHE_ITEMS = 10000
DISK_RESERVE = 256_000_000
MAX_MANIFEST_BYTES = 16000
DOWNLOAD_WORKERS = 2
QUEUE_PREFETCH = 5
MAX_REQUIRED_DOWNLOADS = 8


def cache_key(track: dict) -> str:
    value = f"{track['provider']}:{track['source_id']}:{track.get('youtube_id') or ''}"
    return hashlib.sha256(value.encode()).hexdigest()


class MusicCache:
    def __init__(self, db: Database, sources: MusicSources, store: MusicStore, events: Events) -> None:
        self.db, self.sources, self.store, self.events = db, sources, store, events
        self.root = sources.settings.data_dir / "music-cache"
        self.entries: dict[str, dict] = {}
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

    async def start(self) -> None:
        await asyncio.to_thread(self.load)
        self.task = asyncio.create_task(self.run())
        self.refresh()

    def load(self) -> None:
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
                        and entry["container"] in {"webm", "m4a"}
                        and 0 < audio.stat().st_size == entry["bytes"]
                    ):
                        self.entries[key] = entry
                        self.used += entry["bytes"]
                except (ValueError, KeyError, OSError, TypeError):
                    continue
        self.remove_orphans()

    def remove_orphans(self) -> None:
        for path in self.root.iterdir():
            if path.suffix in {".audio", ".json"} and path.stem not in self.entries:
                path.unlink(missing_ok=True)

    def refresh(self) -> None:
        self.wake.set()

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
            return {"state": "cached", **(self.recording(track) or {})}
        if key in self.states:
            return dict(self.states[key])
        if self.limit_reached:
            return {"state": "failed", "error": "The music cache supports up to 10,000 distinct playlist songs."}
        return {"state": "queued"}

    def recording(self, track: dict) -> dict | None:
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
        if old_key in wanted:
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
        if key not in self.entries and track["provider"] == "spotify" and track.get("youtube_id"):
            automatic = cache_key({**track, "youtube_id": None})
            entry = self.entries.get(automatic)
            if entry and entry["track"]["youtube_id"] == track["youtube_id"]:
                return automatic
        return key

    def retry(self, tracks: list[dict]) -> None:
        for track in tracks:
            key = self.entry_key(track)
            if self.states.get(key, {}).get("state") == "failed":
                self.states.pop(key, None)
        self.refresh()

    def notify(self) -> None:
        for waiters in self.waiters.values():
            for waiter in waiters:
                waiter.set()
        self.events.publish("music_cache")

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
        free = await asyncio.to_thread(shutil.disk_usage, self.root)
        reserved = sum(self.reservations.values())
        available = min(
            self.sources.settings.music_cache_max_bytes - self.used - reserved, free.free - DISK_RESERVE - reserved
        )
        if available <= 0 and reserved:
            return False
        try:
            self.require_space(available)
        except MusicSourceError as error:
            self.states[key] = {"state": "failed", "error": str(error)}
            self.notify()
            return True
        limit = min(available, self.sources.settings.max_import_bytes)
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
                (self.root / (key + ".audio")).unlink(missing_ok=True)
                (self.root / (key + ".json")).unlink(missing_ok=True)
            except OSError:
                return False
            return True

        if await asyncio.to_thread(remove):
            entry = self.entries.pop(key, None)
            if entry:
                self.used -= entry["bytes"]

    async def prune(self, wanted: set[str]) -> None:
        for key in tuple(self.entries):
            if key not in wanted:
                await self.remove_entry(key)

    async def download(self, key: str, track: dict, byte_limit: int) -> None:
        self.states[key] = {"state": "downloading"}
        self.notify()
        path = self.root / (key + ".part")
        try:
            entry = await self.sources.download(track, path, byte_limit)
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
            self.notify()

    @staticmethod
    def require_space(available: int) -> None:
        if available <= 0:
            message = "Music cache storage is full. Remove unused playlist songs or increase MUSIC_CACHE_MAX_BYTES."
            raise MusicSourceError(message, reason="storage_limit")

    def commit(self, key: str, entry: dict) -> None:
        (self.root / (key + ".part")).replace(self.root / (key + ".audio"))
        temporary = self.root / (key + ".json.part")
        temporary.write_text(json.dumps(entry))
        temporary.replace(self.root / (key + ".json"))

    async def local(self, track: dict) -> dict | None:
        key = self.entry_key(track)
        entry = self.entries.get(key)
        if not entry:
            return None
        path = self.root / (key + ".audio")
        try:
            size = await asyncio.to_thread(lambda: path.stat().st_size)
        except FileNotFoundError:
            size = 0
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
        return {"stream": str(path), "container": entry["container"], "track": metadata}

    async def close(self) -> None:
        self.closed = True
        self.notify()
        if self.task:
            self.task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self.task
