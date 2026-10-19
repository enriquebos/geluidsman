from __future__ import annotations

import asyncio
import json
import shutil
import time
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from pathlib import Path

    from fastapi import FastAPI, Request

from fastapi import HTTPException

from app.auth import authorize_admin
from app.storage import fingerprint


def files_in(root: Path) -> list[dict]:
    if not root.is_dir():
        return []
    result = []
    for path in root.rglob("*"):
        if path.is_file() and not path.is_symlink():
            try:
                stat = path.stat()
                result.append({"name": str(path.relative_to(root)), "bytes": stat.st_size, "version": stat.st_mtime_ns})
            except FileNotFoundError:
                continue
    return result


class MediaManagement:
    def __init__(self, app: FastAPI) -> None:
        self.app = app
        self.lock = asyncio.Lock()
        self.scan = None
        self.clients = {}
        self.leases = {}
        self.lease_sequences = {}
        self.used_pending = {}
        self.used_task = None

    def touch(self, resource_id: str) -> None:
        self.used_pending[resource_id] = time.time()
        if not self.used_task or self.used_task.done():
            self.used_task = asyncio.create_task(self.flush_usage())

    async def flush_usage(self) -> None:
        while self.used_pending:
            values, self.used_pending = self.used_pending, {}
            await self.app.state.db.run(self.write_usage, values)
        self.app.state.events.publish("storage")

    def write_usage(self, values: dict) -> None:
        db = self.app.state.db
        with db.lock, db.conn:
            for key, stamp in values.items():
                db.conn.execute(
                    "INSERT INTO media_usage(resource_id,last_used) VALUES (?,?) "
                    "ON CONFLICT(resource_id) DO UPDATE SET last_used=excluded.last_used",
                    (key, stamp),
                )

    def connect(self, client_id: str, user_id: str, *, connected: bool) -> None:
        now = time.monotonic()
        changed = client_id not in self.clients or self.clients[client_id][0] != user_id or not connected
        self.clients[client_id] = (user_id, now + (45 if connected else 60))
        self.prune_clients()
        if changed:
            self.app.state.events.publish("storage")

    def prune_clients(self) -> None:
        now = time.monotonic()
        expired = any(value[1] <= now for value in self.clients.values())
        self.clients = {key: value for key, value in self.clients.items() if value[1] > now}
        self.leases = {key: value for key, value in self.leases.items() if key in self.clients}
        self.lease_sequences = {key: value for key, value in self.lease_sequences.items() if key in self.clients}
        if expired:
            self.app.state.events.publish("storage")

    def lease(self, client_id: str, user_id: str, source: dict | None) -> None:
        self.prune_clients()
        if self.clients.get(client_id, (None,))[0] != user_id:
            raise HTTPException(409, "Reconnect before opening this editor.")
        if source:
            self.leases[client_id] = (source["id"], source["media_id"] or source["id"])
            self.touch("video:" + source["id"])
        else:
            self.leases.pop(client_id, None)
        self.app.state.events.publish("storage")

    def references(self) -> dict:
        state = self.app.state
        result = {}
        rows = state.db.rows("SELECT id,name,creator_id,collaborative,tracks,updated_at FROM music_playlists")
        rows.extend(
            {
                "id": "liked",
                "name": "Liked Songs",
                "creator_id": row["key"].split(":", 1)[1],
                "collaborative": False,
                "tracks": json.loads(row["value"]).get("tracks", []),
                "updated_at": json.loads(row["value"]).get("updated_at", 0),
            }
            for row in state.db.rows("SELECT key,value FROM settings WHERE key LIKE 'music_likes:%'")
        )
        for row in rows:
            tracks = json.loads(row["tracks"]) if isinstance(row["tracks"], str) else row["tracks"]
            for index, track in enumerate(tracks):
                key = state.music_cache.entry_key(track)
                item = result.setdefault(key, {"track": track, "references": []})
                reference = {
                    "id": row["id"],
                    "index": index,
                    "updated_at": row["updated_at"],
                    "track": track,
                    "name": row["name"],
                    "owner": row["creator_id"],
                    "editable": bool(row["collaborative"]),
                    "private": row["id"] == "liked",
                    "url": "/music?tab=playlists&playlist=" + row["id"],
                }
                if reference not in item["references"]:
                    item["references"].append(reference)
        return result

    async def music_records(self, user: dict | None = None, *, include_history: bool = True) -> dict:
        state = self.app.state
        records = await state.db.run(self.references)
        entries = (
            state.music.queue
            if include_history
            else state.music.queue[state.music.index :]
            if state.music.index is not None
            else []
        )
        for entry in entries:
            track = entry["track"]
            key = state.music_cache.entry_key(track)
            item = records.setdefault(key, {"track": track, "references": []})
            name = (
                "Now playing"
                if state.music.current and entry["id"] == state.music.current["id"]
                else "Upcoming in queue"
            )
            reference = {
                "id": "queue",
                "track": track,
                "name": name,
                "owner": None,
                "editable": False,
                "private": False,
                "url": "/music",
            }
            if reference not in item["references"]:
                item["references"].append(reference)
        for key, entry in tuple(state.music_cache.entries.items()):
            records.setdefault(key, {"track": entry["original"], "references": []})
        if user:
            visible = {}
            for key, item in records.items():
                references = [ref for ref in item["references"] if not ref["private"] or ref["owner"] == user["id"]]
                if references or (user["admin"] and not any(ref["private"] for ref in item["references"])):
                    visible[key] = {
                        **item,
                        "track": references[0]["track"] if references else item["track"],
                        "visible_references": references,
                    }
            return visible
        return records

    async def inventory(self) -> dict:
        if self.scan and not self.scan.done():
            return await asyncio.shield(self.scan)
        self.scan = asyncio.create_task(self.fresh_inventory())
        return await asyncio.shield(self.scan)

    async def fresh_inventory(self) -> dict:
        for _attempt in range(3):
            revision = self.app.state.events.media_revision
            result = await self.collect()
            if revision == self.app.state.events.media_revision:
                return result
        raise HTTPException(409, "Media changed during validation. Retry to read current files.")

    async def collect(self) -> dict:
        state = self.app.state
        records = await self.music_records()
        entries = dict(state.music_cache.entries)
        sources, clips, usage = await state.db.run(
            lambda: (state.db.sources(), state.db.clips(), state.db.rows("SELECT * FROM media_usage"))
        )
        measured = await asyncio.to_thread(self.measure, sources, clips, entries)
        stamps = {row["resource_id"]: row["last_used"] for row in usage}
        self.prune_clients()
        legacy = any(key.startswith("legacy:") for key in self.clients)
        for item in measured:
            item["last_used"] = max(stamps.get(item["id"], 0), self.used_pending.get(item["id"], 0)) or None
            reasons, references = [], []
            if item["kind"] == "music":
                record = records.get(item["key"], {"references": []})
                track = record.get("track", {"title": item["name"], "artist": item["subtitle"]})
                item.update(name=track["title"], subtitle=track.get("artist") or "Music")
                references = [
                    {
                        "name": "Private Liked Songs" if ref["private"] else ref["name"],
                        "url": None if ref["private"] else ref["url"],
                    }
                    for ref in record["references"]
                ]
                if references:
                    reasons.append("Required by saved music or the playback queue")
                if item["key"] in state.music_cache.required or item["key"] in state.music_cache.active_downloads:
                    reasons.append("Recording is in use")
            elif item["kind"] == "video":
                references = [
                    {"name": clip["name"], "url": "/soundboard"} for clip in clips if clip["source_id"] == item["key"]
                ]
                if references:
                    reasons.append("Required by linked sounds")
                if any(value[0] == item["key"] for value in self.leases.values()):
                    reasons.append("Open in an editor")
                if legacy:
                    reasons.append("Refresh older open browsers before removing source files")
                if state.media.busy or state.media.lock.locked():
                    reasons.append("A media operation is active")
            else:
                reasons.append("Required sound or application-managed media")
                references = [
                    {
                        "name": "Soundboard" if item["kind"] == "sound" else "Application",
                        "url": "/soundboard" if item["kind"] == "sound" else None,
                    }
                ]
            item.update(references=references, protection=reasons, removable=not reasons)
            item["version"] = fingerprint([item["id"], item["files"], references, reasons])
        categories = {
            kind: sum(row["bytes"] for row in measured if row["kind"] == kind)
            for kind in ("music", "video", "sound", "other")
        }
        budget = state.media.budget
        disk = await asyncio.to_thread(shutil.disk_usage, state.media.root)
        total = sum(categories.values())
        return {
            "items": measured,
            "summary": {
                "used_bytes": total,
                "max_bytes": budget.limit,
                "remaining_bytes": max(0, budget.limit - total),
                "reserved_bytes": sum(budget.reservations.values()),
                "disk_free_bytes": disk.free,
                "categories": categories,
            },
            "suggestions": {
                kind: {
                    "bytes": sum(row["bytes"] for row in measured if row["kind"] == kind and row["removable"]),
                    "count": sum(row["kind"] == kind and row["removable"] for row in measured),
                }
                for kind in ("music", "video")
            },
        }

    def measure(self, sources: list, clips: list, entries: dict) -> list:
        state = self.app.state
        result, known = [], set()
        for kind, rows in (("video", sources), ("sound", clips)):
            for row in rows:
                folder = (row.get("media_id") or row["id"]) if kind == "video" else row["id"]
                known.add(folder)
                files = files_in(state.media.root / folder)
                if not files:
                    continue
                result.append(
                    {
                        "id": kind + ":" + row["id"],
                        "key": row["id"],
                        "folder": folder,
                        "kind": kind,
                        "name": row.get("title") or row.get("name"),
                        "subtitle": "Original source video" if kind == "video" else "Soundboard clip",
                        "bytes": sum(item["bytes"] for item in files),
                        "files": files,
                        "url": "/videos/" + row["id"] + "/cut" if kind == "video" else "/soundboard",
                    }
                )
        for key, entry in entries.items():
            files = []
            for suffix in (".audio", ".json"):
                path = state.music_cache.root / (key + suffix)
                try:
                    stat = path.stat()
                    files.append({"name": path.name, "bytes": stat.st_size, "version": stat.st_mtime_ns})
                except FileNotFoundError:
                    continue
            if not any(item["name"].endswith(".audio") for item in files):
                continue
            track = entry["original"]
            result.append(
                {
                    "id": "music:" + key,
                    "key": key,
                    "kind": "music",
                    "name": track["title"],
                    "subtitle": track.get("artist") or "Music",
                    "bytes": sum(item["bytes"] for item in files),
                    "files": files,
                    "url": "/music",
                }
            )
        result.extend(self.other_files(result, known))
        return result

    def other_files(self, rows: list, known: set[str]) -> list:
        state = self.app.state
        result = []
        for root in (state.media.root, state.music_cache.root):
            known_files = {item["name"] for row in rows if row["kind"] == "music" for item in row["files"]}
            for path in root.iterdir():
                if (root == state.media.root and path.name in known) or (
                    root == state.music_cache.root and path.name in known_files
                ):
                    continue
                try:
                    files = files_in(path) if path.is_dir() else [{"name": path.name, "bytes": path.stat().st_size}]
                except FileNotFoundError:
                    continue
                if files:
                    result.append(
                        {
                            "id": "other:" + fingerprint(str(path)),
                            "key": path.name,
                            "kind": "other",
                            "name": "Working media"
                            if state.media.busy or state.music_cache.active_downloads
                            else "Other media",
                            "subtitle": "Application-managed files",
                            "bytes": sum(item["bytes"] for item in files),
                            "files": files,
                            "url": None,
                        }
                    )
        return result

    async def review(self, ids: list[str]) -> dict:
        data = await self.inventory()
        items = [item for item in data["items"] if item["id"] in ids]
        if len(items) != len(set(ids)):
            raise HTTPException(409, "Stored files changed. Refresh Storage and review again.")
        return {
            "items": items,
            "bytes": sum(item["bytes"] for item in items if item["removable"]),
            "token": fingerprint(
                [(item["id"], item["version"]) for item in sorted(items, key=lambda value: value["id"])]
            ),
        }

    async def remove(self, ids: list[str], token: str, request: Request) -> dict:
        state = self.app.state
        async with self.lock, state.media.lock, state.music.lock:
            if state.media.busy:
                raise HTTPException(409, "A media operation started. Wait and review again.")
            review = await self.review(ids)
            for item in review["items"]:
                item["protection"] = [
                    reason for reason in item["protection"] if reason != "A media operation is active"
                ]
                item["removable"] = not item["protection"]
                item["version"] = fingerprint([item["id"], item["files"], item["references"], item["protection"]])
            current = fingerprint(
                [(item["id"], item["version"]) for item in sorted(review["items"], key=lambda value: value["id"])]
            )
            if current != token or any(not item["removable"] for item in review["items"]):
                raise HTTPException(409, "Files or their references changed. Review the selection again.")
            await authorize_admin(request)
            actor = request.state.user["id"]
            removed, errors, reclaimed = [], [], 0
            for item in review["items"]:
                try:
                    await self.remove_item(item)
                    removed.append(item["id"])
                    reclaimed += item["bytes"]
                    await state.db.run(
                        state.db.audit,
                        actor,
                        "media.remove",
                        item["id"],
                        item["name"],
                        details={"bytes": item["bytes"]},
                    )
                except (OSError, ValueError) as error:
                    remaining = await asyncio.to_thread(self.remaining_size, item)
                    reclaimed += max(0, item["bytes"] - remaining) if remaining is not None else 0
                    errors.append({"id": item["id"], "error": str(error), "remaining_bytes": remaining})
            state.events.publish("storage")
            sources = [item["id"].split(":", 1)[1] for item in review["items"] if item["kind"] == "video"]
            if sources:
                state.events.publish("library", {"scope": "sources", "ids": sources})
            state.events.publish("music_cache")
            return {"removed": removed, "errors": errors, "reclaimed_bytes": reclaimed}

    def remaining_size(self, item: dict) -> int | None:
        try:
            if item["kind"] == "music":
                root = self.app.state.music_cache.root
                return sum(
                    path.stat().st_size
                    for suffix in (".audio", ".json")
                    if (path := root / (item["key"] + suffix)).is_file()
                )
            return sum(file["bytes"] for file in files_in(self.app.state.media.root / item["folder"]))
        except OSError:
            return None

    async def remove_item(self, item: dict) -> None:
        state = self.app.state
        if item["kind"] == "music":
            await state.db.run(self.remove_music, item["key"])
        else:
            await state.db.run(state.db.execute, "UPDATE sources SET media_available=0 WHERE id=?", (item["key"],))
            await asyncio.to_thread(state.media.storage.remove, state.media.root / item["folder"])
            if await asyncio.to_thread(files_in, state.media.root / item["folder"]):
                message = "Some files could not be removed. Review remaining files."
                raise OSError(message)

    def remove_music(self, key: str) -> None:
        state = self.app.state
        cache = state.music_cache
        with state.db.lock, cache.metadata_lock:
            references = self.references()
            queued = {cache.entry_key(entry["track"]) for entry in state.music.queue}
            if key in references or key in queued or key in cache.required or key in cache.active_downloads:
                message = "Recording is now required. Review again."
                raise ValueError(message)
            (cache.root / (key + ".audio")).unlink(missing_ok=True)
            (cache.root / (key + ".json")).unlink(missing_ok=True)
            entry = cache.entries.pop(key, None)
            cache.manifest_sizes.pop(key, None)
            if entry:
                cache.used -= entry["bytes"]
            cache.aliases = {alias: target for alias, target in cache.aliases.items() if target != key}
