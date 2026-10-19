from __future__ import annotations

import json
import time
from typing import TYPE_CHECKING, Annotated, Literal

from fastapi import Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field

from app.activity import register_activity_routes
from app.auth import authorize, authorize_admin
from app.permissions import require_permission
from app.storage import fingerprint

if TYPE_CHECKING:
    from fastapi import FastAPI

    from app.config import Settings
    from app.db import Database


class Preferences(BaseModel):
    preview_volume: float = Field(default=0.8, ge=0, le=1, allow_inf_nan=False)
    caption_language: Literal["all", "nl", "en"] = "all"
    soundboard_mode: Literal["default", "compact"] = "default"


class AppSettings(BaseModel):
    expected_revision: str | None = Field(None, max_length=64, exclude=True)
    max_source_seconds: int = Field(3600, ge=1, le=86400)
    max_import_bytes: int = Field(1_000_000_000, ge=1, le=100_000_000_000)
    max_storage_bytes: int = Field(10_000_000_000, ge=1, le=1_000_000_000_000)
    media_max_bytes: int | None = Field(None, ge=1, le=2_000_000_000_000)
    max_channel_videos: int = Field(2000, ge=1, le=10000)
    audit_retention_days: int = Field(90, ge=1, le=3650)


def operational_settings(settings: Settings, db: Database) -> dict:
    defaults = {
        key: getattr(settings, key)
        for key in AppSettings.model_fields
        if key not in {"audit_retention_days", "expected_revision"}
    }
    return AppSettings(**{**defaults, **db.setting("app_settings", {})}).model_dump()


def save_application_settings(db: Database, settings: Settings, body: AppSettings, actor: str) -> dict:
    with db.lock, db.conn:
        current = operational_settings(settings, db)
        if body.expected_revision and body.expected_revision != fingerprint(current):
            raise HTTPException(409, "Application settings changed elsewhere. Reload and review your changes.")
        if (
            body.media_max_bytes is not None
            and body.media_max_bytes != current["media_max_bytes"]
            and not body.expected_revision
        ):
            raise HTTPException(409, "Reload current settings before changing the shared media limit.")
        values = body.model_dump()
        if values["media_max_bytes"] is None:
            values["media_max_bytes"] = current["media_max_bytes"]
        db.change(
            "INSERT OR REPLACE INTO settings VALUES (?,?)",
            ("app_settings", json.dumps(values)),
            actor,
            "settings.edit",
            resource_id="application",
            name="Application settings",
        )
        return values


def register_account_routes(app: FastAPI, settings: Settings) -> None:
    register_audit_options(app)
    register_activity_routes(app, settings)

    @app.get("/api/admin/logs", dependencies=[Depends(authorize_admin)])
    async def console_logs(
        after: Annotated[int, Query(ge=0)] = 0,
        limit: Annotated[int, Query(ge=1, le=500)] = 200,
    ) -> dict:
        return app.state.console.snapshot(after, limit)

    @app.get("/api/settings/personal", dependencies=[Depends(authorize)])
    async def personal(request: Request) -> dict:
        return request.state.user["preferences"]

    @app.put("/api/settings/personal", dependencies=[Depends(authorize)])
    async def save_personal(body: Preferences, request: Request) -> dict:
        await app.state.db.run(
            app.state.db.execute,
            "UPDATE users SET preferences=? WHERE id=?",
            (body.model_dump_json(), request.state.user["id"]),
        )
        return body.model_dump()

    @app.get("/api/settings/app", dependencies=[Depends(authorize_admin)])
    async def application() -> dict:
        current = await app.state.db.run(operational_settings, settings, app.state.db)
        return {
            "settings": current,
            "revision": fingerprint(current),
            **await app.state.media.summary(fresh=True),
            "media_storage": {"used_bytes": app.state.media.budget.used(), "max_bytes": app.state.media.budget.limit},
            "music_storage": {
                "used_bytes": app.state.music_cache.used,
                "max_bytes": app.state.media.budget.limit,
            },
        }

    @app.put("/api/settings/app", dependencies=[Depends(authorize_admin)])
    async def save_application(body: AppSettings, request: Request) -> dict:
        async with app.state.media_management.lock:
            values = await app.state.db.run(
                save_application_settings, app.state.db, settings, body, request.state.user["id"]
            )
            app.state.media.budget.limit = values["media_max_bytes"]
            app.state.music_cache.refresh()
            app.state.music_sources.settings = await app.state.db.run(lambda: app.state.media.settings)
            app.state.music.settings = app.state.music_sources.settings
            current = await application()
            app.state.events.publish("settings", {"resource": "/settings/app", "value": current})
            app.state.events.publish("storage")
            return {**values, "current": current}

    @app.get("/api/audit", dependencies=[Depends(require_permission("view_audit"))])
    async def audit(
        *,
        actor_id: str | None = None,
        action: str | None = None,
        resource_id: str | None = None,
        outcome: str | None = None,
        after: float | None = None,
        until: float | None = None,
        before: Annotated[int | None, Query(ge=1)] = None,
        limit: Annotated[int, Query(ge=1, le=100)] = 50,
    ) -> dict:
        guild_id = str(settings.discord_guild_id)
        retention = (await app.state.db.run(operational_settings, settings, app.state.db))["audit_retention_days"]
        after = max(after or 0, time.time() - retention * 86400)
        rows = await app.state.db.run(
            app.state.db.rows,
            "SELECT * FROM audit WHERE (? IS NULL OR actor_id=?) AND (? IS NULL OR action=?) "
            "AND (? IS NULL OR resource_id=?) AND (guild_id IS NULL OR guild_id=?) "
            "AND (? IS NULL OR outcome=?) AND (? IS NULL OR timestamp>=?) "
            "AND (? IS NULL OR timestamp<=?) AND (? IS NULL OR id<?) "
            "ORDER BY id DESC LIMIT ?",
            (
                actor_id,
                actor_id,
                action,
                action,
                resource_id,
                resource_id,
                guild_id,
                outcome,
                outcome,
                after,
                after,
                until,
                until,
                before,
                before,
                limit + 1,
            ),
        )
        total = (
            await app.state.db.run(
                app.state.db.one,
                "SELECT COUNT(*) AS total FROM audit WHERE (? IS NULL OR actor_id=?) AND (? IS NULL OR action=?) "
                "AND (? IS NULL OR resource_id=?) AND (guild_id IS NULL OR guild_id=?) AND (? IS NULL OR outcome=?) "
                "AND (? IS NULL OR timestamp>=?) AND (? IS NULL OR timestamp<=?)",
                (
                    actor_id,
                    actor_id,
                    action,
                    action,
                    resource_id,
                    resource_id,
                    guild_id,
                    outcome,
                    outcome,
                    after,
                    after,
                    until,
                    until,
                ),
            )
        )["total"]
        for row in rows:
            row["details"] = json.loads(row["details"])
        return {
            "results": rows[:limit],
            "next_cursor": rows[limit - 1]["id"] if len(rows) > limit else None,
            "total": total,
        }


def register_audit_options(app: FastAPI) -> None:
    @app.get("/api/audit/options", dependencies=[Depends(require_permission("view_audit"))])
    async def options() -> dict:
        db = app.state.db
        users = await db.run(
            db.rows, "SELECT id,display_name AS name,avatar FROM users ORDER BY display_name COLLATE NOCASE"
        )
        resources = {
            clip["id"]: {"id": clip["id"], "name": clip["name"], "emoji": clip["emoji"] or "🔊"}
            for clip in (await db.run(db.clips))
        }
        resources.update(
            {
                source["id"]: {"id": source["id"], "name": source["title"], "emoji": "🎬"}
                for source in (await db.run(db.sources))
            }
        )
        history = await db.run(
            db.rows,
            "SELECT a.* FROM audit a JOIN (SELECT resource_id,MAX(id) AS latest FROM audit "
            "WHERE resource_id IS NOT NULL AND (action LIKE 'sound.%' OR action LIKE 'video.%') "
            "GROUP BY resource_id) h ON a.id=h.latest",
        )
        for item in history:
            if item["resource_id"] not in resources:
                details = json.loads(item["details"])
                resources[item["resource_id"]] = {
                    "id": item["resource_id"],
                    "name": item["resource_name"] or "Deleted sound",
                    "emoji": details.get("emoji") or ("🔊" if item["action"].startswith("sound.") else "🎬"),
                }
        return {
            "users": users,
            "resources": sorted(resources.values(), key=lambda item: item["name"].casefold()),
        }
