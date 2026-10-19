from functools import partial
from typing import Annotated, Literal

from fastapi import Depends, FastAPI, HTTPException, Query, Request

from app.music_models import MusicLibraryQuery, MusicLibraryStatusInput, MusicMembershipInput
from app.music_playlist_tracks import publish_saved_playlist
from app.permissions import require_permission


async def recording_status(app: FastAPI, provider: str, source_id: str, youtube_id: str | None) -> dict:
    cache = app.state.music_cache
    track = {"provider": provider, "source_id": source_id, "youtube_id": youtube_id, "title": "", "duration": 0}
    key = cache.entry_key(track)
    result = cache.status(track)
    if result["state"] == "cached":

        def available() -> bool:
            try:
                return (cache.root / (key + ".audio")).stat().st_size == result["bytes"]
            except OSError:
                return False

        if not await app.state.db.run(available):
            return {"state": "failed", "error": "The downloaded recording is missing. Retry in Downloads."}
    if result["state"] == "queued" and key not in cache.states and key not in cache.priorities:
        return {"state": "not_downloaded"}
    return result


def register_library_routes(app: FastAPI) -> None:
    options = {"dependencies": [Depends(require_permission("view_music"))]}

    @app.get("/api/music/cache", **options)
    async def cache_status(
        provider: Literal["youtube", "spotify"],
        source_id: Annotated[str, Query(min_length=1, max_length=64)],
        youtube_id: Annotated[str | None, Query(min_length=1, max_length=64)] = None,
    ) -> dict:
        return await recording_status(app, provider, source_id, youtube_id)

    @app.get("/api/music/library/status", **options)
    async def status(
        provider: Literal["youtube", "spotify"], source_id: Annotated[str, Query(min_length=1, max_length=64)]
    ) -> dict:
        return await app.state.db.run(app.state.music_store.saved, provider, source_id)

    @app.post("/api/music/library/status", **options)
    async def statuses(body: MusicLibraryStatusInput) -> dict:
        return await app.state.db.run(app.state.music_store.saved_tracks, [track.model_dump() for track in body.tracks])

    @app.get("/api/music/library", **options)
    async def library(request: Request, query: Annotated[MusicLibraryQuery, Query()]) -> dict:
        return await app.state.db.run(
            app.state.music_store.library,
            request.state.user,
            (query.provider, query.source_id),
            query.q.strip(),
            (query.offset, query.limit),
        )

    @app.put("/api/music/playlists/{playlist_id}/membership", **options)
    async def membership(playlist_id: str, body: MusicMembershipInput, request: Request) -> dict:
        track = body.track.model_dump()
        if body.saved and track["duration"] > app.state.music_sources.settings.max_source_seconds:
            raise HTTPException(422, "A song exceeds the configured source duration limit.")
        result = await app.state.db.run(
            partial(app.state.music_store.set_membership, playlist_id, request.state.user, track, saved=body.saved)
        )
        app.state.music_cache.refresh()
        playlist = await app.state.db.run(publish_saved_playlist, app, playlist_id, request.state.user)
        return {**result, **playlist}
