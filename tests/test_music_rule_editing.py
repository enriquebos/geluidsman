from __future__ import annotations

import asyncio
import time
from typing import TYPE_CHECKING
from unittest.mock import Mock

import pytest

from app.conversation_audio import Speech
from app.db import Database
from tests.test_actions import engine, event, rule, state
from tests.test_conversation import manager, seed
from tests.test_music_routes import client as music_fixture
from tests.test_music_routes import override

if TYPE_CHECKING:
    from collections.abc import Iterator
    from pathlib import Path

    from fastapi.testclient import TestClient


@pytest.fixture
def client(tmp_path: Path) -> Iterator[TestClient]:
    yield from music_fixture.__wrapped__(tmp_path)


@pytest.mark.parametrize("namespace", ["conversation", "actions"])
def test_rules_can_be_created_edited_enabled_and_deleted_during_music(client: TestClient, namespace: str) -> None:
    seed(client.app.state.db)
    client.app.state.bot.state.audio_mode = "music"
    override(client, "200", manage_triggers=True, manage_actions=True)
    headers = {"x-member": "200"}
    path = f"/api/{namespace}/triggers"
    body = {"clip_id": "sound", "enabled": True}
    body.update({"phrase": "hello"} if namespace == "conversation" else {"event": "camera_on"})
    created = client.post(path, json=body, headers=headers)
    assert created.status_code == 201
    identity = created.json()["id"]
    field = "phrase" if namespace == "conversation" else "event"
    body[field] = "hello again" if namespace == "conversation" else "mute_on"
    body["delay"] = 3
    assert client.put(path + "/" + identity, json=body, headers=headers).status_code == 200
    rows = client.get(path, headers=headers).json()["items"]
    assert len(rows) == 1
    assert rows[0][field] == body[field]
    assert rows[0]["enabled"] is True
    assert rows[0]["delay"] == 3
    body["enabled"] = False
    assert client.put(path + "/" + identity, json=body, headers=headers).status_code == 200
    assert client.get(path, headers=headers).json()["items"][0]["enabled"] is False
    assert client.delete(path + "/" + identity, headers=headers).status_code == 200
    assert client.get(path, headers=headers).json()["items"] == []
    assert client.app.state.bot.state.audio_mode == "music"
    assert client.app.state.conversation.session is None


@pytest.mark.parametrize("namespace", ["conversation", "actions"])
def test_music_rule_management_keeps_account_permission_checks(client: TestClient, namespace: str) -> None:
    seed(client.app.state.db)
    client.app.state.bot.state.audio_mode = "music"
    permission = "manage_triggers" if namespace == "conversation" else "manage_actions"
    path = f"/api/{namespace}/triggers"
    body = {"clip_id": "sound", **({"phrase": "hello"} if namespace == "conversation" else {"event": "camera_on"})}
    override(client, "200", **{permission: False})
    assert client.post(path, json=body, headers={"x-member": "200"}).status_code == 403
    assert client.get(path, headers={"x-member": "200"}).status_code == 200


@pytest.mark.parametrize("action", ["play", "stop_all"])
def test_enabled_conversation_rules_ignore_stale_speech_in_music(tmp_path: Path, action: str) -> None:
    async def scenario() -> None:
        db = Database(tmp_path / "conversation.sqlite3")
        seed(db)
        value = manager(db)
        value.enabled = True
        value.bot.state.mixer = Mock()
        await value.synchronize()
        session = value.session["id"]
        db.execute(
            "INSERT INTO conversation_triggers(id,owner_id,clip_id,phrase,mode,target,speakers,cooldown,enabled,"
            "created_at,action,delay) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
            ("trigger", "100", "sound", "hello", "word", "everyone", "[]", 0, 1, 0, action, 0),
        )
        saved = db.one("SELECT * FROM conversation_triggers WHERE id='trigger'")
        value.bot.state.audio_mode = "music"
        speech = Speech("100", "Owner", None, time.time(), time.time(), b"audio", "message")
        value.receive(("100", "Owner", None), b"audio", time.time())
        assert value.packets.empty()
        await value.fire_triggers(session, speech, "hello")
        assert not value.delayed
        await value.fire(saved, session, speech)
        value.bot.state.play.assert_not_called()
        value.bot.state.mixer.stop.assert_not_called()
        assert db.one("SELECT outcome FROM audit WHERE action='trigger.play'")["outcome"] == "rejected"
        assert db.one("SELECT enabled FROM conversation_triggers")["enabled"] == 1
        await value.close()
        db.close()

    asyncio.run(scenario())


@pytest.mark.parametrize("action", ["play", "stop_all"])
def test_enabled_actions_ignore_events_and_execution_in_music(tmp_path: Path, action: str) -> None:
    async def scenario() -> None:
        value = engine(tmp_path)
        saved = rule(value, action=action)
        item = event(value)
        value.bot.state.audio_mode = "music"
        member = value.bot.voice.channel.members[0]
        value.receive(member, state(), state(self_video=True))
        assert value.queue.empty()
        await value.match(item)
        assert not value.pending
        await value.run(saved, item)
        value.bot.state.play.assert_not_called()
        value.bot.state.mixer.stop.assert_not_called()
        assert value.db.one("SELECT enabled FROM action_triggers")["enabled"] == 1
        assert value.db.one("SELECT outcome FROM audit WHERE action='action_trigger.fire'")["outcome"] == "rejected"
        await value.close()
        value.db.close()

    asyncio.run(scenario())
