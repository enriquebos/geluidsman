from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from unittest.mock import patch

import pytest

from app.database_schema import SCHEMA_VERSION, SCHEMA_VERSION_KEY, initialize_schema
from app.db import Database


def legacy_database(path: Path) -> sqlite3.Connection:
    connection = sqlite3.connect(path)
    connection.row_factory = sqlite3.Row
    schema = Path(__file__).parents[1].joinpath("app/schema_sqlite.sql").read_text()
    schema = schema.replace(
        "    action TEXT NOT NULL DEFAULT 'play', delay DOUBLE PRECISION NOT NULL DEFAULT 0,\n", ""
    ).replace(
        "CREATE UNIQUE INDEX IF NOT EXISTS conversation_sound_unique "
        "ON conversation_triggers(clip_id) WHERE action='play';",
        "",
    )
    schema = schema.replace(
        "CREATE TRIGGER IF NOT EXISTS conversation_messages_received_insert AFTER INSERT ON conversation_messages\n"
        "BEGIN\nUPDATE conversation_messages SET received_order=NEW.rowid WHERE id=NEW.id;\nEND;",
        "",
    ).replace(
        "CREATE INDEX IF NOT EXISTS conversation_messages_received "
        "ON conversation_messages(session_id,received_order);",
        "",
    )
    schema = schema.replace(", received_order INTEGER", "")
    connection.executescript(schema)
    connection.execute(
        "INSERT INTO users(id,username,display_name,created_at,last_login,preferences) VALUES (?,?,?,?,?,?)",
        ("100", "member", "Member", 1, 1, '{"preview_volume":0.4}'),
    )
    connection.execute(
        "INSERT INTO conversations(id,channel_id,channel_name,started_at) VALUES (?,?,?,?)",
        ("session", "123", "Voice", 1),
    )
    for identity in ("first", "second"):
        connection.execute(
            "INSERT INTO conversation_messages(id,session_id,speaker_id,speaker_name,started_at,ended_at,"
            "text,language) "
            "VALUES (?,?,?,?,?,?,?,?)",
            (identity, "session", "100", "Member", 1, 2, identity, "nl"),
        )
    connection.execute(
        "INSERT INTO conversation_triggers(id,owner_id,clip_id,phrase,mode,target,speakers,cooldown,enabled,"
        "created_at) "
        "VALUES (?,?,?,?,?,?,?,?,?,?)",
        ("trigger", "100", "clip", "hello", "contains", "everyone", "[]", 5, 1, 1),
    )
    for action, actor, guild, outcome in (
        ("sound.create", "100", None, "success"),
        ("sound.play", "100", None, "success"),
        ("sound.play", "100", "1352422295402057759", "success"),
        ("sound.play", None, "1352422295402057759", "success"),
        ("sound.play", "100", "1352422295402057759", "rejected"),
        ("sound.play", "100", "another", "success"),
    ):
        connection.execute(
            "INSERT INTO audit(timestamp,actor_id,actor_name,action,resource_id,resource_name,outcome,guild_id,"
            "details) "
            "VALUES (?,?,?,?,?,?,?,?,?)",
            (1, actor, "Member", action, "clip", "Sound", outcome, guild, "{}"),
        )
    connection.commit()
    return connection


def test_legacy_sqlite_upgrades_columns_before_dependent_indexes_and_preserves_data(tmp_path: Path) -> None:
    path = tmp_path / "legacy.sqlite3"
    original = legacy_database(path)
    account = dict(original.execute("SELECT * FROM users").fetchone())
    audit = [dict(row) for row in original.execute("SELECT * FROM audit")]
    original.close()
    database = Database(path)
    assert database.one("SELECT * FROM users") == account
    assert database.rows("SELECT * FROM audit") == audit
    trigger = database.one("SELECT * FROM conversation_triggers")
    assert trigger["action"] == "play"
    assert trigger["delay"] == 0
    messages = database.rows("SELECT * FROM conversation_messages ORDER BY received_order")
    assert [row["id"] for row in messages] == ["first", "second"]
    assert [row["received_order"] for row in messages] == [1, 2]
    with pytest.raises(sqlite3.IntegrityError):
        database.execute(
            "INSERT INTO conversation_triggers SELECT 'duplicate',owner_id,clip_id,phrase,mode,target,speakers,"
            "cooldown,enabled,created_at,action,delay FROM conversation_triggers"
        )
    assert database.one("SELECT * FROM activity_totals") == {
        "actor_id": "100",
        "name": "Member",
        "created": 1,
        "played": 2,
    }
    assert database.one(
        "SELECT played FROM sound_play_totals WHERE actor_id='100' AND guild_id='1352422295402057759'"
    ) == {"played": 2}
    assert database.setting(SCHEMA_VERSION_KEY) == SCHEMA_VERSION
    assert database.setting("activity_totals_initialized") is True
    assert database.setting("sound_play_totals_initialized") is True
    database.close()


@pytest.mark.parametrize("initialized", [False, True])
def test_upgrade_preserves_existing_totals_and_does_not_replay_marked_backfills(
    tmp_path: Path, *, initialized: bool
) -> None:
    path = tmp_path / "legacy.sqlite3"
    original = legacy_database(path)
    original.execute("INSERT INTO activity_totals(actor_id,name,created,played) VALUES ('100','Member',50,90)")
    original.execute(
        "INSERT INTO sound_play_totals(resource_id,actor_id,guild_id,played) VALUES (?,?,?,?)",
        ("clip", "100", "1352422295402057759", 90),
    )
    if initialized:
        for marker in ("activity_totals_initialized", "sound_play_totals_initialized"):
            original.execute("INSERT INTO settings(key,value) VALUES (?,?)", (marker, "true"))
    original.commit()
    original.close()
    database = Database(path)
    assert database.one("SELECT created,played FROM activity_totals WHERE actor_id='100'") == {
        "created": 50,
        "played": 90,
    }
    assert database.one(
        "SELECT played FROM sound_play_totals WHERE actor_id='100' AND guild_id='1352422295402057759'"
    ) == {"played": 90}
    assert bool(database.one("SELECT played FROM sound_play_totals WHERE actor_id=''")) is not initialized
    database.execute("DELETE FROM audit")
    totals = database.rows("SELECT * FROM sound_play_totals ORDER BY actor_id,guild_id")
    database.close()
    database = Database(path)
    assert database.rows("SELECT * FROM sound_play_totals ORDER BY actor_id,guild_id") == totals
    assert database.one("SELECT played FROM activity_totals WHERE actor_id='100'") == {"played": 90}
    database.close()


def test_current_database_initialization_skips_legacy_alters_and_audit_backfills(tmp_path: Path) -> None:
    database = Database(tmp_path / "current.sqlite3")
    statements = []
    database.conn.set_trace_callback(statements.append)
    with database.conn:
        initialize_schema(database.conn, postgres=False)
    assert not any("ALTER TABLE" in statement for statement in statements)
    assert not any("FROM audit" in statement for statement in statements)
    assert not any("PRAGMA table_info" in statement for statement in statements)
    database.close()


def test_future_schema_version_is_rejected_without_changing_data(tmp_path: Path) -> None:
    path = tmp_path / "future.sqlite3"
    database = Database(path)
    database.set_setting(SCHEMA_VERSION_KEY, SCHEMA_VERSION + 1)
    database.set_setting("preserved", {"queue": ["song"]})
    database.close()
    with pytest.raises(RuntimeError, match="newer"):
        Database(path)
    with sqlite3.connect(path) as connection:
        assert json.loads(connection.execute("SELECT value FROM settings WHERE key='preserved'").fetchone()[0]) == {
            "queue": ["song"]
        }


def test_failed_sqlite_initialization_closes_connection(tmp_path: Path) -> None:
    path = tmp_path / "failed.sqlite3"
    connection = sqlite3.connect(path)
    with (
        patch("app.db.sqlite3.connect", return_value=connection),
        patch("app.db.initialize_schema", side_effect=RuntimeError),
        pytest.raises(RuntimeError),
    ):
        Database(path)
    with pytest.raises(sqlite3.ProgrammingError, match="closed"):
        connection.execute("SELECT 1")


def test_sqlite_media_upgrade_preserves_legacy_data_and_markers(tmp_path: Path) -> None:
    path = tmp_path / "media.sqlite3"
    database = Database(path)
    database.execute(
        "INSERT INTO sources(id,url,title,duration,created_at) VALUES (?,?,?,?,?)",
        ("source", "https://example.com", "Original", 10, 1),
    )
    identity = database.add_job("https://example.com")
    database.set_setting("app_settings", {"max_storage_bytes": 321})
    database.set_setting(SCHEMA_VERSION_KEY, 1)
    database.execute("ALTER TABLE sources DROP COLUMN media_available")
    for column in ("downloaded_bytes", "total_bytes", "total_estimated"):
        database.execute("ALTER TABLE jobs DROP COLUMN " + column)
    database.execute("DROP TABLE media_usage")
    database.close()
    restored = Database(path)
    assert restored.one("SELECT title,media_available FROM sources") == {"title": "Original", "media_available": 1}
    assert restored.one("SELECT downloaded_bytes,total_bytes FROM jobs WHERE id=?", (identity,)) == {
        "downloaded_bytes": 0,
        "total_bytes": None,
    }
    assert restored.setting("app_settings") == {"max_storage_bytes": 321}
    assert restored.setting("activity_totals_initialized") is True
    assert restored.setting("sound_play_totals_initialized") is True
    assert restored.rows("SELECT * FROM media_usage") == []
    restored.close()


@pytest.mark.parametrize(
    ("legacy", "expected"),
    [
        ({}, {}),
        ({"play_outside_voice": True}, {"outside_voice_control": True}),
        ({"always_live_conversation": True}, {"outside_voice_control": True}),
        ({"play_outside_voice": False}, {"outside_voice_control": False}),
        (
            {"play_outside_voice": False, "always_live_conversation": True},
            {"outside_voice_control": True},
        ),
        (
            {"play_outside_voice": True, "outside_voice_control": False},
            {"outside_voice_control": False},
        ),
    ],
)
def test_voice_permissions_migrate_once_without_changing_other_data(
    tmp_path: Path, legacy: dict, expected: dict
) -> None:
    path = tmp_path / "permissions.sqlite3"
    database = Database(path)
    database.execute(
        "INSERT INTO users(id,username,display_name,created_at,last_login,permission_overrides) "
        "VALUES ('100','member','Member',1,2,?)",
        (json.dumps({**legacy, "play_sounds": False}),),
    )
    database.set_setting(SCHEMA_VERSION_KEY, 2)
    database.set_setting("retained_queue", ["first", "second"])
    database.close()
    database = Database(path)
    account = database.one("SELECT * FROM users WHERE id='100'")
    assert json.loads(account["permission_overrides"]) == {**expected, "play_sounds": False}
    assert account["last_login"] == 2
    assert database.setting("retained_queue") == ["first", "second"]
    assert database.setting("activity_totals_initialized") is True
    assert database.setting("sound_play_totals_initialized") is True
    assert database.setting(SCHEMA_VERSION_KEY) == SCHEMA_VERSION
    database.execute("UPDATE users SET permission_overrides='{}' WHERE id='100'")
    database.close()
    database = Database(path)
    assert database.one("SELECT permission_overrides FROM users WHERE id='100'")["permission_overrides"] == "{}"
    database.close()
