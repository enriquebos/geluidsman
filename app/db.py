from __future__ import annotations

import json
import sqlite3
import threading
import time
import uuid
from pathlib import Path
from typing import TYPE_CHECKING

import psycopg

from app.caption_matching import caption_match, search_tokens
from app.import_errors import import_guidance
from app.postgres import Connection

if TYPE_CHECKING:
    from app.types import JsonObject, JsonValue, SQLParameters


DATABASE_ERRORS = (sqlite3.Error, psycopg.Error)


def new_id() -> str:
    return uuid.uuid4().hex


class Database:
    def __init__(self, path: Path, url: str = "") -> None:
        if url:
            self.lock = threading.RLock()
            self.conn = Connection(url)
            self.conn.initialize()
            with self.lock, self.conn:
                self.recover_jobs()
            return
        path.parent.mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock()
        self.conn = sqlite3.connect(path, check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        with self.conn:
            self.conn.executescript(Path(__file__).with_name("schema_sqlite.sql").read_text(encoding="utf-8"))
            columns = {row["name"] for row in self.conn.execute("PRAGMA table_info(conversation_triggers)")}
            for name, definition in (
                ("action", "TEXT NOT NULL DEFAULT 'play'"),
                ("delay", "DOUBLE PRECISION NOT NULL DEFAULT 0"),
            ):
                if name not in columns:
                    self.conn.execute(f"ALTER TABLE conversation_triggers ADD COLUMN {name} {definition}")
            self.recover_jobs()

    def recover_jobs(self) -> None:
        for job in self.rows("SELECT * FROM jobs WHERE status IN ('queued','downloading','processing')"):
            self.insert_audit(job["actor_id"], "video.import", job["id"], job["url"], outcome="interrupted")
        self.conn.execute(
            "UPDATE jobs SET status='interrupted', error='Import interrupted. Retry to start again.' "
            "WHERE status IN ('queued','downloading','processing')"
        )
        self.conn.execute("UPDATE channel_batches SET status='paused' WHERE status IN ('discovering','running')")
        self.conn.execute("UPDATE channel_items SET status='queued' WHERE status='importing'")

    def import_details(self, job: dict) -> dict:
        title = job.get("title")
        if not title:
            item = self.one("SELECT title FROM channel_items WHERE job_id=?", (job["id"],))
            source = self.one("SELECT title FROM sources WHERE id=?", (job.get("source_id"),))
            requested = self.one(
                "SELECT resource_name FROM audit WHERE resource_id=? AND outcome='requested' ORDER BY id DESC LIMIT 1",
                (job["id"],),
            )
            title = (item or source or {}).get("title") or (requested or {}).get("resource_name") or job["url"]
        return {
            "job_id": job["id"],
            "title": title,
            "url": job["url"],
            "status": job["status"],
            "error": job.get("error"),
            "suggestion": import_guidance(job.get("error") or ""),
        }

    def insert_audit(
        self,
        actor_id: str | None,
        action: str,
        resource_id: str | None = None,
        name: str = "",
        *,
        outcome: str = "success",
        guild_id: str | None = None,
        details: dict | None = None,
    ) -> None:
        actor = self.one("SELECT display_name FROM users WHERE id=?", (actor_id,)) if actor_id else None
        details = dict(details or {})
        if action.startswith("sound.") and resource_id:
            clip = self.one("SELECT emoji FROM clips WHERE id=?", (resource_id,))
            if clip:
                details["emoji"] = clip["emoji"]
            else:
                previous = self.one(
                    "SELECT details FROM audit WHERE resource_id=? AND action LIKE 'sound.%' ORDER BY id DESC LIMIT 1",
                    (resource_id,),
                )
                if previous:
                    details["emoji"] = json.loads(previous["details"]).get("emoji", "")
        self.conn.execute(
            "INSERT INTO audit(timestamp,actor_id,actor_name,action,resource_id,resource_name,outcome,guild_id,"
            "details) "
            "VALUES (?,?,?,?,?,?,?,?,?)",
            (
                time.time(),
                actor_id,
                actor["display_name"] if actor else "System",
                action,
                resource_id,
                name,
                outcome,
                guild_id,
                json.dumps(details),
            ),
        )

        if (
            actor_id
            and outcome == "success"
            and action in {"sound.create", "sound.play"}
            and guild_id in {None, "1352422295402057759"}
        ):
            self.conn.execute(
                "INSERT INTO activity_totals(actor_id,name,created,played) VALUES (?,?,?,?) "
                "ON CONFLICT(actor_id) DO UPDATE SET name=excluded.name,"
                "created=activity_totals.created+excluded.created,played=activity_totals.played+excluded.played",
                (
                    actor_id,
                    actor["display_name"] if actor else "Unknown user",
                    int(action == "sound.create"),
                    int(action == "sound.play"),
                ),
            )

    def audit(
        self,
        actor_id: str | None,
        action: str,
        resource_id: str | None = None,
        name: str = "",
        *,
        outcome: str = "success",
        guild_id: str | None = None,
        details: dict | None = None,
    ) -> None:
        with self.lock, self.conn:
            self.insert_audit(actor_id, action, resource_id, name, outcome=outcome, guild_id=guild_id, details=details)

    def change(
        self,
        sql: str,
        args: SQLParameters,
        actor_id: str | None,
        action: str,
        *,
        resource_id: str,
        name: str,
        details: JsonObject | None = None,
    ) -> None:
        with self.lock, self.conn:
            self.conn.execute(sql, args)
            self.insert_audit(actor_id, action, resource_id, name, details=details)

    def rows(self, sql: str, args: SQLParameters = ()) -> list[JsonObject]:
        with self.lock:
            return [dict(r) for r in self.conn.execute(sql, args).fetchall()]

    def one(self, sql: str, args: SQLParameters = ()) -> JsonObject | None:
        rows = self.rows(sql, args)
        return rows[0] if rows else None

    def execute(self, sql: str, args: SQLParameters = ()) -> None:
        with self.lock, self.conn:
            self.conn.execute(sql, args)

    def sources(self) -> list[JsonObject]:
        with self.lock:
            sources = self.rows("SELECT * FROM sources ORDER BY created_at DESC")
            tracks = self.rows("SELECT id,source_id,language,kind,status,error FROM caption_tracks")
        grouped = {}
        for track in tracks:
            grouped.setdefault(track.pop("source_id"), []).append(track)
        for source in sources:
            source["captions"] = grouped.get(source["id"], [])
        return sources

    def save_source(self, source: dict, tracks: list[dict], actor_id: str | None = None) -> None:
        source_id = source["id"]
        with self.lock, self.conn:
            self.conn.execute(
                "INSERT INTO sources (id,url,title,duration,created_at,media_id,importer_id) VALUES (?,?,?,?,?,?,?) "
                "ON CONFLICT(id) DO UPDATE SET title=excluded.title,duration=excluded.duration,"
                "media_id=excluded.media_id",
                (
                    source_id,
                    source["url"],
                    source["title"],
                    source["duration"],
                    time.time(),
                    source["media_id"],
                    actor_id,
                ),
            )
            self.conn.execute("DELETE FROM caption_tracks WHERE source_id=?", (source_id,))
            for track in tracks:
                track_id = new_id()
                self.conn.execute(
                    "INSERT INTO caption_tracks VALUES (?,?,?,?,?,?)",
                    (track_id, source_id, track["language"], track["kind"], track["status"], track.get("error")),
                )
                for cue in track.get("cues", []):
                    cursor = self.conn.execute(
                        "INSERT INTO caption_cues (track_id,start,end,text,words) VALUES (?,?,?,?,?)",
                        (track_id, cue["start"], cue["end"], cue["text"], json.dumps(cue["words"])),
                    )
                    self.conn.execute(
                        "INSERT INTO caption_search(rowid,text) VALUES (?,?)", (cursor.lastrowid, cue["text"])
                    )
            if actor_id:
                self.insert_audit(actor_id, "video.saved", source_id, source["title"])

    def search_captions(self, query: str, language: str, source_id: str | None, offset: int, limit: int) -> list[dict]:
        tokens = search_tokens(query)
        if not tokens:
            return []
        sql = (
            "SELECT c.*, t.language,t.kind,t.source_id,s.title AS source_title FROM caption_search "
            "JOIN caption_cues c ON c.id=caption_search.rowid JOIN caption_tracks t ON t.id=c.track_id "
            "JOIN sources s ON s.id=t.source_id WHERE (?='all' OR t.language=?) "
            "AND (? IS NULL OR t.source_id=?) ORDER BY s.created_at DESC,c.start,c.id"
        )
        args = []
        if isinstance(self.conn, Connection):
            prefix = " <-> ".join(
                "'" + token + "'" + (":*" if i == len(tokens) - 1 else "") for i, token in enumerate(tokens)
            )
            sql = sql.replace(
                "WHERE ",
                "WHERE (caption_search.search_vector @@ "
                "to_tsquery('simple',public.unaccent(?)) OR lower(caption_search.text) %> lower(?)) AND ",
            )
            args = [prefix, " ".join(tokens)]
        rows = self.rows(sql, (*args, language, language, source_id, source_id))
        matches = []
        for row in rows:
            match = caption_match(row["text"], tokens)
            if match is None:
                continue
            score, first, last = match
            row["highlights"] = [[first, last]]
            row["precision"] = "caption"
            words = json.loads(row.pop("words"))
            for index in range(len(words)):
                selected = words[index : index + len(tokens)]
                if len(selected) == len(tokens) and caption_match(" ".join(w["text"] for w in selected), tokens):
                    row.update(
                        start=max(row["start"], selected[0]["start"]),
                        end=min(row["end"], selected[-1]["end"]),
                        precision="word",
                    )
                    break
            matches.append((score, row))
        matches.sort(key=lambda item: item[0])
        return [row for _, row in matches[offset : offset + limit]]

    def clips(self, user_id: str | None = None, guild_id: str | None = None) -> list[JsonObject]:
        rows = self.rows(
            "SELECT clips.*, COALESCE(sources.title, 'Uploaded audio') AS source_title, "
            "users.display_name AS creator_name, "
            "users.avatar AS creator_avatar FROM clips LEFT JOIN sources ON clips.source_id=sources.id "
            "LEFT JOIN users ON users.id=clips.creator_id ORDER BY clips.created_at DESC"
        )
        pinned = {
            row["clip_id"] for row in self.rows("SELECT clip_id FROM user_favourites WHERE user_id=?", (user_id,))
        }
        counts = {
            item["resource_id"]: item
            for item in self.rows(
                "SELECT resource_id, COUNT(*) AS play_count, "
                "SUM(CASE WHEN actor_id=? THEN 1 ELSE 0 END) AS user_play_count "
                "FROM audit WHERE action='sound.play' AND outcome='success' AND guild_id=? "
                "GROUP BY resource_id",
                (user_id, guild_id),
            )
        }
        for row in rows:
            usage = counts.get(row["id"], {})
            row["play_count"] = usage.get("play_count", 0)
            row["user_play_count"] = usage.get("user_play_count", 0)
            row["pinned"] = row["id"] in pinned
            row["tags"] = json.loads(row["tags"])
        return rows

    def jobs(self) -> list[JsonObject]:
        jobs = self.rows(
            "SELECT j.*,COALESCE(NULLIF(j.title,''),"
            "(SELECT NULLIF(title,'') FROM channel_items WHERE job_id=j.id LIMIT 1),"
            "(SELECT NULLIF(title,'') FROM sources WHERE id=j.source_id),"
            "(SELECT NULLIF(resource_name,'') FROM audit WHERE resource_id=j.id AND outcome='requested' "
            "ORDER BY id DESC LIMIT 1),j.url) AS resolved_title FROM jobs j "
            "WHERE NOT EXISTS (SELECT 1 FROM channel_items i "
            "JOIN channel_batches b ON b.id=i.batch_id WHERE i.job_id=j.id AND b.dismissed=1) "
            "ORDER BY j.created_at DESC LIMIT 50"
        )
        for job in jobs:
            job["title"] = job.pop("resolved_title")
            job["details"] = self.import_details(job)
            job["title"] = job["details"]["title"]
        return jobs

    def batches(self) -> list[dict]:
        batches = self.rows("SELECT * FROM channel_batches WHERE dismissed=0 ORDER BY created_at DESC LIMIT 20")
        if not batches:
            return batches
        counts = self.rows(
            "SELECT batch_id,status,count(*) AS count FROM channel_items WHERE batch_id IN "
            "(SELECT id FROM channel_batches WHERE dismissed=0 ORDER BY created_at DESC LIMIT 20) "
            "GROUP BY batch_id,status"
        )
        current = self.rows(
            "SELECT batch_id,title,url FROM channel_items WHERE status='importing' AND batch_id IN "
            "(SELECT id FROM channel_batches WHERE dismissed=0 ORDER BY created_at DESC LIMIT 20)"
        )
        grouped = {}
        for row in counts:
            grouped.setdefault(row["batch_id"], {})[row["status"]] = row["count"]
        active = {row.pop("batch_id"): row for row in current}
        for batch in batches:
            batch["counts"] = grouped.get(batch["id"], {})
            batch["total"] = sum(batch["counts"].values())
            batch["current"] = active.get(batch["id"])
        return batches

    def add_job(self, url: str, actor_id: str | None = None) -> str:
        job_id = new_id()
        self.execute(
            "INSERT INTO jobs (id,url,status,created_at,actor_id) VALUES (?,?,?,?,?)",
            (job_id, url, "queued", time.time(), actor_id),
        )
        return job_id

    def setting(self, key: str, default: JsonValue = None) -> JsonValue:
        row = self.one("SELECT value FROM settings WHERE key=?", (key,))
        return json.loads(row["value"]) if row else default

    def set_setting(self, key: str, value: JsonValue) -> None:
        self.execute("INSERT OR REPLACE INTO settings VALUES (?,?)", (key, json.dumps(value)))

    def close(self) -> None:
        with self.lock:
            self.conn.close()
