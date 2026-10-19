from __future__ import annotations

import asyncio
import json
import re
import time
import uuid
from typing import TYPE_CHECKING

from fastapi import HTTPException, status

if TYPE_CHECKING:
    from collections.abc import AsyncIterator, Callable

    from fastapi import Request

    from app.types import JsonObject


MAX_EFFECT_AGE_MS = 3000


class Events:
    def __init__(self, build_id: str | None = None) -> None:
        self.build_id = build_id
        self.closing = False
        self.revision = 0
        self.media_revision = 0
        self.epoch = uuid.uuid4().hex
        self.clients: set[asyncio.Queue] = set()
        self.download_usage: Callable[[], dict] | None = None

    def publish(self, event: str, data: JsonObject | None = None) -> None:
        self.revision += 1
        if (
            event in {"storage", "music_cache", "music_playlists", "music_likes", "jobs", "library", "music"}
            and (data or {}).get("scope") != "music.playback"
        ):
            self.media_revision += 1
        payload = {**(data or {}), "epoch": self.epoch, "revision": self.revision}
        if (
            self.download_usage
            and (data or {}).get("scope") != "music.playback"
            and event
            in {
                "storage",
                "music_cache",
                "music_playlists",
                "music",
                "music_likes",
                "jobs",
                "library",
                "settings",
            }
        ):
            payload["downloads_usage"] = self.download_usage()
        message = f"event: {event}\ndata: {json.dumps(payload)}\n\n"
        for queue in tuple(self.clients):
            if queue.full():
                while not queue.empty():
                    queue.get_nowait()
                queue.put_nowait(f"event: refresh\ndata: {json.dumps({'build_id': self.build_id})}\n\n")
                if queue.full():
                    continue
            queue.put_nowait(message)

    def shutdown(self) -> None:
        self.closing = True
        self.publish("server-shutdown")

    @staticmethod
    def permitted(message: str, request: Request) -> bool:
        data = json.loads(message.split("data: ", 1)[1])
        resource = data.get("resource", "")
        permission = (
            "view_actions"
            if resource.startswith("/actions/")
            else "view_conversations"
            if resource.startswith("/conversation/")
            else "view_music"
            if resource.startswith("/music/")
            else None
        )
        return not permission or bool(request.state.user.get("permissions", {}).get(permission, False))

    @staticmethod
    def for_viewer(message: str, request: Request) -> str | None:
        if message.startswith(("event: settings\n", "event: conversation\n")):
            data = json.loads(message.split("data: ", 1)[1])
            resource = data.get("resource", "")
            if (resource.startswith("/admin/") or resource == "/settings/app") and not request.state.user.get("admin"):
                data.pop("resource", None)
                data.pop("value", None)
                message = message.split("\n", 1)[0] + "\ndata: " + json.dumps(data) + "\n\n"
        if message.startswith(("event: music_likes\n", "event: fun.kirby\n")):
            return Events.account_for_viewer(message, request)
        if message.startswith("event: fun.goose\n"):
            return Events.goose_for_viewer(message)
        if not message.startswith("event: fun.play\n"):
            return message
        data = json.loads(message.split("data: ", 1)[1])
        state = request.app.state.bot.state
        voice = state.voice
        user_id = request.state.user["id"]
        if (
            not voice
            or not voice.is_connected()
            or str(voice.channel.id) != data["channel_id"]
            or user_id not in data["participants"]
            or not any(str(member.id) == user_id and not member.bot for member in voice.channel.members)
            or not state.fun_settings.get(data["effect"], False)
        ):
            return None
        elapsed = max(0, (time.monotonic() - data["emitted_at"]) * 1000)
        if elapsed > MAX_EFFECT_AGE_MS:
            return None
        payload = {key: data[key] for key in ("effect", "instance_id", "channel_id")}
        payload["elapsed_ms"] = elapsed
        return f"event: fun.play\ndata: {json.dumps(payload)}\n\n"

    @staticmethod
    def account_for_viewer(message: str, request: Request) -> str | None:
        if message.startswith("event: fun.kirby\n"):
            return Events.kirby_for_viewer(message, request)
        data = json.loads(message.split("data: ", 1)[1])
        if request.state.user["id"] != data["user_id"]:
            return None
        payload = {key: value for key, value in data.items() if key != "user_id"}
        return f"event: music_likes\ndata: {json.dumps(payload)}\n\n"

    @staticmethod
    def goose_for_viewer(message: str) -> str | None:
        data = json.loads(message.split("data: ", 1)[1])
        elapsed = max(0, (time.monotonic() - data["emitted_at"]) * 1000)
        if elapsed > MAX_EFFECT_AGE_MS:
            return None
        payload = {key: value for key, value in data.items() if key not in {"emitted_at", "duration_ms"}}
        payload["remaining_ms"] = data.get("duration_ms", 5000) - elapsed
        return f"event: fun.goose\ndata: {json.dumps(payload)}\n\n"

    @staticmethod
    def kirby_for_viewer(message: str, request: Request) -> str | None:
        data = json.loads(message.split("data: ", 1)[1])
        if request.state.user["id"] != data["user_id"]:
            return None
        remaining = request.app.state.bot.state.kirby.remaining(data["user_id"])
        if not remaining:
            return None
        return f"event: fun.kirby\ndata: {json.dumps({'remaining_ms': remaining})}\n\n"

    @staticmethod
    def connect_media_client(request: Request) -> tuple:
        manager = getattr(request.app.state, "media_management", None)
        candidate = request.query_params.get("client_id", "") if manager else ""
        if not isinstance(candidate, str):
            candidate, manager = "", None
        client_id = candidate if re.fullmatch(r"[a-zA-Z0-9-]{1,80}", candidate) else "legacy:" + uuid.uuid4().hex
        user_id = request.state.user["id"] if manager else ""
        if manager:
            manager.connect(client_id, user_id, connected=True)
        return manager, client_id, user_id

    async def stream(self, request: Request) -> AsyncIterator[str]:
        queue = asyncio.Queue(maxsize=32)
        self.clients.add(queue)
        manager, client_id, user_id = self.connect_media_client(request)
        try:
            yield f"event: refresh\ndata: {json.dumps({'build_id': self.build_id})}\n\n"
            while not self.closing and not await request.is_disconnected():
                try:
                    await request.app.state.auth.current(request)
                    if manager:
                        manager.connect(client_id, user_id, connected=True)
                except HTTPException as error:
                    if error.status_code >= status.HTTP_500_INTERNAL_SERVER_ERROR:
                        yield ": authentication temporarily unavailable\n\n"
                        await asyncio.sleep(5)
                        continue
                    yield f"event: auth-required\ndata: {json.dumps({'status': error.status_code})}\n\n"
                    return
                try:
                    message = await asyncio.wait_for(queue.get(), 15)
                    if self.closing:
                        return
                    message = self.for_viewer(message, request) if self.permitted(message, request) else None
                    if message:
                        yield message
                except TimeoutError:
                    yield ": heartbeat\n\n"
        finally:
            self.clients.discard(queue)
            if manager:
                manager.connect(client_id, user_id, connected=False)
