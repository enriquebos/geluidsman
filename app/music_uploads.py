from __future__ import annotations

import asyncio
import hashlib
import json
import time
import uuid
from pathlib import Path
from typing import Annotated

import anyio
from fastapi import Depends, FastAPI, HTTPException, Query, Request
from fastapi import Path as PathParameter
from pydantic import ValidationError

from app.audio_processing import MediaError, process
from app.music_cache import MAX_CACHE_ITEMS, MAX_MANIFEST_BYTES, MAX_RECORDING_METADATA_BYTES, cache_key
from app.music_models import MusicTrack, PlaylistTrackUpdate
from app.music_playlist_tracks import edited_track, publish_saved_playlist
from app.permissions import check_permission, effective_permissions, require_permission

MAX_MUSIC_UPLOAD_BYTES = 100 * 1024 * 1024


class MusicUpload:
    def __init__(self, request: Request, playlist: str, index: int, body: PlaylistTrackUpdate) -> None:
        self.request, self.playlist, self.index, self.body = request, playlist, index, body
        self.state = request.app.state
        self.cache = self.state.music_cache
        self.path = self.cache.root / ("upload-" + uuid.uuid4().hex + ".part")
        self.installed_key: str | None = None

    async def run(self, filename: str) -> dict:
        filename = filename.replace("\\", "/").rsplit("/", 1)[-1]
        if Path(filename).suffix.lower() != ".mp3":
            raise HTTPException(422, "Choose one .mp3 audio file.")
        original = await self.state.db.run(
            self.state.music_store.track_for_edit,
            self.playlist,
            self.index,
            self.request.state.user,
            self.body.expected_updated_at,
        )
        if await asyncio.to_thread(self.state.media.missing_audio_dependencies):
            raise HTTPException(503, "Audio uploads require FFmpeg and FFprobe.")
        async with self.state.media.lock:
            try:
                allocation = await self.state.db.run(
                    self.cache.budget.reserve,
                    self.path.name,
                    min(MAX_MUSIC_UPLOAD_BYTES, self.cache.sources.settings.max_import_bytes) + MAX_MANIFEST_BYTES,
                )
                if allocation <= MAX_MANIFEST_BYTES:
                    raise HTTPException(
                        409, "Media storage is full. Free space in Storage or increase the media limit."
                    )
                await asyncio.wait_for(
                    self.state.media.write_upload(self.request.stream(), self.path, allocation - MAX_MANIFEST_BYTES),
                    60,
                )
                duration = await self.probe()
                user = await self.state.auth.current(self.request)
                check_permission(user, "view_music")
                result = await self.state.music.edit_saved_source(
                    self.playlist,
                    user["id"],
                    original,
                    self.index,
                    lambda: self.state.db.run(self.save, user, filename, duration),
                    publish=lambda: self.state.db.run(publish_saved_playlist, self.request.app, self.playlist, user),
                )
            except TimeoutError:
                raise HTTPException(408, "Audio upload or validation timed out. Try a smaller file.") from None
            except MediaError as error:
                raise HTTPException(400, str(error)) from None
            except OSError:
                raise HTTPException(507, "The MP3 could not be stored. Check available disk space and retry.") from None
            else:
                return result
            finally:
                try:
                    with anyio.CancelScope(shield=True):
                        await self.state.db.run(self.path.unlink, missing_ok=True)
                finally:
                    self.cache.budget.release(self.path.name)
                    self.cache.refresh()
                    if self.installed_key:
                        self.cache.normalization.enqueue(self.installed_key)
                    self.cache.notify()

    async def probe(self) -> float:
        info = json.loads(
            await process(
                [
                    self.cache.sources.settings.ffprobe_path,
                    "-v",
                    "error",
                    "-protocol_whitelist",
                    "file",
                    "-f",
                    "mp3",
                    "-show_entries",
                    "format=format_name,duration:stream=codec_type:stream_disposition=attached_pic",
                    "-of",
                    "json",
                    self.path,
                ],
                30,
            )
        )
        if info.get("format", {}).get("format_name") != "mp3":
            raise HTTPException(422, "The file must contain MP3 audio.")
        duration = self.state.media.validate_upload(info, max_seconds=self.cache.sources.settings.max_source_seconds)
        await process(
            [
                self.cache.sources.settings.ffmpeg_path,
                "-v",
                "error",
                "-nostdin",
                "-xerror",
                "-protocol_whitelist",
                "file",
                "-f",
                "mp3",
                "-i",
                self.path,
                "-threads",
                "1",
                "-map",
                "0:a:0",
                "-vn",
                "-f",
                "null",
                "-",
            ],
            60,
        )
        return duration

    def save(self, user: dict, filename: str, duration: float) -> dict:
        with self.path.open("rb") as audio:
            identity = hashlib.file_digest(audio, "sha256").hexdigest()
        with self.state.db.lock:
            current = self.state.db.one("SELECT permission_overrides FROM users WHERE id=?", (user["id"],))
            if not current:
                raise HTTPException(401, "Sign in with Discord to continue.")
            permissions = effective_permissions(
                json.loads(current["permission_overrides"]),
                admin=user["id"] in self.state.auth.admin_ids,
            )
            user = {**user, "permissions": permissions, "admin": permissions["admin"]}
            check_permission(user, "view_music")
            original = self.state.music_store.track_for_edit(
                self.playlist,
                self.index,
                user,
                self.body.expected_updated_at,
            )
            track = MusicTrack.model_validate(
                {
                    **edited_track(original, self.body, None),
                    "upload_id": identity,
                    "upload_name": filename,
                    "duration": duration,
                    "match_locked": True,
                }
            ).model_dump()
            self.install(track)
            return self.state.music_store.update_track(
                self.playlist,
                self.index,
                user,
                {"track": track, "expected_updated_at": self.body.expected_updated_at},
            )

    def install(self, track: dict) -> None:
        key = cache_key(track)
        existing = self.cache.entries.get(key)
        target = self.cache.root / (key + ".audio")
        if existing and target.is_file() and target.stat().st_size == existing["bytes"]:
            return
        if not existing and len(self.cache.entries) >= MAX_CACHE_ITEMS:
            raise HTTPException(
                409, "The music cache supports up to 10,000 distinct recordings. Review unused files in Storage."
            )
        entry = {
            "original": track,
            "track": track,
            "container": "mp3",
            "bytes": self.path.stat().st_size,
            "completed_at": time.time(),
        }
        if len(json.dumps(entry).encode()) > MAX_RECORDING_METADATA_BYTES:
            raise HTTPException(422, "Recording metadata is too large. Shorten the song and file names.")
        if self.cache.budget.used() + entry["bytes"] + MAX_MANIFEST_BYTES > self.cache.budget.limit:
            raise HTTPException(409, "The media limit changed. Review available storage and try again.")
        staged = self.cache.root / (key + ".part")
        self.path.replace(staged)
        try:
            self.cache.commit(key, entry)
        except OSError:
            staged.unlink(missing_ok=True)
            (self.cache.root / (key + ".json.part")).unlink(missing_ok=True)
            if not existing:
                target.unlink(missing_ok=True)
                (self.cache.root / (key + ".json")).unlink(missing_ok=True)
            raise
        self.cache.entries[key] = entry
        self.cache.used += entry["bytes"] - (existing["bytes"] if existing else 0)
        self.cache.states.pop(key, None)
        self.installed_key = key


def register_music_upload_routes(app: FastAPI) -> None:
    @app.post(
        "/api/music/playlists/{playlist_id}/tracks/{index}/upload",
        dependencies=[Depends(require_permission("view_music"))],
    )
    async def upload(
        playlist_id: str,
        index: Annotated[int, PathParameter(ge=0, lt=1000)],
        request: Request,
        filename: Annotated[str, Query(min_length=1, max_length=255)],
        metadata: Annotated[str, Query(max_length=4096)],
    ) -> dict:
        try:
            body = PlaylistTrackUpdate.model_validate_json(metadata)
        except ValidationError:
            raise HTTPException(422, "Enter a valid song name and playlist revision.") from None
        if body.source_url is not None or body.name is None:
            raise HTTPException(422, "Choose either an MP3 upload or a YouTube source.")
        task = asyncio.current_task()
        app.state.clip_tasks.add(task)
        try:
            return await MusicUpload(request, playlist_id, index, body).run(filename)
        finally:
            app.state.clip_tasks.discard(task)

    @app.post("/api/music/likes/tracks/{index}/upload", dependencies=[Depends(require_permission("view_music"))])
    async def upload_like(
        index: Annotated[int, PathParameter(ge=0, lt=1000)],
        request: Request,
        filename: Annotated[str, Query(min_length=1, max_length=255)],
        metadata: Annotated[str, Query(max_length=4096)],
    ) -> dict:
        return await upload("liked", index, request, filename, metadata)
