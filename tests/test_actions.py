from __future__ import annotations

import asyncio
import json
import time
from types import SimpleNamespace
from typing import TYPE_CHECKING
from unittest.mock import Mock

import pytest

from app.actions import EVENTS, FLAGS, MAX_PENDING, Actions, VoiceEvent, transitions
from app.db import Database
from tests.test_auth import client as auth_fixture
from tests.test_auth import headers, login
from tests.test_conversation import manager, seed

if TYPE_CHECKING:
    from collections.abc import Iterator
    from pathlib import Path

    from fastapi.testclient import TestClient


@pytest.fixture
def client(tmp_path: Path) -> Iterator[TestClient]:
    yield from auth_fixture.__wrapped__(tmp_path)


def state(channel: int | None = 123, **flags: bool) -> SimpleNamespace:
    return SimpleNamespace(
        channel=SimpleNamespace(id=channel) if channel else None, **dict.fromkeys(FLAGS, False) | flags
    )


def engine(tmp_path: Path) -> Actions:
    db = Database(tmp_path / "actions.sqlite3")
    seed(db)
    db.execute("UPDATE users SET permission_overrides=? WHERE id=?", ('{"view_actions":true}', "100"))
    conversation = manager(db)
    value = Actions(conversation.settings, db, conversation.events, conversation.bot)
    member = value.bot.voice.channel.members[0]
    member.guild = SimpleNamespace(id=value.settings.discord_guild_id)
    member.voice = state()
    value.bot.state.mixer = Mock()
    value.synchronize()
    return value


def rule(value: Actions, **changes: object) -> dict:
    values = {
        "id": "rule",
        "owner_id": "100",
        "event": "camera_on",
        "action": "play",
        "clip_id": "sound",
        "target": "everyone",
        "speakers": "[]",
        "enabled": 1,
        "delay": 0,
        "cooldown": 5,
        "created_at": 0,
    } | changes
    value.db.execute(
        "INSERT INTO action_triggers(id,owner_id,event,action,clip_id,target,speakers,enabled,delay,cooldown,"
        "created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        tuple(values.values()),
    )
    return value.db.one("SELECT * FROM action_triggers WHERE id=?", (values["id"],))


def event(value: Actions, actor: str = "100", kind: str = "camera_on") -> VoiceEvent:
    return VoiceEvent(actor, "Participant", kind, value.generation, 123, time.monotonic())


@pytest.mark.parametrize(("flag", "label"), list(FLAGS.items()))
def test_flag_transitions(flag: str, label: str) -> None:
    assert transitions(state(), state(**{flag: True}), 123) == [f"{label}_on"]
    assert transitions(state(**{flag: True}), state(), 123) == [f"{label}_off"]
    assert not transitions(state(456), state(456, **{flag: True}), 123)


def test_moves_simultaneous_changes_and_server_flags() -> None:
    assert transitions(state(None), state(123, self_video=True), 123) == ["join"]
    assert transitions(state(123), state(456), 123) == ["leave"]
    assert transitions(state(456), state(123), 123) == ["join"]
    assert transitions(state(123), state(None), 123) == ["leave"]
    assert transitions(state(), state(**dict.fromkeys(FLAGS, True)), 123) == [
        "camera_on",
        "mute_on",
        "deafen_on",
        "stream_on",
    ]
    assert not transitions(state(), state(mute=True, deaf=True), 123)


def test_receive_suppression_and_overflow(tmp_path: Path) -> None:
    value = engine(tmp_path)
    member = value.bot.voice.channel.members[0]
    value.receive(member, state(None), state())
    assert value.queue.empty()
    member.bot = True
    value.receive(member, state(), state(self_video=True))
    member.bot = False
    member.guild.id = 1
    value.receive(member, state(), state(self_video=True))
    assert value.queue.empty()
    member.guild.id = value.settings.discord_guild_id
    for index in range(MAX_PENDING + 1):
        value.receive(member, state(self_video=bool(index % 2)), state(self_video=not bool(index % 2)))
    assert value.queue.qsize() == MAX_PENDING
    assert value.dropped == 1
    assert value.overflow
    value.invalidate()
    assert value.queue.empty()
    value.db.close()


@pytest.mark.parametrize(
    ("target", "actor", "expected"),
    [("everyone", "100", 1), ("self", "100", 1), ("self", "200", 0), ("selected", "100", 0), ("selected", "200", 1)],
)
def test_targeting_and_shared_cooldown(tmp_path: Path, target: str, actor: str, expected: int) -> None:
    async def scenario() -> None:
        value = engine(tmp_path)
        value.bot.voice.channel.members.append(SimpleNamespace(id=200, bot=False))
        rule(value, target=target, speakers='["200"]')
        await value.match(event(value, actor))
        await asyncio.gather(*value.pending)
        assert value.bot.state.play.call_count == expected
        await value.match(event(value, actor))
        await asyncio.gather(*value.pending)
        assert value.bot.state.play.call_count == expected
        await value.close()
        value.db.close()

    asyncio.run(scenario())


@pytest.mark.parametrize(
    "failure", ["access", "play", "member", "channel", "clip", "capacity", "edit", "delete", "stale"]
)
def test_execution_rechecks_and_skips(tmp_path: Path, failure: str) -> None:
    async def scenario() -> None:
        value = engine(tmp_path)
        saved = rule(value)
        item = event(value)
        if failure in {"access", "play"}:
            permissions = {"view_actions": failure != "access", "play_sounds": failure != "play"}
            value.db.execute("UPDATE users SET permission_overrides=? WHERE id=?", (json.dumps(permissions), "100"))
        elif failure == "member":
            value.bot.client.get_guild.return_value = None
        elif failure == "channel":
            value.bot.voice.channel.permissions_for.return_value.connect = False
        elif failure == "clip":
            value.db.execute("DELETE FROM clips")
        elif failure == "capacity":
            value.bot.state.play.side_effect = ValueError("capacity")
        elif failure == "edit":
            value.db.execute("UPDATE action_triggers SET enabled=0")
        elif failure == "delete":
            value.db.execute("DELETE FROM action_triggers")
        else:
            item = VoiceEvent("100", "Participant", "camera_on", value.generation, 123, time.monotonic() - 10)
        await value.run(saved, item)
        assert not value.db.one("SELECT id FROM audit WHERE action='sound.play'")
        audit = value.db.one("SELECT * FROM audit WHERE action='action_trigger.fire'")
        assert audit["outcome"] == "rejected"
        assert json.loads(audit["details"])["reason"]
        await value.close()
        value.db.close()

    asyncio.run(scenario())


def test_recording_independence_stop_all_leave_and_cancellation(tmp_path: Path) -> None:
    async def scenario() -> None:
        value = engine(tmp_path)
        value.db.set_setting("conversation_enabled", value=False)
        saved = rule(value, action="stop_all", clip_id="", event="leave", delay=0)
        value.bot.voice.channel.members.clear()
        await value.run(saved, event(value, kind="leave"))
        value.bot.state.mixer.stop.assert_called_once()
        assert value.db.one("SELECT id FROM audit WHERE action='sound.stop_all'")
        value.db.execute("UPDATE action_triggers SET delay=1")
        saved = value.db.one("SELECT * FROM action_triggers")
        task = asyncio.create_task(value.run(saved, event(value, kind="leave")))
        value.pending.add(task)
        await asyncio.sleep(0)
        value.invalidate()
        await asyncio.gather(task, return_exceptions=True)
        assert task.cancelled()
        value.bot.state.mixer.stop.assert_called_once()
        await value.close()
        value.db.close()

    asyncio.run(scenario())


def test_api_default_denial_grants_validation_and_ownership(client: TestClient) -> None:
    user = login(client)
    db = client.app.state.db
    seed(db)
    assert not user["permissions"]["view_actions"]
    assert user["permissions"]["manage_actions"]
    for path in ("/api/actions/status", "/api/actions/triggers"):
        assert client.get(path).status_code == 403
    assert client.post("/api/actions/triggers", json={"clip_id": "sound"}, headers=headers(user)).status_code == 403
    db.execute("UPDATE users SET permission_overrides=? WHERE id=?", ('{"view_actions":true}', "100"))
    assert client.get("/api/actions/status").json()["events"] == EVENTS
    body = {"clip_id": "sound", "event": "mute_on", "delay": 2, "target": "selected", "speakers": ["200"]}
    created = client.post("/api/actions/triggers", json=body, headers=headers(user))
    assert created.status_code == 201
    identity = created.json()["id"]
    for changes, code in (
        ({"event": "server_mute"}, 422),
        ({"delay": -1}, 422),
        ({"delay": 61}, 422),
        ({"cooldown": 3601}, 422),
        ({"clip_id": "missing"}, 404),
        ({"speakers": []}, 422),
        ({"speakers": ["invalid"]}, 422),
        ({"unknown": True}, 422),
    ):
        assert (
            client.put(f"/api/actions/triggers/{identity}", json=body | changes, headers=headers(user)).status_code
            == code
        )
    db.execute(
        "INSERT INTO users(id,username,display_name,created_at,last_login) VALUES (?,?,?,?,?)",
        ("200", "other", "Other", 0, 0),
    )
    db.execute("UPDATE action_triggers SET owner_id=? WHERE id=?", ("200", identity))
    assert (
        client.put(
            f"/api/actions/triggers/{identity}", json=body | {"enabled": False}, headers=headers(user)
        ).status_code
        == 200
    )
    assert client.delete(f"/api/actions/triggers/{identity}", headers=headers(user)).status_code == 403
    db.execute(
        "UPDATE users SET permission_overrides=? WHERE id=?", ('{"view_actions":true,"manage_actions":false}', "100")
    )
    assert client.get("/api/actions/triggers").status_code == 200
    assert client.put(f"/api/actions/triggers/{identity}", json=body, headers=headers(user)).status_code == 403
    db.execute("UPDATE users SET permission_overrides=? WHERE id=?", ('{"view_actions":true,"admin":true}', "100"))
    assert client.delete(f"/api/actions/triggers/{identity}", headers=headers(user)).status_code == 200
    assert client.delete(f"/api/actions/triggers/{identity}", headers=headers(user)).status_code == 404
    assert db.one("SELECT id FROM audit WHERE action='action_trigger.delete'")


def test_delayed_rule_edit_and_connection_generation(tmp_path: Path) -> None:
    async def scenario() -> None:
        value = engine(tmp_path)
        saved = rule(value, delay=0.05)
        task = asyncio.create_task(value.run(saved, event(value)))
        await asyncio.sleep(0.01)
        value.db.execute("UPDATE action_triggers SET cooldown=2")
        await task
        value.bot.state.play.assert_not_called()
        saved = value.db.one("SELECT * FROM action_triggers")
        old = event(value)
        value.bot.voice.channel.id = 456
        value.synchronize()
        assert not value.current(old)
        value.bot.voice.channel.id = 123
        value.synchronize()
        assert not value.current(old)
        value.bot.client.is_ready.return_value = False
        value.synchronize()
        assert value.signature is None
        value.bot.client.is_ready.return_value = True
        value.synchronize()
        await value.run(saved, old)
        value.bot.state.play.assert_not_called()
        await value.close()
        value.db.close()

    asyncio.run(scenario())


def test_overflow_audit_and_pending_bound(tmp_path: Path) -> None:
    async def scenario() -> None:
        value = engine(tmp_path)
        for index in range(MAX_PENDING + 2):
            rule(value, id=f"rule{index}", delay=1, cooldown=0)
        await value.match(event(value))
        assert value.backlog() == MAX_PENDING
        assert value.dropped == 2
        assert len(value.db.rows("SELECT id FROM audit WHERE action='action_trigger.fire' AND outcome='rejected'")) == 2
        value.overflow = event(value)
        await value.flush_overflow()
        assert value.overflow is None
        assert json.loads(value.db.one("SELECT details FROM audit ORDER BY id DESC LIMIT 1")["details"])["dropped"] == 2
        await value.close()
        value.bot.state.play.assert_not_called()
        value.db.close()

    asyncio.run(scenario())


def test_success_accounting_and_permission_revocation_during_authorization(tmp_path: Path) -> None:
    async def scenario() -> None:
        value = engine(tmp_path)
        saved = rule(value)
        await value.run(saved, event(value))
        assert value.db.one("SELECT id FROM audit WHERE action='sound.play' AND resource_id='sound'")
        assert value.db.one("SELECT id FROM audit WHERE action='action_trigger.fire' AND outcome='success'")
        value.bot.client.get_guild.return_value.get_member.return_value = None

        async def fetch(_identity: int) -> SimpleNamespace:
            value.db.execute("UPDATE users SET permission_overrides=? WHERE id=?", ('{"view_actions":false}', "100"))
            return value.bot.voice.channel.members[0]

        value.bot.client.get_guild.return_value.fetch_member = fetch
        await value.run(saved, event(value))
        value.bot.state.play.assert_called_once()
        assert value.db.one("SELECT outcome FROM audit ORDER BY id DESC LIMIT 1")["outcome"] == "rejected"
        await value.close()
        value.db.close()

    asyncio.run(scenario())


def test_action_table_persists_without_changing_existing_data(tmp_path: Path) -> None:
    value = engine(tmp_path)
    saved = rule(value)
    value.db.close()
    db = Database(tmp_path / "actions.sqlite3")
    assert db.one("SELECT * FROM action_triggers") == saved
    assert db.one("SELECT id FROM users WHERE id='100'")
    assert db.one("SELECT id FROM clips WHERE id='sound'")
    db.close()


def test_first_join_counts_humans_and_ignores_initial_states(tmp_path: Path) -> None:
    value = engine(tmp_path)
    member = value.bot.voice.channel.members[0]
    value.states.clear()
    value.bot.voice.channel.members.append(SimpleNamespace(id=900, bot=True))
    value.receive(member, state(None), state())
    assert [value.queue.get_nowait().event for _ in range(value.queue.qsize())] == ["join", "first_join"]
    value.receive(member, state(None), state())
    assert value.queue.empty()
    value.receive(member, state(), state(None))
    value.queue.get_nowait()
    value.bot.voice.channel.members.append(SimpleNamespace(id=200, bot=False))
    value.receive(member, state(456), state())
    assert value.queue.get_nowait().event == "join"
    assert value.queue.empty()
    value.db.close()


def test_speaking_callbacks_deduplicate_and_reject_stale_or_deafened_sources(tmp_path: Path) -> None:
    async def scenario() -> None:
        value = engine(tmp_path)
        member = value.bot.voice.channel.members[0]
        value.speech_wanted = True
        callback = value.speaking_callback(value.bot.voice)
        callback(None, "speaking_start")
        callback(member, "speaking_stop")
        callback(member, "speaking_start")
        callback(member, "speaking_start")
        await asyncio.sleep(0)
        assert value.queue.get_nowait().event == "speaking_start"
        assert value.queue.empty()
        callback(member, "speaking_stop")
        callback(member, "speaking_stop")
        await asyncio.sleep(0)
        assert value.queue.get_nowait().event == "speaking_stop"
        assert value.queue.empty()
        value.bot.state.deafened = True
        callback(member, "speaking_start")
        await asyncio.sleep(0)
        assert value.queue.empty()
        value.bot.state.deafened = False
        value.invalidate()
        value.synchronize()
        callback(member, "speaking_start")
        await asyncio.sleep(0)
        assert value.queue.empty()
        fresh = value.speaking_callback(value.bot.voice)
        member.bot = True
        fresh(member, "speaking_start")
        await asyncio.sleep(0)
        assert value.queue.empty()
        member.bot = False
        member.guild.id = 1
        fresh(member, "speaking_start")
        await asyncio.sleep(0)
        assert value.queue.empty()
        await value.close()
        value.db.close()

    asyncio.run(scenario())


def test_speaking_receiver_without_recording_and_shared_handover(tmp_path: Path) -> None:
    async def scenario() -> None:
        value = engine(tmp_path)
        value.db.set_setting("conversation_enabled", value=False)
        rule(value, event="speaking_start")
        voice = value.bot.voice
        voice.is_listening.return_value = False

        def listen(sink: object) -> None:
            voice.sink = sink
            voice.is_listening.return_value = True

        voice.listen.side_effect = listen
        await value.synchronize_speech()
        sink = voice.sink
        assert sink.wants_opus()
        sink.on_voice_member_speaking_start(voice.channel.members[0])
        await asyncio.sleep(0)
        await value.match(value.queue.get_nowait())
        await asyncio.gather(*value.pending)
        value.bot.state.play.assert_called_once()
        value.release_speech()
        voice.stop_listening.assert_called_once()
        value.db.execute("UPDATE action_triggers SET enabled=0")
        callback = value.speaking_callback(voice)
        epoch = value.speech_epoch
        value.speech_check = 0
        await value.synchronize_speech()
        assert value.speech_epoch == epoch
        callback(voice.channel.members[0], "speaking_stop")
        await asyncio.sleep(0)
        assert value.queue.empty()
        await value.close()
        value.db.close()

    asyncio.run(scenario())


def test_conversation_and_action_receivers_handover_without_duplicate_events(tmp_path: Path) -> None:
    async def scenario() -> None:
        value = engine(tmp_path)
        rule(value, event="speaking_start")
        voice = value.bot.voice
        voice.is_listening.return_value = False

        def listen(sink: object) -> None:
            voice.sink = sink
            voice.is_listening.return_value = True

        def stop() -> None:
            voice.is_listening.return_value = False

        voice.listen.side_effect = listen
        voice.stop_listening.side_effect = stop
        await value.synchronize_speech()
        previous = voice.sink
        conversation = manager(value.db)
        conversation.bot = value.bot
        value.bot.actions = value
        await conversation.open_session(voice)
        assert conversation.session
        current = voice.sink
        assert not current.wants_opus()
        previous.on_voice_member_speaking_start(voice.channel.members[0])
        current.on_voice_member_speaking_start(voice.channel.members[0])
        await asyncio.sleep(0)
        assert value.queue.qsize() == 1
        assert value.queue.get_nowait().event == "speaking_start"
        assert ("on_voice_member_speaking_start", "on_voice_member_speaking_start") in current.__sink_listeners__
        await conversation.close_session()
        current.on_voice_member_speaking_stop(voice.channel.members[0])
        await asyncio.sleep(0)
        assert value.queue.empty()
        value.speech_check = 0
        await value.synchronize_speech()
        assert voice.sink.wants_opus()
        assert not value.db.rows("SELECT * FROM conversations")
        await value.close()
        value.db.close()

    asyncio.run(scenario())
