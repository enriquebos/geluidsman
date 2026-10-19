from __future__ import annotations

import hashlib
import json
import os
import shutil
import threading
import time
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from app.media import Media
    from app.music_cache import MusicCache
from pathlib import Path

RECONCILE_SECONDS = 600


def size(path: Path) -> int:
    if path.is_file():
        try:
            return path.stat().st_size
        except FileNotFoundError:
            return 0
    total = 0
    pending = [path]
    while pending:
        try:
            with os.scandir(pending.pop()) as entries:
                for entry in entries:
                    try:
                        if entry.is_dir(follow_symlinks=False):
                            pending.append(Path(entry.path))
                        elif entry.is_file(follow_symlinks=False):
                            total += entry.stat(follow_symlinks=False).st_size
                    except FileNotFoundError:
                        continue
        except FileNotFoundError:
            continue
    return total


class Storage:
    def __init__(self, root: Path) -> None:
        self.root = root
        self.lock = threading.RLock()
        self.folders: dict[str, int] = {}
        self.total = 0
        self.next_scan = 0.0
        self.reconcile()

    def reconcile(self) -> None:
        with self.lock:
            self.folders = {path.name: size(path) for path in self.root.iterdir()}
            self.total = sum(self.folders.values())
            self.next_scan = time.monotonic() + RECONCILE_SECONDS

    def used(self) -> int:
        with self.lock:
            return self.total

    def projected(self, path: Path) -> int:
        with self.lock:
            return self.total - self.folders.get(path.name, 0) + size(path)

    def commit(self, path: Path) -> None:
        with self.lock:
            measured = size(path)
            self.total += measured - self.folders.get(path.name, 0)
            self.folders[path.name] = measured

    def remove(self, path: Path) -> None:
        with self.lock:
            shutil.rmtree(path, ignore_errors=True)
            measured = size(path)
            self.total += measured - self.folders.pop(path.name, 0)
            if measured:
                self.folders[path.name] = measured


class MediaBudget:
    def __init__(self, media: Media, cache: MusicCache) -> None:
        self.media, self.cache = media, cache
        self.lock = threading.RLock()
        self.reservations: dict[str, int] = {}
        values = media.db.setting("app_settings", {})
        if not isinstance(values.get("media_max_bytes"), int):
            values["media_max_bytes"] = media.base_settings.media_max_bytes or (
                values.get("max_storage_bytes", media.base_settings.max_storage_bytes)
                + media.base_settings.music_cache_max_bytes
            )
            media.db.set_setting("app_settings", values)
        self.limit = values["media_max_bytes"]

    def used(self) -> int:
        return self.media.storage.used() + self.cache.used + sum(self.cache.manifest_sizes.values())

    def reserve(self, key: str, maximum: int) -> int:
        with self.lock:
            available = min(
                self.limit - self.used() - sum(self.reservations.values()),
                shutil.disk_usage(self.media.root).free - 256_000_000 - sum(self.reservations.values()),
            )
            amount = max(0, min(maximum, available))
            if amount:
                self.reservations[key] = amount
            return amount

    def release(self, key: str) -> None:
        with self.lock:
            self.reservations.pop(key, None)


def fingerprint(value: object) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, default=str).encode()).hexdigest()
