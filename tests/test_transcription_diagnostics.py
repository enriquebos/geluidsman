from __future__ import annotations

import asyncio
import logging
import time
from unittest.mock import AsyncMock, MagicMock, Mock

import aiohttp
import pytest

from app.conversation import DROP_REPORT_SECONDS, Conversation
from app.deepgram_transcription import MAX_PACKETS, DeepgramStreams, SpeakerStream
from tests.test_deepgram_transcription import manager


def connection() -> MagicMock:
    value = MagicMock()
    value.__aenter__.return_value = value
    value.__aexit__.return_value = False
    return value


@pytest.mark.parametrize("status", [400, 401, 402, 403, 429, 503])
def test_handshake_failures_report_status_without_provider_content(
    status: int, caplog: pytest.LogCaptureFixture
) -> None:
    async def check() -> None:
        owner = manager()
        streams = DeepgramStreams(owner)
        error = aiohttp.WSServerHandshakeError(
            request_info=Mock(), history=(), status=status, message="private transcript test-key"
        )
        streams.http = Mock(ws_connect=AsyncMock(side_effect=error), close=AsyncMock())
        stream = SpeakerStream(("1", "One", None), "session", time.time())
        streams.streams["1"] = stream
        await streams.run(stream)
        assert f"HTTP {status}" in owner.error
        assert owner.dropped == 1
        assert streams.retry["1"] > time.monotonic()
        assert "private transcript" not in owner.error + caplog.text
        assert "test-key" not in owner.error + caplog.text
        assert not streams.streams
        await streams.close()

    asyncio.run(check())


def test_sender_failure_stops_receiver_promptly(caplog: pytest.LogCaptureFixture) -> None:
    async def check() -> None:
        owner = manager()
        streams = DeepgramStreams(owner)
        socket = connection()
        stopped = asyncio.Event()

        async def wait_for_message(*_args: object, **_kwargs: object) -> None:
            try:
                await asyncio.Event().wait()
            finally:
                stopped.set()

        socket.receive = wait_for_message
        socket.send_bytes = AsyncMock(side_effect=aiohttp.ClientConnectionError("test-key"))
        streams.http = Mock(ws_connect=AsyncMock(return_value=socket), close=AsyncMock())
        streams.feed("session", ("1", "One", None), bytes(3840), time.time())
        task = streams.streams["1"].task
        await asyncio.wait_for(task, 1)
        assert stopped.is_set()
        assert owner.dropped == 1
        assert "ClientConnectionError" in owner.error
        assert "test-key" not in caplog.text
        assert not streams.streams
        await streams.close()

    asyncio.run(check())


def test_abnormal_provider_close_uses_cooldown_and_does_not_log_payload(caplog: pytest.LogCaptureFixture) -> None:
    async def check() -> None:
        owner = manager()
        streams = DeepgramStreams(owner)
        socket = connection()
        socket.receive = AsyncMock(return_value=aiohttp.WSMessage(aiohttp.WSMsgType.CLOSE, 1011, "test-key"))
        socket.send_bytes = AsyncMock()
        streams.http = Mock(ws_connect=AsyncMock(return_value=socket), close=AsyncMock())
        streams.feed("session", ("1", "One", None), bytes(3840), time.time())
        await streams.streams["1"].task
        assert "1011" in owner.error
        assert streams.retry["1"] > time.monotonic()
        assert owner.dropped == 1
        assert "test-key" not in caplog.text
        await streams.close()

    asyncio.run(check())


def test_audio_during_retry_does_not_count_every_packet_as_a_failed_utterance(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def check() -> None:
        owner = manager()
        streams = DeepgramStreams(owner)

        async def wait(_stream: SpeakerStream) -> None:
            await asyncio.Event().wait()

        monkeypatch.setattr(streams, "run", wait)
        for _ in range(MAX_PACKETS + 200):
            streams.feed("session", ("1", "One", None), bytes(3840), time.time())
        assert owner.dropped == 1
        assert streams.retry["1"] > time.monotonic()
        await streams.close()
        assert not streams.streams

    asyncio.run(check())


def test_drop_warnings_coalesce_without_losing_counts(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    value = Conversation.__new__(Conversation)
    value.dropped = 1
    value.reported_dropped = 0
    value.last_drop_report = float("-inf")
    clock = Mock(return_value=100)
    monkeypatch.setattr("app.conversation.time.monotonic", clock)
    caplog.set_level(logging.WARNING, logger="app.conversation")
    value.report_drops()
    value.dropped = 500
    clock.return_value = 101
    value.report_drops()
    assert len(caplog.records) == 1
    assert value.reported_dropped == 1
    clock.return_value = 100 + DROP_REPORT_SECONDS
    value.report_drops()
    value.report_drops()
    assert len(caplog.records) == 2
    assert "499 times" in caplog.records[-1].message
    assert "total: 500" in caplog.records[-1].message
    assert value.reported_dropped == 500
