from __future__ import annotations

import threading
import time
from collections import deque
from typing import TYPE_CHECKING

import discord

from app.music_diagnostics import MusicSourceError, source_error

if TYPE_CHECKING:
    from app.network import DownloadProxy

FRAME_SECONDS = 0.02
FRAME_BYTES = 3840
PREBUFFER_FRAMES = 250
MAX_BUFFER_FRAMES = 500
BUFFER_TIMEOUT = 20
END_TOLERANCE = 3.0
SILENCE = bytes(FRAME_BYTES)


class MusicBuffer(discord.AudioSource):
    def __init__(
        self, decoder: discord.AudioSource, remaining: float, proxy: DownloadProxy | None, identity: str
    ) -> None:
        self.decoder, self.remaining, self.proxy, self.identity = decoder, remaining, proxy, identity
        self.condition = threading.Condition()
        self.ready = threading.Event()
        self.stopping = threading.Event()
        self.finished = False
        self.error: MusicSourceError | None = None
        self.queue: deque[bytes] = deque()
        self.produced = 0
        self.played = 0
        self.silent = 0
        self.starved_at: float | None = None
        self.worker = threading.Thread(target=self.produce, daemon=True, name="music-pcm-buffer")
        self.worker.start()

    def prepare(self) -> None:
        if not self.ready.wait(BUFFER_TIMEOUT):
            with self.condition:
                self.error = source_error("buffer_timeout", youtube_id=self.identity)
                self.finished = True
                self.stopping.set()
                self.condition.notify_all()

    def finish_error(self) -> MusicSourceError | None:
        if self.proxy and self.proxy.block_reason:
            return source_error("blocked_destination", youtube_id=self.identity)
        error = getattr(self.decoder, "music_error", None)
        if isinstance(error, MusicSourceError):
            return MusicSourceError(str(error), **{**error.details, "youtube_id": self.identity})
        if getattr(self.decoder, "_current_error", None):
            return source_error("decoder_exit", youtube_id=self.identity)
        if self.remaining - self.produced * FRAME_SECONDS > END_TOLERANCE:
            return source_error("early_eof", youtube_id=self.identity)
        return None

    def produce(self) -> None:
        try:
            while not self.stopping.is_set():
                with self.condition:
                    self.condition.wait_for(lambda: len(self.queue) < MAX_BUFFER_FRAMES or self.stopping.is_set())
                if self.stopping.is_set():
                    break
                data = self.decoder.read()
                with self.condition:
                    if self.stopping.is_set():
                        break
                    if not data:
                        self.error = self.finish_error()
                        self.finished = True
                        break
                    self.queue.append(data)
                    self.produced += 1
                    self.condition.notify_all()
                    if len(self.queue) >= PREBUFFER_FRAMES:
                        self.ready.set()
        except (OSError, ValueError, discord.DiscordException) as error:
            with self.condition:
                self.error = error if isinstance(error, MusicSourceError) else source_error("decoder_exit")
                self.finished = True
        finally:
            self.ready.set()

    def read(self) -> bytes:
        with self.condition:
            if self.stopping.is_set() and self.error:
                raise self.error
            if self.queue:
                data = self.queue.popleft()
                self.played += 1
                self.starved_at = None
                self.condition.notify()
                return data
            if self.finished:
                if self.error:
                    raise self.error
                return b""
            now = time.monotonic()
            if self.starved_at is None:
                self.starved_at = now
            if now - self.starved_at >= BUFFER_TIMEOUT:
                msg = "buffer_timeout"
                raise source_error(msg, youtube_id=self.identity)
            self.silent += 1
            return SILENCE

    def is_opus(self) -> bool:
        return False

    def cleanup(self) -> None:
        self.stopping.set()
        with self.condition:
            self.condition.notify_all()
        try:
            self.decoder.cleanup()
        finally:
            self.worker.join(timeout=3)
