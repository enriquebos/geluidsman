from __future__ import annotations

import asyncio
import json
import time
from types import SimpleNamespace
from typing import TYPE_CHECKING
from unittest.mock import AsyncMock, Mock

import discord
import numpy as np
import pytest

from app.config import Settings
from app.conversation import MAX_QUEUE, Conversation, matches
from app.conversation_audio import MAX_CHUNK_SECONDS, SAMPLE_RATE, SILENCE_SECONDS, ReceiveSink, Segmenter, Speech
from app.db import Database
from app.events import Events
from tests.test_auth import client as auth_fixture
from tests.test_auth import headers
from tests.test_auth import login as auth_login

if TYPE_CHECKING:
    from collections.abc import Iterator
    from pathlib import Path

    from fastapi.testclient import TestClient


@pytest.fixture
def client(tmp_path: Path) -> Iterator[TestClient]:
    yield from auth_fixture.__wrapped__(tmp_path)


def login(client: TestClient) -> dict:
    auth_login(client)
    client.app.state.db.execute(
        "UPDATE users SET permission_overrides=? WHERE id='100'", ('{"view_conversations":true}',)
    )
    return client.get("/api/auth/me").json()


def seed(db: Database) -> None:
    db.execute(
        "INSERT OR IGNORE INTO users(id,username,display_name,created_at,last_login) VALUES (?,?,?,?,?)",
        ("100", "owner", "Owner", time.time(), time.time()),
    )
    db.execute(
        "INSERT OR IGNORE INTO sources(id,url,title,duration,created_at) VALUES (?,?,?,?,?)",
        ("source", "https://example.com/video", "Source", 10, time.time()),
    )
    db.execute(
        (
            "INSERT OR IGNORE INTO clips(id,source_id,name,emoji,tags,start,end,volume,created_at)"
            " VALUES (?,?,?,?,?,?,?,?,?)"
        ),
        ("sound", "source", "Sound", "", "[]", 0, 1, 1, time.time()),
    )


@pytest.mark.parametrize(
    ("text", "phrase", "mode", "expected"),
    [
        ("Hoi WERELD!", "wereld", "word", True),
        ("catch", "cat", "word", False),
        ("catch", "cat", "contains", True),
        ("hello   world", "hello world", "word", True),
        ("répéter déjà", "DÉJÀ", "word", True),
        ("anything", ".*", "word", False),
        ("anything", "", "word", False),
    ],
)
def test_matching(text: str, phrase: str, mode: str, *, expected: bool) -> None:
    assert matches(text, phrase, mode) is expected


def test_segmentation_and_speaker_separation(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        Segmenter, "is_speech", lambda _self, _speaker, audio: np.mean(np.frombuffer(audio, dtype=np.int16)) > 200
    )
    segmenter = Segmenter()
    audio = np.full(1920, 1000, dtype=np.int16).tobytes()
    silent = bytes(3840)
    assert not segmenter.feed(("1", "One", None), audio, 1)
    assert not segmenter.feed(("2", "Two", None), audio, 1.1)
    assert not segmenter.feed(("1", "One", None), silent, 1.2)
    first = segmenter.feed(("1", "One", None), silent, 1.7)[0]
    assert first.speaker_id == "1"
    assert first.started_at == first.ended_at == 1
    assert len(first.pcm) == 3 * 640
    assert segmenter.flush(1.8)[0].speaker_id == "2"
    assert not segmenter.buffers
    assert not segmenter.feed(("1", "One", None), silent, 2)
    assert not segmenter.feed(("1", "One", None), b"invalid", 2)
    chunks = []
    for index in range(MAX_CHUNK_SECONDS * 50):
        chunks.extend(segmenter.feed(("1", "One", None), audio, 3 + index * 0.02))
    assert len(chunks) == 1
    assert len(chunks[0].pcm) == MAX_CHUNK_SECONDS * SAMPLE_RATE * 2
    assert segmenter.buffers["1"].samples == SAMPLE_RATE // 50


def test_audio_resampling_filters_aliases_and_preserves_packet_boundaries() -> None:
    times = np.arange(4800) / 48000
    low = np.sin(2 * np.pi * 1000 * times).astype(np.float32) * 1000
    high = np.sin(2 * np.pi * 12000 * times).astype(np.float32) * 1000
    whole = Segmenter().resample("1", low)
    segmenter = Segmenter()
    pieces = np.concatenate([segmenter.resample("1", piece) for piece in np.split(low, [101, 911, 2345])])
    np.testing.assert_allclose(pieces, whole, atol=0.001)
    filtered = Segmenter().resample("2", high)
    assert np.sqrt(np.mean(filtered[20:] ** 2)) < np.sqrt(np.mean(whole[20:] ** 2)) * 0.05


def test_audio_preserves_bounded_quiet_lead_in(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        Segmenter, "is_speech", lambda _self, _speaker, audio: np.mean(np.frombuffer(audio, dtype=np.int16)) > 200
    )
    segmenter = Segmenter()
    quiet = np.full(1920, 100, dtype=np.int16).tobytes()
    loud = np.full(1920, 1000, dtype=np.int16).tobytes()
    for index in range(30):
        assert not segmenter.feed(("1", "One", None), quiet, index * 0.02)
    assert len(segmenter.leading["1"]) == SAMPLE_RATE * 2 // 5
    assert not segmenter.feed(("1", "One", None), loud, 0.6)
    speech = segmenter.flush(1.1)[0]
    assert speech.started_at == pytest.approx(0.4)
    assert len(speech.pcm) == SAMPLE_RATE * 2 // 5 + 640
    assert not segmenter.leading


def test_sink_discards_bots_and_unknown_or_unannounced_speakers() -> None:
    callback = Mock()
    sink = ReceiveSink(callback, {"1"})
    packet = SimpleNamespace(pcm=bytes(3840))
    sink.write(None, packet)
    sink.write(SimpleNamespace(bot=True, id=1), packet)
    sink.write(SimpleNamespace(bot=False, id=2), packet)
    callback.assert_not_called()
    sink.write(
        SimpleNamespace(bot=False, id=1, display_name="One", display_avatar=SimpleNamespace(url="avatar")), packet
    )
    assert callback.call_args.args[0] == ("1", "One", "avatar")
    sink.cleanup()
    assert not sink.allowed


def test_trigger_api_persistence_validation_and_ownership(client: TestClient) -> None:
    login(client)
    seed(client.app.state.db)
    body = {"clip_id": "sound", "phrase": "Hallo", "target": "selected", "speakers": ["200"], "cooldown": 0}
    response = client.post("/api/conversation/triggers", json=body, headers=headers(client.get("/api/auth/me").json()))
    assert response.status_code == 201
    trigger_id = response.json()["id"]
    trigger = client.get("/api/conversation/triggers").json()["items"][0]
    assert trigger["owner_id"] == "100"
    assert trigger["speakers"] == ["200"]
    assert (
        client.put(
            f"/api/conversation/triggers/{trigger_id}",
            json={**body, "enabled": False},
            headers=headers(client.get("/api/auth/me").json()),
        ).status_code
        == 200
    )
    assert not client.get("/api/conversation/triggers").json()["items"][0]["enabled"]
    for invalid in [
        {"phrase": " "},
        {"cooldown": -1},
        {"mode": "regex"},
        {"speakers": []},
        {"speakers": ["bad"]},
        {"clip_id": "missing"},
    ]:
        assert client.post(
            "/api/conversation/triggers", json={**body, **invalid}, headers=headers(client.get("/api/auth/me").json())
        ).status_code in {404, 422}
    client.app.state.db.execute(
        "INSERT INTO users(id,username,display_name,created_at,last_login) VALUES (?,?,?,?,?)",
        ("200", "other", "Other", 0, 0),
    )
    client.app.state.db.execute("UPDATE conversation_triggers SET owner_id='200' WHERE id=?", (trigger_id,))
    assert client.get("/api/conversation/triggers").json()["items"][0]["owner_id"] == "200"
    assert (
        client.delete(
            f"/api/conversation/triggers/{trigger_id}", headers=headers(client.get("/api/auth/me").json())
        ).status_code
        == 403
    )
    assert (
        client.put(
            f"/api/conversation/triggers/{trigger_id}", json=body, headers=headers(client.get("/api/auth/me").json())
        ).status_code
        == 200
    )
    client.app.state.auth.admin_ids = {"100"}
    assert len(client.get("/api/conversation/triggers").json()["items"]) == 1
    assert (
        client.delete(
            f"/api/conversation/triggers/{trigger_id}", headers=headers(client.get("/api/auth/me").json())
        ).status_code
        == 200
    )
    assert client.get("/api/audit").json()["results"][0]["action"] == "trigger.delete"


@pytest.mark.parametrize(
    ("permission", "method", "path", "body"),
    [
        ("view_conversations", "GET", "/api/conversations/unknown/messages", None),
        ("view_conversations", "GET", "/api/conversations/status", None),
        ("view_conversations", "GET", "/api/conversations/session/messages", None),
        ("control_recording", "PUT", "/api/conversations/recording", {"enabled": False}),
        ("manage_triggers", "POST", "/api/conversation/triggers", {"clip_id": "sound", "phrase": "hello"}),
        ("manage_triggers", "DELETE", "/api/conversation/triggers/id", None),
    ],
)
def test_conversation_permission_denials(
    client: TestClient, permission: str, method: str, path: str, body: dict | None
) -> None:
    login(client)
    client.app.state.db.execute(
        "UPDATE users SET permission_overrides=? WHERE id='100'",
        (json.dumps({"view_conversations": True, permission: False}),),
    )
    assert (
        client.request(method, path, json=body, headers=headers(client.get("/api/auth/me").json())).status_code == 403
    )
    assert client.get("/api/auth/me").status_code == 200


def test_live_message_pagination_and_removed_history(client: TestClient) -> None:
    login(client)
    db = client.app.state.db
    for index in range(51):
        db.execute(
            "INSERT INTO conversations(id,channel_id,channel_name,started_at,ended_at) VALUES (?,?,?,?,?)",
            (f"session{index}", "123", "Voice", index, index + 1),
        )
    for index in range(105):
        db.execute(
            (
                "INSERT INTO conversation_messages(id,session_id,speaker_id,speaker_name,started_at,en"
                "ded_at,text,language) VALUES (?,?,?,?,?,?,?,?)"
            ),
            (f"message{index:03}", "session50", "100", "Me", 1, 2, "Hallo", "nl"),
        )
    assert client.get("/api/conversations").status_code == 404
    assert client.get("/api/conversations/session50/messages").status_code == 404
    client.app.state.conversation.session = {"id": "session50"}
    data = client.get("/api/conversations/session50/messages").json()
    assert len(data["items"]) == 100
    assert data["has_older"]
    older = client.get("/api/conversations/session50/messages", params={"before": data["items"][0]["id"]}).json()
    assert len(older["items"]) == 5
    assert not older["has_older"]
    assert client.get("/api/conversations/session50/messages?before=missing").status_code == 404
    assert client.get("/api/conversations/missing/messages").status_code == 404
    assert client.get("/api/admin/conversations/settings").status_code == 404
    assert (
        client.put(
            "/api/conversations/recording", json={"enabled": False}, headers=headers(client.get("/api/auth/me").json())
        ).status_code
        == 200
    )
    assert not db.setting("conversation_enabled")


def manager(db: Database) -> Conversation:
    member = SimpleNamespace(id=100, bot=False, display_name="Owner", display_avatar=SimpleNamespace(url="avatar"))
    voice = Mock()
    voice.channel.id = 123
    voice.channel.name = "Voice"
    voice.channel.members = [member]
    voice.channel.send = AsyncMock()
    voice.is_connected.return_value = True
    voice.is_listening.return_value = True
    state = SimpleNamespace(deafened=False, play=Mock(return_value="instance"))
    bot = SimpleNamespace(voice=voice, client=Mock(), state=state)
    bot.client.is_ready.return_value = True
    bot.client.get_guild.return_value.get_member.return_value = member
    voice.channel.permissions_for.return_value.view_channel = True
    result = Conversation(Settings(_env_file=None), db, Events(), bot)
    result.worker_ready = AsyncMock(return_value=True)
    return result


def test_session_without_chat_notice_deafen_disconnect_and_cleanup(tmp_path: Path) -> None:
    async def scenario() -> None:
        db = Database(tmp_path / "test.sqlite3")
        value = manager(db)
        voice = value.bot.voice
        voice.channel.send.side_effect = discord.Forbidden(Mock(status=403, reason="Forbidden"), "denied")
        await value.synchronize()
        assert value.session
        assert value.allowed == {"100"}
        voice.channel.send.assert_not_awaited()
        session = value.session["id"]
        value.enqueue(Speech("100", "Owner", None, time.time(), time.time(), b"audio"))
        value.bot.state.deafened = True
        await value.synchronize()
        assert value.session is None
        assert not value.allowed
        assert value.work.empty()
        assert not db.one("SELECT id FROM conversations WHERE id=?", (session,))
        value.bot.state.deafened = False
        await value.synchronize()
        assert value.session["id"] != session
        value.bot.voice.is_connected.return_value = False
        await value.synchronize()
        assert value.session is None
        db.execute("UPDATE conversations SET started_at=0,ended_at=0")
        await value.cleanup()
        assert not db.rows("SELECT * FROM conversations")
        db.close()

    asyncio.run(scenario())


def test_triggers_cooldown_permissions_capacity_and_staleness(tmp_path: Path) -> None:
    async def scenario() -> None:
        db = Database(tmp_path / "test.sqlite3")
        seed(db)
        value = manager(db)
        await value.synchronize()
        db.execute(
            (
                "INSERT INTO conversation_triggers(id,owner_id,clip_id,phrase,mode,target,speakers,coo"
                "ldown,enabled,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)"
            ),
            ("trigger", "100", "sound", "hallo", "word", "self", "[]", 5, 1, 0),
        )
        speech = Speech("100", "Owner", None, time.time(), time.time(), b"audio")
        await value.fire_triggers(value.session["id"], speech, "hallo hallo")
        value.bot.state.play.assert_called_once()
        await value.fire_triggers(value.session["id"], speech, "hallo")
        value.bot.state.play.assert_called_once()
        db.execute("UPDATE conversation_triggers SET cooldown=0")
        db.execute("UPDATE users SET permission_overrides=? WHERE id='100'", ('{"play_sounds":false}',))
        await value.fire_triggers(value.session["id"], speech, "hallo")
        assert db.one("SELECT * FROM audit ORDER BY id DESC LIMIT 1")["outcome"] == "rejected"
        value.bot.state.play.assert_called_once()
        db.execute("UPDATE users SET permission_overrides='{}' WHERE id='100'")
        value.bot.state.play.side_effect = ValueError("capacity")
        await value.fire_triggers(value.session["id"], speech, "hallo")
        assert db.one("SELECT * FROM audit ORDER BY id DESC LIMIT 1")["outcome"] == "rejected"
        count = value.bot.state.play.call_count
        speech.ended_at = time.time() - 60
        await value.fire_triggers(value.session["id"], speech, "hallo")
        assert value.bot.state.play.call_count == count
        for _ in range(MAX_QUEUE + 1):
            value.enqueue(speech)
        assert value.work.qsize() == MAX_QUEUE
        assert value.dropped == 1
        value.receive(("100", "Owner", None), bytes(3840), time.time())
        await value.close_session()
        assert value.work.empty()
        assert value.packets.empty()
        db.close()

    asyncio.run(scenario())


@pytest.mark.parametrize(
    ("target", "speaker", "expected"),
    [
        ("everyone", "200", True),
        ("self", "200", False),
        ("self", "100", True),
        ("selected", "200", True),
        ("selected", "300", False),
    ],
)
def test_trigger_speaker_targets(tmp_path: Path, target: str, speaker: str, *, expected: bool) -> None:
    async def scenario() -> None:
        db = Database(tmp_path / "targets.sqlite3")
        seed(db)
        value = manager(db)
        await value.synchronize()
        db.execute(
            "INSERT INTO conversation_triggers(id,owner_id,clip_id,phrase,mode,target,speakers,cooldown,enabled,"
            "created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
            ("trigger", "100", "sound", "hallo", "word", target, '["200"]', 0, 1, 0),
        )
        speech = Speech(speaker, "Member", None, time.time(), time.time(), b"audio")
        await value.fire_triggers(value.session["id"], speech, "hallo")
        assert bool(value.bot.state.play.call_count) is expected
        await value.close_session()
        db.close()

    asyncio.run(scenario())


@pytest.mark.parametrize("language", ["nl", "en"])
def test_transcript_pipeline_live_storage_and_safe_notifications(tmp_path: Path, language: str) -> None:
    async def scenario() -> None:
        db = Database(tmp_path / "pipeline.sqlite3")
        value = manager(db)
        await value.synchronize()
        events = []
        value.events.publish = lambda name, data=None: events.append((name, data))
        value.fire_triggers = AsyncMock()
        response = Mock(status=200)
        response.json = AsyncMock(return_value={"text": "Private spoken words", "language": language})
        context = AsyncMock()
        context.__aenter__.return_value = response
        value.http = Mock()
        value.http.post.return_value = context
        value.enqueue(Speech("100", "Owner", None, time.time(), time.time(), b"audio"))
        task = asyncio.create_task(value.process())
        for _ in range(100):
            if value.fire_triggers.await_count:
                break
            await asyncio.sleep(0.01)
        assert value.fire_triggers.await_count == 1
        assert db.rows("SELECT * FROM conversation_messages")[0]["language"] == language
        assert "Private spoken words" not in str(events)
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        await value.close_session()
        db.close()
        restored = Database(tmp_path / "pipeline.sqlite3")
        assert not restored.rows("SELECT * FROM conversation_messages")
        restored.close()

    asyncio.run(scenario())


def test_participants_update_without_chat_messages(tmp_path: Path) -> None:
    async def scenario() -> None:
        db = Database(tmp_path / "arrivals.sqlite3")
        value = manager(db)
        await value.synchronize()
        value.voice.channel.members.append(SimpleNamespace(id=200, bot=False, display_name="Guest"))

        value.update_participants(value.voice)
        assert "200" in value.allowed
        value.voice.channel.members.append(SimpleNamespace(id=300, bot=False, display_name="Another"))
        value.voice.channel.send.side_effect = discord.Forbidden(Mock(status=403, reason="Forbidden"), "denied")
        value.update_participants(value.voice)
        assert value.session
        assert value.allowed == {"100", "200", "300"}
        value.voice.channel.send.assert_not_awaited()
        value.voice.channel.members = value.voice.channel.members[:1]
        value.update_participants(value.voice)
        assert value.allowed == {"100"}
        db.close()

    asyncio.run(scenario())


def test_duplicate_utterances_and_deleted_sounds(tmp_path: Path) -> None:
    async def scenario() -> None:
        db = Database(tmp_path / "duplicates.sqlite3")
        seed(db)
        value = manager(db)
        await value.synchronize()
        db.execute(
            "INSERT INTO conversation_triggers(id,owner_id,clip_id,phrase,mode,target,speakers,cooldown,enabled,"
            "created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
            ("trigger", "100", "sound", "hello", "word", "everyone", "[]", 0, 1, 0),
        )
        speech = Speech("100", "Owner", None, time.time(), time.time(), b"audio", "utterance")
        await value.fire_triggers(value.session["id"], speech, "hello hello")
        await value.fire_triggers(value.session["id"], speech, "hello hello")
        value.bot.state.play.assert_called_once()
        db.execute("DELETE FROM clips WHERE id='sound'")
        speech.id = "next"
        await value.fire_triggers(value.session["id"], speech, "hello")
        value.bot.state.play.assert_called_once()
        assert db.one("SELECT outcome FROM audit ORDER BY id DESC LIMIT 1")["outcome"] == "rejected"
        await value.close_session()
        db.close()

    asyncio.run(scenario())


def test_trigger_rechecks_permission_after_membership_lookup(tmp_path: Path) -> None:
    async def scenario() -> None:
        db = Database(tmp_path / "fresh.sqlite3")
        seed(db)
        value = manager(db)
        await value.synchronize()
        guild = value.bot.client.get_guild.return_value
        member = guild.get_member.return_value
        guild.get_member.return_value = None

        async def membership(_user_id: int) -> object:
            db.execute("UPDATE users SET permission_overrides=? WHERE id='100'", ('{"play_sounds":false}',))
            return member

        guild.fetch_member = AsyncMock(side_effect=membership)
        trigger = {"id": "trigger", "owner_id": "100", "clip_id": "sound"}
        speech = Speech("100", "Owner", None, time.time(), time.time(), b"audio")
        await value.fire(trigger, value.session["id"], speech)
        value.bot.state.play.assert_not_called()
        assert db.one("SELECT outcome FROM audit ORDER BY id DESC LIMIT 1")["outcome"] == "rejected"
        db.execute("UPDATE users SET permission_overrides='{}' WHERE id='100'")
        guild.get_member.return_value = member
        value.voice.channel.permissions_for.return_value.connect = False
        await value.fire(trigger, value.session["id"], speech)
        value.bot.state.play.assert_not_called()
        await value.close_session()
        db.close()

    asyncio.run(scenario())


def test_late_packets_cannot_cross_sessions(tmp_path: Path) -> None:
    async def scenario() -> None:
        db = Database(tmp_path / "late.sqlite3")
        value = manager(db)
        await value.synchronize()
        previous = value.session["id"]
        await value.close_session()
        await value.synchronize()
        assert value.session["id"] != previous
        audio = np.full(1920, 1000, dtype=np.int16).tobytes()
        value.receive(("100", "Owner", None), audio, time.time(), previous)
        value.drain_packets()
        assert not value.segmenter.buffers
        assert value.work.empty()
        value.receive(("100", "Owner", None), audio, time.time(), value.session["id"])
        value.drain_packets()
        assert "100" in value.segmenter.buffers
        await value.close_session()
        db.close()

    asyncio.run(scenario())


def test_conversation_language_default_permission_validation_and_persistence(client: TestClient) -> None:
    user = login(client)
    assert client.get("/api/conversations/status").json()["language"] == "nl"
    endpoint = "/api/conversations/language"
    assert client.put(endpoint, json={"language": "de"}, headers=headers(user)).status_code == 422
    assert client.put(endpoint, json={"language": "en"}, headers=headers(user)).status_code == 200
    assert client.app.state.db.setting("conversation_language") == "en"
    assert client.get("/api/conversations/status").json()["language"] == "en"
    client.app.state.db.execute(
        "UPDATE users SET permission_overrides=? WHERE id='100'",
        ('{"view_conversations":true,"control_recording":false}',),
    )
    assert client.put(endpoint, json={"language": "nl"}, headers=headers(user)).status_code == 403
    assert client.app.state.db.setting("conversation_language") == "en"


def test_speech_finalizes_after_short_silence_without_cutting_brief_pauses(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        Segmenter, "is_speech", lambda _self, _speaker, audio: np.mean(np.frombuffer(audio, dtype=np.int16)) > 200
    )
    segmenter = Segmenter()
    audio = np.full(1920, 1000, dtype=np.int16).tobytes()
    segmenter.feed(("1", "Speaker", None), audio, 1)
    assert not segmenter.flush(1 + SILENCE_SECONDS - 0.01)
    assert segmenter.flush(1 + SILENCE_SECONDS + 0.01)[0].speaker_id == "1"


@pytest.mark.parametrize("outcome", ["fire", "deny", "edit", "disconnect"])
def test_delayed_stop_all_rechecks_permissions_and_session(tmp_path: Path, outcome: str) -> None:
    async def scenario() -> None:
        db = Database(tmp_path / "delayed.sqlite3")
        seed(db)
        value = manager(db)
        value.bot.state.mixer = Mock()
        await value.synchronize()
        db.execute(
            "INSERT INTO conversation_triggers(id,owner_id,clip_id,phrase,mode,target,speakers,cooldown,"
            "enabled,created_at,action,delay) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
            ("delayed", "100", "", "stop", "word", "everyone", "[]", 0, 1, 0, "stop_all", 0.03),
        )
        db.execute("UPDATE users SET permission_overrides=? WHERE id='100'", ('{"play_sounds":false}',))
        speech = Speech("100", "Owner", None, time.time(), time.time(), b"audio", id="utterance")
        await value.fire_triggers(value.session["id"], speech, "stop")
        value.bot.state.mixer.stop.assert_not_called()
        assert len(value.delayed) == 1
        if outcome == "deny":
            db.execute("UPDATE users SET permission_overrides=? WHERE id='100'", ('{"stop_sounds":false}',))
        elif outcome == "edit":
            db.execute("UPDATE conversation_triggers SET enabled=0")
        elif outcome == "disconnect":
            await value.close_session()
        await asyncio.gather(*value.delayed)
        assert value.bot.state.mixer.stop.call_count == int(outcome == "fire")
        value.bot.state.play.assert_not_called()
        if outcome == "fire":
            assert db.one("SELECT * FROM audit WHERE action='sound.stop_all'")
        if outcome == "deny":
            assert db.one("SELECT * FROM audit WHERE action='trigger.play'")["outcome"] == "rejected"
        await value.close_session()
        db.close()

    asyncio.run(scenario())


def test_stop_trigger_input_and_delay_validation(client: TestClient) -> None:
    user = login(client)
    body = {"phrase": "stop", "action": "stop_all", "delay": 1.5}
    response = client.post("/api/conversation/triggers", json=body, headers=headers(user))
    assert response.status_code == 201
    saved = client.get("/api/conversation/triggers").json()["items"][0]
    assert saved["action"] == "stop_all"
    assert saved["delay"] == 1.5
    for changes in ({"delay": -1}, {"delay": 61}, {"action": "invalid"}, {"action": "play"}):
        assert client.post(
            "/api/conversation/triggers", json={**body, **changes}, headers=headers(user)
        ).status_code in {404, 422}


@pytest.mark.parametrize("disconnected", [False, True])
def test_batch_speakers_keep_identity_and_discard_disconnected_results(tmp_path: Path, *, disconnected: bool) -> None:
    async def scenario() -> None:
        db = Database(tmp_path / "batch.sqlite3")
        value = manager(db)
        await value.synchronize()
        value.fire_triggers = AsyncMock()
        response = Mock(status=200)

        async def result() -> dict:
            if disconnected:
                await value.close_session()
            return {
                "results": [{"text": "First speaker", "language": "nl"}, {"text": "Second speaker", "language": "en"}]
            }

        response.json = result
        context = AsyncMock()
        context.__aenter__.return_value = response
        value.http = Mock()
        value.http.post.return_value = context
        for speaker in ["100", "200"]:
            value.enqueue(Speech(speaker, speaker, None, time.time(), time.time(), speaker.encode()))
        task = asyncio.create_task(value.process())
        for _ in range(100):
            if value.fire_triggers.await_count == 2 or value.dropped == 2:
                break
            await asyncio.sleep(0.01)
        assert value.http.post.call_count == 1
        assert value.http.post.call_args.args[0].endswith("/transcribe/batch")
        assert value.http.post.call_args.kwargs["data"] == b"100200"
        messages = db.rows("SELECT * FROM conversation_messages ORDER BY speaker_id")
        if disconnected:
            assert not messages
            assert value.fire_triggers.await_count == 0
            assert value.dropped == 2
        else:
            assert [(item["speaker_id"], item["text"]) for item in messages] == [
                ("100", "First speaker"),
                ("200", "Second speaker"),
            ]
            assert value.fire_triggers.await_count == 2
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        await value.close_session()
        db.close()

    asyncio.run(scenario())


def test_batch_bounds_and_stale_work(tmp_path: Path) -> None:
    async def scenario() -> None:
        db = Database(tmp_path / "bounded.sqlite3")
        value = manager(db)
        await value.synchronize()
        for index in range(6):
            value.enqueue(Speech("100", str(index), None, time.time(), time.time() - (60 if index == 0 else 0), b"00"))
        batch = await value.next_batch()
        assert len(batch) == 3
        assert value.work.qsize() == 2
        assert value.dropped == 1
        before = time.monotonic()
        assert len(await value.next_batch()) == 2
        assert time.monotonic() - before < 0.2
        await value.close_session()
        db.close()

    asyncio.run(scenario())


def test_multiple_trigger_terms_persist_and_validate(client: TestClient) -> None:
    login(client)
    seed(client.app.state.db)
    csrf = headers(client.get("/api/auth/me").json())
    body = {"clip_id": "sound", "phrase": " Hallo \nhoi\nHALLO\nhey   iedereen\n"}
    response = client.post("/api/conversation/triggers", json=body, headers=csrf)
    assert response.status_code == 201
    trigger_id = response.json()["id"]
    trigger = client.get("/api/conversation/triggers").json()["items"][0]
    assert trigger["phrase"] == "Hallo\nhoi\nhey iedereen"
    assert trigger["phrases"] == ["Hallo", "hoi", "hey iedereen"]
    assert (
        client.put(
            f"/api/conversation/triggers/{trigger_id}", json={**body, "phrase": "dag\ntot ziens"}, headers=csrf
        ).status_code
        == 200
    )
    trigger = client.get("/api/conversation/triggers").json()["items"][0]
    assert trigger["phrases"] == ["dag", "tot ziens"]
    for phrase in ["\n \n", "x" * 256, "\n".join(str(index) for index in range(21))]:
        assert (
            client.post("/api/conversation/triggers", json={**body, "phrase": phrase}, headers=csrf).status_code == 422
        )
    assert client.delete(f"/api/conversation/triggers/{trigger_id}", headers=csrf).status_code == 200
    maximum = "\n".join(str(index).ljust(255, "x") for index in range(20))
    assert client.post("/api/conversation/triggers", json={**body, "phrase": maximum}, headers=csrf).status_code == 201


@pytest.mark.parametrize(
    ("mode", "text", "expected"),
    [
        ("word", "Hoi allemaal", 1),
        ("word", "hey iedereen en hallo hoi", 1),
        ("word", "ahoi", 0),
        ("contains", "ahoi", 1),
        ("contains", "hey iedereen en hoi hoi", 1),
        ("word", "hey en iedereen", 0),
    ],
)
def test_multiple_terms_activate_once_per_utterance(tmp_path: Path, mode: str, text: str, expected: int) -> None:
    async def scenario() -> None:
        db = Database(tmp_path / "words.sqlite3")
        seed(db)
        value = manager(db)
        await value.synchronize()
        db.execute(
            "INSERT INTO conversation_triggers(id,owner_id,clip_id,phrase,mode,target,speakers,cooldown,enabled,"
            "created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
            ("trigger", "100", "sound", "hallo\nhoi\nhey iedereen", mode, "everyone", "[]", 0, 1, 0),
        )
        speech = Speech("100", "Owner", None, time.time(), time.time(), b"audio", "utterance")
        await value.fire_triggers(value.session["id"], speech, text)
        await value.fire_triggers(value.session["id"], speech, text)
        assert value.bot.state.play.call_count == expected
        await value.close_session()
        db.close()

    asyncio.run(scenario())


def test_global_triggers_are_visible_without_management_permission(client: TestClient) -> None:
    assert client.get("/api/conversation/triggers").status_code == 401
    login(client)
    seed(client.app.state.db)
    user = client.get("/api/auth/me").json()
    response = client.post(
        "/api/conversation/triggers", json={"clip_id": "sound", "phrase": "Shared word"}, headers=headers(user)
    )
    assert response.status_code == 201
    client.app.state.db.execute(
        "UPDATE users SET permission_overrides=? WHERE id='100'",
        ('{"view_conversations":true,"manage_triggers":false}',),
    )
    response = client.get("/api/conversation/triggers")
    assert response.status_code == 200
    assert response.json()["items"][0]["phrase"] == "Shared word"
    assert (
        client.put(
            f"/api/conversation/triggers/{response.json()['items'][0]['id']}",
            json={"clip_id": "sound", "phrase": "Changed"},
            headers=headers(user),
        ).status_code
        == 403
    )


def test_conversation_access_is_default_denied_and_grants_apply_immediately(client: TestClient) -> None:
    user = auth_login(client)
    assert not user["permissions"]["view_conversations"]
    for method, endpoint, body in [
        ("GET", "/api/conversations/unknown/messages", None),
        ("GET", "/api/conversations/status", None),
        ("GET", "/api/conversation/triggers", None),
        ("PUT", "/api/conversations/recording", {"enabled": False}),
        ("PUT", "/api/conversations/language", {"language": "nl"}),
        ("POST", "/api/conversation/triggers", {"action": "stop_all", "phrase": "hello"}),
        ("PUT", "/api/conversation/triggers/unknown", {"action": "stop_all", "phrase": "hello"}),
        ("DELETE", "/api/conversation/triggers/unknown", None),
    ]:
        assert client.request(method, endpoint, json=body, headers=headers(user)).status_code == 403
    client.app.state.db.execute(
        "UPDATE users SET permission_overrides=? WHERE id='100'", ('{"view_conversations":true}',)
    )
    assert client.get("/api/conversations/status").status_code == 200
    assert client.get("/api/conversation/triggers").status_code == 200
    client.app.state.db.execute("UPDATE users SET permission_overrides='{}' WHERE id='100'")
    assert client.get("/api/conversation/triggers").status_code == 403
    assert client.get("/api/auth/me").status_code == 200


@pytest.mark.parametrize("mode", ["word", "contains"])
def test_punctuation_is_ignored_in_trigger_phrases(mode: str) -> None:
    assert matches("Hallo, wereld! Doe. maar...", "hallo wereld", mode)
    assert matches("Hallo wereld", "hallo, wereld!", mode)
    assert not matches("Hallo wereld", "!!!", mode)
    assert not matches("Stoplicht", "stop", "word")


def test_vad_rejects_silence_and_bounds_partial_frames() -> None:
    value = Segmenter()
    for _ in range(100):
        assert not value.is_speech("speaker", bytes(100))
        assert len(value.vad_pending["speaker"]) < 640
    value.is_speech("other", bytes(640))
    assert value.detectors["speaker"] is not value.detectors["other"]


def test_disabling_recording_removes_history_and_preserves_triggers(client: TestClient) -> None:
    user = login(client)
    db = client.app.state.db
    db.execute("INSERT INTO conversations(id,channel_id,channel_name,started_at) VALUES ('history','123','Voice',1)")
    db.execute(
        "INSERT INTO conversation_messages(id,session_id,speaker_id,speaker_name,started_at,ended_at,text,language) "
        "VALUES ('text','history','100','Owner',1,2,'Hello','nl')"
    )
    response = client.put("/api/conversations/recording", json={"enabled": False}, headers=headers(user))
    assert response.status_code == 200
    assert not db.rows("SELECT * FROM conversations")
    assert not db.rows("SELECT * FROM conversation_messages")
    assert not client.app.state.conversation.enabled


def test_admin_model_switch_validation_and_persistence(client: TestClient) -> None:
    user = login(client)
    value = client.app.state.conversation
    value.synchronize_model = AsyncMock(return_value={"ready": True, "model": "large-v3-turbo", "target": None})

    async def selected(name: str) -> dict:
        client.app.state.db.set_setting("transcription_model", name)
        return {"ready": False, "model": "large-v3-turbo", "target": name}

    value.select_model = selected
    endpoint = "/api/admin/transcription"
    assert client.get(endpoint).status_code == 403
    assert client.put(endpoint, json={"model": "large-v3"}, headers=headers(user)).status_code == 403
    client.app.state.auth.admin_ids = {"100"}
    user = client.get("/api/auth/me").json()
    assert client.put(endpoint, json={"model": "invalid"}, headers=headers(user)).status_code == 422
    assert client.put(endpoint, json={"model": "large-v3"}, headers=headers(user)).status_code == 200
    assert client.app.state.db.setting("transcription_model") == "large-v3"
    value.synchronize_model.return_value = {"ready": False, "target": "large-v3"}
    assert client.put(endpoint, json={"model": "large-v3-turbo"}, headers=headers(user)).status_code == 409
    assert client.app.state.db.setting("transcription_model") == "large-v3"


def test_trigger_sound_action_unique_globally(client: TestClient) -> None:
    user = login(client)
    seed(client.app.state.db)
    csrf = headers(user)
    endpoint = "/api/conversation/triggers"
    body = {"clip_id": "sound", "phrase": "hello"}
    created = client.post(endpoint, json=body, headers=csrf)
    assert created.status_code == 201
    trigger_id = created.json()["id"]
    assert client.post(endpoint, json={**body, "phrase": "other", "enabled": False}, headers=csrf).status_code == 409
    assert (
        client.put(f"{endpoint}/{trigger_id}", json={**body, "phrase": "hello\nother"}, headers=csrf).status_code == 200
    )
    stop = {"action": "stop_all", "clip_id": "sound", "phrase": "stop"}
    stopped = client.post(endpoint, json=stop, headers=csrf)
    assert stopped.status_code == 201
    assert client.post(endpoint, json={**stop, "clip_id": "", "phrase": "enough"}, headers=csrf).status_code == 409
    assert client.put(f"{endpoint}/{stopped.json()['id']}", json=body, headers=csrf).status_code == 409
    client.app.state.db.execute(
        "INSERT INTO users(id,username,display_name,created_at,last_login) VALUES ('200','other','Other',1,1)"
    )
    client.app.state.db.execute("UPDATE conversation_triggers SET owner_id='200' WHERE id=?", (trigger_id,))
    assert client.post(endpoint, json=body, headers=csrf).status_code == 409
    assert client.put(f"{endpoint}/{trigger_id}", json={**body, "phrase": "changed"}, headers=csrf).status_code == 200


@pytest.mark.parametrize(
    ("endpoint", "permission"), [("actions", "view_actions"), ("conversation", "view_conversations")]
)
def test_trigger_user_picker_requires_page_access(client: TestClient, endpoint: str, permission: str) -> None:
    auth_login(client)
    client.app.state.bot.guild_members = AsyncMock(return_value=[{"id": "100", "name": "Owner", "avatar": None}])
    path = f"/api/{endpoint}/users"
    assert client.get(path).status_code == 403
    client.app.state.db.execute(
        "UPDATE users SET permission_overrides=? WHERE id='100'", (json.dumps({permission: True}),)
    )
    users = client.get(path)
    assert users.status_code == 200
    assert users.json()["items"][0]["id"] == "100"
    assert set(users.json()["items"][0]) == {"id", "name", "avatar"}


def test_trigger_playback_presence_and_immediate_outside_permission(tmp_path: Path) -> None:
    async def scenario() -> None:
        db = Database(tmp_path / "voice-permission.sqlite3")
        seed(db)
        value = manager(db)
        value.bot.voice.channel.members = []
        trigger = {"owner_id": "100", "action": "play"}
        authorization = value.playback.authorization
        assert await authorization(trigger, lambda: True, None) is not None
        db.execute("UPDATE users SET permission_overrides=? WHERE id='100'", ('{"play_outside_voice":true}',))
        assert await authorization(trigger, lambda: True, None) is None
        db.execute("UPDATE users SET permission_overrides='{}' WHERE id='100'")
        assert await authorization(trigger, lambda: True, None) is not None
        assert await authorization({**trigger, "action": "stop_all"}, lambda: True, None) is None
        db.close()

    asyncio.run(scenario())
