from __future__ import annotations

import logging
from collections import deque
from types import SimpleNamespace
from unittest.mock import Mock, patch

import discord
import pytest

from app.discord_voice import VoiceRecvClient
from app.music_transport import MusicAudioPlayer, MusicTiming


class Frames(discord.AudioSource):
    def __init__(self, frames: int) -> None:
        self.frames = frames

    def read(self) -> bytes:
        if not self.frames:
            return b""
        self.frames -= 1
        return b"pcm"


def test_single_clock_paces_encoded_packets_despite_encoder_and_timer_jitter() -> None:
    now = 0.0
    sent = []
    costs = deque([0.001, 0.007, 0.002, 0.009] * 125)

    def encode(data: bytes, samples: int) -> bytes:
        nonlocal now
        assert data == b"pcm"
        assert samples == 960
        now += costs.popleft()
        return b"opus"

    def send(data: bytes, *, encode: bool) -> None:
        assert not encode
        if data == b"opus":
            sent.append(now)

    voice = SimpleNamespace(
        encoder=SimpleNamespace(encode=encode, SAMPLES_PER_FRAME=960),
        send_audio_packet=send,
        is_connected=lambda: True,
    )
    source = Frames(500)
    player = MusicAudioPlayer(source, voice)

    def wait(seconds: float) -> bool:
        nonlocal now
        now += seconds + 0.002
        return False

    with (
        patch("app.music_clock.time.monotonic", new=lambda: now),
        patch.object(player._end, "wait", new=wait),
        patch.object(player, "_speak"),
        patch("discord.player.time.sleep") as native_wait,
    ):
        player._do_run()
    assert len(sent) == 500
    assert sent[-1] - sent[0] == pytest.approx(9.98, abs=0.003)
    assert player.timing.frames == 500
    assert player.timing.late_frames == 0
    assert player.timing.encoder_stalls == 0
    assert source.music_timing is player.timing
    native_wait.assert_not_called()


def test_cancelling_during_packet_wait_does_not_send_stale_audio() -> None:
    voice = Mock()
    voice.encoder.encode.return_value = b"opus"
    voice.is_connected.return_value = True
    player = MusicAudioPlayer(Frames(4), voice)

    def cancel(_seconds: float) -> bool:
        player._end.set()
        return True

    with patch.object(player._end, "wait", side_effect=cancel), patch.object(player, "_speak"):
        player._do_run()
    packets = [call for call in voice.send_audio_packet.call_args_list if call.args[0] == b"opus"]
    assert len(packets) == 1


@pytest.mark.parametrize("send_seconds", [0.0053, 0.010])
def test_full_sender_retains_song_duration_with_encoding_and_packet_processing(send_seconds: float) -> None:
    now = 0.0
    sent = []

    def encode(data: bytes, samples: int) -> bytes:
        nonlocal now
        assert data == b"pcm"
        assert samples == 960
        now += 0.003
        return b"opus"

    def send(data: bytes, *, encode: bool) -> None:
        nonlocal now
        assert not encode
        if data == b"opus":
            now += send_seconds
            sent.append(now)

    voice = SimpleNamespace(
        encoder=SimpleNamespace(encode=encode, SAMPLES_PER_FRAME=960),
        send_audio_packet=send,
        is_connected=lambda: True,
    )
    player = MusicAudioPlayer(Frames(180_000), voice)

    def wait(seconds: float) -> bool:
        nonlocal now
        now += seconds + 0.001
        return False

    with (
        patch("app.music_clock.time.monotonic", new=lambda: now),
        patch.object(player._end, "wait", new=wait),
        patch.object(player, "_speak"),
    ):
        player._do_run()
    assert len(sent) == 180_000
    assert sent[-1] - sent[0] == pytest.approx(3599.98, abs=0.002)
    assert player.timing.late_frames == 0
    assert player.timing.encoder_stalls == 0
    assert player.timing.send_stalls == 0


def test_stopping_after_connection_failure_does_not_consume_another_frame() -> None:
    voice = Mock()
    voice.is_connected.return_value = False
    voice.wait_until_connected.return_value = False
    source = Frames(4)
    player = MusicAudioPlayer(source, voice)
    with patch.object(player, "_speak"):
        player._do_run()
    assert source.frames == 4
    voice.send_audio_packet.assert_not_called()


def test_music_voice_client_keeps_default_soundboard_play_and_configures_music_encoder() -> None:
    voice = VoiceRecvClient.__new__(VoiceRecvClient)
    voice.is_connected = lambda: True
    voice.is_playing = lambda: False
    source = Frames(1)
    after = Mock()
    with (
        patch("app.discord_voice.discord.opus.Encoder") as encoder,
        patch("app.discord_voice.MusicAudioPlayer") as sender,
    ):
        voice.play_music(source, after=after)
    encoder.assert_called_once_with(bitrate=384, signal_type="music")
    sender.assert_called_once_with(source, voice, after=after)
    sender.return_value.start.assert_called_once()
    assert VoiceRecvClient.play is discord.VoiceClient.play


def test_delivery_warnings_are_coalesced_and_include_only_numeric_counters(caplog: pytest.LogCaptureFixture) -> None:
    timing = MusicTiming()
    timing.encoded(0.03)
    timing.sent(1, 0.001)
    timing.sent(1.1, 0.025)
    timing.report(4)
    timing.report(4)
    assert len(caplog.records) == 1
    assert "late_frames=1" in caplog.text
    assert "encoder_stalls=1" in caplog.text
    assert "send_stalls=1" in caplog.text
    assert "decoder_silence_frames=4" in caplog.text
    assert "longest_gap_ms=100.0" in caplog.text


def test_healthy_timing_reports_actual_rate_and_processing_cost_at_most_once_per_minute(
    caplog: pytest.LogCaptureFixture,
) -> None:
    timing = MusicTiming()
    with caplog.at_level(logging.INFO, logger="app.music"):
        for frame in range(751):
            timing.encoded(0.003)
            timing.sent(frame * 0.02, 0.0053)
        timing.report(0)
        timing.report(0)
        assert len(caplog.records) == 1
        assert "rate_fps=50.00" in caplog.text
        assert "mean_encode_ms=3.00" in caplog.text
        assert "mean_send_ms=5.30" in caplog.text
        for frame in range(751, 3752):
            timing.encoded(0.003)
            timing.sent(frame * 0.02, 0.0053)
        timing.report(0)
        assert len(caplog.records) == 2
        assert all(record.levelno == logging.INFO for record in caplog.records)


def test_sustained_slow_delivery_warns_even_without_individually_slow_frames(caplog: pytest.LogCaptureFixture) -> None:
    timing = MusicTiming()
    for frame in range(3000):
        timing.encoded(0.003)
        timing.sent(frame * 0.0223, 0.0053)
    timing.report(0)
    timing.report(0)
    assert len(caplog.records) == 1
    assert caplog.records[0].levelno == logging.WARNING
    assert "rate_fps=44.84" in caplog.text
    assert "late_frames=0" in caplog.text
    assert "send_stalls=0" in caplog.text
    assert "decoder_silence_frames=0" in caplog.text


def test_delivery_rate_excludes_native_pause_and_reconnection_waiting(caplog: pytest.LogCaptureFixture) -> None:
    timing = MusicTiming()
    timing.sent(1, 0.001)
    timing.sent(1.02, 0.001)
    timing.previous = None
    timing.sent(21, 0.001)
    timing.sent(21.02, 0.001)
    with caplog.at_level(logging.INFO, logger="app.music"):
        timing.report(0)
    assert "rate_fps=50.00" in caplog.text
    assert "elapsed_s=0.040" in caplog.text
