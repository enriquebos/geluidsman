from __future__ import annotations

import threading
import time
import uuid
import wave
from contextlib import ExitStack
from typing import TYPE_CHECKING

import discord
import numpy as np

if TYPE_CHECKING:
    from collections.abc import Callable
    from pathlib import Path

    from app.types import JsonObject

FRAMES = 960
CHANNELS = 2
FRAME_BYTES = FRAMES * CHANNELS * 2
SILENCE = bytes(FRAME_BYTES)


class CapacityError(ValueError):
    pass


class Mixer(discord.AudioSource):
    def __init__(self, limit: int = 8, volume: float = 1.0, on_change: Callable[[], None] | None = None) -> None:
        self.limit, self.volume, self.on_change = limit, volume, on_change
        self.on_change = on_change or (lambda: None)
        self.lock = threading.RLock()
        self.streams = {}
        self.closed = False
        self.muted = False

    def add(self, path: Path, clip: JsonObject) -> str:
        with self.lock:
            if self.closed:
                msg = "Voice connection is unavailable."
                raise ValueError(msg)
            if len(self.streams) >= self.limit:
                msg = f"All {self.limit} playback slots are in use."
                raise CapacityError(msg)
            resources = ExitStack()
            try:
                reader = resources.enter_context(wave.open(str(path), "rb"))
            except BaseException:
                resources.close()
                raise
            if (reader.getframerate(), reader.getnchannels(), reader.getsampwidth()) != (48000, 2, 2):
                resources.close()
                msg = "Clip audio format is invalid."
                raise ValueError(msg)
            instance_id = uuid.uuid4().hex
            self.streams[instance_id] = {
                "reader": reader,
                "resources": resources,
                "clip_id": clip["id"],
                "name": clip["name"],
                "volume": clip["volume"],
                "started_at": time.time(),
                "duration": reader.getnframes() / 48000,
                "position": 0.0,
            }
        self.on_change()
        return instance_id

    def snapshot(self) -> list[JsonObject]:
        with self.lock:
            return [
                {"id": key, **{k: v for k, v in item.items() if k not in {"reader", "resources"}}}
                for key, item in self.streams.items()
            ]

    def stop(self, instance_id: str | None = None) -> None:
        with self.lock:
            keys = list(self.streams) if instance_id is None else [instance_id]
            for key in keys:
                item = self.streams.pop(key, None)
                if item:
                    item["resources"].close()
        self.on_change()

    def read(self) -> bytes:
        changed = False
        with self.lock:
            if self.closed:
                return b""
            if not self.streams:
                return SILENCE
            mixed = np.zeros(FRAMES * CHANNELS, dtype=np.float32)
            for key, stream in list(self.streams.items()):
                raw = stream["reader"].readframes(FRAMES)
                if not raw:
                    stream["resources"].close()
                    del self.streams[key]
                    changed = True
                    continue
                samples = np.frombuffer(raw, dtype="<i2")
                mixed[: len(samples)] += samples.astype(np.float32) * stream["volume"]
                stream["position"] += len(samples) / (CHANNELS * 48000)

            output = np.clip(mixed * self.volume, -32768, 32767).astype("<i2").tobytes()
        if changed:
            self.on_change()
        return SILENCE if self.muted else output

    def cleanup(self) -> None:
        with self.lock:
            self.closed = True
            self.stop()
