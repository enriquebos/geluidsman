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
SMALL_GAP_SECONDS = 0.021
MEDIUM_GAP_SECONDS = 0.025
LARGE_GAP_SECONDS = 0.030


class MusicTiming:
    def __init__(self) -> None:
        self.frames = 0
        self.previous: float | None = None
        self.late_frames = 0
        self.encoder_stalls = 0
        self.send_stalls = 0
        self.read_stalls = 0
        self.longest_gap = 0.0
        self.read_seconds = 0.0
        self.max_read = 0.0
        self.encoder_seconds = 0.0
        self.send_seconds = 0.0
        self.active_seconds = 0.0
        self.intervals = 0
        self.gaps_over_21ms = 0
        self.gaps_over_25ms = 0
        self.gaps_over_30ms = 0
        self.waits = 0
        self.wait_seconds = 0.0
        self.oversleep_seconds = 0.0
        self.max_oversleep = 0.0
        self.max_lateness = 0.0
        self.rebases = 0
        self.rebased_seconds = 0.0
        self.reported = (0, 0, 0, 0, 0, 0)
        self.reported_frames = 0
        self.reported_seconds = 0.0
        self.reported_intervals = 0

    def read(self, seconds: float) -> None:
        self.read_seconds += seconds
        self.max_read = max(self.max_read, seconds)
        if seconds > FRAME_SECONDS:
            self.read_stalls += 1

    def paced(self, clock: MusicClock) -> None:
        if clock.wait_seconds:
            self.waits += 1
            self.wait_seconds += clock.wait_seconds
            self.oversleep_seconds += clock.oversleep
            self.max_oversleep = max(self.max_oversleep, clock.oversleep)
        self.max_lateness = max(self.max_lateness, clock.lateness)
        if clock.rebased:
            self.rebases += 1
            self.rebased_seconds += clock.rebased

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
            self.gaps_over_21ms += gap > SMALL_GAP_SECONDS
            self.gaps_over_25ms += gap > MEDIUM_GAP_SECONDS
            self.gaps_over_30ms += gap > LARGE_GAP_SECONDS
            if gap > FRAME_SECONDS * 2:
                self.late_frames += 1
        self.previous = now
        self.frames += 1
        self.send_seconds += seconds
        if seconds > FRAME_SECONDS:
            self.send_stalls += 1

    def report(self, silence: int) -> None:
        counters = self.late_frames, self.encoder_stalls, self.send_stalls, silence, self.read_stalls, self.rebases
        changed = counters != self.reported
        frames, seconds = self.frames, self.active_seconds
        if not frames or (
            not changed and self.reported_frames and seconds - self.reported_seconds < TIMING_HEARTBEAT_SECONDS
        ):
            return
        rate = self.intervals / seconds if seconds > 0 else 1 / FRAME_SECONDS
        window_seconds = seconds - self.reported_seconds
        window_intervals = self.intervals - self.reported_intervals
        window_rate = window_intervals / window_seconds if window_seconds > 0 else rate
        slow = (frames >= MIN_HEALTH_FRAMES and rate < MIN_HEALTH_RATE) or (
            window_intervals >= MIN_HEALTH_FRAMES and window_rate < MIN_HEALTH_RATE
        )
        self.reported = counters
        self.reported_frames = frames
        self.reported_seconds = seconds
        self.reported_intervals = self.intervals
        logging.getLogger("app.music").log(
            logging.WARNING if changed or slow else logging.INFO,
            "Music local send timing: sent_frames=%d late_frames=%d encoder_stalls=%d send_stalls=%d "
            "decoder_silence_frames=%d longest_gap_ms=%.1f rate_fps=%.2f elapsed_s=%.3f "
            "mean_encode_ms=%.2f mean_send_ms=%.2f window_rate_fps=%.2f drift_ms=%.1f "
            "gaps_over_21ms=%d gaps_over_25ms=%d gaps_over_30ms=%d "
            "read_stalls=%d mean_read_ms=%.2f max_read_ms=%.2f waits=%d mean_wait_ms=%.2f "
            "mean_oversleep_ms=%.2f max_oversleep_ms=%.2f max_lateness_ms=%.2f clock_rebases=%d rebase_ms=%.1f",
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
            window_rate,
            (seconds - self.intervals * FRAME_SECONDS) * 1000,
            self.gaps_over_21ms,
            self.gaps_over_25ms,
            self.gaps_over_30ms,
            self.read_stalls,
            self.read_seconds / frames * 1000,
            self.max_read * 1000,
            self.waits,
            self.wait_seconds / max(1, self.waits) * 1000,
            self.oversleep_seconds / max(1, self.waits) * 1000,
            self.max_oversleep * 1000,
            self.max_lateness * 1000,
            self.rebases,
            self.rebased_seconds * 1000,
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
            started = time.monotonic()
            data = self.source.read()
            if not data:
                self._current_error = self._current_error or getattr(self.source, "_current_error", None)
                self.stop()
                break
            self.timing.read(time.monotonic() - started)
            if not self.source.is_opus():
                started = time.monotonic()
                data = self.client.encoder.encode(data, self.client.encoder.SAMPLES_PER_FRAME)
                self.timing.encoded(time.monotonic() - started)
            if not self.ready() or not self.clock.wait():
                break
            self.timing.paced(self.clock)
            started = time.monotonic()
            self.client.send_audio_packet(data, encode=False)
            finished = time.monotonic()
            self.clock.packet_sent(started, finished)
            self.timing.sent(finished, finished - started)
        if self.client.is_connected():
            self.send_silence()
