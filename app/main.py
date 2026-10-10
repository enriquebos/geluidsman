from __future__ import annotations

import asyncio
import json
import logging
import math
import re
from contextlib import asynccontextmanager
from typing import TYPE_CHECKING, Annotated, Literal

from fastapi import Depends, FastAPI, HTTPException, Query, Request, status
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, ValidationError, field_validator

from app.accounts import register_account_routes
from app.action_routes import register_action_routes
from app.actions import Actions
from app.admin import register_admin_routes
from app.auth import Auth, authorize, register_auth_routes
from app.bot import Bot, GuildVoice, VoiceError
from app.config import ROOT, Settings, get_settings
from app.conversation import Conversation
from app.conversation_routes import register_conversation_routes
from app.db import Database
from app.events import Events
from app.logs import ConsoleLogs
from app.media import Media, MediaError
from app.mixer import CapacityError
from app.permissions import can_play_in_channel, require_permission, require_sound_permission

if TYPE_CHECKING:
    from collections.abc import AsyncIterator, Awaitable, Callable


MAX_UNICODE_EMOJI_LENGTH = 20
MAX_TAG_LENGTH = 30
MIN_CLIP_SECONDS = 0.1
MAX_DISCORD_ID_LENGTH = 20
VOICE_MEMBER_CACHE_SECONDS = 15
STANDARD_CLIP_VOLUME = 3
LONG_SOUND_SECONDS = 600
LONG_SOUND_UPLOAD_BYTES = 100 * 1024 * 1024
STANDARD_SOUND_UPLOAD_BYTES = 20 * 1024 * 1024


class ImportInput(BaseModel):
    url: str = Field(min_length=8, max_length=2048)


class ClipMeta(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    emoji: str = Field(default="", max_length=100)
    tags: list[str] = Field(default_factory=list, max_length=10)
    volume: float = Field(default=1, ge=0, le=10, allow_inf_nan=False)

    @field_validator("emoji")
    @classmethod
    def clean_emoji(cls, value: str) -> str:
        if re.fullmatch(r"<a?:[A-Za-z0-9_]{2,32}:\d{1,20}>", value) or (
            len(value) <= MAX_UNICODE_EMOJI_LENGTH and "<" not in value
        ):
            return value
        message = "Choose a Unicode emoji or a valid Discord custom emoji."
        raise ValueError(message)

    @field_validator("name")
    @classmethod
    def clean_name(cls, value: str) -> str:
        value = value.strip()
        if not value:
            msg = "Name cannot be blank."
            raise ValueError(msg)
        return value

    @field_validator("tags")
    @classmethod
    def clean_tags(cls, tags: list[str]) -> list[str]:
        if any(len(t) > MAX_TAG_LENGTH for t in tags):
            msg = "Tags must be at most 30 characters."
            raise ValueError(msg)
        return list(dict.fromkeys(t.strip() for t in tags if t.strip()))


class ClipInput(ClipMeta):
    source_id: str
    start: float = Field(ge=0, allow_inf_nan=False)
    end: float = Field(gt=0, allow_inf_nan=False)


class ChannelInput(BaseModel):
    channel_id: str = Field(pattern=r"^\d{1,20}$")


class FavouriteInput(BaseModel):
    pinned: bool


class VoiceFlags(BaseModel):
    muted: bool
    deafened: bool


class VolumeInput(BaseModel):
    volume: float = Field(ge=0, le=1, allow_inf_nan=False)


def validate_clip(start: float, end: float, duration: float, max_duration: float) -> None:
    if (
        not all(math.isfinite(x) for x in (start, end, duration))
        or start < 0
        or end > duration
        or not MIN_CLIP_SECONDS <= round(end - start, 6) <= max_duration
    ):
        msg = f"Choose a selection between 0.1 and {max_duration:g} seconds within the source."
        raise MediaError(msg)


async def initialize_automation(app: FastAPI, settings: Settings) -> None:
    db, events, bot = app.state.db, app.state.events, app.state.bot
    app.state.conversation = Conversation(settings, db, events, bot)
    bot.state.receiver = app.state.conversation
    app.state.actions = Actions(settings, db, events, bot)
    bot.actions = app.state.actions
    bot.state.actions = app.state.actions
    await app.state.actions.start()
    await app.state.conversation.start()


def create_app(settings: Settings | None = None, *, resume_channel_id: str | None = None) -> FastAPI:
    settings = settings or get_settings()

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        console = ConsoleLogs(settings)
        app.state.console = console
        root_logger = logging.getLogger()
        previous_level = root_logger.level
        root_logger.setLevel(logging.INFO)
        root_logger.addHandler(console)
        db = Database(settings.data_dir / "library.sqlite3", settings.database_url.get_secret_value())
        events = Events()
        media = await asyncio.to_thread(Media, settings, db, events)
        bot = Bot(settings, db, events)
        app.state.db, app.state.events, app.state.media, app.state.bot = db, events, media, bot
        app.state.auth = Auth(settings, db, bot)
        app.state.clip_tasks = set()
        logging.getLogger("app").info("Website starting; admin console available")
        await initialize_automation(app, settings)
        await bot.start()
        try:
            if resume_channel_id:
                batch = await db.run(db.one, "SELECT status FROM channel_batches WHERE id=?", (resume_channel_id,))
                if batch and batch["status"] == "paused":
                    await media.channels.resume(resume_channel_id)
            yield
        finally:
            await bot.close()
            await app.state.actions.close()
            await app.state.conversation.close()
            await app.state.auth.close()
            await media.close()
            for task in tuple(app.state.clip_tasks):
                task.cancel()
            await asyncio.gather(*app.state.clip_tasks, return_exceptions=True)
            db.close()
            root_logger.removeHandler(console)
            root_logger.setLevel(previous_level)
            console.close()

    app = FastAPI(title="Geluidsman", lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)

    register_private_responses(app)

    register_auth_routes(app)
    register_account_routes(app, settings)
    register_admin_routes(app)
    register_conversation_routes(app)
    register_action_routes(app)
    register_state_routes(app, settings)

    register_library_routes(app, settings)

    register_voice_routes(app, settings)

    register_media_routes(app, settings)
    register_channel_routes(app)
    return app


def register_private_responses(app: FastAPI) -> None:
    @app.middleware("http")
    async def private_responses(request: Request, call_next: Callable[[Request], Awaitable[Response]]) -> Response:
        try:
            response = await call_next(request)
        except Exception:
            logging.getLogger("app.http").exception(
                "Unhandled request failure: %s %s", request.method, request.url.path
            )
            raise
        if response.status_code >= status.HTTP_400_BAD_REQUEST:
            logging.getLogger("app.http").warning(
                "%s %s returned %s", request.method, request.url.path, response.status_code
            )
        if request.url.path.startswith("/api/"):
            response.headers["Cache-Control"] = "private, no-store"
        response.headers["Referrer-Policy"] = "same-origin"
        return response


def register_state_routes(app: FastAPI, settings: Settings) -> None:
    api_options = {"dependencies": [Depends(authorize)]}

    @app.exception_handler(ValueError)
    async def value_error(_request: Request, exc: ValueError) -> JSONResponse:
        if isinstance(exc, CapacityError):
            logging.getLogger("app.http").warning("Playback capacity reached: %s", exc)
        else:
            logging.getLogger("app.http").error("Operation failed", exc_info=exc)
        status = 409 if isinstance(exc, CapacityError) else 400
        if isinstance(exc, VoiceError):
            status = 409
        return JSONResponse({"detail": str(exc)}, status_code=status)

    @app.get("/api/state", **api_options)
    async def state(
        request: Request, guild_id: Annotated[str | None, Query(pattern=r"^\d{1,20}$")] = None
    ) -> dict[str, object]:
        user = request.state.user
        if guild_id and guild_id != str(settings.discord_guild_id):
            raise HTTPException(403, "This app only supports the configured Discord server.")
        guild_id = str(settings.discord_guild_id)
        member = await app.state.auth.member(request, guild_id, fresh=False) if guild_id else None
        summary = await app.state.media.summary()
        media_settings = await app.state.db.run(lambda: app.state.media.settings)
        return {
            "user": user,
            "guilds": user["guilds"],
            "sources": (await app.state.db.run(app.state.db.sources)),
            "clips": (await app.state.db.run(app.state.db.clips, user["id"], str(settings.discord_guild_id))),
            "emojis": app.state.bot.emojis(),
            "jobs": (await app.state.db.run(app.state.db.jobs)),
            "channel_imports": (await app.state.db.run(app.state.db.batches)),
            "status": app.state.bot.status(int(guild_id)) if guild_id else app.state.bot.status(),
            "channels": app.state.bot.channels(int(guild_id), member) if guild_id else [],
            "limits": {
                "max_clip_seconds": settings.max_clip_seconds,
                "max_source_seconds": media_settings.max_source_seconds,
                "max_storage_bytes": media_settings.max_storage_bytes,
                "used_bytes": summary["used_bytes"],
            },
            "missing_dependencies": summary["missing_dependencies"],
        }

    @app.get("/api/jobs", **api_options)
    async def jobs() -> dict[str, object]:
        return {
            "jobs": (await app.state.db.run(app.state.db.jobs)),
            "channel_imports": (await app.state.db.run(app.state.db.batches)),
        }

    @app.get("/api/health")
    async def health() -> dict[str, object]:
        return {
            "ok": True,
            "application": "geluidsman",
        }

    @app.get("/api/events", **api_options)
    async def events(request: Request) -> StreamingResponse:
        return StreamingResponse(
            app.state.events.stream(request),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )


def register_library_routes(app: FastAPI, settings: Settings) -> None:
    api_options = {"dependencies": [Depends(authorize)]}

    @app.get("/api/captions/search", **api_options)
    async def caption_search(
        q: Annotated[str, Query(min_length=1, max_length=200)],
        language: Literal["all", "nl", "en"] = "all",
        source_id: str | None = None,
        offset: Annotated[int, Query(ge=0)] = 0,
        limit: Annotated[int, Query(ge=1, le=50)] = 50,
    ) -> dict[str, object]:
        return {
            "results": await app.state.db.run(
                app.state.db.search_captions, q.strip(), language, source_id, offset, limit
            )
        }

    @app.post(
        "/api/sources/{source_id}/refresh", status_code=202, dependencies=[Depends(require_permission("import_videos"))]
    )
    async def refresh_source(source_id: str, request: Request) -> dict[str, object]:
        source = await app.state.db.run(app.state.db.one, "SELECT * FROM sources WHERE id=?", (source_id,))
        if not source:
            raise HTTPException(404, "Source not found.")
        return {"job_id": await app.state.media.import_url(source["url"], source_id, request.state.user["id"])}

    @app.post("/api/imports", status_code=202, dependencies=[Depends(require_permission("import_videos"))])
    async def imports(body: ImportInput, request: Request) -> dict[str, object]:
        return {"job_id": await app.state.media.import_url(body.url.strip(), actor_id=request.state.user["id"])}

    @app.post(
        "/api/imports/{job_id}/retry",
        status_code=202,
        dependencies=[Depends(require_permission("manage_imports", "import_videos"))],
    )
    async def retry(job_id: str, request: Request) -> dict[str, object]:
        job = await app.state.db.run(app.state.db.one, "SELECT * FROM jobs WHERE id=?", (job_id,))
        if not job:
            raise HTTPException(404, "Import job not found.")
        if job["status"] not in ("failed", "interrupted"):
            raise HTTPException(409, "Only failed or interrupted imports can be retried.")
        return {"job_id": await app.state.media.import_url(job["url"], job["source_id"], request.state.user["id"])}

    register_clip_routes(app, settings)
    register_delete_routes(app)
    register_job_routes(app)


def register_job_routes(app: FastAPI) -> None:
    @app.delete("/api/imports/{job_id}", dependencies=[Depends(require_permission("manage_imports"))])
    async def dismiss_job(job_id: str) -> dict[str, object]:
        job = await app.state.db.run(app.state.db.one, "SELECT status FROM jobs WHERE id=?", (job_id,))
        if not job:
            raise HTTPException(404, "Import job not found.")
        if job["status"] not in ("failed", "interrupted", "complete"):
            raise HTTPException(409, "Wait for the import to finish before dismissing it.")
        await app.state.db.run(app.state.db.execute, "DELETE FROM jobs WHERE id=?", (job_id,))
        app.state.events.publish("jobs")
        return {"ok": True}


def register_channel_routes(app: FastAPI) -> None:
    @app.post("/api/channel-imports", status_code=202, dependencies=[Depends(require_permission("import_channels"))])
    async def channel_import(body: ImportInput, request: Request) -> dict[str, object]:
        return {"batch_id": await app.state.media.channels.start(body.url.strip(), request.state.user["id"])}

    async def get_batch(batch_id: str) -> dict:
        batch = await app.state.db.run(app.state.db.one, "SELECT * FROM channel_batches WHERE id=?", (batch_id,))
        if not batch:
            raise HTTPException(404, "Channel import not found.")
        return batch

    @app.post("/api/channel-imports/{batch_id}/ignore", dependencies=[Depends(require_permission("manage_imports"))])
    async def ignore_channel(batch_id: str, request: Request) -> dict[str, object]:
        batch = await get_batch(batch_id)
        if batch["status"] in ("running", "discovering"):
            raise HTTPException(409, "Pause this channel import before ignoring its alert.")
        await app.state.db.run(app.state.db.execute, "UPDATE channel_batches SET dismissed=1 WHERE id=?", (batch_id,))
        await app.state.db.run(app.state.db.audit, request.state.user["id"], "channel.ignore", batch_id, batch["title"])
        app.state.events.publish("jobs")
        return {"ok": True}

    @app.post("/api/channel-imports/{batch_id}/pause", dependencies=[Depends(require_permission("manage_imports"))])
    async def pause_channel(batch_id: str, request: Request) -> dict[str, object]:
        if (await get_batch(batch_id))["status"] not in ("running", "discovering"):
            raise HTTPException(409, "This channel import is not running.")
        await app.state.media.channels.pause(batch_id)
        await app.state.db.run(
            app.state.db.audit,
            request.state.user["id"],
            "channel.pause",
            batch_id,
            (await get_batch(batch_id))["title"],
        )
        return {"ok": True}

    @app.post(
        "/api/channel-imports/{batch_id}/resume",
        status_code=202,
        dependencies=[Depends(require_permission("manage_imports", "import_channels"))],
    )
    async def resume_channel(batch_id: str, request: Request) -> dict[str, object]:
        if (await get_batch(batch_id))["status"] not in ("paused", "failed", "complete"):
            raise HTTPException(409, "This channel import is already running.")
        await app.state.media.channels.resume(batch_id, request.state.user["id"])
        return {"ok": True}


def check_clip_volume(user: dict, volume: float) -> None:
    if volume > STANDARD_CLIP_VOLUME and not user["permissions"].get("high_volume", False):
        raise HTTPException(403, "Sound volume above 300% requires the boost sound volume permission.")


def register_clip_routes(app: FastAPI, settings: Settings) -> None:
    api_options = {"dependencies": [Depends(authorize)]}

    @app.post("/api/clips", status_code=201, dependencies=[Depends(require_permission("create_sounds"))])
    async def clips(body: ClipInput, request: Request) -> dict[str, object]:
        check_clip_volume(request.state.user, body.volume)
        source = await app.state.db.run(app.state.db.one, "SELECT * FROM sources WHERE id=?", (body.source_id,))
        if not source:
            raise HTTPException(404, "Source not found.")
        validate_clip(
            body.start,
            body.end,
            source["duration"],
            LONG_SOUND_SECONDS
            if request.state.user["permissions"].get("long_sounds", False)
            else settings.max_clip_seconds,
        )
        task = asyncio.current_task()
        app.state.clip_tasks.add(task)
        try:
            clip_id = await app.state.media.create_clip(
                source, {**body.model_dump(), "creator_id": request.state.user["id"]}
            )
        finally:
            app.state.clip_tasks.discard(task)
        app.state.events.publish("library")
        return {"id": clip_id}

    @app.post("/api/clips/upload", status_code=201, dependencies=[Depends(require_permission("create_sounds"))])
    async def upload_clip(
        request: Request,
        filename: Annotated[str, Query(min_length=1, max_length=255)],
        metadata: Annotated[str, Query(max_length=4096)],
    ) -> dict[str, object]:
        try:
            values = ClipMeta.model_validate_json(metadata).model_dump()
        except ValidationError as error:
            raise HTTPException(422, "Enter a valid sound name, emoji, tags and volume.") from error
        check_clip_volume(request.state.user, values["volume"])
        task = asyncio.current_task()
        app.state.clip_tasks.add(task)
        try:
            clip_id = await app.state.media.upload_clip(
                request.stream(),
                filename,
                {**values, "creator_id": request.state.user["id"]},
                max_seconds=LONG_SOUND_SECONDS
                if request.state.user["permissions"].get("long_sounds", False)
                else settings.max_clip_seconds,
                max_bytes=LONG_SOUND_UPLOAD_BYTES
                if request.state.user["permissions"].get("long_sounds", False)
                else STANDARD_SOUND_UPLOAD_BYTES,
            )
        finally:
            app.state.clip_tasks.discard(task)
        app.state.events.publish("library")
        return {"id": clip_id}

    @app.put("/api/clips/{clip_id}/favourite", **api_options)
    async def favourite(clip_id: str, body: FavouriteInput, request: Request) -> dict[str, object]:
        if not (await app.state.db.run(app.state.db.one, "SELECT id FROM clips WHERE id=?", (clip_id,))):
            raise HTTPException(404, "Sound not found.")
        if body.pinned:
            await app.state.db.run(
                app.state.db.execute,
                "INSERT OR IGNORE INTO user_favourites VALUES (?,?)",
                (request.state.user["id"], clip_id),
            )
        else:
            await app.state.db.run(
                app.state.db.execute,
                "DELETE FROM user_favourites WHERE user_id=? AND clip_id=?",
                (request.state.user["id"], clip_id),
            )
        app.state.events.publish(
            "favourites", {"user_id": request.state.user["id"], "clip_id": clip_id, "pinned": body.pinned}
        )
        return {"pinned": body.pinned}

    @app.patch("/api/clips/{clip_id}", dependencies=[Depends(require_sound_permission("edit"))])
    async def edit_clip(clip_id: str, body: ClipMeta, request: Request) -> dict[str, object]:
        check_clip_volume(request.state.user, body.volume)
        if not (await app.state.db.run(app.state.db.one, "SELECT id FROM clips WHERE id=?", (clip_id,))):
            raise HTTPException(404, "Sound not found.")
        await app.state.db.run(
            app.state.db.change,
            "UPDATE clips SET name=?,emoji=?,tags=?,volume=? WHERE id=?",
            (body.name, body.emoji, json.dumps(body.tags), body.volume, clip_id),
            request.state.user["id"],
            "sound.edit",
            resource_id=clip_id,
            name=body.name,
        )
        app.state.events.publish("library")
        return {"ok": True}


def register_delete_routes(app: FastAPI) -> None:
    @app.delete("/api/clips/{clip_id}", dependencies=[Depends(require_sound_permission("delete"))])
    async def delete_clip(clip_id: str, request: Request) -> dict[str, object]:
        async with app.state.media.lock:
            if not (await app.state.db.run(app.state.db.one, "SELECT id FROM clips WHERE id=?", (clip_id,))):
                raise HTTPException(404, "Sound not found.")
            clip = await app.state.db.run(app.state.db.one, "SELECT name FROM clips WHERE id=?", (clip_id,))
            app.state.bot.stop_clip(clip_id)
            await app.state.db.run(
                app.state.db.change,
                "DELETE FROM clips WHERE id=?",
                (clip_id,),
                request.state.user["id"],
                "sound.delete",
                resource_id=clip_id,
                name=clip["name"],
            )
            await asyncio.to_thread(app.state.media.storage.remove, app.state.media.root / clip_id)
        app.state.events.publish("library")
        return {"ok": True}

    @app.delete("/api/sources/{source_id}", dependencies=[Depends(require_permission("delete_videos"))])
    async def delete_source(source_id: str, request: Request) -> dict[str, object]:
        async with app.state.media.lock:
            source = await app.state.db.run(app.state.db.one, "SELECT * FROM sources WHERE id=?", (source_id,))
            if not source:
                raise HTTPException(404, "Source not found.")
            if await app.state.db.run(app.state.db.one, "SELECT id FROM clips WHERE source_id=?", (source_id,)):
                raise HTTPException(409, "Delete this source's sounds first.")
            await app.state.db.run(
                app.state.db.change,
                "DELETE FROM sources WHERE id=?",
                (source_id,),
                request.state.user["id"],
                "video.delete",
                resource_id=source_id,
                name=source["title"],
            )
            await asyncio.to_thread(
                app.state.media.storage.remove, app.state.media.root / (source["media_id"] or source_id)
            )
        app.state.events.publish("library")
        return {"ok": True}


async def voice_target(app: FastAPI, request: Request, guild_id: str, channel_id: str | None = None) -> GuildVoice:
    if not guild_id.isdigit() or len(guild_id) > MAX_DISCORD_ID_LENGTH:
        raise HTTPException(422, "Invalid server ID.")
    if guild_id != str(app.state.bot.settings.discord_guild_id):
        raise HTTPException(403, "This app only supports the configured Discord server.")
    if not app.state.bot.client.is_ready():
        msg = "Bot is offline. Wait for Discord to reconnect."
        raise VoiceError(msg)
    member = await app.state.auth.member(request, guild_id, fresh=False, max_age=VOICE_MEMBER_CACHE_SECONDS)
    state = app.state.bot.guild_state(int(guild_id))
    channel = member.guild.get_channel(int(channel_id)) if channel_id else state.voice.channel if state.voice else None
    if channel and str(channel.id) not in {item["id"] for item in app.state.bot.channels(int(guild_id), member)}:
        raise HTTPException(403, "You cannot control this voice channel.")
    return state


def register_voice_routes(app: FastAPI, _settings: Settings) -> None:
    api_options = {"dependencies": [Depends(authorize)]}

    @app.get("/api/playback", **api_options)
    async def playback_status() -> dict[str, object]:
        return {"status": app.state.bot.status()}

    @app.post("/api/guilds/{guild_id}/voice/connect", dependencies=[Depends(require_permission("connect_voice"))])
    async def connect(guild_id: str, body: ChannelInput, request: Request) -> dict[str, object]:
        state = await voice_target(app, request, guild_id, body.channel_id)
        await state.connect(body.channel_id)
        await app.state.db.run(
            app.state.db.audit, request.state.user["id"], "voice.connect", body.channel_id, guild_id=guild_id
        )
        return {"ok": True, "status": state.status()}

    @app.post("/api/guilds/{guild_id}/voice/disconnect", dependencies=[Depends(require_permission("disconnect_voice"))])
    async def disconnect(guild_id: str, request: Request) -> dict[str, object]:
        state = await voice_target(app, request, guild_id)
        await state.disconnect()
        await app.state.db.run(app.state.db.audit, request.state.user["id"], "voice.disconnect", guild_id=guild_id)
        return {"ok": True, "status": state.status()}

    @app.put("/api/guilds/{guild_id}/voice/state", dependencies=[Depends(require_permission("mute_deafen"))])
    async def voice_flags(guild_id: str, body: VoiceFlags, request: Request) -> dict[str, object]:
        state = await voice_target(app, request, guild_id)
        await state.flags(muted=body.muted, deafened=body.deafened)
        await app.state.db.run(
            app.state.db.audit,
            request.state.user["id"],
            "voice.state",
            guild_id=guild_id,
            details=body.model_dump(),
        )
        return {"ok": True, "status": state.status()}

    @app.put("/api/guilds/{guild_id}/voice/volume", dependencies=[Depends(require_permission("master_volume"))])
    async def volume(guild_id: str, body: VolumeInput, request: Request) -> dict[str, object]:
        state = await voice_target(app, request, guild_id)
        await state.volume(body.volume)
        return {"ok": True, "status": state.status()}

    @app.post(
        "/api/guilds/{guild_id}/clips/{clip_id}/play",
        status_code=201,
        dependencies=[Depends(require_permission("play_sounds"))],
    )
    async def play(guild_id: str, clip_id: str, request: Request) -> dict[str, object]:
        state = await voice_target(app, request, guild_id)
        user = request.state.user
        if state.voice and not can_play_in_channel(user["id"], user["permissions"], state.voice.channel):
            raise HTTPException(
                403, "Join the bot's voice channel to play sounds, or request outside-channel playback permission."
            )
        clip = await app.state.db.run(app.state.db.one, "SELECT * FROM clips WHERE id=?", (clip_id,))
        if not clip:
            raise HTTPException(404, "Sound not found.")
        try:
            instance = state.play(app.state.media.root / clip_id / "sound.wav", clip)
        except ValueError:
            await app.state.db.run(
                app.state.db.audit,
                request.state.user["id"],
                "sound.play",
                clip_id,
                clip["name"],
                outcome="rejected",
                guild_id=guild_id,
            )
            raise
        await app.state.db.run(
            app.state.db.audit,
            request.state.user["id"],
            "sound.play",
            clip_id,
            clip["name"],
            guild_id=guild_id,
            details={"instance_id": instance},
        )
        app.state.events.publish("audit")
        return {"instance_id": instance, "status": state.status()}

    register_stop_routes(app)


def register_stop_routes(app: FastAPI) -> None:
    @app.post("/api/guilds/{guild_id}/playbacks/stop", dependencies=[Depends(require_permission("stop_sounds"))])
    async def stop_all(guild_id: str, request: Request) -> dict[str, object]:
        state = await voice_target(app, request, guild_id)
        if state.mixer:
            state.mixer.stop()
        await app.state.db.run(app.state.db.audit, request.state.user["id"], "sound.stop_all", guild_id=guild_id)
        return {"ok": True, "status": state.status()}

    @app.delete(
        "/api/guilds/{guild_id}/playbacks/{instance_id}", dependencies=[Depends(require_permission("stop_sounds"))]
    )
    async def stop(guild_id: str, instance_id: str, request: Request) -> dict[str, object]:
        state = await voice_target(app, request, guild_id)
        playback = (
            next((item for item in state.mixer.snapshot() if item["id"] == instance_id), None) if state.mixer else None
        )
        if not playback:
            raise HTTPException(404, "Playback not found in this server.")
        state.mixer.stop(instance_id)
        await app.state.db.run(
            app.state.db.audit,
            request.state.user["id"],
            "sound.stop",
            playback["clip_id"],
            playback["name"],
            guild_id=guild_id,
        )
        return {"ok": True, "status": state.status()}


def register_media_routes(app: FastAPI, _settings: Settings) -> None:
    api_options = {"dependencies": [Depends(authorize)]}

    @app.get("/api/media/{item_id}/{filename}", **api_options)
    async def file(item_id: str, filename: str) -> FileResponse:
        source_files = {"video.mp4", "audio.m4a", "peaks.json", "thumbnail.jpg"}
        clip_files = {"preview.m4a"}
        query = (
            "SELECT id FROM sources WHERE id=?"
            if filename in source_files
            else "SELECT id FROM clips WHERE id=?"
            if filename in clip_files
            else None
        )
        if query is None or not (await app.state.db.run(app.state.db.one, query, (item_id,))):
            raise HTTPException(404, "Media not found.")
        source = (
            (await app.state.db.run(app.state.db.one, "SELECT media_id FROM sources WHERE id=?", (item_id,)))
            if filename in source_files
            else None
        )
        path = app.state.media.root / ((source["media_id"] or item_id) if source else item_id) / filename
        if not path.is_file():
            raise HTTPException(404, "Media not found.")
        return FileResponse(path, headers={"Cache-Control": "private, no-store"})

    dist = ROOT / "frontend" / "dist"
    if (dist / "assets").is_dir():
        app.mount("/assets", StaticFiles(directory=dist / "assets"), name="assets")

    @app.get("/login", response_model=None)
    @app.get("/settings", response_model=None)
    @app.get("/actions", response_model=None)
    @app.get("/conversation", response_model=None)
    @app.get("/hall-of-shame", response_model=None)
    @app.get("/audit", response_model=None)
    @app.get("/admin", response_model=None)
    @app.get("/", response_model=None)
    @app.get("/soundboard", response_model=None)
    @app.get("/videos", response_model=None)
    @app.get("/videos/{source_id}/cut", response_model=None)
    async def index() -> FileResponse | JSONResponse:
        if not (dist / "index.html").exists():
            return JSONResponse(
                {"detail": "Dashboard not built. Run npm --prefix frontend ci, then npm --prefix frontend run build."},
                status_code=503,
            )
        return FileResponse(dist / "index.html", headers={"Cache-Control": "no-cache"})


app = create_app()
