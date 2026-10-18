from __future__ import annotations

import json
import math
import time
from typing import TYPE_CHECKING
from urllib.parse import urlsplit, urlunsplit

from fastapi import HTTPException

from app.db import new_id
from app.postgres import Connection

if TYPE_CHECKING:
    from app.db import Database

MAX_PLAYLIST_TRACKS = 1000
MAX_PLAYLISTS = 100
MAX_ARTWORK_URL = 2048


class MusicStore:
    def __init__(self, db: Database) -> None:
        self.db = db

    def load_player(self) -> dict:
        return self.db.setting("music_player", {})

    def save_player(self, value: dict) -> None:
        self.db.set_setting("music_player", value)

    def liked(self, user: dict) -> dict:
        value = self.db.setting("music_likes:" + user["id"], {})
        return {
            "id": "liked",
            "name": "Liked Songs",
            "creator_id": user["id"],
            "creator_name": user["display_name"],
            "collaborative": False,
            "liked": True,
            "tracks": value.get("tracks", []),
            "track_count": len(value.get("tracks", [])),
            "created_at": value.get("created_at", 0),
            "updated_at": value.get("updated_at", 0),
        }

    def like_summary(self, user: dict) -> dict:
        row = self.liked(user)
        return {
            "keys": [track["provider"] + ":" + track["source_id"] for track in row["tracks"]],
            "total": row["track_count"],
            "updated_at": row["updated_at"],
        }

    def set_like(self, user: dict, track: dict, *, liked: bool) -> dict:
        with self.db.lock, self.db.conn:
            row = self.liked(user)
            tracks = row["tracks"]
            key = track["provider"], track["source_id"]
            exists = any((item["provider"], item["source_id"]) == key for item in tracks)
            if exists == liked:
                return self.like_summary(user)
            if liked:
                if len(tracks) >= MAX_PLAYLIST_TRACKS:
                    raise HTTPException(409, "You can like up to 1,000 songs. Remove a like to make room.")
                tracks.insert(0, track)
            else:
                tracks = [item for item in tracks if (item["provider"], item["source_id"]) != key]
            now = time.time()
            self.db.set_setting(
                "music_likes:" + user["id"],
                {"tracks": tracks, "created_at": row["created_at"] or now, "updated_at": now},
            )
            return self.like_summary(user)

    def liked_cache_page(self, after: str) -> list[dict]:
        rows = self.db.rows(
            "SELECT key AS id,value FROM settings WHERE key LIKE 'music_likes:%' AND key>? ORDER BY key LIMIT 5",
            (after,),
        )
        return [{"id": row["id"], "tracks": json.dumps(json.loads(row["value"])["tracks"])} for row in rows]

    def cache_page(self, after: str) -> list[dict]:
        return self.db.rows("SELECT id,tracks FROM music_playlists WHERE id>? ORDER BY id LIMIT 5", (after,))

    def playlists(self, user_id: str, offset: int = 0, limit: int = 50, *, editable_by: dict | None = None) -> dict:
        restrict = int(editable_by is not None and not editable_by["admin"])
        artwork = (
            "jsonb_path_query_array(p.tracks::jsonb, '$[0 to 3].thumbnail')::text"
            if isinstance(self.db.conn, Connection)
            else "(SELECT json_group_array(json_extract(value, '$.thumbnail')) FROM json_each(p.tracks) WHERE key<4)"
        )
        query = (
            "SELECT p.id,p.name,p.creator_id,p.collaborative,p.track_count,p.created_at,p.updated_at,"
            "{artwork} AS artwork,u.display_name AS creator_name "
            "FROM music_playlists p JOIN users u ON u.id=p.creator_id "
            "WHERE (?=0 OR p.creator_id=? OR p.collaborative=1) "
            "ORDER BY CASE WHEN p.creator_id=? THEN 0 ELSE 1 END,p.updated_at DESC,p.id LIMIT ? OFFSET ?"
        ).replace("{artwork}", artwork)
        rows = self.db.rows(
            query,
            (restrict, user_id, user_id, limit, offset),
        )
        for row in rows:
            row["artwork"] = self.artwork(json.loads(row["artwork"]))
            row["tracks"] = []
            row["collaborative"] = bool(row["collaborative"])
        count = self.db.one(
            "SELECT COUNT(*) AS total FROM music_playlists WHERE (?=0 OR creator_id=? OR collaborative=1)",
            (restrict, user_id),
        )
        return {"playlists": rows, "total": count["total"], "offset": offset, "limit": limit}

    @staticmethod
    def artwork(values: list) -> list[str]:
        result = []
        for value in values[:4]:
            if not isinstance(value, str) or len(value) > MAX_ARTWORK_URL:
                continue
            try:
                parsed = urlsplit(value)
            except ValueError:
                continue
            if parsed.scheme == "https" and parsed.hostname in {"i.ytimg.com", "i.scdn.co", "mosaic.scdn.co"}:
                source = urlunsplit(("https", parsed.hostname, parsed.path, "", ""))
                if source not in result:
                    result.append(source)
        return result

    def playlist(self, playlist_id: str) -> dict:
        row = self.db.one(
            "SELECT p.*,u.display_name AS creator_name FROM music_playlists p JOIN users u ON u.id=p.creator_id "
            "WHERE p.id=?",
            (playlist_id,),
        )
        if not row:
            raise HTTPException(404, "Playlist not found.")
        row["tracks"] = json.loads(row["tracks"])
        row["collaborative"] = bool(row["collaborative"])
        return row

    def membership_sql(self) -> str:
        if isinstance(self.db.conn, Connection):
            return (
                "EXISTS(SELECT 1 FROM jsonb_array_elements(p.tracks::jsonb) t "
                "WHERE t->>'provider'=? AND t->>'source_id'=?)"
            )
        return (
            "EXISTS(SELECT 1 FROM json_each(p.tracks) t "
            "WHERE json_extract(t.value,'$.provider')=? AND json_extract(t.value,'$.source_id')=?)"
        )

    def saved(self, provider: str, source_id: str) -> dict:
        row = self.db.one(
            "SELECT EXISTS(SELECT 1 FROM music_playlists p WHERE {membership}) AS saved".replace(
                "{membership}", self.membership_sql()
            ),
            (provider, source_id),
        )
        return {"saved": bool(row["saved"])}

    def saved_tracks(self, tracks: list[dict]) -> dict:
        if isinstance(self.db.conn, Connection):
            query = (
                "WITH requested AS (SELECT t->>'provider' AS provider,t->>'source_id' AS source_id "
                "FROM jsonb_array_elements(?::jsonb) t) "
                "SELECT DISTINCT r.provider,r.source_id FROM music_playlists p "
                "CROSS JOIN LATERAL jsonb_array_elements(p.tracks::jsonb) t "
                "JOIN requested r ON t->>'provider'=r.provider AND t->>'source_id'=r.source_id"
            )
        else:
            query = (
                "WITH requested AS (SELECT json_extract(value,'$.provider') AS provider,"
                "json_extract(value,'$.source_id') AS source_id FROM json_each(?)) "
                "SELECT DISTINCT r.provider,r.source_id FROM music_playlists p "
                "JOIN json_each(p.tracks) t JOIN requested r "
                "ON json_extract(t.value,'$.provider')=r.provider AND json_extract(t.value,'$.source_id')=r.source_id"
            )
        rows = self.db.rows(query, (json.dumps(tracks),))
        return {"keys": [row["provider"] + ":" + row["source_id"] for row in rows]}

    def library(self, user: dict, identity: tuple[str, str], query: str, page: tuple[int, int]) -> dict:
        pattern = "%" + query.lower().replace("!", "!!").replace("%", "!%").replace("_", "!_") + "%"
        rows = self.db.rows(
            "SELECT p.id,p.name,p.creator_id,p.collaborative,p.track_count,p.updated_at,"
            "u.display_name AS creator_name," + self.membership_sql() + " AS saved "
            "FROM music_playlists p JOIN users u ON u.id=p.creator_id WHERE lower(p.name) LIKE ? ESCAPE '!' "
            "ORDER BY saved DESC,CASE WHEN p.creator_id=? THEN 0 ELSE 1 END,p.updated_at DESC,p.id LIMIT ? OFFSET ?",
            (*identity, pattern, user["id"], page[1], page[0]),
        )
        for row in rows:
            row["saved"] = bool(row["saved"])
            row["editable"] = bool(row["collaborative"] or self.owner(row, user))
        count = self.db.one(
            "SELECT COUNT(*) AS total FROM music_playlists WHERE lower(name) LIKE ? ESCAPE '!'", (pattern,)
        )
        return {"playlists": rows, "total": count["total"], "offset": page[0], "limit": page[1]}

    def set_membership(self, playlist_id: str, user: dict, track: dict, *, saved: bool) -> dict:
        with self.db.lock, self.db.conn:
            row = self.playlist(playlist_id)
            self.editable(row, user)
            identity = track["provider"], track["source_id"]
            tracks = row["tracks"]
            found = any((value["provider"], value["source_id"]) == identity for value in tracks)
            if saved != found:
                tracks = (
                    [*tracks, track]
                    if saved
                    else [value for value in tracks if (value["provider"], value["source_id"]) != identity]
                )
                row = self.update(playlist_id, user, {"tracks": tracks, "expected_updated_at": row["updated_at"]})
            return {"saved": saved, "track_count": len(row["tracks"]), "updated_at": row["updated_at"]}

    @staticmethod
    def owner(row: dict, user: dict) -> bool:
        return row["creator_id"] == user["id"] or user["admin"]

    def editable(self, row: dict, user: dict) -> None:
        if not self.owner(row, user) and not row["collaborative"]:
            raise HTTPException(403, "Only the creator or admins can edit this playlist.")

    def create(self, name: str, user: dict, *, collaborative: bool = False) -> dict:
        with self.db.lock, self.db.conn:
            count = self.db.one("SELECT COUNT(*) AS total FROM music_playlists WHERE creator_id=?", (user["id"],))
            if count["total"] >= MAX_PLAYLISTS:
                raise HTTPException(409, "You can create up to 100 playlists.")
            playlist_id = new_id()
            now = time.time()
            self.db.execute(
                "INSERT INTO music_playlists(id,name,creator_id,collaborative,tracks,created_at,updated_at) "
                "VALUES (?,?,?,?,?,?,?)",
                (playlist_id, name, user["id"], int(collaborative), "[]", now, now),
            )
            return self.playlist(playlist_id)

    def update(self, playlist_id: str, user: dict, changes: dict, *, append: bool = False) -> dict:
        with self.db.lock, self.db.conn:
            row = self.playlist(playlist_id)
            self.editable(row, user)
            if "collaborative" in changes and not self.owner(row, user):
                raise HTTPException(403, "Only the creator or admins can change playlist sharing.")
            if changes.get("expected_updated_at", row["updated_at"]) != row["updated_at"]:
                raise HTTPException(409, "This playlist changed. Review the refreshed playlist and try again.")
            tracks = changes.get("tracks", row["tracks"])
            if append:
                tracks = [*row["tracks"], *tracks]
            if len(tracks) > MAX_PLAYLIST_TRACKS:
                raise HTTPException(409, "A playlist can contain up to 1,000 songs.")
            changed = self.db.one(
                "UPDATE music_playlists SET name=?,collaborative=?,tracks=?,track_count=?,updated_at=? "
                "WHERE id=? AND updated_at=? RETURNING id",
                (
                    changes.get("name", row["name"]),
                    int(changes.get("collaborative", row["collaborative"])),
                    json.dumps(tracks),
                    len(tracks),
                    max(time.time(), math.nextafter(row["updated_at"], math.inf)),
                    playlist_id,
                    row["updated_at"],
                ),
            )
            if not changed:
                raise HTTPException(409, "This playlist changed. Review the refreshed playlist and try again.")
            return self.playlist(playlist_id)

    def delete(self, playlist_id: str, user: dict) -> None:
        with self.db.lock, self.db.conn:
            row = self.playlist(playlist_id)
            if not self.owner(row, user):
                raise HTTPException(403, "Only the creator or admins can delete a playlist.")
            self.db.execute("DELETE FROM music_playlists WHERE id=?", (playlist_id,))

    def append(self, playlist_id: str, user: dict, tracks: list[dict]) -> dict:
        return self.update(playlist_id, user, {"tracks": tracks}, append=True)

    def track_for_edit(self, playlist_id: str, index: int, user: dict, expected_updated_at: float) -> dict:
        with self.db.lock, self.db.conn:
            row = self.playlist(playlist_id)
            self.editable(row, user)
            if row["updated_at"] != expected_updated_at:
                raise HTTPException(409, "This playlist changed. Refresh it before editing the song.")
            if index < 0 or index >= len(row["tracks"]):
                raise HTTPException(404, "Playlist song not found.")
            return row["tracks"][index]

    def update_track(self, playlist_id: str, index: int, user: dict, changes: dict) -> dict:
        with self.db.lock, self.db.conn:
            self.track_for_edit(playlist_id, index, user, changes["expected_updated_at"])
            row = self.playlist(playlist_id)
            row["tracks"][index] = changes["track"]
            return self.update(
                playlist_id, user, {"tracks": row["tracks"], "expected_updated_at": changes["expected_updated_at"]}
            )
