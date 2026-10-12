from __future__ import annotations

import asyncio
import json
import time
from types import SimpleNamespace
from typing import TYPE_CHECKING
from unittest.mock import AsyncMock, Mock

import pytest

from app.bot import GuildVoice
from app.config import Settings
from app.db import Database
from app.events import Events
from app.fun import SOUND_EFFECTS, FunSettings, KirbyGuard
from app.mixer import CapacityError, Mixer
from tests.test_actions import engine, event, rule
from tests.test_auth import client as auth_fixture
from tests.test_auth import headers, login
from tests.test_mixer import audio_file, clip
from tests.test_trigger_authorization import participant_setup

if TYPE_CHECKING:
    from collections.abc import Iterator
    from pathlib import Path

    from fastapi.testclient import TestClient


@pytest.fixture
def client(tmp_path: Path) -> Iterator[TestClient]:
    yield from auth_fixture.__wrapped__(tmp_path)


def test_trigger_credits_unregistered_participant(tmp_path: Path) -> None:
    async def scenario() -> None:
        value = engine(tmp_path)
        participant_setup(value.bot)
        await value.run(rule(value), event(value, actor="200"))
        for action in ("sound.play", "action_trigger.fire"):
            entry = value.db.one("SELECT * FROM audit WHERE action=?", (action,))
            assert entry["actor_id"] == "200"
            assert entry["actor_name"] == "Participant"
            assert json.loads(entry["details"])["creator_id"] == "100"
        assert not value.db.one("SELECT id FROM users WHERE id='200'")
        total = value.db.one("SELECT * FROM activity_totals WHERE actor_id='200'")
        assert total["name"] == "Participant"
        assert total["played"] == 1
        assert not value.db.one("SELECT * FROM activity_totals WHERE actor_id='100'")
        await value.close()
        value.db.close()

    asyncio.run(scenario())


def test_fun_settings_authorization_validation_and_persistence(client: TestClient) -> None:
    user = login(client)
    assert client.get("/api/admin/fun").status_code == 403
    client.app.state.auth.admin_ids.add("100")
    values = FunSettings(flashbang=True, vine_boom=True, dvd=True).model_dump()
    response = client.put("/api/admin/fun", headers=headers(user), json=values)
    assert response.status_code == 200
    assert response.json() == values
    assert client.app.state.db.setting("fun_settings") == values
    assert client.app.state.bot.state.fun_settings == values
    assert client.get("/api/admin/fun").json() == values
    assert client.put("/api/admin/fun", headers=headers(user), json={"dvd": "true"}).status_code == 422
    assert client.put("/api/admin/fun", headers=headers(user), json={"unknown": True}).status_code == 422
    assert client.app.state.db.one("SELECT actor_id FROM audit WHERE action='fun.update'")["actor_id"] == "100"


def test_protected_sound_ids_cannot_be_deleted(client: TestClient) -> None:
    user = login(client)
    db = client.app.state.db
    for identity in (*SOUND_EFFECTS, "impostor"):
        db.execute(
            "INSERT INTO clips(id,name,emoji,tags,start,end,volume,created_at,creator_id) VALUES (?,?,?,?,?,?,?,?,?)",
            (identity, "Flashbang", "", "[]", 0, 1, 1, 0, "100"),
        )
    for identity in SOUND_EFFECTS:
        assert client.delete(f"/api/clips/{identity}", headers=headers(user)).status_code == 403
        assert db.one("SELECT id FROM clips WHERE id=?", (identity,))
    rows = db.clips("100", "1352422295402057759")
    assert all(row["protected"] == (row["id"] in SOUND_EFFECTS) for row in rows)
    assert client.delete("/api/clips/impostor", headers=headers(user)).status_code == 200


def test_guest_leaderboard_uses_discord_identity(client: TestClient) -> None:
    login(client)
    client.app.state.db.audit("200", "sound.play", "guest-sound", "Sound", details={"speaker_name": "Guest Speaker"})
    rows = client.get("/api/audit/leaderboard").json()["leaderboard"]
    assert rows[0]["user_id"] == "200"
    assert rows[0]["name"] == "Guest Speaker"
    assert rows[0]["played"] == 1


@pytest.mark.parametrize("effect", ["flashbang", "patapim", "tung_sahur", "skibidi", "spion"])
@pytest.mark.parametrize("state", ["paused", "playing", "idle"])
@pytest.mark.parametrize("kind", ["enabled", "disabled", "same_name"])
def test_successful_playback_emits_only_bound_enabled_effect(
    tmp_path: Path, state: str, kind: str, effect: str
) -> None:
    async def scenario() -> None:
        db = Database(tmp_path / "playback.sqlite3")
        events = Events()
        queue = asyncio.Queue(maxsize=8)
        events.clients.add(queue)
        client = Mock()
        voice = client.get_guild.return_value.voice_client
        voice.is_connected.return_value = True
        voice.channel = SimpleNamespace(id=123, members=[SimpleNamespace(id=100, bot=False)])
        voice.is_paused.return_value = state == "paused"
        voice.is_playing.return_value = state == "playing"
        value = GuildVoice(Settings(_env_file=None, data_dir=tmp_path), db, events, client, 1352422295402057759)
        value.mixer = Mixer(on_change=lambda: None)
        value.fun_settings[effect] = kind != "disabled"
        sound = {
            **clip(),
            "id": next(key for key, value in SOUND_EFFECTS.items() if value == effect)
            if kind != "same_name"
            else "impostor",
            "name": "Flashbang",
        }
        instance = value.play(audio_file(tmp_path), sound)
        messages = []
        while not queue.empty():
            messages.append(queue.get_nowait())
        effects = [message for message in messages if "event: fun.play" in message]
        assert bool(effects) is (kind == "enabled")
        if effects:
            assert instance in effects[0]
            assert f'"effect": "{effect}"' in effects[0]
        value.mixer.cleanup()
        db.close()

    asyncio.run(scenario())


@pytest.mark.parametrize("case", ["eligible", "outside", "left", "moved", "disconnected", "disabled", "stale", "bot"])
def test_effect_delivery_is_limited_to_current_voice_participants(case: str) -> None:
    member = SimpleNamespace(id=100, bot=case == "bot")
    voice = Mock()
    voice.is_connected.return_value = case != "disconnected"
    voice.channel = SimpleNamespace(id=456 if case == "moved" else 123, members=[] if case == "left" else [member])
    state = SimpleNamespace(voice=voice, fun_settings={"flashbang": case != "disabled"})
    request = SimpleNamespace(
        app=SimpleNamespace(state=SimpleNamespace(bot=SimpleNamespace(state=state))),
        state=SimpleNamespace(user={"id": "200" if case == "outside" else "100"}),
    )
    data = {
        "effect": "flashbang",
        "instance_id": "instance",
        "channel_id": "123",
        "participants": ["100"],
        "emitted_at": time.monotonic() - (4 if case == "stale" else 0),
    }
    message = f"event: fun.play\ndata: {json.dumps(data)}\n\n"
    result = Events.for_viewer(message, request)
    assert bool(result) is (case == "eligible")
    if result:
        payload = json.loads(result.split("data: ")[1])
        assert 0 <= payload["elapsed_ms"] < 100
        assert "emitted_at" not in payload
        assert "participants" not in payload
    assert Events.for_viewer("event: fun.settings\ndata: {}\n\n", request) is not None


def test_effect_broadcast_reaches_two_independent_authenticated_streams() -> None:
    async def scenario() -> None:
        events = Events()
        voice = Mock()
        voice.channel = SimpleNamespace(id=123, members=[SimpleNamespace(id=value, bot=False) for value in (100, 200)])
        state = SimpleNamespace(voice=voice, fun_settings={"vine_boom": True})
        app = SimpleNamespace(
            state=SimpleNamespace(bot=SimpleNamespace(state=state), auth=SimpleNamespace(current=AsyncMock()))
        )
        requests = [
            SimpleNamespace(
                app=app, state=SimpleNamespace(user={"id": str(value)}), is_disconnected=AsyncMock(return_value=False)
            )
            for value in (100, 200, 300)
        ]
        streams = [events.stream(request) for request in requests]
        for stream in streams:
            assert "event: refresh" in await anext(stream)
        pending = [asyncio.create_task(anext(stream)) for stream in streams]
        await asyncio.sleep(0)
        events.publish(
            "fun.play",
            {
                "effect": "vine_boom",
                "instance_id": "shared",
                "channel_id": "123",
                "participants": ["100", "200"],
                "emitted_at": time.monotonic(),
            },
        )
        for task in pending[:2]:
            assert "shared" in await asyncio.wait_for(task, 1)
        events.publish("status")
        assert "event: status" in await asyncio.wait_for(pending[2], 1)
        for stream in streams:
            await stream.aclose()
        assert not events.clients

    asyncio.run(scenario())


@pytest.mark.parametrize("speed", [0, 6, "fast", True])
def test_dvd_speed_rejects_invalid_values(client: TestClient, speed: object) -> None:
    user = login(client)
    client.app.state.auth.admin_ids.add("100")
    assert client.put("/api/admin/fun", headers=headers(user), json={"dvd_speed": speed}).status_code == 422


def test_dvd_speed_and_sus_toggle_persist(client: TestClient) -> None:
    user = login(client)
    client.app.state.auth.admin_ids.add("100")
    response = client.put("/api/admin/fun", headers=headers(user), json={"sus": True, "dvd_speed": 2.5})
    assert response.status_code == 200
    assert client.get("/api/admin/fun").json()["dvd_speed"] == 2.5
    assert client.app.state.db.setting("fun_settings")["sus"] is True


def test_kirby_window_pause_and_account_isolation(monkeypatch: pytest.MonkeyPatch) -> None:
    guard = KirbyGuard()
    now = [100.0]
    monkeypatch.setattr("app.fun.time.monotonic", lambda: now[0])
    settings = FunSettings(kirby=True, kirby_threshold=3).model_dump()
    assert guard.attempt("100", settings) == (0, False)
    now[0] += 5
    assert guard.attempt("100", settings) == (0, False)
    assert guard.attempt("100", settings) == (0, False)
    assert guard.attempt("100", settings) == (5000, True)
    assert guard.attempt("200", settings) == (0, False)
    now[0] += 1
    assert guard.attempt("100", settings) == (4000, False)
    assert guard.remaining("100") == 4000
    now[0] += 4
    assert guard.attempt("100", settings) == (0, False)
    assert guard.remaining("100") == 0
    guard.clear()
    assert not guard.accounts


def test_kirby_bounded_buffers_expiry_and_disabled(monkeypatch: pytest.MonkeyPatch) -> None:
    guard = KirbyGuard()
    now = [100.0]
    monkeypatch.setattr("app.fun.time.monotonic", lambda: now[0])
    settings = FunSettings(kirby=True, kirby_threshold=100).model_dump()
    for _ in range(99):
        guard.attempt("100", settings)
    assert len(guard.accounts["100"].attempts) == 99
    assert guard.attempt("100", settings) == (5000, True)
    assert len(guard.accounts["100"].attempts) == 0
    now[0] += 61
    guard.attempt("200", settings)
    assert "100" not in guard.accounts
    assert guard.attempt("300", FunSettings().model_dump()) == (0, False)
    assert "300" not in guard.accounts


def test_kirby_delivery_is_account_targeted() -> None:
    guard = KirbyGuard()
    guard.attempt("100", FunSettings(kirby=True, kirby_threshold=1).model_dump())
    request = SimpleNamespace(
        app=SimpleNamespace(state=SimpleNamespace(bot=SimpleNamespace(state=SimpleNamespace(kirby=guard)))),
        state=SimpleNamespace(user={"id": "100"}),
    )
    message = 'event: fun.kirby\ndata: {"user_id":"100"}\n\n'
    result = Events.for_viewer(message, request)
    assert "remaining_ms" in result
    assert "user_id" not in result
    request.state.user["id"] = "200"
    assert Events.for_viewer(message, request) is None
    guard.clear()
    request.state.user["id"] = "100"
    assert Events.for_viewer(message, request) is None


@pytest.mark.parametrize(
    "changes",
    [
        {"kirby_threshold": 0},
        {"kirby_threshold": 101},
        {"kirby_threshold": True},
        {"kirby_window": 0},
        {"kirby_window": 61},
    ],
)
def test_kirby_settings_validation(client: TestClient, changes: dict) -> None:
    user = login(client)
    client.app.state.auth.admin_ids.add("100")
    assert client.put("/api/admin/fun", headers=headers(user), json=changes).status_code == 422


def test_manual_api_kirby_capacity_denials_and_reset(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    user = login(client)
    db = client.app.state.db
    db.execute(
        "INSERT INTO clips(id,name,emoji,tags,start,end,volume,created_at,creator_id) VALUES (?,?,?,?,?,?,?,?,?)",
        ("sound", "Sound", "", "[]", 0, 1, 1, 0, "100"),
    )
    state = client.app.state.bot.state
    monkeypatch.setattr(state, "status", Mock(return_value=state.status()))
    state.fun_settings = FunSettings(kirby=True, kirby_threshold=2).model_dump()
    voice = Mock()
    voice.is_connected.return_value = True
    voice.channel = SimpleNamespace(members=[SimpleNamespace(id=100)])
    monkeypatch.setattr(type(state), "voice", property(lambda _: voice))
    monkeypatch.setattr("app.main.voice_target", AsyncMock(return_value=state))
    playback = Mock(side_effect=CapacityError("All eight playback slots are occupied."))
    monkeypatch.setattr(state, "play", playback)
    endpoint = "/api/guilds/1352422295402057759/clips/sound/play"
    assert client.post(endpoint.replace("sound/play", "missing/play"), headers=headers(user)).status_code == 404
    assert not state.kirby.accounts
    voice.channel.members = []
    assert client.post(endpoint, headers=headers(user)).status_code == 403
    assert not state.kirby.accounts
    voice.channel.members = [SimpleNamespace(id=100)]
    assert client.post(endpoint, headers=headers(user)).status_code == 409
    response = client.post(endpoint, headers=headers(user))
    assert response.status_code == 409
    assert "Kirby" in response.json()["detail"]
    assert int(response.headers["X-Kirby-Remaining-Ms"]) > 0
    assert playback.call_count == 1
    assert client.post(endpoint, headers=headers(user)).status_code == 409
    assert playback.call_count == 1
    client.app.state.auth.member = AsyncMock(return_value=None)
    assert client.get("/api/state").json()["kirby_remaining_ms"] > 0
    client.app.state.auth.admin_ids.add("100")
    assert client.put("/api/admin/fun", json={"kirby": False}, headers=headers(user)).status_code == 200
    assert state.kirby.remaining("100") == 0
    assert client.post(endpoint, headers=headers(user)).status_code == 409
    assert playback.call_count == 2


def test_simultaneous_kirby_attempts_activate_once() -> None:
    async def scenario() -> None:
        guard = KirbyGuard()
        settings = FunSettings(kirby=True, kirby_threshold=20).model_dump()

        async def attempt() -> tuple[float, bool]:
            return guard.attempt("100", settings)

        values = await asyncio.gather(*(attempt() for _ in range(50)))
        assert sum(activated for _, activated in values) == 1
        assert sum(remaining == 0 for remaining, _ in values) == 19
        assert KirbyGuard().remaining("100") == 0

    asyncio.run(scenario())


def test_kirby_broadcast_reaches_only_target_account_devices() -> None:
    async def scenario() -> None:
        events = Events()
        guard = KirbyGuard()
        guard.attempt("100", FunSettings(kirby=True, kirby_threshold=1).model_dump())
        app = SimpleNamespace(
            state=SimpleNamespace(
                bot=SimpleNamespace(state=SimpleNamespace(kirby=guard)), auth=SimpleNamespace(current=AsyncMock())
            )
        )
        requests = [
            SimpleNamespace(
                app=app, state=SimpleNamespace(user={"id": identity}), is_disconnected=AsyncMock(return_value=False)
            )
            for identity in ("100", "100", "200")
        ]
        streams = [events.stream(request) for request in requests]
        for stream in streams:
            await anext(stream)
        pending = [asyncio.create_task(anext(stream)) for stream in streams]
        await asyncio.sleep(0)
        events.publish("fun.kirby", {"user_id": "100"})
        for task in pending[:2]:
            assert "remaining_ms" in await asyncio.wait_for(task, 1)
        events.publish("status")
        assert "event: status" in await asyncio.wait_for(pending[2], 1)
        for stream in streams:
            await stream.aclose()
        assert not events.clients

    asyncio.run(scenario())


def test_kirby_account_capacity_is_bounded(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("app.fun.MAX_KIRBY_ACCOUNTS", 1)
    guard = KirbyGuard()
    settings = FunSettings(kirby=True).model_dump()
    guard.attempt("100", settings)
    with pytest.raises(OverflowError):
        guard.attempt("200", settings)
    assert len(guard.accounts) == 1


def test_goose_message_admin_validation_and_broadcast(client: TestClient) -> None:
    user = login(client)
    route = "/api/admin/goose/message"
    assert client.post(route, headers=headers(user), json={"text": "Hello"}).status_code == 403
    client.app.state.auth.admin_ids.add("100")
    publish = Mock()
    client.app.state.events.publish = publish
    for text in ("", "   ", "x" * 31, 42):
        assert client.post(route, headers=headers(user), json={"text": text}).status_code == 422
    assert client.post(route, json={"text": "Hello"}).status_code == 403
    assert not publish.called
    assert client.post(route, headers=headers(user), json={"text": "  Hello Goose  "}).json() == {"sent": True}
    event, payload = publish.call_args.args
    assert event == "fun.goose"
    assert payload["text"] == "Hello Goose"
    assert len(payload["instance_id"]) == 32
    message = f"event: {event}\ndata: {json.dumps(payload)}\n\n"
    for identity in ("100", "200"):
        request = SimpleNamespace(state=SimpleNamespace(user={"id": identity}))
        delivered = Events.for_viewer(message, request)
        data = json.loads(delivered.split("data: ", 1)[1])
        assert data["text"] == "Hello Goose"
        assert 0 < data["remaining_ms"] <= 5000
        assert "emitted_at" not in data
    payload["emitted_at"] = time.monotonic() - 4
    assert Events.for_viewer(f"event: {event}\ndata: {json.dumps(payload)}\n\n", request) is None


@pytest.mark.parametrize(("action", "duration"), [("raid", 10000), ("draw", 30000), ("deliver", 12000)])
def test_goose_actions_are_admin_only_and_broadcast(client: TestClient, action: str, duration: int) -> None:
    user = login(client)
    body = {"action": action, "sketch": "shrek", "text": "Hello"}
    assert client.post("/api/admin/goose/action", headers=headers(user), json=body).status_code == 403
    client.app.state.auth.admin_ids.add("100")
    publish = Mock()
    client.app.state.events.publish = publish
    assert client.post("/api/admin/goose/action", headers=headers(user), json=body).status_code == 200
    event, payload = publish.call_args.args
    delivered = Events.goose_for_viewer(f"event: {event}\ndata: {json.dumps(payload)}\n\n")
    data = json.loads(delivered.split("data: ", 1)[1])
    assert data["action"] == action
    assert data["sketch"] == "shrek"
    assert duration - 1000 <= data["remaining_ms"] <= duration
    for invalid in (
        {"action": "unknown"},
        {"action": "draw", "sketch": "unknown"},
        {"action": "deliver", "text": " "},
        {"action": "deliver", "text": "x" * 31},
    ):
        assert client.post("/api/admin/goose/action", headers=headers(user), json=invalid).status_code == 422
