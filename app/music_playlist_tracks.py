from __future__ import annotations

from typing import Annotated

from fastapi import Depends, FastAPI, HTTPException, Path, Request
from pydantic import ValidationError

from app.music_models import MusicTrack, MusicTrackInput, PlaylistTrackUpdate
from app.music_sources import MusicSourceError, source_query
from app.permissions import check_permission, require_permission


def source_target(value: str) -> tuple[str, str]:
    try:
        kind, target = source_query(value)
    except MusicSourceError:
        raise HTTPException(422, "Use an individual YouTube video URL for the song source.") from None
    if kind != "track":
        raise HTTPException(422, "Use an individual YouTube video URL for the song source.")
    return target, target.rsplit("=", 1)[-1]


def edited_track(original: dict, body: PlaylistTrackUpdate, recording: dict | None) -> dict:
    track = dict(original)
    if body.name is not None and body.name != track["title"]:
        if track["provider"] == "spotify" and not track.get("original_title"):
            track["original_title"] = track["title"]
        track["title"] = body.name
    if recording is not None:
        track.update(youtube_id=recording["source_id"], youtube_title=recording["title"], match_locked=True)
        if track["provider"] == "youtube":
            track.update(
                source_id=recording["source_id"],
                duration=recording["duration"],
                thumbnail=recording.get("thumbnail"),
            )
    return MusicTrack.model_validate(track).model_dump()


async def edit_track(playlist_id: str, index: int, body: PlaylistTrackUpdate, request: Request) -> dict:
    app = request.app
    old = await app.state.db.run(
        app.state.music_store.track_for_edit, playlist_id, index, request.state.user, body.expected_updated_at
    )
    recording = None
    if body.source_url is not None:
        target, identity = source_target(body.source_url)
        cached = app.state.music_cache.recording(old) or {}
        selected = old.get("youtube_id") or cached.get("youtube_id")
        if identity != (selected or (old["source_id"] if old["provider"] == "youtube" else None)):
            try:
                resolved = await app.state.music_sources.resolve(target)
            except MusicSourceError as error:
                raise HTTPException(400, str(error)) from None
            tracks = resolved.get("tracks", [])
            if len(tracks) != 1 or tracks[0].get("provider") != "youtube" or tracks[0].get("source_id") != identity:
                raise HTTPException(400, "The source did not return the selected YouTube recording.")
            try:
                recording = MusicTrack.model_validate(tracks[0]).model_dump()
            except ValidationError:
                raise HTTPException(400, "The source returned unsupported recording metadata.") from None
            if recording["duration"] > app.state.music_sources.settings.max_source_seconds:
                raise HTTPException(422, "A song exceeds the configured source duration limit.")
    track = edited_track(old, body, recording)
    if track["duration"] > app.state.music_sources.settings.max_source_seconds:
        raise HTTPException(422, "A song exceeds the configured source duration limit.")
    user = await app.state.auth.current(request)
    check_permission(user, "view_music")
    result = await app.state.db.run(
        app.state.music_store.update_track,
        playlist_id,
        index,
        user,
        {"track": track, "expected_updated_at": body.expected_updated_at},
    )
    if recording is not None:
        await app.state.music_cache.replace(old, track)
    app.state.music_cache.refresh()
    app.state.events.publish("music_playlists")
    result["cache"] = [app.state.music_cache.status(item) for item in result["tracks"]]
    return result


def register_playlist_track_routes(app: FastAPI) -> None:
    options = {"dependencies": [Depends(require_permission("view_music"))]}

    @app.patch("/api/music/playlists/{playlist_id}/tracks/{index}", **options)
    async def update(
        playlist_id: str, index: Annotated[int, Path(ge=0, lt=1000)], body: PlaylistTrackUpdate, request: Request
    ) -> dict:
        return await edit_track(playlist_id, index, body, request)

    @app.post("/api/music/playlists/{playlist_id}/tracks", **options)
    async def append(playlist_id: str, body: MusicTrackInput, request: Request) -> dict:
        track = body.track.model_dump()
        if track["duration"] > app.state.music_sources.settings.max_source_seconds:
            raise HTTPException(422, "A song exceeds the configured source duration limit.")
        result = await app.state.db.run(app.state.music_store.append, playlist_id, request.state.user, [track])
        app.state.music_cache.refresh()
        app.state.events.publish("music_playlists")
        result["cache"] = [app.state.music_cache.status(item) for item in result["tracks"]]
        return result
