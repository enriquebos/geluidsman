from __future__ import annotations

import asyncio
import contextlib
import json
import math
import os
import re
import wave
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from collections.abc import Sequence
    from pathlib import Path

TARGET_LOUDNESS = -16.0
TARGET_TRUE_PEAK = -2.0
MAX_GAIN = 24.0
SHORT_SOUND_RMS = -19.0


class MediaError(ValueError):
    pass


async def process(
    args: Sequence[str | Path | float],
    deadline_seconds: float = 300,
    *,
    stderr: bool = False,
    low_priority: bool = False,
) -> bytes:
    creationflags = 0x08000000 if os.name == "nt" else 0
    if low_priority and os.name == "nt":
        creationflags |= 0x00004000
    proc = await asyncio.create_subprocess_exec(
        *map(str, args), stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, creationflags=creationflags
    )
    try:
        if low_priority and hasattr(os, "setpriority"):
            with contextlib.suppress(OSError):
                os.setpriority(os.PRIO_PROCESS, proc.pid, 10)
        out, errors = await asyncio.wait_for(proc.communicate(), deadline_seconds)
    except BaseException:
        if proc.returncode is None:
            proc.kill()
        await proc.communicate()
        raise
    if proc.returncode:
        message = "Media processing failed. The source may be corrupt or unsupported."
        raise MediaError(message)
    return errors if stderr else out


def ffmpeg_command(executable: str, *args: str | Path | float) -> list[str | Path | float]:
    return [executable, "-hide_banner", "-nostdin", "-y", "-protocol_whitelist", "file,pipe", *args]


def loudness_measurement(report: bytes) -> dict:
    try:
        text = report.decode("utf8")
        values, _ = json.JSONDecoder().raw_decode(text[text.rindex("{") :])
        loudness, peak = float(values["input_i"]), float(values["input_tp"])
    except (ValueError, KeyError, TypeError, UnicodeError) as error:
        message = "Audio loudness could not be measured."
        raise MediaError(message) from error
    if math.isnan(peak) or peak == math.inf or math.isnan(loudness) or loudness == math.inf:
        message = "Audio loudness measurement is invalid."
        raise MediaError(message)
    loudness_gain = TARGET_LOUDNESS - loudness if math.isfinite(loudness) else MAX_GAIN
    if loudness == -math.inf:
        rms_levels = re.findall(r"RMS level dB:\s*(-?\d+(?:\.\d+)?|-inf)", text)
        if rms_levels and math.isfinite(rms := float(rms_levels[-1])):
            loudness_gain = SHORT_SOUND_RMS - rms
    return {
        "integrated_lufs": loudness if math.isfinite(loudness) else None,
        "true_peak_dbfs": peak if math.isfinite(peak) else None,
        "gain_db": 0.0 if peak == -math.inf else min(loudness_gain, TARGET_TRUE_PEAK - peak, MAX_GAIN),
    }


def normalization_gain(report: bytes) -> float:
    return loudness_measurement(report)["gain_db"]


async def measure_gain(source: Path, executable: str) -> float:
    return (await measure_loudness(source, executable))["gain_db"]


async def measure_loudness(source: Path, executable: str, *, music: bool = False) -> dict:
    report = await process(
        ffmpeg_command(
            executable,
            "-loglevel",
            "info",
            "-nostats",
            "-xerror",
            "-threads",
            "1",
            "-filter_threads",
            "1",
            "-i",
            source,
            "-map",
            "0:a:0",
            "-af",
            ("aformat=sample_rates=48000:channel_layouts=stereo," if music else "")
            + "astats=measure_perchannel=none:measure_overall=RMS_level:reset=0,"
            "loudnorm=I=-16:TP=-2:LRA=11:print_format=json",
            "-f",
            "null",
            "-",
        ),
        stderr=True,
        low_priority=music,
    )
    return loudness_measurement(report)


def audio_frames(path: Path) -> int:
    with wave.open(str(path), "rb") as reader:
        if (reader.getframerate(), reader.getnchannels(), reader.getsampwidth()) != (48000, 2, 2):
            message = "Normalized audio must be 48 kHz stereo PCM."
            raise MediaError(message)
        return reader.getnframes()


async def normalize_sound(source: Path, destination: Path, executable: str) -> float:
    frames = await asyncio.to_thread(audio_frames, source)
    gain = await measure_gain(source, executable)
    await process(
        ffmpeg_command(
            executable,
            "-loglevel",
            "error",
            "-i",
            source,
            "-map",
            "0:a:0",
            "-af",
            f"volume={gain:.6f}dB",
            "-ac",
            "2",
            "-ar",
            "48000",
            "-c:a",
            "pcm_s16le",
            destination,
        )
    )
    if await asyncio.to_thread(audio_frames, destination) != frames:
        message = "Normalization changed the sound duration."
        raise MediaError(message)
    return gain
