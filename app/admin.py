from __future__ import annotations

import json
import time
import uuid
from typing import TYPE_CHECKING, Annotated

from fastapi import Depends, HTTPException, Query, Request
from pydantic import BaseModel, ConfigDict, Field, StrictBool, field_validator

from app.auth import authorize_admin
from app.fun import FunSettings, GooseAction, GooseMessage
from app.goose_sketches import register_sketch_routes, resolve_sketch
from app.permissions import CATALOGUE, DEFAULTS, effective_permissions

if TYPE_CHECKING:
    from fastapi import FastAPI


class PermissionOverrides(BaseModel):
    model_config = ConfigDict(extra="forbid")
    overrides: dict[str, StrictBool] = Field(default_factory=dict, max_length=len(DEFAULTS))

    @field_validator("overrides")
    @classmethod
    def known_permissions(cls, values: dict[str, bool]) -> dict[str, bool]:
        if values.keys() - DEFAULTS.keys():
            message = "Unknown permission key."
            raise ValueError(message)
        return values


def user_permissions(app: FastAPI, user: dict) -> dict:
    user["protected_admin"] = user["id"] in app.state.auth.admin_ids
    defaults = effective_permissions({}, admin=user["protected_admin"])
    user["overrides"] = {
        key: value for key, value in json.loads(user.pop("permission_overrides")).items() if value != defaults.get(key)
    }
    user["permissions"] = effective_permissions(user["overrides"], admin=user["protected_admin"])
    user["admin"] = user["permissions"]["admin"]
    return user


def update_permissions(app: FastAPI, request: Request, user_id: str, overrides: dict, action: str) -> dict:
    db = app.state.db
    with db.lock, db.conn:
        user = db.one("SELECT id,display_name,permission_overrides FROM users WHERE id=?", (user_id,))
        if not user:
            raise HTTPException(404, "User not found.")
        protected = user_id in app.state.auth.admin_ids
        if protected and request.state.user["id"] != user_id:
            raise HTTPException(403, "Only this protected administrator can change their own permissions.")
        if protected and overrides.get("admin") is False:
            raise HTTPException(409, "Protected administrator access cannot be disabled.")
        defaults = effective_permissions({}, admin=protected)
        overrides = {key: value for key, value in overrides.items() if value != defaults[key]}
        previous = effective_permissions(json.loads(user["permission_overrides"]), admin=protected)
        updated = effective_permissions(overrides, admin=protected)
        changes = [
            {"permission": key, "label": label, "before": previous[key], "after": updated[key]}
            for key, label, _group in CATALOGUE
            if previous[key] != updated[key]
        ]
        db.conn.execute("UPDATE users SET permission_overrides=? WHERE id=?", (json.dumps(overrides), user_id))
        db.insert_audit(
            request.state.user["id"],
            action,
            user_id,
            user["display_name"],
            details={"target_user_id": user_id, "permission_changes": changes},
        )
    return {"permissions": updated, "overrides": overrides}


def register_admin_routes(app: FastAPI) -> None:
    register_sketch_routes(app)
    options = {"dependencies": [Depends(authorize_admin)]}

    @app.get("/api/admin/fun", **options)
    async def fun_settings() -> dict:
        return FunSettings.model_validate(app.state.bot.state.fun_settings).model_dump()

    @app.put("/api/admin/fun", **options)
    async def save_fun(body: FunSettings, request: Request) -> dict:
        values = body.model_dump()
        await app.state.db.run(app.state.db.set_setting, "fun_settings", values)
        app.state.bot.state.fun_settings = values
        if not values["kirby"]:
            app.state.bot.state.kirby.clear()
        await app.state.db.run(app.state.db.audit, request.state.user["id"], "fun.update", details=values)
        app.state.events.publish("fun.settings", {**values, "resource": "/state/fun", "value": {"fun": values}})
        app.state.events.publish("audit")
        return values

    @app.post("/api/admin/goose/message", **options)
    async def goose_message(body: GooseMessage) -> dict:
        app.state.events.publish(
            "fun.goose",
            {"instance_id": uuid.uuid4().hex, "text": body.text, "emitted_at": time.monotonic()},
        )
        return {"sent": True}

    @app.post("/api/admin/goose/action", **options)
    async def goose_action(body: GooseAction) -> dict:
        drawing = await app.state.db.run(
            resolve_sketch, app.state.db, body.sketch_id if body.action == "draw" else None
        )
        app.state.events.publish(
            "fun.goose",
            {
                **body.model_dump(),
                "drawing": drawing,
                "instance_id": uuid.uuid4().hex,
                "emitted_at": time.monotonic(),
                "duration_ms": {"raid": 10000, "draw": 30000, "deliver": 12000}[body.action],
            },
        )
        return {"sent": True}

    @app.get("/api/admin/permissions", **options)
    async def catalogue() -> dict:
        return {
            "permissions": [{"id": key, "label": label, "group": group} for key, label, group in CATALOGUE],
            "defaults": DEFAULTS,
            "admin_defaults": effective_permissions({}, admin=True),
        }

    @app.get("/api/admin/users", **options)
    async def users(
        q: Annotated[str, Query(max_length=200)] = "",
        page: Annotated[int, Query(ge=1)] = 1,
        page_size: Annotated[int, Query(ge=1, le=50)] = 50,
    ) -> dict:
        search = (q.strip(),) * 3
        total = (
            await app.state.db.run(
                app.state.db.one,
                "SELECT COUNT(*) AS total FROM users WHERE instr(lower(display_name),lower(?))>0 "
                "OR instr(lower(username),lower(?))>0 OR instr(id,?)>0",
                search,
            )
        )["total"]
        rows = await app.state.db.run(
            app.state.db.rows,
            "SELECT id,username,display_name,avatar,last_login,permission_overrides FROM users WHERE "
            "instr(lower(display_name),lower(?))>0 OR instr(lower(username),lower(?))>0 OR instr(id,?)>0 "
            "ORDER BY display_name COLLATE NOCASE,id LIMIT ? OFFSET ?",
            (*search, page_size, (page - 1) * page_size),
        )
        return {
            "users": [user_permissions(app, user) for user in rows],
            "total": total,
            "page": page,
            "page_size": page_size,
        }

    @app.put("/api/admin/users/{user_id}/permissions", **options)
    async def save(user_id: str, body: PermissionOverrides, request: Request) -> dict:
        result = await app.state.db.run(update_permissions, app, request, user_id, body.overrides, "permissions.update")
        app.state.events.publish("permissions", {"user_id": user_id})
        return result

    @app.delete("/api/admin/users/{user_id}/permissions", **options)
    async def reset(user_id: str, request: Request) -> dict:
        result = await app.state.db.run(update_permissions, app, request, user_id, {}, "permissions.reset")
        app.state.events.publish("permissions", {"user_id": user_id})
        return result
