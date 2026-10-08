from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi.testclient import TestClient
from pydantic import SecretStr

from app.channels import channel_url, video_id
from app.config import Settings
from app.db import Database
from app.download_worker import discover_channel
from app.events import Events
from app.main import create_app
from app.media import Media
from tests.helpers import authenticated_fixture

if TYPE_CHECKING:
    from pathlib import Path


@pytest.mark.parametrize(
    "url",
    [
        "http://127.0.0.1/@KudNL/videos",
        "https://youtube.com.evil/@KudNL/videos",
        "https://www.youtube.com/playlist?list=abc",
        "https://www.youtube.com/watch?v=b0gI0uJ4s2I",
    ],
)
def test_channel_validation(url: str) -> None:
    with pytest.raises(ValueError, match=r"channel|private"):
        channel_url(url)


def test_channel_canonicalization_and_duplicate_identity() -> None:
    assert channel_url("https://youtube.com/@KudNL") == "https://www.youtube.com/@KudNL/videos"
    assert video_id("https://youtu.be/b0gI0uJ4s2I?si=abc") == video_id("https://www.youtube.com/watch?v=b0gI0uJ4s2I")
    assert video_id("https://example.com/watch?v=b0gI0uJ4s2I") is None


def test_discovery_bounds_and_only_canonical_video_destinations() -> None:
    downloader = MagicMock()
    downloader.__enter__.return_value = downloader
    downloader.extract_info.return_value = {
        "title": "Channel",
        "entries": [
            {"id": "aaaaaaaaaaa", "title": "A", "url": "http://127.0.0.1/"},
            {"id": "aaaaaaaaaaa", "title": "A"},
            {"id": "not-valid", "title": "Bad"},
        ],
    }
    with (
        patch("app.download_worker.GuardedDownloader", return_value=downloader),
        patch("app.download_worker.configure_requests"),
        patch("app.download_worker.emit") as emit,
    ):
        discover_channel("https://www.youtube.com/@KudNL/videos", {}, 2)
        assert emit.call_args.args[0]["videos"] == [
            {"url": "https://www.youtube.com/watch?v=aaaaaaaaaaa", "title": "A"}
        ]
        downloader.extract_info.return_value["entries"] = [{"id": "aaaaaaaaaaa"}, {"id": "bbbbbbbbbbb"}]
        with pytest.raises(ValueError, match="MAX_CHANNEL_VIDEOS"):
            discover_channel("https://www.youtube.com/@KudNL/videos", {}, 1)


def test_queue_skip_failure_continuation_and_retry(tmp_path: Path) -> None:
    async def verify() -> None:
        settings = Settings(_env_file=None, discord_token=SecretStr(""), data_dir=tmp_path)
        db = Database(tmp_path / "db.sqlite3")
        db.save_source(
            {
                "id": "old",
                "url": "https://youtu.be/aaaaaaaaaaa",
                "title": "Existing",
                "duration": 10,
                "media_id": "old",
            },
            [],
        )
        media = Media(settings, db, Events())
        videos = [{"url": "https://www.youtube.com/watch?v=" + letter * 11, "title": letter} for letter in "abc"]
        active = 0
        maximum = 0

        async def import_video(job_id: str, url: str) -> None:
            nonlocal active, maximum
            active += 1
            maximum = max(maximum, active)
            await asyncio.sleep(0)
            media.update_job(job_id, "failed" if url.endswith("b" * 11) else "complete")
            active -= 1

        with (
            patch.object(media, "download", new=AsyncMock(return_value={"title": "Kud", "videos": videos})),
            patch.object(media, "import_job", side_effect=import_video),
        ):
            batch_id = media.channels.start("https://www.youtube.com/@KudNL/videos")
            await media.channels.task
        batch = db.batches()[0]
        assert batch["counts"] == {"complete": 1, "failed": 1, "skipped": 1}
        assert batch["status"] == "complete"
        assert maximum == 1
        assert not media.busy

        async def successful(job_id: str, _url: str) -> None:
            media.update_job(job_id, "complete")

        with patch.object(media, "import_job", side_effect=successful):
            media.channels.resume(batch_id)
            await media.channels.task
        assert db.batches()[0]["counts"] == {"complete": 2, "skipped": 1}
        db.close()

    asyncio.run(verify())


def test_pause_cleanup_and_restart_queue_recovery(tmp_path: Path) -> None:
    async def verify() -> None:
        settings = Settings(_env_file=None, discord_token=SecretStr(""), data_dir=tmp_path)
        path = tmp_path / "db.sqlite3"
        db = Database(path)
        media = Media(settings, db, Events())
        with patch.object(media, "download", new=AsyncMock()):
            batch_id = media.channels.start("https://www.youtube.com/@KudNL/videos")
            await media.channels.pause(batch_id)
        assert not media.busy
        assert db.batches()[0]["status"] == "paused"
        db.execute(
            "INSERT INTO channel_items(batch_id,url,title,status) VALUES (?,?,?,?)",
            (batch_id, "https://www.youtube.com/watch?v=aaaaaaaaaaa", "Video", "importing"),
        )
        db.execute("UPDATE channel_batches SET status='running' WHERE id=?", (batch_id,))
        db.close()
        db = Database(path)
        assert db.batches()[0]["status"] == "paused"
        assert db.batches()[0]["counts"] == {"queued": 1}
        db.close()

    asyncio.run(verify())


def test_channel_api_validation_and_busy_protection(tmp_path: Path) -> None:
    settings = Settings(_env_file=None, discord_token=SecretStr(""), data_dir=tmp_path)
    with TestClient(create_app(settings)) as client:
        authenticated_fixture(client.app)
        assert client.post("/api/channel-imports", json={"url": "http://127.0.0.1/videos"}).status_code == 400
        assert client.post("/api/channel-imports/missing/resume").status_code == 404
        assert client.post("/api/channel-imports/missing/pause").status_code == 404
        client.app.state.media.busy = True
        assert (
            client.post("/api/channel-imports", json={"url": "https://www.youtube.com/@KudNL/videos"}).status_code
            == 400
        )


@pytest.mark.parametrize("resume", [False, True])
def test_channel_resume_only_on_explicit_maintenance_restart(tmp_path: Path, *, resume: bool) -> None:
    settings = Settings(_env_file=None, discord_token=SecretStr(""), data_dir=tmp_path)
    batch_id = "a" * 32
    db = Database(tmp_path / "library.sqlite3")
    db.execute(
        "INSERT INTO channel_batches(id,url,title,status,created_at) VALUES (?,?,?,?,?)",
        (batch_id, "https://www.youtube.com/@KudNL/videos", "Channel", "running", 0),
    )
    db.close()
    with (
        patch("app.channels.ChannelImports.resume") as restart,
        TestClient(create_app(settings, resume_channel_id=batch_id if resume else None)) as client,
    ):
        assert (
            client.app.state.db.one("SELECT status FROM channel_batches WHERE id=?", (batch_id,))["status"] == "paused"
        )
        if resume:
            restart.assert_called_once_with(batch_id)
        else:
            restart.assert_not_called()


def test_ignore_channel_hides_alerts_preserves_history_and_survives_restart(tmp_path: Path) -> None:
    settings = Settings(_env_file=None, discord_token=SecretStr(""), data_dir=tmp_path)
    with TestClient(create_app(settings)) as client:
        authenticated_fixture(client.app)
        db = client.app.state.db
        db.execute(
            "INSERT INTO channel_batches(id,url,title,status,created_at) VALUES (?,?,?,?,?)",
            ("batch", "https://example.com", "Channel", "running", 1),
        )
        assert client.post("/api/channel-imports/batch/ignore").status_code == 409
        db.execute("UPDATE channel_batches SET status='complete' WHERE id='batch'")
        job_id = db.add_job("https://example.com/video")
        client.app.state.media.update_job(job_id, "failed", error="Download failed.")
        db.execute(
            "INSERT INTO channel_items(batch_id,url,title,status,job_id) VALUES (?,?,?,?,?)",
            ("batch", "https://example.com/video", "Video", "failed", job_id),
        )
        assert client.post("/api/channel-imports/batch/ignore").status_code == 200
        assert db.batches() == []
        assert db.jobs() == []
        assert db.one("SELECT id FROM audit WHERE resource_id=? AND outcome='failed'", (job_id,))
    db = Database(tmp_path / "library.sqlite3")
    assert db.batches() == []
    assert db.jobs() == []
    assert db.one("SELECT id FROM channel_items WHERE batch_id='batch'")
    db.close()
