from __future__ import annotations

from functools import partial
from typing import TYPE_CHECKING, Annotated

from fastapi import Depends, FastAPI, HTTPException, Query, Request

from app.music_access import music_voice_access, recheck_music_voice_access
from app.music_library import register_library_routes
from app.music_models import (
    MusicImportInput,
    MusicLikeInput,
    MusicModeInput,
    MusicOrderInput,
    MusicPlayerInput,
    MusicTrackInput,
    MusicTracksInput,
    PlaylistInput,
    PlaylistUpdate,
)
from app.music_playlist_tracks import publish_saved_playlist, register_playlist_track_routes
from app.music_sources import MAX_QUERY, MusicSourceError
from app.music_uploads import register_music_upload_routes
from app.permissions import require_permission

if TYPE_CHECKING:
    from collections.abc import Awaitable


async def player_result(result: Awaitable[dict]) -> dict:
    try:
        return await result
    except ValueError as error:
        raise HTTPException(409, str(error)) from None


def saved_origin(body: MusicTracksInput, request: Request) -> dict | None:
    reference = body.saved_origin
    if reference is None:
        return None
    store, user = request.app.state.music_store, request.state.user
    row = store.liked(user) if reference.playlist_id == "liked" else store.playlist(reference.playlist_id)
    if row["updated_at"] != reference.expected_updated_at or reference.index >= len(row["tracks"]):
        raise HTTPException(409, "This saved song changed. Review it before adding it to the queue.")
    if (
        len(body.tracks) != 1
        or body.tracks[0].model_dump()
        != MusicTracksInput(tracks=[row["tracks"][reference.index]]).tracks[0].model_dump()
    ):
        raise HTTPException(409, "This recording no longer matches the saved song.")
    return {"playlist_id": reference.playlist_id, "owner_id": user["id"]}


def tracks_for_player(body: MusicTracksInput, request: Request) -> list[dict]:
    tracks = [track.model_dump() for track in body.tracks]
    if any(track["duration"] > request.app.state.music_sources.settings.max_source_seconds for track in tracks):
        raise HTTPException(422, "A song exceeds the configured source duration limit.")
    return tracks


def register_music_routes(app: FastAPI) -> None:
    @app.put("/api/audio-mode", dependencies=[Depends(require_permission("view_music", "switch_audio_mode"))])
    async def mode(body: MusicModeInput, request: Request) -> dict:
        music_voice_access(app, request.state.user, mode_required=False, control_required=False)
        await app.state.bot.state.select_mode(body.mode, request.state.user["id"])
        return {"status": app.state.bot.status()}

    @app.get("/api/music", dependencies=[Depends(require_permission("view_music"))])
    async def music(request: Request) -> dict:
        return {**app.state.music.snapshot(), "imports": app.state.music_imports.snapshot(request.state.user)}

    @app.get("/api/music/search", dependencies=[Depends(require_permission("view_music"))])
    async def search(q: Annotated[str, Query(min_length=1, max_length=MAX_QUERY)]) -> dict:
        try:
            return {"tracks": await app.state.music_sources.search(q.strip())}
        except MusicSourceError as error:
            raise HTTPException(400, str(error)) from None

    @app.post("/api/music/imports", status_code=202, dependencies=[Depends(require_permission("view_music"))])
    async def start_import(body: MusicImportInput, request: Request) -> dict:
        return await app.state.music_imports.start(body.query.strip(), body.destination, request.state.user)

    @app.delete("/api/music/imports/{job_id}", dependencies=[Depends(require_permission("view_music"))])
    async def cancel_import(job_id: str, request: Request) -> dict:
        await app.state.music_imports.cancel(job_id, request.state.user)
        return {"ok": True}

    register_player_routes(app)
    register_queue_routes(app)
    register_playlist_routes(app)
    register_playlist_track_routes(app)
    register_music_upload_routes(app)
    register_playlist_playback(app)
    register_likes_routes(app)
    register_library_routes(app)


def register_likes_routes(app: FastAPI) -> None:
    options = {"dependencies": [Depends(require_permission("view_music"))]}

    @app.get("/api/music/likes", **options)
    async def likes(request: Request) -> dict:
        return await app.state.db.run(app.state.music_store.like_summary, request.state.user)

    @app.put("/api/music/likes", **options)
    async def like(body: MusicLikeInput, request: Request) -> dict:
        track = (
            tracks_for_player(MusicTracksInput(tracks=[body.track]), request)[0]
            if body.liked
            else body.track.model_dump()
        )
        result = await app.state.db.run(
            partial(app.state.music_store.set_like, request.state.user, track, liked=body.liked)
        )
        app.state.music_cache.refresh()
        app.state.events.publish("music_likes", {"user_id": request.state.user["id"]})
        return result

    @app.get("/api/music/likes/playlist", **options)
    async def liked_playlist(request: Request) -> dict:
        row = await app.state.db.run(app.state.music_store.liked, request.state.user)
        row["cache"] = [app.state.music_cache.status(track) for track in row["tracks"]]
        return row

    @app.get("/api/music/likes/cache", **options)
    async def liked_cache(request: Request) -> dict:
        row = await app.state.db.run(app.state.music_store.liked, request.state.user)
        return {
            "cache": [app.state.music_cache.status(track) for track in row["tracks"]],
            "updated_at": row["updated_at"],
        }

    @app.post("/api/music/likes/cache", **options)
    async def retry_liked_cache(request: Request) -> dict:
        row = await app.state.db.run(app.state.music_store.liked, request.state.user)
        await app.state.music_cache.retry_verified(row["tracks"])
        return {"ok": True}

    async def playable(request: Request) -> list[dict]:
        music_voice_access(app, request.state.user)
        row = await app.state.db.run(app.state.music_store.liked, request.state.user)
        if not row["tracks"]:
            raise HTTPException(409, "Like a song before playing Liked Songs.")
        return tracks_for_player(MusicTracksInput(tracks=row["tracks"]), request)

    control = {"dependencies": [Depends(require_permission("view_music", "control_music"))]}

    @app.post("/api/music/likes/play", **control)
    async def play_likes(request: Request) -> dict:
        tracks = await playable(request)
        return await player_result(
            app.state.music.play_playlist(
                tracks,
                request.state.user,
                {"id": "liked:" + request.state.user["id"], "name": "Liked Songs"},
                guard=lambda: recheck_music_voice_access(app, request.state.user["id"]),
            )
        )

    @app.post("/api/music/likes/queue", **control)
    async def queue_likes(request: Request) -> dict:
        tracks = await playable(request)
        return await player_result(
            app.state.music.enqueue(
                tracks,
                request.state.user,
                guard=lambda: recheck_music_voice_access(app, request.state.user["id"]),
                saved_origin={"playlist_id": "liked", "owner_id": request.state.user["id"]},
            )
        )


def register_player_routes(app: FastAPI) -> None:
    options = {"dependencies": [Depends(require_permission("view_music", "control_music"))]}

    @app.post("/api/music/play", **options)
    async def play_now(body: MusicTrackInput, request: Request) -> dict:
        music_voice_access(app, request.state.user)
        collection = MusicTracksInput(tracks=[body.track], saved_origin=body.saved_origin)
        reference = await app.state.db.run(saved_origin, collection, request)
        tracks = tracks_for_player(collection, request)
        return await player_result(
            app.state.music.play_now(
                tracks[0],
                request.state.user,
                guard=lambda: recheck_music_voice_access(app, request.state.user["id"]),
                saved_origin=reference,
            )
        )

    @app.post("/api/music/player", **options)
    async def player(body: MusicPlayerInput, request: Request) -> dict:
        music_voice_access(app, request.state.user)
        if body.action == "seek" and body.value is None:
            raise HTTPException(422, "Choose a playback position.")
        if body.action == "repeat" and body.value not in {None, 0, 1, 2}:
            raise HTTPException(422, "Choose repeat off, one song or all songs.")
        if body.action == "shuffle" and body.value not in {None, 0, 1}:
            raise HTTPException(422, "Choose shuffle on or off.")
        return await player_result(
            app.state.music.command(
                body.action, body.value, guard=lambda: recheck_music_voice_access(app, request.state.user["id"])
            )
        )


def register_queue_routes(app: FastAPI) -> None:
    options = {"dependencies": [Depends(require_permission("view_music", "control_music"))]}

    @app.post("/api/music/queue", **options)
    async def enqueue(body: MusicTracksInput, request: Request) -> dict:
        music_voice_access(app, request.state.user)
        reference = await app.state.db.run(saved_origin, body, request)
        return await player_result(
            app.state.music.enqueue(
                tracks_for_player(body, request),
                request.state.user,
                guard=lambda: recheck_music_voice_access(app, request.state.user["id"]),
                saved_origin=reference,
            )
        )

    @app.put("/api/music/queue/order", **options)
    async def reorder(body: MusicOrderInput, request: Request) -> dict:
        music_voice_access(app, request.state.user)
        return await player_result(
            app.state.music.reorder(body.ids, guard=lambda: recheck_music_voice_access(app, request.state.user["id"]))
        )

    @app.delete("/api/music/queue", **options)
    async def clear(request: Request) -> dict:
        music_voice_access(app, request.state.user)
        return await player_result(
            app.state.music.clear(guard=lambda: recheck_music_voice_access(app, request.state.user["id"]))
        )

    @app.delete("/api/music/queue/{entry_id}", **options)
    async def remove(entry_id: str, request: Request) -> dict:
        music_voice_access(app, request.state.user)
        return await player_result(
            app.state.music.remove(entry_id, guard=lambda: recheck_music_voice_access(app, request.state.user["id"]))
        )


def register_playlist_routes(app: FastAPI) -> None:
    options = {"dependencies": [Depends(require_permission("view_music"))]}

    @app.get("/api/music/playlists", **options)
    async def playlists(
        request: Request,
        offset: Annotated[int, Query(ge=0)] = 0,
        limit: Annotated[int, Query(ge=1, le=50)] = 50,
        *,
        editable_only: bool = False,
    ) -> dict:
        return await app.state.db.run(
            partial(
                app.state.music_store.playlists,
                request.state.user["id"],
                offset,
                limit,
                editable_by=request.state.user if editable_only else None,
            )
        )

    @app.get("/api/music/playlists/{playlist_id}", **options)
    async def playlist(playlist_id: str) -> dict:
        result = await app.state.db.run(app.state.music_store.playlist, playlist_id)
        result["cache"] = [app.state.music_cache.status(track) for track in result["tracks"]]
        return result

    @app.post("/api/music/playlists", status_code=201, **options)
    async def create(body: PlaylistInput, request: Request) -> dict:
        result = await app.state.db.run(
            partial(app.state.music_store.create, body.name, request.state.user, collaborative=body.collaborative)
        )
        app.state.events.publish("music_playlists")
        return result

    @app.patch("/api/music/playlists/{playlist_id}", **options)
    async def update(playlist_id: str, body: PlaylistUpdate, request: Request) -> dict:
        changes = body.model_dump(exclude_none=True)
        if body.tracks:
            tracks_for_player(MusicTracksInput(tracks=body.tracks), request)
        await app.state.db.run(app.state.music_store.update, playlist_id, request.state.user, changes)
        app.state.music_cache.refresh()
        return await app.state.db.run(publish_saved_playlist, app, playlist_id, request.state.user)

    @app.delete("/api/music/playlists/{playlist_id}", **options)
    async def delete(playlist_id: str, request: Request) -> dict:
        await app.state.db.run(app.state.music_store.delete, playlist_id, request.state.user)
        app.state.music_cache.refresh()
        app.state.events.publish("music_playlists")
        return {"ok": True}

    @app.post("/api/music/playlists/{playlist_id}/cache", **options)
    async def retry_cache(playlist_id: str, request: Request) -> dict:
        row = await app.state.db.run(app.state.music_store.playlist, playlist_id)
        app.state.music_store.editable(row, request.state.user)
        await app.state.music_cache.retry_verified(row["tracks"])
        return {"ok": True}

    @app.get("/api/music/playlists/{playlist_id}/cache", **options)
    async def cache_status(playlist_id: str) -> dict:
        row = await app.state.db.run(app.state.music_store.playlist, playlist_id)
        return {
            "cache": [app.state.music_cache.status(track) for track in row["tracks"]],
            "updated_at": row["updated_at"],
        }


def register_playlist_playback(app: FastAPI) -> None:
    options = {"dependencies": [Depends(require_permission("view_music", "control_music"))]}

    async def playable(playlist_id: str, request: Request) -> tuple[dict, list[dict]]:
        music_voice_access(app, request.state.user)
        row = await app.state.db.run(app.state.music_store.playlist, playlist_id)
        if not row["tracks"]:
            raise HTTPException(409, "Add a song to this playlist before playing it.")
        tracks = tracks_for_player(MusicTracksInput(tracks=row["tracks"]), request)
        return row, tracks

    @app.post("/api/music/playlists/{playlist_id}/queue", **options)
    async def queue(playlist_id: str, request: Request) -> dict:
        _, tracks = await playable(playlist_id, request)
        return await player_result(
            app.state.music.enqueue(
                tracks,
                request.state.user,
                guard=lambda: recheck_music_voice_access(app, request.state.user["id"]),
                saved_origin={"playlist_id": playlist_id, "owner_id": request.state.user["id"]},
            )
        )

    @app.post("/api/music/playlists/{playlist_id}/play", **options)
    async def play(playlist_id: str, request: Request) -> dict:
        row, tracks = await playable(playlist_id, request)
        return await player_result(
            app.state.music.play_playlist(
                tracks,
                request.state.user,
                {"id": row["id"], "name": row["name"]},
                guard=lambda: recheck_music_voice_access(app, request.state.user["id"]),
            )
        )
