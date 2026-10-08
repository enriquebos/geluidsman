from __future__ import annotations

from typing import TYPE_CHECKING, Literal

from fastapi import HTTPException, Request

if TYPE_CHECKING:
    from collections.abc import Awaitable, Callable


CATALOGUE = [
    ("admin", "Access admin panel", "Administration"),
    ("high_volume", "Boost sound volume to 1000%", "Sounds"),
    ("play_sounds", "Play sounds", "Soundboard"),
    ("stop_sounds", "Stop sounds and stop-all", "Soundboard"),
    ("connect_voice", "Connect or move the bot", "Voice"),
    ("disconnect_voice", "Disconnect the bot", "Voice"),
    ("master_volume", "Change master volume", "Voice"),
    ("mute_deafen", "Mute or deafen the bot", "Voice"),
    ("create_sounds", "Create sounds", "Sounds"),
    ("edit_own_sounds", "Edit own sounds", "Sounds"),
    ("edit_all_sounds", "Edit all sounds", "Sounds"),
    ("delete_own_sounds", "Delete own sounds", "Sounds"),
    ("delete_all_sounds", "Delete all sounds", "Sounds"),
    ("import_videos", "Import videos", "Library"),
    ("import_channels", "Import channels", "Library"),
    ("manage_imports", "Manage import jobs", "Library"),
    ("delete_videos", "Delete videos", "Library"),
    ("view_conversations", "View conversations", "Conversation"),
    ("control_recording", "Enable or disable recording", "Conversation"),
    ("manage_triggers", "Manage personal sound triggers", "Conversation"),
    ("view_audit", "View audit log", "Activity"),
]
DEFAULTS = {
    key: key not in {"admin", "high_volume", "mute_deafen", "master_volume"} for key, _label, _group in CATALOGUE
}


def effective_permissions(overrides: dict, *, admin: bool = False) -> dict[str, bool]:
    return {
        key: True if admin and key == "admin" else overrides.get(key, True if admin else default)
        for key, default in DEFAULTS.items()
    }


def check_permission(user: dict, permission: str) -> None:
    if not user["permissions"].get(permission, False):
        raise HTTPException(403, "You do not have permission to perform this action.")


def require_permission(*permissions: str) -> Callable[[Request], Awaitable[dict]]:
    async def verify(request: Request) -> dict:
        user = await request.app.state.auth.current(request)
        for permission in permissions:
            check_permission(user, permission)
        return user

    return verify


def require_sound_permission(action: Literal["edit", "delete"]) -> Callable[[Request], Awaitable[dict]]:
    async def verify(request: Request) -> dict:
        user = await request.app.state.auth.current(request)
        clip = request.app.state.db.one("SELECT creator_id FROM clips WHERE id=?", (request.path_params["clip_id"],))
        if not clip:
            raise HTTPException(404, "Sound not found.")
        if not user["permissions"][f"{action}_all_sounds"]:
            check_permission(user, f"{action}_own_sounds")
            if clip["creator_id"] != user["id"]:
                raise HTTPException(403, "You can only manage your own sounds.")
        return user

    return verify
