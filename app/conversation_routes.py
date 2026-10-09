from __future__ import annotations

import asyncio
import json
import time
from typing import TYPE_CHECKING, Annotated, Literal

import aiohttp
from fastapi import Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field, field_validator

from app.auth import authorize_admin
from app.db import new_id
from app.permissions import require_permission
from app.transcription_models import ModelSelection

MAX_DISCORD_ID = 20
MESSAGE_PAGE_SIZE = 100
MAX_TRIGGER_TERMS = 20
MAX_TRIGGER_TERM_LENGTH = 255
MAX_TRIGGER_TEXT_LENGTH = MAX_TRIGGER_TERMS * (MAX_TRIGGER_TERM_LENGTH + 1) - 1

if TYPE_CHECKING:
    from fastapi import FastAPI


class TranscriptionInput(ModelSelection):
    pass


class RecordingInput(BaseModel):
    enabled: bool


class LanguageInput(BaseModel):
    language: Literal["nl", "en", "auto"]


class TriggerInput(BaseModel):
    clip_id: str = Field(default="", max_length=100)
    action: Literal["play", "stop_all"] = "play"
    delay: float = Field(0, ge=0, le=60, allow_inf_nan=False)
    phrase: str = Field(min_length=1, max_length=MAX_TRIGGER_TEXT_LENGTH)
    mode: Literal["word", "contains"] = "word"
    target: Literal["everyone", "self", "selected"] = "everyone"
    speakers: list[str] = Field(default_factory=list, max_length=64)
    cooldown: float = Field(5, ge=0, le=3600, allow_inf_nan=False)
    enabled: bool = True

    @field_validator("phrase")
    @classmethod
    def phrase_not_blank(cls, value: str) -> str:
        terms = [" ".join(term.split()) for term in value.splitlines() if term.strip()]
        if not terms:
            message = "Enter at least one word or phrase."
            raise ValueError(message)
        if len(terms) > MAX_TRIGGER_TERMS or any(len(term) > MAX_TRIGGER_TERM_LENGTH for term in terms):
            message = "Use up to 20 words or phrases, with at most 255 characters each."
            raise ValueError(message)
        unique = {}
        for term in terms:
            unique.setdefault(term.casefold(), term)
        return "\n".join(unique.values())

    @field_validator("speakers")
    @classmethod
    def speaker_ids(cls, values: list[str]) -> list[str]:
        if any(not value.isascii() or not value.isdigit() or len(value) > MAX_DISCORD_ID for value in values):
            message = "Choose valid Discord speaker IDs."
            raise ValueError(message)
        return list(dict.fromkeys(values))


def register_conversation_routes(app: FastAPI) -> None:
    register_trigger_routes(app)
    register_transcription_routes(app)

    @app.get("/api/conversations/status", dependencies=[Depends(require_permission("view_conversations"))])
    async def conversation_status() -> dict:
        return app.state.conversation.snapshot()

    @app.put(
        "/api/conversations/recording",
        dependencies=[Depends(require_permission("view_conversations", "control_recording"))],
    )
    async def recording(body: RecordingInput, request: Request) -> dict:
        manager = app.state.conversation
        await asyncio.to_thread(app.state.db.set_setting, "conversation_enabled", body.enabled)
        manager.enabled = body.enabled
        if not body.enabled:
            await manager.close_session()
            await asyncio.to_thread(app.state.db.execute, "DELETE FROM conversations")
        await asyncio.to_thread(
            app.state.db.audit, request.state.user["id"], "conversation.recording", details=body.model_dump()
        )
        app.state.events.publish("conversation")
        return {"enabled": manager.enabled}

    @app.put(
        "/api/conversations/language",
        dependencies=[Depends(require_permission("view_conversations", "control_recording"))],
    )
    async def language(body: LanguageInput, request: Request) -> dict:
        await asyncio.to_thread(app.state.db.set_setting, "conversation_language", body.language)
        app.state.conversation.language = body.language
        await asyncio.to_thread(
            app.state.db.audit, request.state.user["id"], "conversation.recording", details={"language": body.language}
        )
        app.state.events.publish("conversation")
        return {"language": body.language}

    @app.get(
        "/api/conversations/{session_id}/messages", dependencies=[Depends(require_permission("view_conversations"))]
    )
    def messages(session_id: str, before: Annotated[str | None, Query(max_length=100)] = None) -> dict:
        db = app.state.db
        manager = app.state.conversation
        if not manager.enabled or not manager.session or manager.session["id"] != session_id:
            raise HTTPException(404, "Live conversation not found.")
        session = db.one("SELECT * FROM conversations WHERE id=?", (session_id,))
        if not session:
            raise HTTPException(404, "Conversation not found.")
        boundary = (
            db.one("SELECT started_at,id FROM conversation_messages WHERE session_id=? AND id=?", (session_id, before))
            if before
            else None
        )
        if before and not boundary:
            raise HTTPException(404, "Message cursor not found.")
        timestamp = boundary["started_at"] if boundary else time.time() + 86400
        cursor = boundary["id"] if boundary else "~"
        rows = db.rows(
            "SELECT * FROM conversation_messages WHERE session_id=? AND (started_at<? OR (started_at=? AND id<?)) "
            "ORDER BY started_at DESC,id DESC LIMIT 101",
            (session_id, timestamp, timestamp, cursor),
        )
        return {"session": session, "items": list(reversed(rows[:100])), "has_older": len(rows) > MESSAGE_PAGE_SIZE}


def register_trigger_users(app: FastAPI, path: str, permission: str) -> None:
    @app.get(path, dependencies=[Depends(require_permission(permission))])
    async def users() -> dict:
        return {"items": await app.state.bot.guild_members()}


def register_trigger_routes(app: FastAPI) -> None:
    register_trigger_users(app, "/api/conversation/users", "view_conversations")

    @app.get("/api/conversation/triggers", dependencies=[Depends(require_permission("view_conversations"))])
    def triggers() -> dict:
        rows = app.state.db.rows(
            "SELECT t.*,u.display_name AS owner_name,c.name AS sound_name,c.emoji AS emoji "
            "FROM conversation_triggers t "
            "JOIN users u ON u.id=t.owner_id LEFT JOIN clips c ON c.id=t.clip_id "
            "ORDER BY t.created_at,t.id",
        )
        for row in rows:
            row["speakers"] = json.loads(row["speakers"])
            row["enabled"] = bool(row["enabled"])
            row["phrases"] = row["phrase"].splitlines()
        return {"items": rows}

    @app.post(
        "/api/conversation/triggers",
        status_code=201,
        dependencies=[Depends(require_permission("view_conversations", "manage_triggers"))],
    )
    def create_trigger(body: TriggerInput, request: Request) -> dict:
        with app.state.db.lock:
            check_trigger(app, body)
            check_unique_trigger(app, body)
            trigger_id = new_id()
            app.state.db.change(
                "INSERT INTO conversation_triggers(id,owner_id,clip_id,phrase,mode,target,speakers,cooldown,enabled,"
                "created_at,action,delay) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                (
                    trigger_id,
                    request.state.user["id"],
                    body.clip_id,
                    body.phrase,
                    body.mode,
                    body.target,
                    json.dumps(body.speakers),
                    body.cooldown,
                    int(body.enabled),
                    time.time(),
                    body.action,
                    body.delay,
                ),
                request.state.user["id"],
                "trigger.create",
                resource_id=trigger_id,
                name=body.phrase,
            )
        app.state.events.publish("conversation")
        return {"id": trigger_id}

    @app.put(
        "/api/conversation/triggers/{trigger_id}",
        dependencies=[Depends(require_permission("view_conversations", "manage_triggers"))],
    )
    def update_trigger(trigger_id: str, body: TriggerInput, request: Request) -> dict:
        with app.state.db.lock:
            existing_trigger(app, trigger_id)
            check_trigger(app, body)
            check_unique_trigger(app, body, trigger_id)
            app.state.db.change(
                "UPDATE conversation_triggers SET clip_id=?,phrase=?,mode=?,target=?,speakers=?,"
                "cooldown=?,enabled=?,action=?,delay=? "
                "WHERE id=?",
                (
                    body.clip_id,
                    body.phrase,
                    body.mode,
                    body.target,
                    json.dumps(body.speakers),
                    body.cooldown,
                    int(body.enabled),
                    body.action,
                    body.delay,
                    trigger_id,
                ),
                request.state.user["id"],
                "trigger.update",
                resource_id=trigger_id,
                name=body.phrase,
            )
        app.state.events.publish("conversation")
        return {"ok": True}

    @app.delete(
        "/api/conversation/triggers/{trigger_id}",
        dependencies=[Depends(require_permission("view_conversations", "manage_triggers"))],
    )
    def delete_trigger(trigger_id: str, request: Request) -> dict:
        trigger = owned(app, trigger_id, request)
        app.state.db.change(
            "DELETE FROM conversation_triggers WHERE id=?",
            (trigger_id,),
            request.state.user["id"],
            "trigger.delete",
            resource_id=trigger_id,
            name=trigger["phrase"],
        )
        app.state.events.publish("conversation")
        return {"ok": True}


def register_transcription_routes(app: FastAPI) -> None:
    @app.get("/api/admin/transcription", dependencies=[Depends(authorize_admin)])
    async def transcription_status() -> dict:
        return await app.state.conversation.synchronize_model()

    @app.put("/api/admin/transcription", dependencies=[Depends(authorize_admin)])
    async def transcription_model(body: TranscriptionInput, request: Request) -> dict:
        manager = app.state.conversation
        status = await manager.synchronize_model()
        if status.get("target"):
            raise HTTPException(409, "Wait for the current model switch to finish.")
        if not status.get("ready"):
            raise HTTPException(503, "Transcription worker is unavailable or still loading.")
        try:
            status = await manager.select_model(body.model)
        except (aiohttp.ClientError, TimeoutError, ValueError) as error:
            raise HTTPException(503, "Could not request the model switch. The current model is unchanged.") from error
        await asyncio.to_thread(
            app.state.db.audit, request.state.user["id"], "settings.edit", details=body.model_dump()
        )
        app.state.events.publish("conversation")
        return status


def check_unique_trigger(app: FastAPI, body: TriggerInput, trigger_id: str = "") -> None:
    duplicate = app.state.db.one(
        "SELECT id FROM conversation_triggers WHERE action=? AND (action='stop_all' OR clip_id=?) AND id<>? LIMIT 1",
        (body.action, body.clip_id, trigger_id),
    )
    if duplicate:
        raise HTTPException(409, "A trigger already exists for this sound/action. Add words to the existing trigger.")


def check_trigger(app: FastAPI, body: TriggerInput) -> None:
    if body.action == "stop_all":
        body.clip_id = ""
    if body.action == "play" and not app.state.db.one("SELECT id FROM clips WHERE id=?", (body.clip_id,)):
        raise HTTPException(404, "Sound not found.")
    if body.target == "selected" and not body.speakers:
        raise HTTPException(422, "Select at least one speaker.")


def existing_trigger(app: FastAPI, trigger_id: str) -> dict:
    trigger = app.state.db.one("SELECT * FROM conversation_triggers WHERE id=?", (trigger_id,))
    if not trigger:
        raise HTTPException(404, "Trigger not found.")
    return trigger


def owned(app: FastAPI, trigger_id: str, request: Request) -> dict:
    trigger = existing_trigger(app, trigger_id)
    if not request.state.user["admin"] and trigger["owner_id"] != request.state.user["id"]:
        raise HTTPException(403, "You can only manage your own triggers.")
    return trigger
