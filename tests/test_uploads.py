from __future__ import annotations

import asyncio
import json
import shutil
import subprocess
from contextvars import ContextVar
from typing import TYPE_CHECKING
from unittest.mock import AsyncMock

import pytest
from fastapi.testclient import TestClient
from pydantic import SecretStr

from app.config import Settings
from app.db import Database
from app.main import create_app
from app.media import Media, MediaError
from tests.helpers import authenticated_fixture

if TYPE_CHECKING:
    from pathlib import Path


@pytest.mark.parametrize("extension", ["mp3", "ogg", "mp3-cover"])
def test_upload_conversion_persistence_and_cleanup(tmp_path: Path, extension: str) -> None:
    cover = extension == "mp3-cover"
    extension = "mp3" if cover else extension
    audio = tmp_path / ("input." + extension)
    subprocess.run(
        [shutil.which("ffmpeg"), "-v", "error", "-f", "lavfi", "-i", "sine=duration=0.5", str(audio)],
        check=True,
    )
    if cover:
        decorated = tmp_path / "cover.mp3"
        subprocess.run(
            [
                shutil.which("ffmpeg"),
                "-v",
                "error",
                "-i",
                str(audio),
                "-f",
                "lavfi",
                "-i",
                "color=c=blue:s=32x32:d=0.04",
                "-map",
                "0:a",
                "-map",
                "1:v",
                "-c:a",
                "copy",
                "-c:v",
                "png",
                "-threads:v",
                "1",
                "-disposition:v",
                "attached_pic",
                str(decorated),
            ],
            check=True,
        )
        audio = decorated
    settings = Settings(_env_file=None, data_dir=tmp_path, discord_token=SecretStr(""))
    with TestClient(create_app(settings)) as client:
        authenticated_fixture(client.app)
        result = client.post(
            "/api/clips/upload",
            params={
                "filename": "../../sound." + extension,
                "metadata": json.dumps({"name": "  Uploaded  ", "emoji": "🎵", "tags": ["New"], "volume": 0.5}),
            },
            content=audio.read_bytes(),
        )
        assert result.status_code == 201, result.text
        clip_id = result.json()["id"]
        state = client.get("/api/state").json()
        clip = state["clips"][0]
        assert clip["id"] == clip_id
        assert clip["name"] == "Uploaded"
        assert clip["tags"] == ["New"]
        assert clip["source_id"] is None
        assert clip["creator_id"] == "100"
        assert clip["volume"] == 0.5
        assert state["sources"] == []
        folder = tmp_path / "media" / clip_id
        assert {file.name for file in folder.iterdir()} == {"sound.wav", "preview.m4a"}
        assert client.get(f"/api/media/{clip_id}/preview.m4a").status_code == 200
        assert client.app.state.db.rows("SELECT action FROM audit")[0]["action"] == "sound.create"
    db = Database(tmp_path / "library.sqlite3")
    assert db.clips()[0]["id"] == clip_id
    db.close()
    with TestClient(create_app(settings)) as client:
        authenticated_fixture(client.app)
        assert folder.exists()
        assert client.delete(f"/api/clips/{clip_id}").status_code == 200
        assert not folder.exists()


@pytest.mark.parametrize(
    ("filename", "body", "metadata", "expected"),
    [
        ("bad.wav", b"audio", '{"name":"Sound"}', 400),
        ("bad.mp3", b"not audio", '{"name":"Sound"}', 400),
        ("bad.ogg", b"", '{"name":"Sound"}', 400),
        ("sound.mp3", b"audio", '{"name":""}', 422),
        ("sound.mp3", b"audio", '{"name":"Sound","tags":[123]}', 422),
    ],
)
def test_rejected_upload_leaves_no_media(
    tmp_path: Path, filename: str, body: bytes, metadata: str, expected: int
) -> None:
    settings = Settings(_env_file=None, data_dir=tmp_path, discord_token=SecretStr(""))
    with TestClient(create_app(settings)) as client:
        authenticated_fixture(client.app)
        result = client.post("/api/clips/upload", params={"filename": filename, "metadata": metadata}, content=body)
        assert result.status_code == expected, result.text
        assert not client.app.state.db.clips()
        assert not list((tmp_path / "media").iterdir())


def test_stream_size_limit_and_duration_validation(tmp_path: Path) -> None:
    async def chunks() -> bytes:
        yield b"1234"
        yield b"5678"

    with pytest.raises(MediaError, match="limit"):
        asyncio.run(Media.write_upload(chunks(), tmp_path / "upload", 5))
    assert (tmp_path / "upload").stat().st_size == 4
    media = object.__new__(Media)
    media.base_settings = Settings(_env_file=None, data_dir=tmp_path, discord_token=SecretStr(""))
    media.db = Database(tmp_path / "test.sqlite3")
    media.operation = ContextVar("test", default=None)
    for duration in (0, 0.09, 61, float("nan"), float("inf")):
        with pytest.raises(MediaError, match="between"):
            media.validate_upload(
                {"format": {"format_name": "ogg", "duration": duration}, "streams": [{"codec_type": "audio"}]}
            )
    with pytest.raises(MediaError, match="known duration"):
        media.validate_upload({"format": {"duration": "N/A"}})
    media.db.close()


@pytest.mark.parametrize("setting", ["max_import_bytes", "max_storage_bytes"])
def test_upload_storage_and_import_budget(tmp_path: Path, setting: str) -> None:
    settings = Settings(_env_file=None, data_dir=tmp_path, discord_token=SecretStr(""))
    with TestClient(create_app(settings)) as client:
        authenticated_fixture(client.app)
        client.app.state.db.set_setting("app_settings", {setting: 100})
        result = client.post(
            "/api/clips/upload", params={"filename": "sound.mp3", "metadata": '{"name":"Sound"}'}, content=b"x" * 101
        )
        assert result.status_code == 400
        assert "storage" in result.json()["detail"]
        assert not list((tmp_path / "media").iterdir())


@pytest.mark.parametrize(
    ("streams", "accepted"),
    [
        ([{"codec_type": "audio"}, {"codec_type": "video", "disposition": {"attached_pic": 1}}], True),
        ([{"codec_type": "audio"}, {"codec_type": "video", "disposition": {"attached_pic": 0}}], False),
        ([{"codec_type": "audio"}, {"codec_type": "video"}], False),
        ([{"codec_type": "video", "disposition": {"attached_pic": 1}}], False),
        ([{"codec_type": "audio"}, {"codec_type": "subtitle"}], False),
        ([], False),
    ],
)
def test_upload_distinguishes_cover_art_from_video(tmp_path: Path, streams: list, *, accepted: bool) -> None:
    media = object.__new__(Media)
    media.base_settings = Settings(_env_file=None, data_dir=tmp_path, discord_token=SecretStr(""))
    media.db = Database(tmp_path / "test.sqlite3")
    media.operation = ContextVar("test", default=None)
    info = {"format": {"format_name": "mp3", "duration": 1}, "streams": streams}
    try:
        if accepted:
            assert media.validate_upload(info) == 1
        else:
            with pytest.raises(MediaError, match="without video"):
                media.validate_upload(info)
    finally:
        media.db.close()


@pytest.mark.parametrize("allowed", [False, True])
def test_long_upload_permission_and_saved_duration(tmp_path: Path, *, allowed: bool) -> None:
    audio = tmp_path / "long.mp3"
    subprocess.run(
        [shutil.which("ffmpeg"), "-v", "error", "-f", "lavfi", "-i", "sine=duration=61", str(audio)],
        check=True,
    )
    settings = Settings(_env_file=None, data_dir=tmp_path, discord_token=SecretStr(""))
    with TestClient(create_app(settings)) as client:
        authenticated_fixture(client.app)
        client.get("/api/auth/me")
        client.app.state.db.execute(
            "UPDATE users SET permission_overrides=? WHERE id='100'", (json.dumps({"long_sounds": allowed}),)
        )
        response = client.post(
            "/api/clips/upload",
            params={"filename": "long.mp3", "metadata": '{"name":"Long sound"}'},
            content=audio.read_bytes(),
        )
        assert response.status_code == (201 if allowed else 400), response.text
        if allowed:
            assert client.app.state.db.clips()[0]["end"] > 60
        else:
            assert "60 seconds" in response.json()["detail"]
            assert not client.app.state.db.clips()
            assert not list((tmp_path / "media").iterdir())


@pytest.mark.parametrize(("allowed", "duration", "expected"), [(False, 61, 400), (True, 600, 201), (True, 600.1, 400)])
def test_video_cut_long_sound_permission(tmp_path: Path, *, allowed: bool, duration: float, expected: int) -> None:
    settings = Settings(_env_file=None, data_dir=tmp_path, discord_token=SecretStr(""))
    with TestClient(create_app(settings)) as client:
        authenticated_fixture(client.app)
        client.get("/api/auth/me")
        db = client.app.state.db
        db.execute("UPDATE users SET permission_overrides=? WHERE id='100'", (json.dumps({"long_sounds": allowed}),))
        db.execute(
            "INSERT INTO sources(id,url,title,duration,created_at) VALUES ('source','https://example.com','Video',1000,0)"
        )
        client.app.state.media.create_clip = AsyncMock(return_value="clip")
        response = client.post(
            "/api/clips", json={"source_id": "source", "name": "Long cut", "start": 0, "end": duration}
        )
        assert response.status_code == expected, response.text
        assert bool(client.app.state.media.create_clip.call_count) is (expected == 201)
        db.execute(
            "UPDATE users SET permission_overrides=? WHERE id='100'", ('{"long_sounds":true,"create_sounds":false}',)
        )
        assert (
            client.post(
                "/api/clips", json={"source_id": "source", "name": "Denied", "start": 0, "end": duration}
            ).status_code
            == 403
        )


def test_ten_minute_upload_boundary(tmp_path: Path) -> None:
    media = object.__new__(Media)
    media.base_settings = Settings(_env_file=None, data_dir=tmp_path, discord_token=SecretStr(""))
    media.db = Database(tmp_path / "test.sqlite3")
    media.operation = ContextVar("test", default=None)
    try:
        info = {"format": {"format_name": "mp3", "duration": 600}, "streams": [{"codec_type": "audio"}]}
        assert media.validate_upload(info, max_seconds=600) == 600
        with pytest.raises(MediaError, match="60 seconds"):
            media.validate_upload(info)
        info["format"]["duration"] = 600.1
        with pytest.raises(MediaError, match="600 seconds"):
            media.validate_upload(info, max_seconds=600)
    finally:
        media.db.close()
