from __future__ import annotations

import asyncio
import contextlib
import hashlib
import json
import math
from collections import deque
from typing import TYPE_CHECKING

from app.audio_processing import MAX_GAIN, MediaError, measure_loudness

if TYPE_CHECKING:
    from pathlib import Path

    from app.music_cache import MusicCache

POLICY_VERSION = 1
ANALYSIS_ERROR = "Loudness analysis failed. Retry analysis; the downloaded file has been kept."
RESERVATION_KEY = "music-normalization"


def media_version(path: Path) -> str:
    stat = path.stat()
    return hashlib.sha256(
        str((stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns)).encode()
    ).hexdigest()


def current_measurement(entry: dict, version: str) -> dict:
    result = entry.get("normalization", {})
    pending = {"policy": POLICY_VERSION, "media_version": version, "state": "queued"}
    if (
        not isinstance(result, dict)
        or result.get("policy") != POLICY_VERSION
        or result.get("media_version") != version
        or result.get("state") not in {"queued", "ready", "failed"}
    ):
        return pending
    if result.get("state") == "ready":
        gain = result.get("gain_db")
        if type(gain) not in {float, int} or not math.isfinite(gain) or gain > MAX_GAIN:
            return pending
        for name in ("integrated_lufs", "true_peak_dbfs"):
            value = result.get(name)
            if name not in result or (
                value is not None and (type(value) not in {float, int} or not math.isfinite(value))
            ):
                return pending
    return result


class MusicNormalization:
    def __init__(self, cache: MusicCache) -> None:
        self.cache = cache
        self.pending: deque[str] = deque()
        self.queued: set[str] = set()
        self.wake = asyncio.Event()
        self.task: asyncio.Task | None = None
        self.analysis: asyncio.Task | None = None
        self.active: str | None = None
        self.preparing = 0

    def start(self) -> None:
        for key in self.cache.entries:
            self.enqueue(key)
        self.task = asyncio.create_task(self.run())

    def enqueue(self, key: str) -> None:
        entry = self.cache.entries.get(key)
        if not entry:
            return
        state = entry.get("normalization", {}).get("state", "queued")
        if state in {"ready", "failed"}:
            return
        if key not in self.queued and key != self.active:
            if len(self.pending) >= len(self.cache.entries):
                self.pending = deque(item for item in self.pending if item in self.cache.entries)
                self.queued = set(self.pending)
            self.queued.add(key)
            self.pending.append(key)
        self.wake.set()

    def busy(self) -> bool:
        budget = self.cache.budget
        return bool(
            self.preparing
            or self.cache.required
            or any(not task.done() for task in self.cache.active_downloads.values())
            or (budget and len(budget.reservations) > int(RESERVATION_KEY in budget.reservations))
        )

    async def run(self) -> None:
        while True:
            if not self.pending or self.busy():
                self.wake.clear()
                with contextlib.suppress(TimeoutError):
                    await asyncio.wait_for(self.wake.wait(), 1 if self.pending else None)
                continue
            key = self.pending.popleft()
            self.queued.discard(key)
            self.active = key
            interrupted = False
            try:
                self.analysis = asyncio.create_task(self.analyze(key))
                while not self.analysis.done():
                    if self.busy():
                        interrupted = True
                        self.analysis.cancel()
                        break
                    with contextlib.suppress(TimeoutError):
                        await asyncio.wait_for(asyncio.shield(self.analysis), 0.2)
                await self.analysis
            except asyncio.CancelledError:
                if asyncio.current_task().cancelling():
                    raise
                interrupted = True
            finally:
                if self.analysis:
                    if not self.analysis.done():
                        self.analysis.cancel()
                    await asyncio.gather(self.analysis, return_exceptions=True)
                self.analysis = None
                self.active = None
                entry = self.cache.entries.get(key, {})
                if interrupted or entry.get("normalization", {}).get("state") == "queued":
                    self.enqueue(key)
            await asyncio.sleep(0.05)

    async def analyze(self, key: str) -> None:
        entry = self.cache.entries.get(key)
        if not entry:
            return
        path = self.cache.root / (key + ".audio")
        version = ""
        try:
            version = await asyncio.to_thread(media_version, path)
            previous = current_measurement(entry, version)
            if previous["state"] in {"ready", "failed"}:
                entry["normalization"] = previous
                return
            pending = {"policy": POLICY_VERSION, "media_version": version, "state": "queued"}
            if not await self.persist(key, entry, version, pending):
                return
            self.cache.notify(key, counts_changed=False)
            result = await measure_loudness(path, self.cache.sources.settings.ffmpeg_path, music=True)
            await self.persist(key, entry, version, {**pending, **result, "state": "ready"})
        except (OSError, MediaError, TimeoutError):
            result = {"policy": POLICY_VERSION, "media_version": version, "state": "failed", "error": ANALYSIS_ERROR}
            if version:
                await self.persist(key, entry, version, result)
            elif self.cache.entries.get(key) is entry:
                entry["normalization"] = result
        finally:
            self.cache.notify(key, counts_changed=entry.get("normalization", {}).get("state") == "failed")

    async def persist(self, key: str, entry: dict, version: str, result: dict) -> bool:
        def write() -> bool:
            with self.cache.metadata_lock:
                path = self.cache.root / (key + ".audio")
                if self.cache.entries.get(key) is not entry or media_version(path) != version:
                    return False
                updated = {**entry, "normalization": result}
                budget = self.cache.budget
                try:
                    if budget:
                        needed = len(json.dumps(updated, allow_nan=False).encode())
                        if budget.reserve(RESERVATION_KEY, needed) < needed:
                            message = "Insufficient storage to save loudness analysis."
                            raise OSError(message)
                    self.cache.write_manifest(key, updated)
                finally:
                    if budget:
                        budget.release(RESERVATION_KEY)
                entry["normalization"] = result
                return True

        try:
            return await self.cache.db.run(write)
        except OSError:
            if self.cache.entries.get(key) is entry:
                entry["normalization"] = {
                    "policy": POLICY_VERSION,
                    "media_version": version,
                    "state": "failed",
                    "error": ANALYSIS_ERROR,
                }
            return False

    def status(self, key: str, entry: dict) -> dict:
        result = dict(entry.get("normalization", {"state": "queued"}))
        if key == self.active and result["state"] == "queued":
            result["state"] = "analyzing"
        return result

    async def close(self) -> None:
        if self.task:
            self.task.cancel()
            await asyncio.gather(self.task, return_exceptions=True)
