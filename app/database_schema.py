from __future__ import annotations

import json
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    import sqlite3

    from app.postgres import Connection

MEDIA_SCHEMA_VERSION = 2
PERMISSION_SCHEMA_VERSION = 3
SCHEMA_VERSION = PERMISSION_SCHEMA_VERSION
SCHEMA_VERSION_KEY = "database_schema_version"


def schema_version(connection: sqlite3.Connection | Connection, *, postgres: bool) -> int:
    query = (
        "SELECT to_regclass('settings') AS name"
        if postgres
        else "SELECT name FROM sqlite_master WHERE type='table' AND name='settings'"
    )
    tables = connection.execute(query).fetchall()
    if not tables or not tables[0]["name"]:
        return 0
    rows = connection.execute("SELECT value FROM settings WHERE key=?", (SCHEMA_VERSION_KEY,)).fetchall()
    return int(rows[0]["value"]) if rows else 0


def upgrade_columns(connection: sqlite3.Connection | Connection, *, postgres: bool) -> None:
    if postgres:
        rows = connection.execute(
            "SELECT table_name,column_name,is_nullable FROM information_schema.columns "
            "WHERE table_schema=current_schema() AND table_name IN "
            "('clips','conversation_messages','conversation_triggers')"
        ).fetchall()
        columns = {(row["table_name"], row["column_name"]): row["is_nullable"] for row in rows}
        if columns.get(("clips", "source_id")) == "NO":
            connection.execute("ALTER TABLE clips ALTER COLUMN source_id DROP NOT NULL")
    else:
        columns = {
            (table, row["name"]): None
            for table in ("conversation_messages", "conversation_triggers")
            for row in connection.execute(f"PRAGMA table_info({table})").fetchall()
        }
    for table, column, definition in (
        ("conversation_messages", "received_order", "BIGSERIAL" if postgres else "INTEGER"),
        ("conversation_triggers", "action", "TEXT NOT NULL DEFAULT 'play'"),
        ("conversation_triggers", "delay", "DOUBLE PRECISION NOT NULL DEFAULT 0"),
    ):
        if (table, column) not in columns and any(name == table for name, _ in columns):
            connection.execute(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")
            if table == "conversation_messages" and not postgres:
                connection.execute("UPDATE conversation_messages SET received_order=rowid")


def seed_totals(connection: sqlite3.Connection | Connection) -> None:
    for marker, query in (
        (
            "activity_totals_initialized",
            (
                "INSERT INTO activity_totals(actor_id,name,created,played) "
                "SELECT actor_id,MAX(actor_name),SUM(CASE WHEN action='sound.create' THEN 1 ELSE 0 END),"
                "SUM(CASE WHEN action='sound.play' THEN 1 ELSE 0 END) "
                "FROM audit WHERE actor_id IS NOT NULL AND outcome='success' "
                "AND action IN ('sound.create','sound.play') "
                "AND (guild_id IS NULL OR guild_id='1352422295402057759') GROUP BY actor_id "
                "ON CONFLICT(actor_id) DO NOTHING"
            ),
        ),
        (
            "sound_play_totals_initialized",
            (
                "INSERT INTO sound_play_totals(resource_id,actor_id,guild_id,played) "
                "SELECT resource_id,COALESCE(actor_id,''),COALESCE(guild_id,'1352422295402057759'),COUNT(*) "
                "FROM audit WHERE action='sound.play' AND outcome='success' AND resource_id IS NOT NULL "
                "GROUP BY resource_id,COALESCE(actor_id,''),COALESCE(guild_id,'1352422295402057759') "
                "ON CONFLICT(resource_id,actor_id,guild_id) DO NOTHING"
            ),
        ),
    ):
        if not connection.execute("SELECT key FROM settings WHERE key=?", (marker,)).fetchall():
            connection.execute(query)
            connection.execute("INSERT INTO settings(key,value) VALUES (?,?)", (marker, "true"))


def upgrade_media_columns(connection: sqlite3.Connection | Connection, *, postgres: bool) -> None:
    for table, definitions in (
        ("sources", {"media_available": "INTEGER NOT NULL DEFAULT 1"}),
        (
            "jobs",
            {
                "downloaded_bytes": "BIGINT NOT NULL DEFAULT 0",
                "total_bytes": "BIGINT",
                "total_estimated": "INTEGER NOT NULL DEFAULT 0",
            },
        ),
    ):
        rows = (
            connection.execute(
                "SELECT column_name AS name FROM information_schema.columns "
                "WHERE table_schema=current_schema() AND table_name=?",
                (table,),
            ).fetchall()
            if postgres
            else connection.execute(f"PRAGMA table_info({table})").fetchall()
        )
        columns = {row["name"] for row in rows}
        for column, definition in definitions.items():
            if columns and column not in columns:
                connection.execute(f"ALTER TABLE {table} ADD COLUMN {column} {definition}")


def merge_voice_permissions(connection: sqlite3.Connection | Connection) -> None:
    for row in connection.execute("SELECT id,permission_overrides FROM users").fetchall():
        overrides = json.loads(row["permission_overrides"])
        legacy = [overrides.pop(key) for key in ("play_outside_voice", "always_live_conversation") if key in overrides]
        if legacy:
            overrides.setdefault("outside_voice_control", any(legacy))
            connection.execute("UPDATE users SET permission_overrides=? WHERE id=?", (json.dumps(overrides), row["id"]))


def initialize_schema(connection: sqlite3.Connection | Connection, *, postgres: bool) -> None:
    version = schema_version(connection, postgres=postgres)
    if version > SCHEMA_VERSION:
        message = "Database schema is newer than this application supports"
        raise RuntimeError(message)
    if version < MEDIA_SCHEMA_VERSION:
        upgrade_columns(connection, postgres=postgres)
    if version < MEDIA_SCHEMA_VERSION:
        upgrade_media_columns(connection, postgres=postgres)
    filename = "schema.sql" if postgres else "schema_sqlite.sql"
    connection.executescript(Path(__file__).with_name(filename).read_text(encoding="utf-8"))
    if version < PERMISSION_SCHEMA_VERSION:
        merge_voice_permissions(connection)
    if version < SCHEMA_VERSION:
        seed_totals(connection)
        connection.execute(
            "INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (SCHEMA_VERSION_KEY, str(SCHEMA_VERSION)),
        )
