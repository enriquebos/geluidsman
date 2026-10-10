from __future__ import annotations

import shutil
import subprocess
import time
import wave
from pathlib import Path
from typing import TYPE_CHECKING
from unittest.mock import AsyncMock, Mock, patch

import discord
import pytest
from fastapi.testclient import TestClient
from pydantic import SecretStr, ValidationError

from app.config import Settings
from app.db import Database
from app.main import ClipMeta, create_app, validate_clip
from app.media import MediaError
from app.mixer import CapacityError
from tests.helpers import authenticated_fixture


def test_custom_emoji_validation() -> None:
    value = "<a:dancing_bear:123456789012345678>"
    assert ClipMeta(name="Custom", emoji=value).emoji == value
    for invalid in ("<img src=x>", "<:bad-name:123>", "x" * 21):
        with pytest.raises(ValidationError):
            ClipMeta(name="Invalid", emoji=invalid)


if TYPE_CHECKING:
    from collections.abc import Iterator


@pytest.fixture
def client(tmp_path: Path) -> Iterator[TestClient]:
    settings = Settings(_env_file=None, discord_token=SecretStr(""), data_dir=tmp_path)
    with TestClient(create_app(settings)) as client:
        authenticated_fixture(client.app)
        db = client.app.state.db
        db.execute(
            "INSERT INTO sources (id,url,title,duration,created_at) VALUES (?,?,?,?,?)",
            ("source", "https://example.com/video", "Example source", 10, time.time()),
        )
        yield client


def test_secret_free_state_and_offline_behaviour(client: TestClient) -> None:
    response = client.get("/api/state")
    assert response.status_code == 200
    assert "discord_token" not in response.json()["status"]
    assert response.json()["status"]["guild_id"] == "1352422295402057759"
    assert response.json()["channels"] == []
    assert client.post("/api/guilds/1352422295402057759/voice/connect", json={"channel_id": "123"}).status_code == 409
    assert client.post("/api/guilds/1352422295402057759/voice/connect", json={"channel_id": "../x"}).status_code == 422
    assert client.get("/api/media/source/../../.env").status_code == 404
    assert client.get("/api/media/source/.env").status_code == 404


def test_configured_secret_never_enters_api(tmp_path: Path) -> None:

    private_value = "test-value-that-must-stay-private"
    settings = Settings(_env_file=None, discord_token=SecretStr(private_value), data_dir=tmp_path)
    with patch("app.bot.Bot.start", new=AsyncMock()), TestClient(create_app(settings)) as client:
        authenticated_fixture(client.app)
        for endpoint in ["/api/state", "/api/health"]:
            assert private_value not in client.get(endpoint).text
        assert client.get("/.env").status_code == 404


@pytest.mark.parametrize(
    ("start", "end", "duration"),
    [(-1, 2, 10), (2, 1, 10), (0, 0.09, 10), (0, 61, 100), (0, 11, 10), (float("nan"), 2, 10), (0, float("inf"), 10)],
)
def test_invalid_boundaries(start: float, end: float, duration: float) -> None:
    with pytest.raises(MediaError):
        validate_clip(start, end, duration, 60)


def test_boundaries_at_limits() -> None:
    validate_clip(0, 0.1, 0.1, 60)
    validate_clip(10, 70, 70, 60)


def test_sound_name_character_limit() -> None:
    assert len(ClipMeta(name="x" * 255).name) == 255
    with pytest.raises(ValidationError, match="255"):
        ClipMeta(name="x" * 256)


def test_clip_validation_and_source_delete_protection(client: TestClient) -> None:
    payload = {"source_id": "source", "start": 0, "end": 11, "name": "Clip"}
    assert client.post("/api/clips", json=payload).status_code == 400
    payload["name"] = " "
    assert client.post("/api/clips", json=payload).status_code == 422
    client.app.state.db.execute(
        "INSERT INTO clips(id,source_id,name,emoji,tags,start,end,volume,created_at) VALUES (?,?,?,?,?,?,?,?,?)",
        ("clip", "source", "Hi", "", "[]", 0, 1, 1, time.time()),
    )
    assert client.delete("/api/sources/source").status_code == 409
    assert client.post("/api/guilds/1352422295402057759/clips/clip/play").status_code == 409
    assert (
        client.patch(
            "/api/clips/clip", json={"name": "Edited", "emoji": "✨", "tags": [" hi ", "hi"], "volume": 0.5}
        ).status_code
        == 200
    )
    assert client.get("/api/state").json()["clips"][0]["tags"] == ["hi"]
    assert client.delete("/api/clips/clip").status_code == 200
    assert client.delete("/api/sources/source").status_code == 200


def test_import_validation_busy_limits_and_retry(client: TestClient) -> None:
    assert client.post("/api/imports", json={"url": "file:///secret"}).status_code == 400
    media = client.app.state.media
    media.busy = True
    assert client.post("/api/imports", json={"url": "https://example.com/video"}).status_code == 400
    media.busy = False
    job = client.app.state.db.add_job("https://example.com/video")
    assert client.post(f"/api/imports/{job}/retry").status_code == 409
    assert client.post("/api/imports/missing/retry").status_code == 404
    client.app.state.db.execute("UPDATE jobs SET status='failed' WHERE id=?", (job,))
    media.base_settings.max_storage_bytes = 1
    folder = media.root / "source"
    folder.mkdir()
    (folder / "test").write_bytes(b"ab")
    media.storage.commit(folder)
    assert client.post(f"/api/imports/{job}/retry").status_code == 400


def test_persistence_and_job_recovery(tmp_path: Path) -> None:
    path = tmp_path / "library.sqlite3"
    db = Database(path)
    db.set_setting("selected_channel_id", "123456789012345678")
    job = db.add_job("https://example.com/video")
    db.close()
    db = Database(path)
    assert db.setting("selected_channel_id") == "123456789012345678"
    assert db.one("SELECT * FROM jobs WHERE id=?", (job,))["status"] == "interrupted"
    db.close()


def test_import_error_dismissal_preserves_library_and_running_jobs(client: TestClient) -> None:
    db = client.app.state.db
    job_id = db.add_job("https://example.com/video")
    assert client.delete(f"/api/imports/{job_id}").status_code == 409
    db.execute("UPDATE jobs SET status='failed' WHERE id=?", (job_id,))
    assert client.delete(f"/api/imports/{job_id}").status_code == 200
    assert db.one("SELECT id FROM jobs WHERE id=?", (job_id,)) is None
    assert len(db.sources()) == 1
    assert client.delete(f"/api/imports/{job_id}").status_code == 404


@pytest.mark.skipif(not shutil.which("ffmpeg"), reason="Requires FFmpeg")
def test_real_clip_extraction(client: TestClient) -> None:

    folder = client.app.state.media.root / "source"
    folder.mkdir()
    subprocess.run(
        [
            shutil.which("ffmpeg"),
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=440:duration=10",
            "-c:a",
            "aac",
            str(folder / "audio.m4a"),
        ],
        check=True,
    )
    response = client.post("/api/clips", json={"source_id": "source", "start": 1, "end": 1.5, "name": "Real tone"})
    assert response.status_code == 201, response.text
    clip_id = response.json()["id"]

    with wave.open(str(client.app.state.media.root / clip_id / "sound.wav")) as reader:
        assert reader.getframerate() == 48000
        assert reader.getnchannels() == 2
        assert reader.getnframes() == 24000
    response = client.get(f"/api/media/{clip_id}/preview.m4a", headers={"Range": "bytes=0-99"})
    assert response.status_code == 206
    assert len(response.content) == 100
    assert client.get("/api/state").json()["clips"][0]["name"] == "Real tone"


def test_guild_channel_validation(client: TestClient) -> None:

    bot = client.app.state.bot
    bot.client.is_ready = lambda: True
    guild = Mock()
    guild.me = Mock()
    allowed = Mock(spec=discord.VoiceChannel)
    allowed.id = 123
    allowed.name = "Allowed"
    allowed.category = None
    allowed.permissions_for.return_value = discord.Permissions(view_channel=True, connect=True, speak=True)
    forbidden = Mock(spec=discord.VoiceChannel)
    forbidden.id = 456
    forbidden.name = "Hidden"
    forbidden.permissions_for.return_value = discord.Permissions.none()
    guild.voice_channels = [allowed, forbidden]
    guild.voice_client = None
    guild.get_channel.return_value = None
    bot.client.get_guild = lambda guild_id: guild if guild_id == 1352422295402057759 else None
    assert bot.channels() == [{"id": "123", "name": "Allowed", "category": None}]
    assert client.post("/api/guilds/1352422295402057759/voice/connect", json={"channel_id": "999"}).status_code == 409


def test_playback_status_does_not_load_the_library(client: TestClient) -> None:
    client.app.state.db.sources = Mock(side_effect=AssertionError("Library should not be loaded"))
    client.app.state.db.clips = Mock(side_effect=AssertionError("Clips should not be loaded"))
    response = client.get("/api/playback")
    assert response.status_code == 200
    assert set(response.json()) == {"status"}
    assert response.json()["status"]["snapshot_at"] > 0
    assert not response.json()["status"]["connected"]


def test_activity_counts_successes_boundaries_and_guild(client: TestClient) -> None:
    client.get("/api/state")
    db = client.app.state.db
    after = time.time() - 7200
    until = after + 7200
    events = [
        (after, "sound.play", "success", None),
        (after + 1800, "sound.play", "success", "1352422295402057759"),
        (after + 3600, "sound.play", "success", None),
        (after + 3600, "sound.create", "success", None),
        (after + 5000, "sound.play", "rejected", None),
        (after + 5000, "sound.play", "success", "999"),
        (until, "sound.play", "success", None),
        (after - 1, "sound.play", "success", None),
    ]
    for timestamp, action, outcome, guild in events:
        db.audit("100", action, outcome=outcome, guild_id=guild)
        db.execute("UPDATE audit SET timestamp=? WHERE id=(SELECT MAX(id) FROM audit)", (timestamp,))
    response = client.get("/api/audit/activity", params={"after": after, "until": until})
    assert response.status_code == 200
    data = response.json()
    assert data["total_played"] == 3
    assert [point["played"] for point in data["series"]] == [2, 1]
    assert data["leaderboard"][0]["created"] == 1
    assert data["leaderboard"][0]["played"] == 3


def test_activity_empty_period_validation_and_retention(client: TestClient) -> None:
    after = time.time() - 86400
    valid = {"after": after, "until": after + 86400, "bucket_seconds": 86400}
    data = client.get("/api/audit/activity", params=valid).json()
    assert data["leaderboard"] == []
    assert data["series"][0]["played"] == 0
    for params in (
        {**valid, "until": after},
        {**valid, "until": after + 92 * 86400},
        {**valid, "after": "nan"},
        {**valid, "bucket_seconds": 1},
        {**valid, "sort": "unknown"},
    ):
        assert client.get("/api/audit/activity", params=params).status_code == 422
    db = client.app.state.db
    db.audit("100", "sound.play")
    db.execute("UPDATE audit SET timestamp=?", (after - 1,))
    db.set_setting("app_settings", {"audit_retention_days": 1})
    older = {"after": after - 86400, "until": after, "bucket_seconds": 86400}
    assert client.get("/api/audit/activity", params=older).json()["total_played"] == 0


def test_capacity_error_does_not_log_traceback(client: TestClient, caplog: pytest.LogCaptureFixture) -> None:
    async def full() -> object:
        message = "All eight playback slots are occupied."
        raise CapacityError(message)

    client.app.add_api_route("/capacity-test", full)
    response = client.get("/capacity-test")
    assert response.status_code == 409
    assert "eight" in response.json()["detail"]
    records = [record for record in caplog.records if "capacity reached" in record.message]
    assert records
    assert all(record.exc_info is None and record.levelname == "WARNING" for record in records)


def test_all_time_leaderboard_survives_audit_cleanup_and_restart(client: TestClient) -> None:
    db = client.app.state.db
    db.audit("100", "sound.create")
    db.audit("100", "sound.play")
    db.audit("100", "sound.play", outcome="rejected")
    db.audit("100", "sound.play", guild_id="999")
    db.execute("DELETE FROM audit")
    data = client.get("/api/audit/leaderboard").json()
    assert data["leaderboard"][0]["created"] == 1
    assert data["leaderboard"][0]["played"] == 1
    db.conn.executescript(Path(__file__).parents[1].joinpath("app/schema_sqlite.sql").read_text(encoding="utf-8"))
    assert client.get("/api/audit/leaderboard").json() == data
    assert client.get("/api/audit/leaderboard", params={"sort": "unknown"}).status_code == 422
    db.execute("UPDATE users SET permission_overrides=? WHERE id=?", ('{"view_audit":false}', "100"))
    assert client.get("/api/audit/leaderboard").status_code == 403
