from __future__ import annotations

import threading
import time
from unittest.mock import patch

import discord
import pytest

from app.music_buffer import MAX_BUFFER_FRAMES, PREBUFFER_FRAMES, SILENCE
from app.music_sources import GuardedMusicAudio, MusicSourceError

FRAME = b"\1\0" * 1920


class StallingAudio(discord.AudioSource):
    def __init__(self, initial: int = PREBUFFER_FRAMES) -> None:
        self.initial = initial
        self.stalled = threading.Event()
        self.release = threading.Event()
        self.resumed = threading.Event()
        self.reads = 0
        self.closed = False

    def read(self) -> bytes:
        self.reads += 1
        if self.initial:
            self.initial -= 1
            return FRAME
        self.stalled.set()
        self.release.wait(3)
        self.resumed.set()
        return b"" if self.closed else FRAME

    def is_opus(self) -> bool:
        return False

    def cleanup(self) -> None:
        self.closed = True
        self.release.set()


def track() -> dict:
    return {"duration": 180, "youtube_id": "aaaaaaaaaaa"}


def test_prebuffer_loads_five_seconds_and_memory_stays_bounded() -> None:
    decoder = StallingAudio(MAX_BUFFER_FRAMES + 10)
    audio = GuardedMusicAudio(decoder, None, track(), (0, 1))
    try:
        audio.check_prepared()
        with audio.buffer.condition:
            assert PREBUFFER_FRAMES <= len(audio.buffer.queue) <= MAX_BUFFER_FRAMES
        deadline = time.monotonic() + 1
        while decoder.reads < MAX_BUFFER_FRAMES and time.monotonic() < deadline:
            audio.buffer.ready.wait(0.001)
        assert decoder.reads == MAX_BUFFER_FRAMES
        assert len(audio.buffer.queue) == MAX_BUFFER_FRAMES
    finally:
        audio.cleanup()
        assert audio.done.wait(3)
        assert not audio.buffer.worker.is_alive()


def test_decoder_stall_never_blocks_voice_or_counts_silence_as_music() -> None:
    decoder = StallingAudio()
    audio = GuardedMusicAudio(decoder, None, track(), (0, 1))
    try:
        assert decoder.stalled.wait(1)
        for _ in range(PREBUFFER_FRAMES):
            assert audio.read() == FRAME
        started = time.monotonic()
        for _ in range(50):
            assert audio.read() == SILENCE
        assert time.monotonic() - started < 0.1
        assert audio.played_seconds == 5
        assert audio.starved_seconds == 1
        decoder.release.set()
        assert decoder.resumed.wait(1)
        with audio.buffer.condition:
            assert audio.buffer.condition.wait_for(lambda: bool(audio.buffer.queue), timeout=1)
        assert audio.read() == FRAME
        assert audio.played_seconds == pytest.approx(5.02)
        audio.volume = 0
        assert audio.read() == SILENCE
        assert audio.played_seconds == pytest.approx(5.04)
    finally:
        audio.cleanup()
        assert audio.done.wait(3)


def test_sustained_stall_reports_safe_timeout_instead_of_blocking_or_speeding_up() -> None:
    decoder = StallingAudio()
    audio = GuardedMusicAudio(decoder, None, track(), (0, 1))
    try:
        assert decoder.stalled.wait(1)
        for _ in range(PREBUFFER_FRAMES):
            audio.read()
        with patch("app.music_buffer.time.monotonic", side_effect=[1, 22]):
            assert audio.read() == SILENCE
            with pytest.raises(MusicSourceError) as failure:
                audio.read()
        assert failure.value.details == {"reason": "buffer_timeout", "youtube_id": "aaaaaaaaaaa"}
    finally:
        audio.cleanup()
        assert audio.done.wait(3)


def test_prebuffer_failure_is_reported_before_voice_playback() -> None:
    decoder = StallingAudio(0)
    decoder.closed = True
    decoder.release.set()
    audio = GuardedMusicAudio(decoder, None, track(), (0, 1))
    try:
        with pytest.raises(MusicSourceError) as failure:
            audio.check_prepared()
        assert failure.value.details["reason"] == "early_eof"
        assert audio.played_seconds == 0
    finally:
        audio.cleanup()
        assert audio.done.wait(3)
