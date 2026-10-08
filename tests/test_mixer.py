from __future__ import annotations

import wave
from typing import TYPE_CHECKING

import numpy as np
import pytest

from app.mixer import FRAME_BYTES, SILENCE, CapacityError, Mixer

if TYPE_CHECKING:
    from pathlib import Path

    from app.types import JsonObject


def audio_file(tmp_path: Path, value: int = 1000, frames: int = 960) -> Path:
    file = tmp_path / f"{value}-{frames}.wav"
    with wave.open(str(file), "wb") as writer:
        writer.setparams((2, 2, 48000, frames, "NONE", "not compressed"))
        writer.writeframes(np.full(frames * 2, value, dtype="<i2").tobytes())
    return file


def clip(volume: float = 1) -> JsonObject:
    return {"id": "clip", "name": "Test", "volume": volume}


def test_overlap_timing_and_saturation(tmp_path: Path) -> None:
    mixer = Mixer(volume=0.5)
    path = audio_file(tmp_path, 30000, 1920)
    mixer.add(path, clip(2))
    mixer.add(path, clip(2))
    first = mixer.read()
    assert len(first) == FRAME_BYTES
    assert np.all(np.frombuffer(first, dtype="<i2") == 32767)
    assert mixer.snapshot()[0]["position"] == pytest.approx(0.02)
    mixer.read()
    assert mixer.read() == SILENCE
    assert mixer.snapshot() == []


def test_individual_stop_capacity_and_handles(tmp_path: Path) -> None:
    mixer = Mixer(limit=2)
    path = audio_file(tmp_path)
    first = mixer.add(path, clip())
    mixer.add(path, clip())
    readers = [s["reader"] for s in mixer.streams.values()]
    with pytest.raises(CapacityError):
        mixer.add(path, clip())
    mixer.stop(first)
    assert len(mixer.snapshot()) == 1
    assert readers[0]._file is None
    assert np.all(np.frombuffer(mixer.read(), dtype="<i2") == 1000)
    mixer.cleanup()
    assert readers[1]._file is None
    assert mixer.read() == b""


def test_partial_frame_and_gain(tmp_path: Path) -> None:
    mixer = Mixer(volume=0.5)
    mixer.add(audio_file(tmp_path, -2000, 100), clip(0.5))
    samples = np.frombuffer(mixer.read(), dtype="<i2")
    assert len(samples) == 1920
    assert np.all(samples[:200] == -500)
    assert np.all(samples[200:] == 0)
    mixer.stop()
    assert mixer.read() == SILENCE
