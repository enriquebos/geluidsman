from __future__ import annotations

import asyncio
import json
import shutil
import wave
from typing import TYPE_CHECKING

import numpy as np
import pytest

from app.audio_processing import MediaError, audio_frames, measure_gain, normalization_gain, normalize_sound

if TYPE_CHECKING:
    from pathlib import Path


def report(loudness: str, peak: str) -> bytes:
    return b"FFmpeg diagnostics\n" + json.dumps({"input_i": loudness, "input_tp": peak}).encode()


@pytest.mark.parametrize(
    ("loudness", "peak", "expected"),
    [
        ("-30", "-20", 14),
        ("-10", "-1", -6),
        ("-30", "-3", 1),
        ("-60", "-50", 24),
        ("-inf", "-inf", 0),
        ("-inf", "-10", 8),
    ],
)
def test_loudness_gain_and_peak_headroom(loudness: str, peak: str, expected: float) -> None:
    assert normalization_gain(report(loudness, peak)) == expected


@pytest.mark.parametrize("value", [b"", b"{}", b"{bad", report("nan", "-10"), report("-20", "inf")])
def test_invalid_measurement_is_rejected(value: bytes) -> None:
    with pytest.raises(MediaError, match="loudness"):
        normalization_gain(value)


def test_short_sound_uses_rms_instead_of_peak_only_boost() -> None:
    assert normalization_gain(report("-inf", "-20") + b"\nRMS level dB: -23") == 4


def write_sound(path: Path, amplitude: float, seconds: float = 1) -> None:
    samples = np.sin(np.arange(int(seconds * 48000)) * 2 * np.pi * 440 / 48000) * amplitude * 32767
    stereo = np.repeat(samples.astype("<i2")[:, None], 2, axis=1)
    with wave.open(str(path), "wb") as writer:
        writer.setparams((2, 2, 48000, 0, "NONE", "not compressed"))
        writer.writeframes(stereo.tobytes())


@pytest.mark.parametrize(("amplitude", "seconds"), [(0.02, 1), (0.8, 1), (0, 1), (0.1, 0.1)])
def test_normalized_audio_retains_frames_and_stays_peak_safe(tmp_path: Path, amplitude: float, seconds: float) -> None:
    source, output = tmp_path / "original.wav", tmp_path / "normalized.wav"
    write_sound(source, amplitude, seconds)
    executable = shutil.which("ffmpeg")
    assert executable
    asyncio.run(normalize_sound(source, output, executable))
    assert audio_frames(source) == audio_frames(output)
    with wave.open(str(output), "rb") as reader:
        samples = np.frombuffer(reader.readframes(reader.getnframes()), dtype="<i2")
    assert np.max(np.abs(samples.astype(np.int32))) <= 26030
    if amplitude and seconds >= 1:
        assert abs(asyncio.run(measure_gain(output, executable))) < 0.1
    if not amplitude:
        assert not np.any(samples)
