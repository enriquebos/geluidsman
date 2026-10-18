from __future__ import annotations

import json
import os
import time
from typing import TYPE_CHECKING
from unittest.mock import patch
from urllib.parse import urlsplit

import pytest
from fastapi.testclient import TestClient
from pydantic import SecretStr

from app.config import Settings
from app.database_schema import SCHEMA_VERSION_KEY
from app.db import Database
from app.goose_sketches import Sketch, change_library, resolve_sketch
from app.main import create_app
from app.music_models import MusicTrack
from app.music_store import MusicStore
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
    connection.raw.execute(
        "TRUNCATE users,sources,settings,oauth_states,audit,channel_batches,activity_totals,sound_play_totals CASCADE"
    )
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
            "/api/conversations/status",
            "/api/conversation/triggers",
            "/api/state",
            "/api/admin/users",
            "/api/captions/search?q=Hallo",
            "/api/audit",
            "/api/audit/leaderboard",
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
        app.state.conversation.session = app.state.db.one("SELECT * FROM conversations WHERE id='session'")
        assert client.get("/api/conversations/session/messages").json()["items"][0]["text"] == "Hallo"
        app.state.db.execute(
            "INSERT INTO conversation_messages(id,session_id,speaker_id,speaker_name,started_at,"
            "ended_at,text,language) "
            "VALUES (?,?,?,?,?,?,?,?)",
            ("late", "session", "200", "Member", time.time() - 10, time.time() - 9, "Later result", "nl"),
        )
        delta = client.get("/api/conversations/session/messages?after=message").json()
        assert [item["id"] for item in delta["items"]] == ["late"]
        assert delta["has_new"] is False
        assert client.put("/api/conversations/recording", json={"enabled": False}).status_code == 200
        assert not app.state.db.rows("SELECT * FROM conversation_messages")
        app.state.db.audit("100", "sound.play")
        activity = client.get("/api/audit/activity", params={"after": time.time() - 3600, "until": time.time() + 1})
        assert activity.status_code == 200, activity.text
        assert activity.json()["total_played"] == 1
        assert activity.json()["leaderboard"][0]["played"] == 1
        app.state.db.execute("DELETE FROM audit")
        assert client.get("/api/audit/leaderboard").json()["leaderboard"][0]["played"] == 1
        app.state.db.conn.initialize()
        assert client.get("/api/audit/leaderboard").json()["leaderboard"][0]["played"] == 1


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


def test_postgres_action_rules_persistence_and_audit(database: Database) -> None:
    now = time.time()
    database.execute(
        "INSERT INTO users(id,username,display_name,created_at,last_login) VALUES (?,?,?,?,?)",
        ("action-owner", "owner", "Owner", now, now),
    )
    database.change(
        "INSERT INTO action_triggers(id,owner_id,event,action,delay,cooldown,created_at) VALUES (?,?,?,?,?,?,?)",
        ("voice-rule", "action-owner", "camera_on", "stop_all", 1.5, 5, now),
        "action-owner",
        "action_trigger.create",
        resource_id="voice-rule",
        name="Camera enabled",
        details={"event_label": "Camera enabled", "action": "stop_all"},
    )
    saved = database.one("SELECT * FROM action_triggers WHERE id='voice-rule'")
    assert saved["delay"] == 1.5
    assert saved["enabled"] == 1
    assert (
        json.loads(database.one("SELECT details FROM audit WHERE action='action_trigger.create'")["details"])["action"]
        == "stop_all"
    )
    database.execute("UPDATE action_triggers SET enabled=0 WHERE id='voice-rule'")
    assert not database.one("SELECT enabled FROM action_triggers WHERE id='voice-rule'")["enabled"]
    database.execute("DELETE FROM action_triggers WHERE id='voice-rule'")
    assert not database.rows("SELECT * FROM action_triggers")


def test_postgres_sound_rankings_survive_retention(database: Database) -> None:
    database.execute(
        "INSERT INTO clips(id,source_id,name,emoji,tags,start,end,volume,created_at) VALUES (?,?,?,?,?,?,?,?,?)",
        ("ranked", None, "Ranked", "", "[]", 0, 1, 1, time.time()),
    )
    for actor in ("100", "100", "200"):
        database.audit(actor, "sound.play", "ranked", guild_id="1352422295402057759")
    database.audit("100", "sound.play", "ranked", outcome="rejected", guild_id="1352422295402057759")
    database.audit("100", "sound.play", "ranked", guild_id="999")
    database.execute("DELETE FROM audit")
    database.conn.initialize()
    ranked = database.clips("100", "1352422295402057759")[0]
    assert ranked["play_count"] == 3
    assert ranked["user_play_count"] == 2


def test_postgres_shared_goose_library_preserves_settings(database: Database) -> None:
    database.set_setting("fun_settings", {"goose": True})
    body = Sketch.model_validate({"name": "Goose", "strokes": [{"color": "#ef3340", "points": [[0, 0], [150, 130]]}]})
    saved = change_library(database, body)
    assert resolve_sketch(database, saved["id"]) == saved
    updated = change_library(database, body.model_copy(update={"name": "Edited"}), saved["id"])
    assert database.setting("goose_sketches") == [updated]
    assert database.setting("fun_settings") == {"goose": True}
    change_library(database, None, saved["id"])
    assert database.setting("goose_sketches") == []


def test_postgres_personal_music_likes_persist_and_feed_downloads(database: Database) -> None:
    member = {"id": "200", "display_name": "Member"}
    other = {"id": "300", "display_name": "Other"}
    song = MusicTrack(provider="youtube", source_id="abcdefghijk", title="Song", duration=120).model_dump()
    store = MusicStore(database)
    first = store.set_like(member, song, liked=True)
    assert first["keys"] == ["youtube:abcdefghijk"]
    assert store.set_like(member, song, liked=True) == first
    assert store.like_summary(other)["total"] == 0
    assert json.loads(store.liked_cache_page("")[0]["tracks"]) == [song]
    database.conn.initialize()
    assert MusicStore(database).liked(member)["tracks"] == [song]
    assert store.set_like(member, song, liked=False)["total"] == 0
    assert store.liked(member)["tracks"] == []


def test_postgres_music_library_membership_search_and_idempotence(database: Database) -> None:
    user = {"id": "200", "display_name": "Member", "admin": False}
    database.execute(
        "INSERT INTO users(id,username,display_name,created_at,last_login) VALUES (?,?,?,?,?)",
        ("200", "member", "Member", time.time(), time.time()),
    )
    store = MusicStore(database)
    playlist = store.create("100%_beats!", user)
    song = MusicTrack(provider="youtube", source_id="abcdefghijk", title="Song", duration=120).model_dump()
    first = store.set_membership(playlist["id"], user, song, saved=True)
    assert store.set_membership(playlist["id"], user, song, saved=True) == first
    assert store.saved("youtube", "abcdefghijk") == {"saved": True}
    identities = [
        {"provider": "youtube", "source_id": "abcdefghijk"},
        {"provider": "spotify", "source_id": "abcdefghijk"},
        {"provider": "youtube", "source_id": "missing"},
    ]
    assert store.saved_tracks(identities * 2) == {"keys": ["youtube:abcdefghijk"]}
    page = store.library(user, ("youtube", "abcdefghijk"), "%_beats!", (0, 50))
    assert page["total"] == 1
    assert page["playlists"][0]["saved"] is True
    assert page["playlists"][0]["editable"] is True
    assert "tracks" not in page["playlists"][0]
    store.set_membership(playlist["id"], user, song, saved=False)
    assert store.saved("youtube", "abcdefghijk") == {"saved": False}
    assert store.saved_tracks(identities) == {"keys": []}


def test_postgres_legacy_upgrade_preserves_rows_and_initializes_totals(database: Database) -> None:
    database.execute(
        "DELETE FROM settings WHERE key IN (?,?,?)",
        (SCHEMA_VERSION_KEY, "activity_totals_initialized", "sound_play_totals_initialized"),
    )
    database.conn.raw.execute("ALTER TABLE clips ALTER COLUMN source_id SET NOT NULL")
    database.conn.raw.execute("ALTER TABLE conversation_triggers DROP COLUMN action, DROP COLUMN delay")
    database.conn.raw.execute("ALTER TABLE conversation_messages DROP COLUMN received_order")
    database.execute(
        "INSERT INTO users(id,username,display_name,created_at,last_login) VALUES (?,?,?,?,?)",
        ("100", "member", "Member", 1, 1),
    )
    database.execute(
        "INSERT INTO conversations(id,channel_id,channel_name,started_at) VALUES (?,?,?,?)",
        ("session", "123", "Voice", 1),
    )
    database.execute(
        "INSERT INTO conversation_messages(id,session_id,speaker_id,speaker_name,started_at,ended_at,text,language) "
        "VALUES (?,?,?,?,?,?,?,?)",
        ("message", "session", "100", "Member", 1, 2, "hello", "nl"),
    )
    database.execute(
        "INSERT INTO conversation_triggers(id,owner_id,clip_id,phrase,mode,target,speakers,cooldown,enabled,"
        "created_at) "
        "VALUES (?,?,?,?,?,?,?,?,?,?)",
        ("trigger", "100", "clip", "hello", "contains", "everyone", "[]", 5, 1, 1),
    )
    database.execute(
        "INSERT INTO audit(timestamp,actor_id,actor_name,action,resource_id,resource_name,outcome,guild_id,details) "
        "VALUES (?,?,?,?,?,?,?,?,?)",
        (1, "100", "Member", "sound.play", "clip", "Sound", "success", "1352422295402057759", "{}"),
    )
    database.conn.initialize()
    assert database.setting(SCHEMA_VERSION_KEY) == 1
    assert database.one("SELECT action,delay FROM conversation_triggers WHERE id='trigger'") == {
        "action": "play",
        "delay": 0,
    }
    assert database.one("SELECT text,received_order FROM conversation_messages WHERE id='message'") == {
        "text": "hello",
        "received_order": 1,
    }
    assert database.one("SELECT played FROM activity_totals WHERE actor_id='100'") == {"played": 1}
    assert database.one("SELECT played FROM sound_play_totals WHERE resource_id='clip'") == {"played": 1}
    database.execute(
        "INSERT INTO clips(id,source_id,name,emoji,tags,start,end,volume,created_at) VALUES (?,?,?,?,?,?,?,?,?)",
        ("uploaded", None, "Upload", "", "[]", 0, 1, 1, 1),
    )
    database.execute("DELETE FROM audit")
    database.conn.initialize()
    assert database.one("SELECT played FROM activity_totals WHERE actor_id='100'") == {"played": 1}
    assert database.one("SELECT played FROM sound_play_totals WHERE resource_id='clip'") == {"played": 1}


def test_postgres_failed_legacy_upgrade_rolls_back_schema_changes(database: Database) -> None:
    database.execute("DELETE FROM settings WHERE key=?", (SCHEMA_VERSION_KEY,))
    database.conn.raw.execute("ALTER TABLE conversation_triggers DROP COLUMN action, DROP COLUMN delay")
    with patch("app.database_schema.seed_totals", side_effect=RuntimeError), pytest.raises(RuntimeError):
        database.conn.initialize()
    columns = database.rows(
        "SELECT column_name FROM information_schema.columns WHERE table_schema=current_schema() "
        "AND table_name='conversation_triggers'"
    )
    assert not {"action", "delay"} & {row["column_name"] for row in columns}
    assert database.setting(SCHEMA_VERSION_KEY) is None
    database.conn.initialize()
    assert database.setting(SCHEMA_VERSION_KEY) == 1
