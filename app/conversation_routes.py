from __future__ import annotations

import asyncio
import json
import time
from typing import TYPE_CHECKING, Annotated, Literal

from fastapi import Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field, field_validator

from app.auth import authorize_admin
from app.db import new_id
from app.permissions import require_permission

MAX_DISCORD_ID = 20
MESSAGE_PAGE_SIZE = 100

if TYPE_CHECKING:
    from fastapi import FastAPI


class RecordingInput(BaseModel):
    enabled: bool


class LanguageInput(BaseModel):
    language: Literal["nl", "en", "auto"]


class RetentionInput(BaseModel):
    days: int = Field(30, ge=1, le=3650)


class TriggerInput(BaseModel):
    clip_id: str = Field(default="", max_length=100)
    action: Literal["play", "stop_all"] = "play"
    delay: float = Field(0, ge=0, le=60, allow_inf_nan=False)
    phrase: str = Field(min_length=1, max_length=255)
    mode: Literal["word", "contains"] = "word"
    target: Literal["everyone", "self", "selected"] = "everyone"
    speakers: list[str] = Field(default_factory=list, max_length=64)
    cooldown: float = Field(5, ge=0, le=3600, allow_inf_nan=False)
    enabled: bool = True

    @field_validator("phrase")
    @classmethod
    def phrase_not_blank(cls, value: str) -> str:
        if not value.strip():
            message = "Enter a word or phrase."
            raise ValueError(message)
        return value.strip()

    @field_validator("speakers")
    @classmethod
    def speaker_ids(cls, values: list[str]) -> list[str]:
        if any(not value.isascii() or not value.isdigit() or len(value) > MAX_DISCORD_ID for value in values):
            message = "Choose valid Discord speaker IDs."
            raise ValueError(message)
        return list(dict.fromkeys(values))


def register_conversation_routes(app: FastAPI) -> None:
    register_trigger_routes(app)
    register_conversation_admin(app)

    @app.get("/api/conversations/status", dependencies=[Depends(require_permission("view_conversations"))])
    async def conversation_status() -> dict:
        return app.state.conversation.snapshot()

    @app.put("/api/conversations/recording", dependencies=[Depends(require_permission("control_recording"))])
    async def recording(body: RecordingInput, request: Request) -> dict:
        manager = app.state.conversation
        await asyncio.to_thread(app.state.db.set_setting, "conversation_enabled", body.enabled)
        manager.enabled = body.enabled
        if not body.enabled:
            await manager.close_session()
        await asyncio.to_thread(
            app.state.db.audit, request.state.user["id"], "conversation.recording", details=body.model_dump()
        )
        app.state.events.publish("conversation")
        return {"enabled": manager.enabled}

    @app.put("/api/conversations/language", dependencies=[Depends(require_permission("control_recording"))])
    async def language(body: LanguageInput, request: Request) -> dict:
        await asyncio.to_thread(app.state.db.set_setting, "conversation_language", body.language)
        app.state.conversation.language = body.language
        await asyncio.to_thread(
            app.state.db.audit, request.state.user["id"], "conversation.recording", details={"language": body.language}
        )
        app.state.events.publish("conversation")
        return {"language": body.language}

    @app.get("/api/conversations", dependencies=[Depends(require_permission("view_conversations"))])
    def sessions(page: Annotated[int, Query(ge=1)] = 1) -> dict:
        db = app.state.db
        total = db.one("SELECT COUNT(*) AS total FROM conversations")["total"]
        return {
            "items": db.rows(
                "SELECT * FROM conversations ORDER BY started_at DESC,id DESC LIMIT 50 OFFSET ?", ((page - 1) * 50,)
            ),
            "total": total,
            "page": page,
            "pages": max(1, (total + 49) // 50),
        }

    @app.get(
        "/api/conversations/{session_id}/messages", dependencies=[Depends(require_permission("view_conversations"))]
    )
    def messages(session_id: str, before: Annotated[str | None, Query(max_length=100)] = None) -> dict:
        db = app.state.db
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


def register_trigger_routes(app: FastAPI) -> None:
    @app.get("/api/conversation/triggers", dependencies=[Depends(require_permission("manage_triggers"))])
    def triggers(request: Request) -> dict:
        user = request.state.user
        rows = app.state.db.rows(
            "SELECT t.*,u.display_name AS owner_name,c.name AS sound_name,c.emoji AS emoji "
            "FROM conversation_triggers t "
            "JOIN users u ON u.id=t.owner_id LEFT JOIN clips c ON c.id=t.clip_id WHERE (?=1 OR t.owner_id=?) "
            "ORDER BY t.created_at,t.id",
            (int(user["admin"]), user["id"]),
        )
        for row in rows:
            row["speakers"] = json.loads(row["speakers"])
            row["enabled"] = bool(row["enabled"])
        return {"items": rows}

    @app.post(
        "/api/conversation/triggers", status_code=201, dependencies=[Depends(require_permission("manage_triggers"))]
    )
    def create_trigger(body: TriggerInput, request: Request) -> dict:
        check_trigger(app, body)
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

    @app.put("/api/conversation/triggers/{trigger_id}", dependencies=[Depends(require_permission("manage_triggers"))])
    def update_trigger(trigger_id: str, body: TriggerInput, request: Request) -> dict:
        owned(app, trigger_id, request)
        check_trigger(app, body)
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
        "/api/conversation/triggers/{trigger_id}", dependencies=[Depends(require_permission("manage_triggers"))]
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


def register_conversation_admin(app: FastAPI) -> None:
    @app.get("/api/admin/conversations/settings", dependencies=[Depends(authorize_admin)])
    def retention() -> dict:
        return {"days": app.state.db.setting("conversation_retention_days", 30)}

    @app.put("/api/admin/conversations/settings", dependencies=[Depends(authorize_admin)])
    def save_retention(body: RetentionInput, request: Request) -> dict:
        app.state.db.set_setting("conversation_retention_days", body.days)
        app.state.db.audit(request.state.user["id"], "conversation.retention", details=body.model_dump())
        app.state.events.publish("conversation")
        return body.model_dump()

    @app.delete("/api/conversations/{session_id}", dependencies=[Depends(authorize_admin)])
    async def delete_session(session_id: str, request: Request) -> dict:
        manager = app.state.conversation
        if manager.session and manager.session["id"] == session_id:
            raise HTTPException(409, "Disable recording before deleting the active conversation.")
        session = await asyncio.to_thread(app.state.db.one, "SELECT * FROM conversations WHERE id=?", (session_id,))
        if not session:
            raise HTTPException(404, "Conversation not found.")
        await asyncio.to_thread(
            app.state.db.change,
            "DELETE FROM conversations WHERE id=?",
            (session_id,),
            request.state.user["id"],
            "conversation.delete",
            resource_id=session_id,
            name=session["channel_name"],
        )
        app.state.events.publish("conversation")
        return {"ok": True}


def check_trigger(app: FastAPI, body: TriggerInput) -> None:
    if body.action == "play" and not app.state.db.one("SELECT id FROM clips WHERE id=?", (body.clip_id,)):
        raise HTTPException(404, "Sound not found.")
    if body.target == "selected" and not body.speakers:
        raise HTTPException(422, "Select at least one speaker.")


def owned(app: FastAPI, trigger_id: str, request: Request) -> dict:
    trigger = app.state.db.one("SELECT * FROM conversation_triggers WHERE id=?", (trigger_id,))
    if not trigger:
        raise HTTPException(404, "Trigger not found.")
    if not request.state.user["admin"] and trigger["owner_id"] != request.state.user["id"]:
        raise HTTPException(403, "You can only manage your own triggers.")
    return trigger
