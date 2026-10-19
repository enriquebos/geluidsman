from __future__ import annotations

from typing import Annotated, Literal

from fastapi import Depends, FastAPI, HTTPException, Query, Request
from pydantic import BaseModel, Field

from app.auth import authorize, authorize_admin
from app.downloads import GROUPS


class DownloadAction(BaseModel):
    action: Literal["retry", "cancel"]


class FileSelection(BaseModel):
    ids: list[str] = Field(min_length=1, max_length=100)
    token: str = Field(default="", max_length=64)


class EditorLease(BaseModel):
    sequence: int = Field(ge=1)
    client_id: str = Field(pattern=r"^[a-zA-Z0-9-]{1,80}$")
    source_id: str | None = Field(default=None, max_length=100)
    media_version: str | None = Field(default=None, max_length=100)


class DownloadQuery(BaseModel):
    kind: Literal["all", "music", "video"] = "all"
    q: str = Field(default="", max_length=200)
    group: Literal["all", "active", "waiting", "attention", "completed"] = "all"
    offset: int = Field(default=0, ge=0)
    limit: int = Field(default=50, ge=1, le=50)


class StorageQuery(BaseModel):
    kind: Literal["all", "music", "video", "sound", "other"] = "all"
    q: str = Field(default="", max_length=200)
    sort: Literal["largest", "smallest", "name", "last_used", "oldest"] = "largest"
    offset: int = Field(default=0, ge=0)
    limit: int = Field(default=50, ge=1, le=50)
    removable: bool = False


def register_media_management_routes(app: FastAPI) -> None:
    register_download_routes(app)
    register_storage_routes(app)
    register_lease_route(app)


def register_download_routes(app: FastAPI) -> None:
    @app.get("/api/downloads/summary", dependencies=[Depends(authorize)])
    async def download_summary() -> dict:
        budget = app.state.media.budget
        return {"used_bytes": budget.used(), "max_bytes": budget.limit}

    @app.get("/api/downloads", dependencies=[Depends(authorize)])
    async def downloads(request: Request, params: Annotated[DownloadQuery, Query()]) -> dict:
        kind, q, group, offset, limit = params.kind, params.q, params.group, params.offset, params.limit
        rows = await app.state.downloads.rows(request.state.user)
        filtered = [
            row
            for row in rows
            if (kind == "all" or row["kind"] == kind)
            and q.casefold()
            in (
                row["name"] + " " + row["subtitle"] + " " + " ".join(origin["name"] for origin in row["origins"])
            ).casefold()
        ]
        counts = {value: sum(row["group"] == value for row in filtered) for value in GROUPS}
        groups = {}
        for value in GROUPS:
            selected = [row for row in filtered if row["group"] == value]
            start = offset if group == value else 0
            count = limit if group == value or value != "completed" else 3
            groups[value] = selected[start : start + count]
        budget = app.state.media.budget
        return {
            "groups": groups,
            "counts": counts,
            "usage": {"used_bytes": budget.used(), "max_bytes": budget.limit},
            "offset": offset,
            "limit": limit,
        }

    @app.post("/api/downloads/retry-all", dependencies=[Depends(authorize)])
    async def retry_all(request: Request, params: Annotated[DownloadQuery, Query()]) -> dict:
        async with app.state.media_management.lock:
            await authorize(request)
            result = await app.state.downloads.retry_all(request.state.user, params.kind, params.q)
            return {
                **result,
                "downloads_usage": await download_summary(),
                "downloads_revision": app.state.events.revision,
            }

    @app.post("/api/downloads/{identity}", dependencies=[Depends(authorize)])
    async def download_action(identity: str, body: DownloadAction, request: Request) -> dict:
        async with app.state.media_management.lock:
            await authorize(request)
            result = await app.state.downloads.mutate(identity, body.action, request.state.user)
            return {
                **result,
                "downloads_usage": await download_summary(),
                "downloads_revision": app.state.events.revision,
            }


def register_storage_routes(app: FastAPI) -> None:
    @app.get("/api/admin/storage/summary", dependencies=[Depends(authorize_admin)])
    async def storage_summary() -> dict:
        data = await app.state.media_management.inventory()
        return {"summary": data["summary"], "suggestions": data["suggestions"]}

    @app.get("/api/admin/storage", dependencies=[Depends(authorize_admin)])
    async def storage(params: Annotated[StorageQuery, Query()]) -> dict:
        kind, q, sort, offset, limit, removable = (
            params.kind,
            params.q,
            params.sort,
            params.offset,
            params.limit,
            params.removable,
        )
        data = await app.state.media_management.inventory()
        rows = [
            row
            for row in data["items"]
            if (kind == "all" or row["kind"] == kind)
            and q.casefold() in (row["name"] + " " + row["subtitle"]).casefold()
            and (not removable or row["removable"])
        ]
        if sort == "name":
            rows.sort(key=lambda row: (row["name"].casefold(), row["id"]))
        elif sort in {"last_used", "oldest"}:
            rows.sort(key=lambda row: (row["last_used"] or 0, row["id"]), reverse=sort == "last_used")
        else:
            rows.sort(key=lambda row: (row["bytes"], row["id"]), reverse=sort == "largest")
        return {
            "summary": data["summary"],
            "suggestions": data["suggestions"],
            "items": rows[offset : offset + limit],
            "total": len(rows),
            "offset": offset,
            "limit": limit,
        }

    @app.post("/api/admin/storage/review", dependencies=[Depends(authorize_admin)])
    async def review(body: FileSelection) -> dict:
        return await app.state.media_management.review(body.ids)

    @app.post("/api/admin/storage/remove", dependencies=[Depends(authorize_admin)])
    async def remove(body: FileSelection, request: Request) -> dict:
        return await app.state.media_management.remove(body.ids, body.token, request)


def register_lease_route(app: FastAPI) -> None:
    @app.post("/api/media/lease", dependencies=[Depends(authorize)])
    async def lease(body: EditorLease, request: Request) -> dict:
        async with app.state.media_management.lock:
            manager = app.state.media_management
            manager.prune_clients()
            if manager.clients.get(body.client_id, (None,))[0] != request.state.user["id"]:
                raise HTTPException(409, "Reconnect before opening this editor.")
            if body.sequence <= manager.lease_sequences.get(body.client_id, 0):
                raise HTTPException(409, "A newer editor replaced this request.")
            manager.lease_sequences[body.client_id] = body.sequence
            source = None
            if body.source_id:
                source = await app.state.db.run(app.state.db.one, "SELECT * FROM sources WHERE id=?", (body.source_id,))
                if (
                    not source
                    or not source["media_available"]
                    or (source["media_id"] or source["id"]) != body.media_version
                ):
                    raise HTTPException(409, "Media changed or was removed. Reload current source information.")
            app.state.media_management.lease(body.client_id, request.state.user["id"], source)
            return {"ok": True}
