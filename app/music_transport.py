from __future__ import annotations

import logging
import time
from typing import TYPE_CHECKING

from discord.enums import SpeakingState
from discord.player import AudioPlayer

from app.music_buffer import FRAME_SECONDS
from app.music_clock import MusicClock

if TYPE_CHECKING:
    from collections.abc import Callable

    import discord

TIMING_HEARTBEAT_SECONDS = 60
MIN_HEALTH_FRAMES = 500
MIN_HEALTH_RATE = 49.5


class MusicTiming:
    def __init__(self) -> None:
        self.frames = 0
        self.previous: float | None = None
        self.late_frames = 0
        self.encoder_stalls = 0
        self.send_stalls = 0
        self.longest_gap = 0.0
        self.encoder_seconds = 0.0
        self.send_seconds = 0.0
        self.active_seconds = 0.0
        self.intervals = 0
        self.reported = (0, 0, 0, 0)
        self.reported_frames = 0
        self.reported_seconds = 0.0

    def encoded(self, seconds: float) -> None:
        self.encoder_seconds += seconds
        if seconds > FRAME_SECONDS:
            self.encoder_stalls += 1

    def sent(self, now: float, seconds: float) -> None:
        if self.previous is not None:
            gap = now - self.previous
            self.active_seconds += gap
            self.intervals += 1
            self.longest_gap = max(self.longest_gap, gap)
            if gap > FRAME_SECONDS * 2:
                self.late_frames += 1
        self.previous = now
        self.frames += 1
        self.send_seconds += seconds
        if seconds > FRAME_SECONDS:
            self.send_stalls += 1

    def report(self, silence: int) -> None:
        counters = self.late_frames, self.encoder_stalls, self.send_stalls, silence
        changed = counters != self.reported
        frames, seconds = self.frames, self.active_seconds
        if not frames or (
            not changed and self.reported_frames and seconds - self.reported_seconds < TIMING_HEARTBEAT_SECONDS
        ):
            return
        rate = self.intervals / seconds if seconds > 0 else 1 / FRAME_SECONDS
        slow = frames >= MIN_HEALTH_FRAMES and rate < MIN_HEALTH_RATE
        self.reported = counters
        self.reported_frames = frames
        self.reported_seconds = seconds
        logging.getLogger("app.music").log(
            logging.WARNING if changed or slow else logging.INFO,
            "Music delivery timing: sent_frames=%d late_frames=%d encoder_stalls=%d send_stalls=%d "
            "decoder_silence_frames=%d longest_gap_ms=%.1f rate_fps=%.2f elapsed_s=%.3f "
            "mean_encode_ms=%.2f mean_send_ms=%.2f",
            frames,
            self.late_frames,
            self.encoder_stalls,
            self.send_stalls,
            silence,
            self.longest_gap * 1000,
            rate,
            seconds,
            self.encoder_seconds / frames * 1000,
            self.send_seconds / frames * 1000,
        )


class MusicAudioPlayer(AudioPlayer):
    def __init__(
        self,
        source: discord.AudioSource,
        client: discord.VoiceClient,
        *,
        after: Callable[[Exception | None], None] | None = None,
    ) -> None:
        super().__init__(source, client, after=after)
        self.clock = MusicClock(self._end)
        self.timing = MusicTiming()
        source.music_timing = self.timing

    def ready(self) -> bool:
        if not self._resumed.is_set():
            self.send_silence()
            self._resumed.wait()
            self.clock = MusicClock(self._end)
            self.timing.previous = None
        if self._end.is_set():
            return False
        if not self.client.is_connected():
            if not self.client.wait_until_connected(self.client.timeout) or self._end.is_set():
                return False
            self._speak(SpeakingState.voice)
            self.clock = MusicClock(self._end)
            self.timing.previous = None
        return True

    def _do_run(self) -> None:
        self._speak(SpeakingState.voice)
        while not self._end.is_set() and self.ready():
            data = self.source.read()
            if not data:
                self._current_error = self._current_error or getattr(self.source, "_current_error", None)
                self.stop()
                break
            if not self.source.is_opus():
                started = time.monotonic()
                data = self.client.encoder.encode(data, self.client.encoder.SAMPLES_PER_FRAME)
                self.timing.encoded(time.monotonic() - started)
            if not self.ready() or not self.clock.wait():
                break
            started = time.monotonic()
            self.client.send_audio_packet(data, encode=False)
            finished = time.monotonic()
            self.clock.packet_sent(started, finished)
            self.timing.sent(finished, finished - started)
        if self.client.is_connected():
            self.send_silence()
