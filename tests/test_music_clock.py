from __future__ import annotations

from itertools import pairwise
from unittest.mock import Mock, patch

import pytest

from app.music_clock import MIN_FRAME_INTERVAL, MusicClock


def test_music_clock_prevents_catch_up_bursts_and_keeps_normal_frame_rate() -> None:
    now = 0.0
    stopping = Mock()
    stopping.is_set.return_value = False

    def wait(delay: float) -> bool:
        nonlocal now
        now += delay
        return False

    stopping.wait.side_effect = wait
    clock = MusicClock(stopping)
    with patch("app.music_clock.time.monotonic", side_effect=lambda: now):
        times = []
        for _ in range(500):
            assert clock.wait()
            times.append(now)
        assert times[-1] == pytest.approx(9.98)
        now += 0.6
        times.clear()
        for _ in range(30):
            assert clock.wait()
            times.append(now)
        assert all(after - before >= MIN_FRAME_INTERVAL - 1e-9 for before, after in pairwise(times))
        assert times[-1] - times[0] == pytest.approx(0.58)


def test_music_clock_stops_waiting_immediately_when_playback_is_cancelled() -> None:
    stopping = Mock()
    stopping.is_set.return_value = False
    stopping.wait.return_value = True
    clock = MusicClock(stopping)
    with patch("app.music_clock.time.monotonic", return_value=1):
        assert clock.wait()
        assert not clock.wait()
    stopping.wait.assert_called_once()


def test_normal_timer_wakeup_jitter_does_not_accumulate_slowdown() -> None:
    now = 0.0
    stopping = Mock()
    stopping.is_set.return_value = False

    def wait(delay: float) -> bool:
        nonlocal now
        now += delay + 0.002
        return False

    stopping.wait.side_effect = wait
    clock = MusicClock(stopping)
    with patch("app.music_clock.time.monotonic", side_effect=lambda: now):
        times = []
        for _ in range(500):
            assert clock.wait()
            times.append(now)
            now += 0.001
    assert times[-1] - times[0] == pytest.approx(9.98, abs=0.003)


def test_slow_packet_send_does_not_allow_an_immediate_following_packet() -> None:
    stopping = Mock()
    stopping.is_set.return_value = False
    stopping.wait.return_value = False
    clock = MusicClock(stopping)
    with patch("app.music_clock.time.monotonic", return_value=0):
        assert clock.wait()
    clock.packet_sent(0, 0.09)
    with patch("app.music_clock.time.monotonic", return_value=0.09):
        assert clock.wait()
    stopping.wait.assert_called_once_with(pytest.approx(MIN_FRAME_INTERVAL))


def test_occasional_timer_lateness_does_not_permanently_shift_the_clock() -> None:
    now = 0.0
    samples = 0
    stopping = Mock()
    stopping.is_set.return_value = False

    def wait(delay: float) -> bool:
        nonlocal now, samples
        samples += 1
        now += delay + (0.005 if samples % 4 == 0 else 0.001)
        return False

    stopping.wait.side_effect = wait
    clock = MusicClock(stopping)
    times = []
    with patch("app.music_clock.time.monotonic", side_effect=lambda: now):
        for _ in range(750):
            assert clock.wait()
            times.append(now)
            clock.packet_sent(now, now)
            now += 0.001
    assert times[-1] - times[0] == pytest.approx(14.98, abs=0.006)
    assert all(after - before >= MIN_FRAME_INTERVAL - 1e-9 for before, after in pairwise(times))


@pytest.mark.parametrize("send_seconds", [0.001, 0.0053, 0.012, 0.019])
def test_packet_processing_within_frame_budget_does_not_slow_the_song(send_seconds: float) -> None:
    now = 0.0
    stopping = Mock()
    stopping.is_set.return_value = False

    def wait(delay: float) -> bool:
        nonlocal now
        now += delay
        return False

    stopping.wait.side_effect = wait
    clock = MusicClock(stopping)
    times = []
    with patch("app.music_clock.time.monotonic", side_effect=lambda: now):
        for _ in range(3000):
            assert clock.wait()
            started = now
            now += send_seconds
            clock.packet_sent(started, now)
            times.append(now)
    assert times[-1] - times[0] == pytest.approx(59.98)
    assert all(after - before >= MIN_FRAME_INTERVAL - 1e-9 for before, after in pairwise(times))
