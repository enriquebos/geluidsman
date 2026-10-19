from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING

from fastapi import HTTPException

if TYPE_CHECKING:
    from fastapi import FastAPI

from app.channels import video_id
from app.import_errors import import_guidance
from app.music_diagnostics import REASONS
from app.storage import fingerprint, size

GROUPS = ("active", "waiting", "attention", "completed")


def group_for(status: str) -> str:
    if status in {"downloading", "processing", "discovering"}:
        return "active"
    if status in {"cached", "complete"}:
        return "completed"
    if status in {"failed", "interrupted", "cancelled", "paused"}:
        return "attention"
    return "waiting"


class Downloads:
    def __init__(self, app: FastAPI) -> None:
        self.app = app

    async def music(self, user: dict) -> list[dict]:
        if not user["permissions"].get("view_music"):
            return []
        state = self.app.state
        records = await state.media_management.music_records(user, include_history=False)
        verified = await asyncio.to_thread(
            lambda: {key: size(state.music_cache.root / (key + ".audio")) for key in records}
        )
        rows = []
        for key, record in records.items():
            track, refs = record["track"], record["references"]
            visible = record["visible_references"]
            cached = state.music_cache.status(track)
            entry = state.music_cache.entries.get(key)
            if entry and verified.get(key) != entry["bytes"]:
                cached = {
                    "state": "failed",
                    "error": "Uploaded MP3 is missing. Upload it again in Edit playlist song."
                    if track.get("upload_id")
                    else "Downloaded file is missing. Retry the download.",
                }
            owned = bool(refs) and all(ref["owner"] == user["id"] for ref in refs)
            editable = user["admin"] or any(ref["owner"] == user["id"] or ref["editable"] for ref in visible)
            protected = key in state.music_cache.required or state.music_cache.priorities[:1] == [key]
            status = cached["state"]
            normalization = cached.get("normalization", {})
            analysis_failed = status == "cached" and normalization.get("state") == "failed"
            href = next((ref["url"] for ref in visible if ref["id"] != "queue"), "/music")
            rows.append(
                {
                    "id": "music:" + key,
                    "target": "music:" + key,
                    "completed_at": entry.get("completed_at", 0) if entry else 0,
                    "kind": "music",
                    "name": track["title"],
                    "subtitle": track.get("artist") or "Music",
                    "thumbnail": track.get("thumbnail"),
                    "group": "attention" if analysis_failed else group_for(status),
                    "status": "analysis_failed" if analysis_failed else status,
                    "normalization": normalization,
                    "downloaded_bytes": cached.get("downloaded_bytes", entry["bytes"] if entry else 0),
                    "total_bytes": cached.get("total_bytes"),
                    "bytes": entry["bytes"] if entry and status == "cached" else None,
                    "estimated": False,
                    "error": normalization.get("error") if analysis_failed else cached.get("error"),
                    "guidance": None
                    if analysis_failed
                    or track.get("upload_id")
                    or cached.get("error") in {REASONS["age_restricted"], REASONS["match_not_found"]}
                    else "Choose another recording in the song's playlist if retrying does not help.",
                    "origins": [{"name": ref["name"], "url": ref["url"]} for ref in visible]
                    or [{"name": "Stored recording", "url": None}],
                    "url": href,
                    "can_retry": editable
                    and (analysis_failed or (not track.get("upload_id") and status in {"failed", "cancelled"})),
                    "can_cancel": (user["admin"] or owned) and not protected and status in {"queued", "downloading"},
                    "protection": "Required for playback"
                    if protected
                    else "Shared download; only admins can cancel"
                    if not user["admin"] and not owned
                    else None,
                    "editable_references": [
                        {
                            "playlist_id": ref["id"],
                            "index": ref["index"],
                            "updated_at": ref["updated_at"],
                            "name": ref["name"],
                        }
                        for ref in visible
                        if ref["id"] != "queue"
                        and (
                            ref["owner"] == user["id"] or (ref["id"] != "liked" and (user["admin"] or ref["editable"]))
                        )
                    ],
                    "recording_url": next(
                        (
                            ref["url"] + "&edit=" + track["provider"] + ":" + track["source_id"]
                            for ref in visible
                            if ref["id"] not in {"liked", "queue"}
                            and (user["admin"] or ref["owner"] == user["id"] or ref["editable"])
                        ),
                        None,
                    ),
                }
            )
        return rows

    async def videos(self, user: dict) -> list[dict]:
        state = self.app.state
        jobs, pending, sources = await state.db.run(
            lambda: (
                state.db.rows(
                    "SELECT j.*,b.title AS channel_title FROM jobs j "
                    "LEFT JOIN channel_items i ON i.job_id=j.id LEFT JOIN channel_batches b ON b.id=i.batch_id "
                    "WHERE NOT EXISTS (SELECT 1 FROM jobs n WHERE "
                    "COALESCE(n.source_id,n.url)=COALESCE(j.source_id,j.url) AND n.created_at>j.created_at) "
                    "ORDER BY j.created_at DESC"
                ),
                state.db.rows(
                    "SELECT i.*,b.title AS batch_title,b.status AS batch_status FROM channel_items i "
                    "JOIN channel_batches b ON b.id=i.batch_id WHERE b.dismissed=0 "
                    "AND i.status IN ('queued','cancelled') ORDER BY i.id"
                ),
                state.db.sources(),
            )
        )
        sizes = await asyncio.to_thread(self.video_sizes, sources)
        by_id = {source["id"]: source for source in sources}
        by_url = {source["url"]: source["id"] for source in sources}
        rows, seen = [], set()
        manage = user["permissions"].get("manage_imports", False)
        retry = manage and user["permissions"].get("import_videos", False)
        for job in jobs:
            identity = video_id(job["url"]) or job["url"]
            source_identity = job["source_id"] or by_url.get(job["url"])
            if identity in seen:
                continue
            seen.add(identity)
            source = by_id.get(source_identity)
            available = bool(source and source.get("media_available", 1) and source["id"] in sizes)
            if job["status"] == "complete" and not available:
                continue
            title = source["title"] if source else job["title"] or job["url"]
            href = "/videos/" + source["id"] + "/cut" if source else None
            stored_size = sizes.get(source["id"]) if available else None
            status = job["status"]
            rows.append(
                {
                    "id": "video:" + fingerprint(identity),
                    "target": "video:" + job["id"],
                    "completed_at": job["created_at"],
                    "kind": "video",
                    "name": title,
                    "subtitle": "Video",
                    "thumbnail": f"/api/media/{source['id']}/thumbnail.jpg?v={source['media_id'] or source['id']}"
                    if available
                    else None,
                    "group": group_for(status),
                    "status": status,
                    "downloaded_bytes": job["downloaded_bytes"],
                    "total_bytes": job["total_bytes"],
                    "bytes": stored_size,
                    "estimated": bool(job["total_estimated"]),
                    "error": job["error"],
                    "guidance": import_guidance(job["error"] or ""),
                    "origins": [{"name": job["channel_title"] or "Video library", "url": "/videos"}],
                    "url": href,
                    "can_retry": retry and status in {"failed", "interrupted", "cancelled"} and not state.media.busy,
                    "can_cancel": manage and (job["id"] in state.media.job_tasks or status == "queued"),
                    "protection": "Another video import is running"
                    if state.media.busy and status in {"failed", "interrupted", "cancelled"}
                    else None,
                    "recording_url": None,
                }
            )
        for source in sources:
            identity = video_id(source["url"]) or source["url"]
            if identity in seen or not source.get("media_available", 1):
                continue
            if source["id"] not in sizes:
                continue
            seen.add(identity)
            rows.append(
                {
                    "id": "video:" + fingerprint(identity),
                    "target": "source:" + source["id"],
                    "completed_at": source["created_at"],
                    "kind": "video",
                    "name": source["title"],
                    "subtitle": "Video",
                    "thumbnail": f"/api/media/{source['id']}/thumbnail.jpg?v={source['media_id'] or source['id']}",
                    "group": "completed",
                    "status": "complete",
                    "downloaded_bytes": 0,
                    "total_bytes": None,
                    "bytes": sizes[source["id"]],
                    "estimated": False,
                    "error": None,
                    "guidance": None,
                    "origins": [{"name": "Video library", "url": "/videos"}],
                    "url": "/videos/" + source["id"] + "/cut",
                    "can_retry": False,
                    "can_cancel": False,
                    "protection": None,
                    "recording_url": None,
                }
            )
        for item in pending:
            identity = video_id(item["url"]) or item["url"]
            if identity in seen:
                continue
            seen.add(identity)
            status = (
                "cancelled"
                if item["status"] == "cancelled"
                else "paused"
                if item["batch_status"] == "paused"
                else "queued"
            )
            rows.append(
                {
                    "id": "video:" + fingerprint(identity),
                    "target": "channel:" + str(item["id"]),
                    "kind": "video",
                    "name": item["title"],
                    "subtitle": "Video",
                    "thumbnail": None,
                    "group": group_for(status),
                    "status": status,
                    "downloaded_bytes": 0,
                    "total_bytes": None,
                    "bytes": None,
                    "estimated": False,
                    "error": "Channel import is paused"
                    if status == "paused"
                    else "Download cancelled"
                    if status == "cancelled"
                    else None,
                    "guidance": "Resume the channel import to continue." if status == "paused" else None,
                    "origins": [{"name": item["batch_title"], "url": "/videos"}],
                    "url": None,
                    "can_retry": manage
                    and user["permissions"].get("import_channels", False)
                    and status in {"paused", "cancelled"}
                    and not state.media.busy,
                    "can_cancel": manage and status == "queued",
                    "protection": None,
                    "recording_url": None,
                }
            )
        return rows

    def video_sizes(self, sources: list[dict]) -> dict:
        result = {}
        for source in sources:
            folder = self.app.state.media.root / (source["media_id"] or source["id"])
            if (folder / "video.mp4").is_file() and (folder / "audio.m4a").is_file():
                result[source["id"]] = size(folder)
        return result

    async def rows(self, user: dict) -> list[dict]:
        rows = None
        for _attempt in range(3):
            revision = self.app.state.events.media_revision
            music, videos = await asyncio.gather(self.music(user), self.videos(user))
            if revision == self.app.state.events.media_revision:
                rows = [*music, *videos]
                break
        if rows is None:
            raise HTTPException(409, "Downloads changed during validation. Retry to read current status.")
        rows.sort(key=lambda row: row.get("completed_at", 0), reverse=True)
        for row in rows:
            row["revision"] = fingerprint([row["id"], row["status"], row["can_retry"], row["can_cancel"]])
        return rows

    async def retry_all(self, user: dict, kind: str, query: str) -> dict:
        state = self.app.state
        rows = [
            row
            for row in await self.rows(user)
            if row["can_retry"]
            and (kind == "all" or row["kind"] == kind)
            and query.casefold()
            in (
                row["name"] + " " + row["subtitle"] + " " + " ".join(origin["name"] for origin in row["origins"])
            ).casefold()
        ]
        jobs, tracks = [], []
        records = await state.media_management.music_records(user, include_history=False)
        for row in rows:
            category, key = row["target"].split(":", 1)
            if category == "music":
                tracks.append(records[key]["track"])
            elif category == "video":
                jobs.append(await state.db.run(state.db.one, "SELECT * FROM jobs WHERE id=?", (key,)))
            else:
                jobs.append(await state.db.run(state.db.one, "SELECT * FROM channel_items WHERE id=?", (int(key),)))
        await state.media.retry_jobs(jobs, user["id"])
        await state.music_cache.retry_verified(tracks)
        await state.db.run(
            state.db.audit, user["id"], "download.retry", None, "Retry downloads", details={"count": len(rows)}
        )
        state.events.publish("music_cache")
        return {"queued": len(rows)}

    async def mutate(self, identity: str, action: str, user: dict) -> dict:
        state = self.app.state
        row = next((row for row in await self.rows(user) if row["id"] == identity), None)
        if not row:
            raise HTTPException(404, "Download not found.")
        if not row["can_" + action]:
            raise HTTPException(
                409, row["protection"] or "This download changed or you cannot manage it. Refresh Downloads."
            )
        kind, key = row["target"].split(":", 1)
        if kind == "music":
            if action == "cancel":
                await state.music_cache.cancel_download(key)
            else:
                records = await state.media_management.music_records(user, include_history=False)
                await state.music_cache.retry_verified([records[key]["track"]])
        elif kind == "video":
            if action == "cancel":
                await state.media.cancel_job(key)
            else:
                job = await state.db.run(state.db.one, "SELECT * FROM jobs WHERE id=?", (key,))
                await state.media.import_url(job["url"], job["source_id"], user["id"])
        else:
            item = await state.db.run(state.db.one, "SELECT * FROM channel_items WHERE id=?", (int(key),))
            if action == "cancel":
                await state.media.channels.cancel_item(int(key))
            else:
                await state.db.run(state.db.execute, "UPDATE channel_items SET status='queued' WHERE id=?", (int(key),))
                await state.media.channels.resume(item["batch_id"], user["id"])
        await state.db.run(state.db.audit, user["id"], "download." + action, identity, row["name"])
        state.events.publish("jobs", {"ids": [identity]})
        state.events.publish("music_cache", {"ids": [identity]})
        return {"ok": True}
