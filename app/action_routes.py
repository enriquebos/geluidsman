from __future__ import annotations

import json
import time
from typing import TYPE_CHECKING, Literal

from fastapi import Depends, HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.actions import EVENTS
from app.conversation_routes import TriggerInput, register_trigger_users
from app.db import new_id
from app.permissions import require_permission

if TYPE_CHECKING:
    from fastapi import FastAPI


class ActionInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    event: str = "camera_on"
    action: Literal["play", "stop_all"] = "play"
    clip_id: str = Field(default="", max_length=100)
    target: Literal["everyone", "self", "selected"] = "everyone"
    speakers: list[str] = Field(default_factory=list, max_length=64)
    enabled: bool = True
    delay: float = Field(0, ge=0, le=60, allow_inf_nan=False)
    cooldown: float = Field(5, ge=0, le=3600, allow_inf_nan=False)

    @field_validator("event")
    @classmethod
    def valid_event(cls, value: str) -> str:
        if value not in EVENTS:
            message = "Choose a supported Discord voice event."
            raise ValueError(message)
        return value

    @field_validator("speakers")
    @classmethod
    def valid_speakers(cls, values: list[str]) -> list[str]:
        return TriggerInput.speaker_ids(values)


def check_input(app: FastAPI, body: ActionInput) -> None:
    if body.action == "play" and not app.state.db.one("SELECT id FROM clips WHERE id=?", (body.clip_id,)):
        raise HTTPException(404, "Sound not found.")
    if body.target == "selected" and not body.speakers:
        raise HTTPException(422, "Select at least one participant.")


def register_action_routes(app: FastAPI) -> None:
    register_trigger_users(app, "/api/actions/users", "view_actions")

    @app.get("/api/actions/status", dependencies=[Depends(require_permission("view_actions"))])
    async def status() -> dict:
        return app.state.actions.snapshot()

    @app.get("/api/actions/triggers", dependencies=[Depends(require_permission("view_actions"))])
    def rules() -> dict:
        rows = app.state.db.rows(
            "SELECT t.*,u.display_name AS owner_name,c.name AS sound_name,c.emoji FROM action_triggers t "
            "JOIN users u ON u.id=t.owner_id LEFT JOIN clips c ON c.id=t.clip_id ORDER BY t.created_at,t.id"
        )
        for row in rows:
            row["speakers"] = json.loads(row["speakers"])
            row["enabled"] = bool(row["enabled"])
        return {"items": rows}

    @app.post(
        "/api/actions/triggers",
        status_code=201,
        dependencies=[Depends(require_permission("view_actions", "manage_actions"))],
    )
    def create(body: ActionInput, request: Request) -> dict:
        check_input(app, body)
        rule_id = new_id()
        app.state.db.change(
            "INSERT INTO action_triggers(id,owner_id,event,action,clip_id,target,speakers,enabled,delay,cooldown,"
            "created_at) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
            (
                rule_id,
                request.state.user["id"],
                body.event,
                body.action,
                body.clip_id,
                body.target,
                json.dumps(body.speakers),
                int(body.enabled),
                body.delay,
                body.cooldown,
                time.time(),
            ),
            request.state.user["id"],
            "action_trigger.create",
            resource_id=rule_id,
            name=EVENTS[body.event],
            details={**body.model_dump(), "event_label": EVENTS[body.event]},
        )
        app.state.events.publish("actions")
        app.state.events.publish("audit")
        return {"id": rule_id}

    @app.put(
        "/api/actions/triggers/{rule_id}", dependencies=[Depends(require_permission("view_actions", "manage_actions"))]
    )
    def update(rule_id: str, body: ActionInput, request: Request) -> dict:
        if not app.state.db.one("SELECT id FROM action_triggers WHERE id=?", (rule_id,)):
            raise HTTPException(404, "Action trigger not found.")
        check_input(app, body)
        app.state.db.change(
            "UPDATE action_triggers SET event=?,action=?,clip_id=?,target=?,speakers=?,enabled=?,delay=?,cooldown=? "
            "WHERE id=?",
            (
                body.event,
                body.action,
                body.clip_id,
                body.target,
                json.dumps(body.speakers),
                int(body.enabled),
                body.delay,
                body.cooldown,
                rule_id,
            ),
            request.state.user["id"],
            "action_trigger.update",
            resource_id=rule_id,
            name=EVENTS[body.event],
            details={**body.model_dump(), "event_label": EVENTS[body.event]},
        )
        app.state.events.publish("actions")
        app.state.events.publish("audit")
        return {"ok": True}

    @app.delete(
        "/api/actions/triggers/{rule_id}", dependencies=[Depends(require_permission("view_actions", "manage_actions"))]
    )
    def delete(rule_id: str, request: Request) -> dict:
        rule = app.state.db.one("SELECT * FROM action_triggers WHERE id=?", (rule_id,))
        if not rule:
            raise HTTPException(404, "Action trigger not found.")
        if not request.state.user["admin"] and rule["owner_id"] != request.state.user["id"]:
            raise HTTPException(403, "Only the creator or an administrator can delete this action trigger.")
        app.state.db.change(
            "DELETE FROM action_triggers WHERE id=?",
            (rule_id,),
            request.state.user["id"],
            "action_trigger.delete",
            resource_id=rule_id,
            name=EVENTS[rule["event"]],
            details={"event": rule["event"], "event_label": EVENTS[rule["event"]]},
        )
        app.state.events.publish("actions")
        app.state.events.publish("audit")
        return {"ok": True}
