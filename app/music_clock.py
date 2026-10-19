from __future__ import annotations

import time
from typing import TYPE_CHECKING

from app.music_buffer import FRAME_SECONDS

if TYPE_CHECKING:
    from threading import Event

MIN_FRAME_INTERVAL = FRAME_SECONDS / 4
STALL_COOLDOWN = FRAME_SECONDS * 0.85


class MusicClock:
    def __init__(self, stopping: Event) -> None:
        self.stopping = stopping
        self.deadline: float | None = None
        self.previous: float | None = None
        self.minimum_interval = MIN_FRAME_INTERVAL
        self.wait_seconds = 0.0
        self.oversleep = 0.0
        self.lateness = 0.0
        self.rebased = 0.0

    def packet_sent(self, started: float, finished: float) -> None:
        stalled = finished - started > FRAME_SECONDS
        self.previous = finished if stalled else started
        self.minimum_interval = STALL_COOLDOWN if stalled else MIN_FRAME_INTERVAL

    def wait(self) -> bool:
        now = time.monotonic()
        target = self.deadline if self.deadline is not None else now
        deadline = target
        if self.previous is not None:
            deadline = max(deadline, self.previous + self.minimum_interval)
        self.wait_seconds = max(0.0, deadline - now)
        self.oversleep = self.lateness = self.rebased = 0.0
        if self.wait_seconds and self.stopping.wait(self.wait_seconds):
            return False
        now = time.monotonic()
        if self.wait_seconds:
            self.oversleep = max(0.0, now - deadline)
        self.lateness = max(0.0, now - target)
        if self.lateness > FRAME_SECONDS:
            self.rebased = self.lateness
        self.previous = now
        self.deadline = (now if self.rebased else target) + FRAME_SECONDS
        return not self.stopping.is_set()
