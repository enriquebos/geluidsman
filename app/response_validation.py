from __future__ import annotations

import hashlib
from typing import TYPE_CHECKING

from fastapi.responses import Response

if TYPE_CHECKING:
    from fastapi import Request
    from fastapi.responses import StreamingResponse


def validates_representation(path: str) -> bool:
    return path in {
        "/api/state",
        "/api/jobs",
        "/api/playback",
        "/api/actions/status",
        "/api/conversations/status",
        "/api/admin/permissions",
        "/api/downloads",
        "/api/downloads/summary",
        "/api/admin/storage",
        "/api/admin/storage/summary",
        "/api/admin/users",
        "/api/settings/app",
        "/api/admin/fun",
        "/api/audit",
        "/api/audit/options",
        "/api/audit/activity",
        "/api/audit/leaderboard",
        "/api/actions/users",
        "/api/actions/triggers",
        "/api/conversation/users",
        "/api/conversation/triggers",
        "/api/music/library",
        "/api/music/library/status",
        "/api/music/cache",
        "/api/music/likes",
        "/api/music/likes/playlist",
        "/api/music/playlists",
    } or path.startswith(("/api/state/", "/api/admin/transcription", "/api/music/playlists/"))


async def validate_representation(request: Request, response: StreamingResponse) -> Response:
    body = b"".join([chunk async for chunk in response.body_iterator])
    owner = request.state.user["id"]
    identity = f"{owner}:{request.url.path}?{request.url.query}:".encode()
    tag = '"' + hashlib.sha256(identity + body).hexdigest() + '"'
    headers = dict(response.headers)
    headers["etag"] = tag
    headers.pop("content-length", None)
    unchanged = request.headers.get("if-none-match") == tag
    return Response(
        content=None if unchanged else body,
        status_code=304 if unchanged else response.status_code,
        headers=headers,
        background=response.background,
    )
