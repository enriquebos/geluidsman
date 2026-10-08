from __future__ import annotations

import asyncio
import threading
import time
from typing import TYPE_CHECKING
from unittest.mock import AsyncMock, Mock

import pytest
from fastapi import HTTPException

from app.config import Settings
from app.db import Database
from app.events import Events
from app.media import Media, MediaError
from tests.test_auth import client as auth_fixture
from tests.test_auth import login

if TYPE_CHECKING:
    from collections.abc import Iterator
    from pathlib import Path

    from fastapi.testclient import TestClient


@pytest.fixture
def client(tmp_path: Path) -> Iterator[TestClient]:
    yield from auth_fixture.__wrapped__(tmp_path)


def test_library_and_job_queries_are_bounded(tmp_path: Path) -> None:
    db = Database(tmp_path / "library.sqlite3")
    for index in range(80):
        db.save_source(
            {
                "id": str(index),
                "url": "https://example.com",
                "title": f"Video {index}",
                "duration": 10,
                "media_id": str(index),
            },
            [{"language": "nl", "kind": "manual", "status": "ready", "cues": []}],
        )
        job_id = db.add_job("https://example.com")
        db.execute("UPDATE jobs SET source_id=? WHERE id=?", (str(index), job_id))
    queries = []
    db.conn.set_trace_callback(queries.append)
    assert len(db.sources()) == 80
    assert len(queries) == 2
    queries.clear()
    jobs = db.jobs()
    assert len(jobs) == 50
    assert all(job["title"].startswith("Video ") for job in jobs)
    assert len(queries) == 1
    db.close()


def test_media_summary_coalesces_off_thread_and_limits_remain_fresh(tmp_path: Path) -> None:
    db = Database(tmp_path / "library.sqlite3")
    media = Media(Settings(_env_file=None, data_dir=tmp_path), db, Events())
    thread_ids = []
    original = media.used_bytes

    def scan() -> int:
        thread_ids.append(threading.get_ident())
        return original()

    media.used_bytes = scan
    media.dependencies = Mock(return_value=[])

    async def check() -> None:
        results = await asyncio.gather(*(media.summary() for _ in range(8)))
        assert all(result["used_bytes"] == 0 for result in results)
        assert len(thread_ids) == 1
        assert thread_ids[0] != threading.get_ident()
        (media.root / "added").write_bytes(bytes(100))
        assert media.used_bytes() == 100
        assert (await media.summary())["used_bytes"] == 0
        media.summary_until = 0
        assert (await media.summary())["used_bytes"] == 100

    asyncio.run(check())
    db.close()


@pytest.mark.parametrize("change", ["revision", "deleted", "duration"])
def test_queued_extraction_rechecks_source(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, change: str) -> None:
    db = Database(tmp_path / "library.sqlite3")
    media = Media(Settings(_env_file=None, data_dir=tmp_path), db, Events())
    db.save_source(
        {"id": "source", "url": "https://example.com", "title": "Video", "duration": 10, "media_id": "old"}, []
    )
    source = db.sources()[0]
    calls = []

    async def process(args: list) -> bytes:
        calls.append([str(argument) for argument in args])
        return b""

    monkeypatch.setattr("app.media.process", process)

    async def check() -> None:
        await media.lock.acquire()
        task = asyncio.create_task(
            media.create_clip(source, {"name": "Sound", "emoji": "", "tags": [], "volume": 1, "start": 0, "end": 2})
        )
        await asyncio.sleep(0)
        if change == "deleted":
            db.execute("DELETE FROM sources WHERE id='source'")
        elif change == "duration":
            db.execute("UPDATE sources SET duration=1 WHERE id='source'")
        else:
            db.execute("UPDATE sources SET media_id='new' WHERE id='source'")
        media.lock.release()
        if change == "revision":
            await task
            assert str(media.root / "new" / "audio.m4a") in calls[0]
            assert len(db.clips()) == 1
        else:
            with pytest.raises(MediaError, match=r"deleted|changed"):
                await task
            assert not calls
            assert not db.clips()

    asyncio.run(check())
    db.close()


def test_authenticated_requests_avoid_repeated_session_writes(client: TestClient) -> None:
    login(client)
    db = client.app.state.db
    queries = []
    db.conn.set_trace_callback(queries.append)
    for _ in range(4):
        assert client.get("/api/auth/me").status_code == 200
    assert not any("UPDATE sessions SET last_seen" in query for query in queries)
    db.execute("UPDATE sessions SET last_seen=?", (time.time() - 61,))
    queries.clear()
    assert client.get("/api/auth/me").status_code == 200
    assert sum("UPDATE sessions SET last_seen" in query for query in queries) == 1
    assert client.get("/api/jobs").status_code == 200


def test_channel_summary_queries_are_bounded(tmp_path: Path) -> None:
    db = Database(tmp_path / "library.sqlite3")
    for index in range(20):
        db.execute(
            "INSERT INTO channel_batches(id,url,title,status,created_at) VALUES (?,?,?,?,?)",
            (str(index), "https://example.com", "Channel", "paused", index),
        )
        db.execute(
            "INSERT INTO channel_items(batch_id,url,title,status) VALUES (?,?,?,?)",
            (str(index), "https://example.com/video", "Current video", "importing"),
        )
    queries = []
    db.conn.set_trace_callback(queries.append)
    batches = db.batches()
    assert len(queries) == 3
    assert len(batches) == 20
    assert all(batch["total"] == 1 and batch["counts"] == {"importing": 1} for batch in batches)
    assert all(batch["current"]["title"] == "Current video" for batch in batches)
    db.close()


def test_events_retry_temporary_auth_failure_without_logout(monkeypatch: pytest.MonkeyPatch) -> None:
    events = Events()
    request = Mock()
    request.is_disconnected = AsyncMock(return_value=False)
    request.app.state.auth.current = AsyncMock(
        side_effect=[HTTPException(503, "Temporary outage"), {}, HTTPException(401)]
    )
    monkeypatch.setattr("app.events.asyncio.sleep", AsyncMock())

    async def check() -> None:
        stream = events.stream(request)
        assert "event: refresh" in await anext(stream)
        events.publish("playback")
        assert "temporarily unavailable" in await anext(stream)
        assert "event: playback" in await anext(stream)
        assert "auth-required" in await anext(stream)
        await stream.aclose()
        assert not events.clients

    asyncio.run(check())
