from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import TYPE_CHECKING

import numpy as np
import webrtcvad
from discord.ext import voice_recv

if TYPE_CHECKING:
    from collections.abc import Callable

    from discord import Member, User

MAX_CHUNK_SECONDS = 5
SILENCE_SECONDS = 0.4
MAX_SPEAKERS = 64
SAMPLE_RATE = 16000
VAD_FRAME_BYTES = 640
RESAMPLE_FACTOR = 3
FILTER_TAPS = 31
PRE_ROLL_SECONDS = 0.2
PRE_ROLL_BYTES = int(SAMPLE_RATE * PRE_ROLL_SECONDS * 2)


@dataclass
class Speech:
    speaker_id: str
    name: str
    avatar: str | None
    started_at: float
    ended_at: float
    pcm: bytes
    id: str = ""


@dataclass
class Buffer:
    name: str
    avatar: str | None
    started_at: float
    last_speech: float
    pieces: list[bytes] = field(default_factory=list)
    samples: int = 0


class Segmenter:
    def __init__(self) -> None:
        self.buffers: dict[str, Buffer] = {}
        self.history: dict[str, np.ndarray] = {}
        self.phases: dict[str, int] = {}
        self.leading: dict[str, bytes] = {}
        self.detectors: dict[str, webrtcvad.Vad] = {}
        self.vad_pending: dict[str, bytes] = {}
        positions = np.arange(FILTER_TAPS) - (FILTER_TAPS - 1) / 2
        kernel = np.sinc(positions / RESAMPLE_FACTOR) * np.hamming(FILTER_TAPS)
        self.kernel = kernel / kernel.sum()

    def resample(self, speaker_id: str, values: np.ndarray) -> np.ndarray:
        history = self.history.get(speaker_id, np.zeros(FILTER_TAPS - 1, dtype=np.float32))
        joined = np.concatenate((history, values))
        self.history[speaker_id] = joined[-(FILTER_TAPS - 1) :]
        phase = self.phases.get(speaker_id, 0)
        filtered = np.convolve(joined, self.kernel, mode="valid")[phase::RESAMPLE_FACTOR]
        self.phases[speaker_id] = (phase - len(values)) % RESAMPLE_FACTOR
        return filtered

    def feed(self, speaker: tuple[str, str, str | None], pcm: bytes, timestamp: float) -> list[Speech]:
        if not pcm or len(pcm) % 4:
            return []
        speaker_id, name, avatar = speaker
        if speaker_id not in self.history and len(self.history) >= MAX_SPEAKERS:
            return []
        mono = np.frombuffer(pcm, dtype=np.int16).reshape(-1, 2).astype(np.float32).mean(axis=1)
        values = self.resample(speaker_id, mono)
        if not len(values):
            return []
        limits = np.iinfo(np.int16)
        audio = np.clip(np.rint(values), limits.min, limits.max).astype(np.int16).tobytes()
        active = self.is_speech(speaker_id, audio)
        buffer = self.buffers.get(speaker_id)
        if buffer is None:
            if not active or len(self.buffers) >= MAX_SPEAKERS:
                self.leading[speaker_id] = (self.leading.get(speaker_id, b"") + audio)[-PRE_ROLL_BYTES:]
                return []
            prefix = self.leading.pop(speaker_id, b"")
            buffer = Buffer(
                name,
                avatar,
                timestamp - len(prefix) / (SAMPLE_RATE * 2),
                timestamp,
                pieces=[prefix] if prefix else [],
                samples=len(prefix) // 2,
            )
            self.buffers[speaker_id] = buffer
        if active:
            buffer.last_speech = timestamp
        buffer.pieces.append(audio)
        buffer.samples += len(values)
        if timestamp - buffer.last_speech >= SILENCE_SECONDS or buffer.samples >= SAMPLE_RATE * MAX_CHUNK_SECONDS:
            return [self.finish(speaker_id)]
        return []

    def is_speech(self, speaker_id: str, audio: bytes) -> bool:
        detector = self.detectors.get(speaker_id)
        if detector is None:
            detector = webrtcvad.Vad(1)
            self.detectors[speaker_id] = detector
        pending = self.vad_pending.get(speaker_id, b"") + audio
        active = False
        while len(pending) >= VAD_FRAME_BYTES:
            active = detector.is_speech(pending[:VAD_FRAME_BYTES], SAMPLE_RATE) or active
            pending = pending[VAD_FRAME_BYTES:]
        self.vad_pending[speaker_id] = pending
        return active

    def finish(self, speaker_id: str) -> Speech:
        buffer = self.buffers.pop(speaker_id)
        return Speech(
            speaker_id, buffer.name, buffer.avatar, buffer.started_at, buffer.last_speech, b"".join(buffer.pieces)
        )

    def flush(self, timestamp: float) -> list[Speech]:
        return [
            self.finish(key)
            for key, buffer in list(self.buffers.items())
            if timestamp - buffer.last_speech >= SILENCE_SECONDS
        ]


class SpeakingSink(voice_recv.AudioSink):
    def __init__(self, speaking: Callable[[Member | User | None, str], None] | None = None) -> None:
        super().__init__()
        self.speaking = speaking

    def wants_opus(self) -> bool:
        return True

    def write(self, _user: Member | User | None, _data: voice_recv.VoiceData) -> None:
        return

    @voice_recv.AudioSink.listener()
    def on_voice_member_speaking_start(self, member: Member | User | None) -> None:
        if self.speaking:
            self.speaking(member, "speaking_start")

    @voice_recv.AudioSink.listener()
    def on_voice_member_speaking_stop(self, member: Member | User | None) -> None:
        if self.speaking:
            self.speaking(member, "speaking_stop")

    def cleanup(self) -> None:
        self.speaking = None


class ReceiveSink(SpeakingSink):
    def __init__(
        self,
        callback: Callable[[tuple[str, str, str | None], bytes, float], None],
        allowed: set[str],
        speaking: Callable[[Member | User | None, str], None] | None = None,
    ) -> None:
        super().__init__(speaking)
        self.callback, self.allowed = callback, allowed

    def wants_opus(self) -> bool:
        return False

    def write(self, user: Member | User | None, data: voice_recv.VoiceData) -> None:
        if user is None or user.bot or str(user.id) not in self.allowed:
            return
        avatar = str(user.display_avatar.url)
        self.callback((str(user.id), user.display_name, avatar), data.pcm, time.time())

    def cleanup(self) -> None:
        super().cleanup()
        self.allowed.clear()
