from __future__ import annotations

from fastapi import Depends, FastAPI, HTTPException, Request

from app.auth import authorize


def register_resource_routes(app: FastAPI) -> None:
    options = {"dependencies": [Depends(authorize)]}

    @app.get("/api/state/interface", **options)
    async def interface(request: Request) -> dict:
        member = await app.state.auth.member(request, str(app.state.bot.settings.discord_guild_id), fresh=False)
        return {
            "user": request.state.user,
            "build_id": app.state.frontend.build_id,
            "channels": app.state.bot.channels(app.state.bot.settings.discord_guild_id, member),
            "emojis": app.state.bot.emojis(),
        }

    @app.get("/api/state/sounds", **options)
    async def sounds(request: Request) -> dict:
        return {
            "clips": await app.state.db.run(
                app.state.db.clips, request.state.user["id"], str(app.state.bot.settings.discord_guild_id)
            )
        }

    @app.get("/api/state/library", **options)
    async def library(request: Request) -> dict:
        return {
            **await sounds(request),
            "sources": await app.state.db.run(app.state.db.sources),
            "limits": {"max_source_seconds": app.state.media.settings.max_source_seconds},
        }

    @app.get("/api/state/sources/{source_id}", **options)
    async def source(source_id: str) -> dict:
        rows = await app.state.db.run(app.state.db.sources)
        value = next((row for row in rows if row["id"] == source_id), None)
        if value is None:
            raise HTTPException(404, "This video is no longer available.")
        return value

    @app.get("/api/state/editor-options", **options)
    async def editor_options(request: Request) -> dict:
        clips = await app.state.db.run(app.state.db.clips)
        return {
            "user": request.state.user,
            "emojis": app.state.bot.emojis(),
            "tags": sorted({tag for clip in clips for tag in clip["tags"]}),
            "max_clip_seconds": app.state.bot.settings.max_clip_seconds,
        }

    @app.get("/api/state/fun", **options)
    async def fun() -> dict:
        return {"fun": app.state.bot.state.fun_settings}
