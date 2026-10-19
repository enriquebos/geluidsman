from __future__ import annotations

import logging
from typing import TYPE_CHECKING

from app.music_sources import GuardedMusicAudio, MusicDecoder

if TYPE_CHECKING:
    import pytest


def decoder(seconds: float) -> MusicDecoder:
    return MusicDecoder(
        f"sine=frequency=440:sample_rate=48000:duration={seconds}",
        before_options="-f lavfi",
        options="-vn",
    )


def test_stopping_buffered_music_requests_decoder_cleanup_without_a_failure(caplog: pytest.LogCaptureFixture) -> None:
    source = decoder(60)
    process = source._process
    audio = GuardedMusicAudio(source, None, {"duration": 60}, (0, 1))
    try:
        assert audio.read()
        assert process.poll() is None
    finally:
        with caplog.at_level(logging.INFO):
            audio.cleanup()
            assert audio.done.wait(3)
    assert process.wait(timeout=3) != 0
    assert source.music_error is None
    assert source._current_error is None
    assert "outcome=requested_stop exit_before_cleanup=None" in caplog.text
    assert "terminated" in caplog.text


def test_natural_decoder_eof_is_reported_as_completed(caplog: pytest.LogCaptureFixture) -> None:
    source = decoder(0.2)
    try:
        frames = 0
        while source.read():
            frames += 1
        assert frames == 10
        assert source._process.wait(timeout=3) == 0
        assert source.music_error is None
    finally:
        with caplog.at_level(logging.INFO):
            source.cleanup()
    assert "outcome=completed exit_before_cleanup=0" in caplog.text


def test_decoder_killed_before_cleanup_retains_unexpected_exit_failure(caplog: pytest.LogCaptureFixture) -> None:
    source = decoder(60)
    try:
        assert source.read()
        source._process.kill()
        code = source._process.wait(timeout=3)
        while source.read():
            pass
        assert source.music_error is not None
        assert source.music_error.details == {"reason": "decoder_exit", "decoder_exit": code}
        assert source._current_error is source.music_error
    finally:
        source.cleanup()
    assert "outcome=unexpected_exit" in caplog.text
