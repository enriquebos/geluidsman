from __future__ import annotations

import json
from typing import TYPE_CHECKING

from fastapi import HTTPException

from app.permissions import check_permission, effective_permissions

if TYPE_CHECKING:
    from fastapi import FastAPI


async def music_user(app: FastAPI, user_id: str) -> dict:
    row = await app.state.db.run(app.state.db.one, "SELECT * FROM users WHERE id=?", (user_id,))
    if not row:
        raise HTTPException(403, "This account is no longer available.")
    permissions = effective_permissions(
        json.loads(row["permission_overrides"]), admin=user_id in app.state.bot.settings.app_admin_ids
    )
    row.update(permissions=permissions, admin=permissions["admin"])
    check_permission(row, "view_music")
    return row


def music_voice_access(app: FastAPI, user: dict, *, mode_required: bool = True, control_required: bool = True) -> None:
    if control_required:
        check_permission(user, "control_music")
    state = app.state.bot.state
    voice = state.voice
    if app.state.bot.closing or not app.state.bot.client.is_ready() or not voice or not voice.is_connected():
        raise HTTPException(409, "Connect the bot to a voice channel before controlling music.")
    if not any(str(member.id) == user["id"] and not member.bot for member in voice.channel.members):
        raise HTTPException(403, "Join the bot's voice channel to control music or switch modes.")
    if mode_required and state.audio_mode != "music":
        raise HTTPException(409, "Switch to Music mode before controlling the music queue or player.")
