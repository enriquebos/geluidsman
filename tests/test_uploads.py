from __future__ import annotations

import asyncio
import json
import shutil
import subprocess
from contextvars import ContextVar
from typing import TYPE_CHECKING

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


@pytest.mark.parametrize("extension", ["mp3", "ogg"])
def test_upload_conversion_persistence_and_cleanup(tmp_path: Path, extension: str) -> None:
    audio = tmp_path / ("input." + extension)
    subprocess.run(
        [shutil.which("ffmpeg"), "-v", "error", "-f", "lavfi", "-i", "sine=duration=0.5", str(audio)],
        check=True,
    )
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
