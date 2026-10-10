from __future__ import annotations

import os
import shutil
import threading
import time
from pathlib import Path

RECONCILE_SECONDS = 600


def size(path: Path) -> int:
    if path.is_file():
        return path.stat().st_size
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
