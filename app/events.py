from __future__ import annotations

import asyncio
import json
import time
from typing import TYPE_CHECKING

from fastapi import HTTPException, status

if TYPE_CHECKING:
    from collections.abc import AsyncIterator

    from fastapi import Request

    from app.types import JsonObject


MAX_EFFECT_AGE_MS = 3000


class Events:
    def __init__(self, build_id: str | None = None) -> None:
        self.build_id = build_id
        self.closing = False
        self.clients: set[asyncio.Queue] = set()

    def publish(self, event: str, data: JsonObject | None = None) -> None:
        message = f"event: {event}\ndata: {json.dumps(data or {})}\n\n"
        for queue in tuple(self.clients):
            if queue.full():
                queue.get_nowait()
            queue.put_nowait(message)

    def shutdown(self) -> None:
        self.closing = True
        self.publish("server-shutdown")

    @staticmethod
    def for_viewer(message: str, request: Request) -> str | None:
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
        return "event: music_likes\ndata: {}\n\n" if request.state.user["id"] == data["user_id"] else None

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

    async def stream(self, request: Request) -> AsyncIterator[str]:
        queue = asyncio.Queue(maxsize=32)
        self.clients.add(queue)
        try:
            yield f"event: refresh\ndata: {json.dumps({'build_id': self.build_id})}\n\n"
            while not self.closing and not await request.is_disconnected():
                try:
                    await request.app.state.auth.current(request)
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
                    message = self.for_viewer(message, request)
                    if message:
                        yield message
                except TimeoutError:
                    yield ": heartbeat\n\n"
        finally:
            self.clients.discard(queue)
