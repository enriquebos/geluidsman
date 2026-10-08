from __future__ import annotations

import asyncio
import json
from typing import TYPE_CHECKING

from fastapi import HTTPException, status

if TYPE_CHECKING:
    from collections.abc import AsyncIterator

    from fastapi import Request

    from app.types import JsonObject


class Events:
    def __init__(self) -> None:
        self.clients: set[asyncio.Queue] = set()

    def publish(self, event: str, data: JsonObject | None = None) -> None:
        message = f"event: {event}\ndata: {json.dumps(data or {})}\n\n"
        for queue in tuple(self.clients):
            if queue.full():
                queue.get_nowait()
            queue.put_nowait(message)

    async def stream(self, request: Request) -> AsyncIterator[str]:
        queue = asyncio.Queue(maxsize=32)
        self.clients.add(queue)
        try:
            yield "event: refresh\ndata: {}\n\n"
            while not await request.is_disconnected():
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
                    yield await asyncio.wait_for(queue.get(), 15)
                except TimeoutError:
                    yield ": heartbeat\n\n"
        finally:
            self.clients.discard(queue)
