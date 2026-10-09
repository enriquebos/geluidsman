from __future__ import annotations

import json
import time
from typing import TYPE_CHECKING
from unittest.mock import Mock

from app.permissions import effective_permissions

if TYPE_CHECKING:
    from fastapi import FastAPI, Request


def authenticated_fixture(app: FastAPI) -> None:
    app.state.auth.admin_ids.add("100")

    async def current(request: Request, *, csrf: bool = True) -> dict:
        if not csrf:
            request.state.fixture = True
        db = app.state.db
        db.execute(
            "INSERT OR IGNORE INTO users(id,username,display_name,created_at,last_login) VALUES (?,?,?,?,?)",
            ("100", "tester", "Test Member", time.time(), time.time()),
        )
        profile = db.one("SELECT * FROM users WHERE id='100'")
        profile.update(
            admin=True,
            protected_admin=True,
            permissions=effective_permissions(json.loads(profile["permission_overrides"]), admin=True),
            csrf="fixture-csrf",
            guilds=[{"id": "1352422295402057759", "name": "Test server"}],
            preferences={
                "preview_volume": 0.8,
                "caption_language": "all",
                **json.loads(profile["preferences"]),
            },
        )
        request.state.user = profile
        request.state.session = {"id": "fixture", "user_id": "100"}
        return profile

    async def member(_request: Request, guild_id: str, *, fresh: bool = True, max_age: float = 300) -> Mock | None:
        if not fresh and max_age > 0:
            _request.state.fixture = True
        guild = app.state.bot.client.get_guild(int(guild_id))
        return Mock(guild=guild) if guild else None

    app.state.auth.current = current
    app.state.auth.member = member

    async def guild_members() -> list[dict]:
        return [
            {"id": "100", "name": "Test Member", "avatar": None},
            {"id": "200", "name": "Fixture Member", "avatar": None},
        ]

    app.state.bot.guild_members = guild_members
