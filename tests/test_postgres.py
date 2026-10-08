from __future__ import annotations

import json
import os
import time
from typing import TYPE_CHECKING
from urllib.parse import urlsplit

import pytest
from fastapi.testclient import TestClient
from pydantic import SecretStr

from app.config import Settings
from app.db import Database
from app.main import create_app
from app.postgres import Connection
from tests.helpers import authenticated_fixture
from tests.test_captions import source, track

if TYPE_CHECKING:
    from collections.abc import Iterator
    from pathlib import Path

URL = os.environ.get("TEST_DATABASE_URL", "")
pytestmark = pytest.mark.skipif(not URL, reason="Requires isolated PostgreSQL test database")


@pytest.fixture
def database(tmp_path: Path) -> Iterator[Database]:
    assert urlsplit(URL).path == "/geluidsman_test"
    connection = Connection(URL)
    connection.initialize()
    connection.raw.execute("TRUNCATE users,sources,settings,oauth_states,audit,channel_batches CASCADE")
    connection.close()
    db = Database(tmp_path / "unused.sqlite3", URL)
    yield db
    db.close()


def test_postgres_search_refresh_transactions(database: Database) -> None:
    database.save_source(source(), [track()])
    assert database.search_captions("HALLO MOOIE", "nl", None, 0, 50)[0]["precision"] == "word"
    assert not database.search_captions("wereld Hallo", "all", "video", 0, 50)
    assert not database.search_captions('" OR 1=1 --', "all", None, 0, 50)
    for query in ("wer", "werld", "MOOIE wer", "mooi wereld", "w"):
        assert database.search_captions(query, "nl", None, 0, 50), query
    database.execute(
        "INSERT INTO clips(id,source_id,name,emoji,tags,start,end,volume,created_at) VALUES (?,?,?,?,?,?,?,?,?)",
        ("uploaded", None, "Upload", "", "[]", 0, 1, 1, time.time()),
    )
    assert database.clips()[0]["source_title"] == "Uploaded audio"
    database.set_setting("volume", 0.7)
    database.set_setting("volume", 0.9)
    assert database.setting("volume") == 0.9

    def rollback() -> None:
        with database.conn:
            database.set_setting("volume", 0.2)
            raise RuntimeError

    with pytest.raises(RuntimeError):
        rollback()
    assert database.setting("volume") == 0.9
    database.save_source(source("new"), [])
    assert database.sources()[0]["media_id"] == "new"
    assert not database.search_captions("Hallo", "all", None, 0, 50)


def test_postgres_api(database: Database, tmp_path: Path) -> None:
    database.close()
    settings = Settings(_env_file=None, data_dir=tmp_path, database_url=SecretStr(URL), discord_token=SecretStr(""))
    app = create_app(settings)
    with TestClient(app) as client:
        authenticated_fixture(app)
        app.state.db.save_source(source(), [track()])
        for endpoint in (
            "/api/conversations",
            "/api/conversations/status",
            "/api/conversation/triggers",
            "/api/admin/conversations/settings",
            "/api/state",
            "/api/admin/users",
            "/api/captions/search?q=Hallo",
            "/api/audit",
            "/api/audit/activity?after=1700000000&until=1700003600",
        ):
            response = client.get(endpoint)
            assert response.status_code == 200, response.text
            assert URL not in response.text
        app.state.db.execute(
            "INSERT INTO conversations(id,channel_id,channel_name,started_at) VALUES (?,?,?,?)",
            ("session", "123", "Voice", time.time()),
        )
        app.state.db.execute(
            "INSERT INTO conversation_messages(id,session_id,speaker_id,speaker_name,started_at,ended_at,"
            "text,language) VALUES (?,?,?,?,?,?,?,?)",
            ("message", "session", "100", "Member", time.time(), time.time(), "Hallo", "nl"),
        )
        assert client.get("/api/conversations/session/messages").json()["items"][0]["text"] == "Hallo"
        assert client.delete("/api/conversations/session").status_code == 200
        assert not app.state.db.rows("SELECT * FROM conversation_messages")
        app.state.db.audit("100", "sound.play")
        activity = client.get("/api/audit/activity", params={"after": time.time() - 3600, "until": time.time() + 1})
        assert activity.status_code == 200, activity.text
        assert activity.json()["total_played"] == 1
        assert activity.json()["leaderboard"][0]["played"] == 1


def test_postgres_persistence_and_interrupted_jobs(database: Database, tmp_path: Path) -> None:
    database.execute(
        "INSERT INTO users(id,username,display_name,created_at,last_login,permission_overrides) VALUES(?,?,?,?,?,?)",
        ("100", "tester", "Test Member", 1700000000.123456, 1700000001.654321, json.dumps({"play_sounds": False})),
    )
    database.save_source(source(), [track()], "100")
    job = database.add_job("https://example.com/video", "100")
    expected = database.rows("SELECT * FROM users")
    recovered = Database(tmp_path / "unused.sqlite3", URL)
    assert recovered.rows("SELECT * FROM users") == expected
    assert recovered.search_captions("Hallo", "all", None, 0, 50)
    assert recovered.one("SELECT status FROM jobs WHERE id=?", (job,))["status"] == "interrupted"
    recovered.audit("100", "test.action", details={"nested": {"ok": True}})
    assert json.loads(recovered.rows("SELECT * FROM audit ORDER BY id DESC")[0]["details"])["nested"]["ok"]
    recovered.close()
