from __future__ import annotations

import time
from typing import TYPE_CHECKING

from app.music_buffer import FRAME_SECONDS

if TYPE_CHECKING:
    from threading import Event

MIN_FRAME_INTERVAL = FRAME_SECONDS * 0.85


class MusicClock:
    def __init__(self, stopping: Event) -> None:
        self.stopping = stopping
        self.deadline: float | None = None
        self.previous: float | None = None

    def packet_sent(self, started: float, finished: float) -> None:
        self.previous = finished if finished - started > FRAME_SECONDS else started

    def wait(self) -> bool:
        now = time.monotonic()
        target = self.deadline if self.deadline is not None else now
        deadline = target
        if self.previous is not None:
            deadline = max(deadline, self.previous + MIN_FRAME_INTERVAL)
        if deadline > now and self.stopping.wait(deadline - now):
            return False
        now = time.monotonic()
        self.previous = now
        self.deadline = (now if now - target > FRAME_SECONDS else target) + FRAME_SECONDS
        return not self.stopping.is_set()
