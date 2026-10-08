from __future__ import annotations

import json
from typing import TYPE_CHECKING, Annotated

from fastapi import Depends, HTTPException, Query, Request
from pydantic import BaseModel, ConfigDict, Field, StrictBool, field_validator

from app.auth import authorize_admin
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
    user["admin"] = user["id"] in app.state.auth.admin_ids
    user["overrides"] = json.loads(user.pop("permission_overrides"))
    user["permissions"] = effective_permissions(user["overrides"], admin=user["admin"])
    return user


def update_permissions(app: FastAPI, request: Request, user_id: str, overrides: dict, action: str) -> dict:
    db = app.state.db
    with db.lock, db.conn:
        user = db.one("SELECT id,display_name,permission_overrides FROM users WHERE id=?", (user_id,))
        if not user:
            raise HTTPException(404, "User not found.")
        if user_id in app.state.auth.admin_ids:
            raise HTTPException(409, "Configured administrators have protected full access.")
        previous = effective_permissions(json.loads(user["permission_overrides"]))
        updated = effective_permissions(overrides)
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
    app.state.events.publish("refresh")
    return {"permissions": updated, "overrides": overrides}


def register_admin_routes(app: FastAPI) -> None:
    options = {"dependencies": [Depends(authorize_admin)]}

    @app.get("/api/admin/permissions", **options)
    async def catalogue() -> dict:
        return {
            "permissions": [{"id": key, "label": label, "group": group} for key, label, group in CATALOGUE],
            "defaults": DEFAULTS,
        }

    @app.get("/api/admin/users", **options)
    async def users(
        q: Annotated[str, Query(max_length=200)] = "",
        page: Annotated[int, Query(ge=1)] = 1,
        page_size: Annotated[int, Query(ge=1, le=50)] = 50,
    ) -> dict:
        search = (q.strip(),) * 3
        total = app.state.db.one(
            "SELECT COUNT(*) AS total FROM users WHERE instr(lower(display_name),lower(?))>0 "
            "OR instr(lower(username),lower(?))>0 OR instr(id,?)>0",
            search,
        )["total"]
        rows = app.state.db.rows(
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
        return update_permissions(app, request, user_id, body.overrides, "permissions.update")

    @app.delete("/api/admin/users/{user_id}/permissions", **options)
    async def reset(user_id: str, request: Request) -> dict:
        return update_permissions(app, request, user_id, {}, "permissions.reset")
