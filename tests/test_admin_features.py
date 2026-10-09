from __future__ import annotations

import asyncio
import logging
import time
from concurrent.futures import ThreadPoolExecutor
from typing import TYPE_CHECKING
from unittest.mock import AsyncMock, Mock

import pytest
from cryptography.fernet import Fernet
from fastapi.testclient import TestClient
from pydantic import SecretStr

from app.bot import GuildVoice, VoiceError
from app.config import Settings
from app.db import Database
from app.events import Events
from app.logs import ConsoleLogs
from app.main import create_app
from app.mixer import SILENCE, Mixer
from tests.helpers import authenticated_fixture
from tests.test_mixer import audio_file, clip

if TYPE_CHECKING:
    from pathlib import Path


def test_console_redacts_credentials_and_has_bounded_cursor(tmp_path: Path) -> None:
    console = ConsoleLogs(Settings(_env_file=None, data_dir=tmp_path, discord_token=SecretStr("private-bot-token")))
    record = logging.LogRecord(
        "app.bot",
        logging.ERROR,
        "",
        1,
        "private-bot-token Authorization: Bearer hidden-token access_token=oauth-private "
        "https://discord.com/callback?code=private-code&state=private-state",
        (),
        None,
    )
    console.emit(record)
    result = console.snapshot(0, 20)
    entry = result["entries"][0]
    for secret in ("private-bot-token", "hidden-token", "oauth-private", "private-code", "private-state"):
        assert secret not in entry["message"]
    assert entry["level"] == "ERROR"
    assert console.snapshot(result["cursor"], 20)["entries"] == []
    assert console.snapshot(100, 20)["reset"]
    assert "oauth-private" not in console.redact("https://example.com/video?token=oauth-private")
    assert "cookie-private" not in console.redact("Cookie: session=something; next=cookie-private")
    for _ in range(2001):
        console.emit(record)
    assert len(console.entries) == 2000
    assert console.snapshot(1, 20)["truncated"]


def test_console_api_is_private_and_reports_errors(tmp_path: Path) -> None:
    with TestClient(
        create_app(
            Settings(
                _env_file=None,
                data_dir=tmp_path,
                discord_token=SecretStr(""),
                discord_client_secret=SecretStr("test-private"),
                auth_encryption_key=SecretStr(Fernet.generate_key().decode()),
            )
        )
    ) as client:
        assert client.get("/api/admin/logs").status_code == 401
        authenticated_fixture(client.app)
        logger = logging.getLogger("app.test")

        def fail() -> None:
            msg = "Useful diagnostic"
            raise ValueError(msg)

        try:
            fail()
        except ValueError:
            logger.exception("Operation failed")
        response = client.get("/api/admin/logs")
        assert response.status_code == 200
        assert response.headers["cache-control"] == "private, no-store"
        assert any("ValueError: Useful diagnostic" in item["message"] for item in response.json()["entries"])
        assert client.get("/api/admin/logs?limit=501").status_code == 422


def test_pins_are_personal_persistent_and_removed_with_clip(tmp_path: Path) -> None:
    settings = Settings(_env_file=None, data_dir=tmp_path, discord_token=SecretStr(""))
    with TestClient(create_app(settings)) as client:
        authenticated_fixture(client.app)
        client.get("/api/state")
        db = client.app.state.db
        db.execute(
            "INSERT INTO sources (id,url,title,duration,created_at) VALUES (?,?,?,?,?)",
            ("source", "https://example.com/video", "Example", 10, time.time()),
        )
        db.execute(
            "INSERT INTO clips (id,source_id,name,emoji,tags,start,end,volume,created_at) VALUES (?,?,?,?,?,?,?,?,?)",
            ("clip", "source", "Sound", "", "[]", 0, 1, 1, time.time()),
        )
        assert client.put("/api/clips/clip/favourite", json={"pinned": True}).status_code == 200
        assert client.put("/api/clips/clip/favourite", json={"pinned": True}).status_code == 200
        assert client.get("/api/state").json()["clips"][0]["pinned"]
        assert not db.clips("other-user")[0]["pinned"]
        assert client.put("/api/clips/missing/favourite", json={"pinned": True}).status_code == 404
    with TestClient(create_app(settings)) as client:
        authenticated_fixture(client.app)
        assert client.get("/api/state").json()["clips"][0]["pinned"]
        assert client.put("/api/clips/clip/favourite", json={"pinned": False}).status_code == 200
        assert not client.get("/api/state").json()["clips"][0]["pinned"]
        client.put("/api/clips/clip/favourite", json={"pinned": True})
        assert client.delete("/api/clips/clip").status_code == 200
        assert client.app.state.db.rows("SELECT * FROM user_favourites") == []


def test_mute_outputs_silence_without_losing_volume_or_timing(tmp_path: Path) -> None:
    mixer = Mixer(volume=0.7)
    mixer.add(audio_file(tmp_path, frames=2880), clip())
    mixer.muted = True
    assert mixer.read() == SILENCE
    assert mixer.snapshot()[0]["position"] == pytest.approx(0.02)
    mixer.muted = False
    assert mixer.read() != SILENCE
    assert mixer.volume == 0.7
    mixer.cleanup()


def test_clip_requests_queue_instead_of_hitting_pending_job_limit(tmp_path: Path) -> None:
    settings = Settings(_env_file=None, data_dir=tmp_path, discord_token=SecretStr(""))
    with TestClient(create_app(settings)) as client:
        authenticated_fixture(client.app)
        client.get("/api/state")
        client.app.state.db.execute(
            "INSERT INTO sources (id,url,title,duration,created_at) VALUES (?,?,?,?,?)",
            ("source", "https://example.com/video", "Example", 10, time.time()),
        )
        arrived = 0
        gate = asyncio.Event()

        async def extract(_source: dict, metadata: dict) -> str:
            nonlocal arrived
            arrived += 1
            if arrived == 5:
                gate.set()
            await asyncio.wait_for(gate.wait(), 3)
            async with client.app.state.media.lock:
                await asyncio.sleep(0.01)
                return metadata["name"]

        client.app.state.media.create_clip = extract

        def save(index: int) -> int:
            return client.post(
                "/api/clips", json={"source_id": "source", "name": f"Clip {index}", "start": 0, "end": 1}
            ).status_code

        with ThreadPoolExecutor(max_workers=5) as pool:
            assert list(pool.map(save, range(5))) == [201] * 5
        assert not client.app.state.clip_tasks


def test_voice_flags_use_bot_self_state_and_require_connection(tmp_path: Path) -> None:
    async def run() -> None:
        db = Database(tmp_path / "test.sqlite3")
        guild = Mock(voice_client=Mock(is_connected=Mock(return_value=True)), change_voice_state=AsyncMock())
        guild.voice_client.channel.members = []
        bot = Mock(get_guild=Mock(return_value=guild))
        state = GuildVoice(Settings(_env_file=None), db, Events(), bot, 1352422295402057759)
        state.mixer = Mixer()
        await state.flags(muted=True, deafened=False)
        guild.change_voice_state.assert_awaited_once_with(
            channel=guild.voice_client.channel,
            self_mute=True,
            self_deaf=False,
        )
        assert state.status()["muted"]
        assert not state.status()["deafened"]
        assert state.mixer.muted
        guild.voice_client.is_connected.return_value = False
        with pytest.raises(VoiceError, match="Connect the bot"):
            await state.flags(muted=False, deafened=True)
        state.mixer.cleanup()
        db.close()

    asyncio.run(run())
