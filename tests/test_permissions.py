from __future__ import annotations

import json
import time
from types import SimpleNamespace
from typing import TYPE_CHECKING
from unittest.mock import AsyncMock, Mock

import pytest

from app.db import Database
from app.permissions import DEFAULTS
from tests.test_auth import GUILD, headers, login
from tests.test_auth import client as auth_fixture
from tests.test_conversation import seed

if TYPE_CHECKING:
    from collections.abc import Iterator
    from pathlib import Path

    from fastapi.testclient import TestClient


@pytest.fixture
def client(tmp_path: Path) -> Iterator[TestClient]:
    yield from auth_fixture.__wrapped__(tmp_path)


def add_user(client: TestClient, user_id: str = "200") -> None:
    client.app.state.db.execute(
        "INSERT OR IGNORE INTO users(id,username,display_name,created_at,last_login) VALUES (?,?,?,?,?)",
        (user_id, "other", "Other Member", time.time(), time.time()),
    )


def override(client: TestClient, values: dict, user_id: str = "100") -> None:
    client.app.state.db.execute("UPDATE users SET permission_overrides=? WHERE id=?", (json.dumps(values), user_id))


@pytest.mark.parametrize(
    ("permission", "method", "path", "body"),
    [
        ("play_sounds", "POST", f"/api/guilds/{GUILD}/clips/clip/play", None),
        ("stop_sounds", "POST", f"/api/guilds/{GUILD}/playbacks/stop", None),
        ("stop_sounds", "DELETE", f"/api/guilds/{GUILD}/playbacks/instance", None),
        ("connect_voice", "POST", f"/api/guilds/{GUILD}/voice/connect", {"channel_id": "123"}),
        ("disconnect_voice", "POST", f"/api/guilds/{GUILD}/voice/disconnect", None),
        ("master_volume", "PUT", f"/api/guilds/{GUILD}/voice/volume", {"volume": 0.5}),
        ("mute_deafen", "PUT", f"/api/guilds/{GUILD}/voice/state", {"muted": True, "deafened": True}),
        ("create_sounds", "POST", "/api/clips/upload?filename=sound.mp3&metadata=%7B%22name%22:%22Sound%22%7D", None),
        ("create_sounds", "POST", "/api/clips", {"name": "Sound", "source_id": "source", "start": 0, "end": 1}),
        ("import_videos", "POST", "/api/imports", {"url": "https://example.com/video"}),
        ("import_videos", "POST", "/api/sources/source/refresh", None),
        ("import_videos", "POST", "/api/imports/job/retry", None),
        ("manage_imports", "POST", "/api/imports/job/retry", None),
        ("manage_imports", "DELETE", "/api/imports/job", None),
        ("import_channels", "POST", "/api/channel-imports", {"url": "https://www.youtube.com/@kud/videos"}),
        ("manage_imports", "POST", "/api/channel-imports/batch/pause", None),
        ("manage_imports", "POST", "/api/channel-imports/batch/ignore", None),
        ("manage_imports", "POST", "/api/channel-imports/batch/resume", None),
        ("import_channels", "POST", "/api/channel-imports/batch/resume", None),
        ("delete_videos", "DELETE", "/api/sources/source", None),
        ("view_audit", "GET", "/api/audit", None),
        ("view_audit", "GET", "/api/audit/options", None),
        ("view_audit", "GET", "/api/audit/activity?after=1700000000&until=1700003600", None),
    ],
)
def test_direct_requests_enforce_permissions(
    client: TestClient, permission: str, method: str, path: str, body: dict | None
) -> None:
    user = login(client)
    override(client, {permission: False})
    response = client.request(method, path, json=body, headers=headers(user))
    assert response.status_code == 403
    assert "permission" in response.json()["detail"]
    assert client.get("/api/auth/me").status_code == 200
    assert client.get("/api/playback").status_code == 200
    assert client.get("/api/settings/personal").status_code == 200


def test_own_all_and_unattributed_sound_rules(client: TestClient) -> None:
    user = login(client)
    add_user(client)
    db = client.app.state.db
    db.execute(
        "INSERT INTO sources(id,url,title,duration,created_at) VALUES (?,?,?,?,?)",
        ("source", "https://example.com/video", "Video", 10, time.time()),
    )
    for clip_id, creator in (("own", "100"), ("other", "200"), ("legacy", None)):
        db.execute(
            "INSERT INTO clips(id,source_id,name,emoji,tags,start,end,volume,created_at,creator_id) "
            "VALUES (?,?,?,?,?,?,?,?,?,?)",
            (clip_id, "source", clip_id, "", "[]", 0, 1, 1, time.time(), creator),
        )
    override(client, {"edit_all_sounds": False, "delete_all_sounds": False})
    assert client.patch("/api/clips/own", json={"name": "Updated"}, headers=headers(user)).status_code == 200
    for clip_id in ("other", "legacy"):
        assert client.patch(f"/api/clips/{clip_id}", json={"name": "Changed"}, headers=headers(user)).status_code == 403
        assert client.delete(f"/api/clips/{clip_id}", headers=headers(user)).status_code == 403
    override(client, {"edit_all_sounds": False, "edit_own_sounds": False})
    assert client.patch("/api/clips/own", json={"name": "Changed"}, headers=headers(user)).status_code == 403
    override(client, {"edit_own_sounds": False})
    assert client.patch("/api/clips/own", json={"name": "All allowed"}, headers=headers(user)).status_code == 200
    assert client.patch("/api/clips/legacy", json={"name": "Legacy allowed"}, headers=headers(user)).status_code == 200
    override(client, {"delete_all_sounds": False})
    assert client.delete("/api/clips/own", headers=headers(user)).status_code == 200
    assert client.delete("/api/clips/missing", headers=headers(user)).status_code == 404


def test_admin_permissions_validation_search_protection_and_audit(client: TestClient) -> None:
    user = login(client)
    assert user["permissions"] == DEFAULTS
    assert not user["permissions"]["master_volume"]
    assert not user["permissions"]["mute_deafen"]
    assert client.get("/api/admin/users").status_code == 403
    assert client.get("/api/admin/permissions").status_code == 403
    add_user(client)
    client.app.state.auth.admin_ids.add("100")
    assert all(client.get("/api/auth/me").json()["permissions"].values())
    endpoint = "/api/admin/users/200/permissions"
    for invalid in ({"unknown": True}, {"play_sounds": "false"}, {"play_sounds": 1}):
        assert client.put(endpoint, json={"overrides": invalid}, headers=headers(user)).status_code == 422
    assert client.put(endpoint, json={"overrides": {}, "admin": True}, headers=headers(user)).status_code == 422
    assert (
        client.put(
            "/api/admin/users/100/permissions", json={"overrides": {"admin": False}}, headers=headers(user)
        ).status_code
        == 409
    )
    assert client.delete("/api/admin/users/missing/permissions", headers=headers(user)).status_code == 404
    client.app.state.events.publish = Mock()
    response = client.put(
        endpoint, json={"overrides": {"mute_deafen": True, "play_sounds": False}}, headers=headers(user)
    )
    assert response.status_code == 200
    client.app.state.events.publish.assert_called_once_with("permissions", {"user_id": "200"})
    assert response.json()["permissions"]["mute_deafen"]
    assert not response.json()["permissions"]["play_sounds"]
    assert client.get("/api/admin/users?q=Other").json()["total"] == 1
    assert client.get("/api/admin/users?q=' OR 1=1 --").json()["total"] == 0
    assert client.get("/api/admin/users?page_size=51").status_code == 422
    result = client.get("/api/audit?action=permissions.update").json()["results"][0]
    assert result["actor_id"] == "100"
    assert result["resource_id"] == "200"
    assert len(result["details"]["permission_changes"]) == 2
    assert client.delete(endpoint, headers=headers(user)).json()["permissions"] == DEFAULTS
    assert client.get("/api/audit?action=permissions.reset").json()["total"] == 1


def test_grant_and_revoke_affect_existing_session_without_admin_access(client: TestClient) -> None:
    member = login(client)
    member_cookie = client.cookies.get("session")
    client.cookies.delete("session")
    auth = client.app.state.auth
    auth.admin_ids.add("200")
    auth.discord_request.return_value = {"id": "200", "username": "owner", "global_name": "Owner", "avatar": None}
    admin = login(client)
    endpoint = "/api/admin/users/100/permissions"
    assert client.put(endpoint, json={"overrides": {"mute_deafen": True}}, headers=headers(admin)).status_code == 200
    member_headers = {**headers(member), "Cookie": f"session={member_cookie}"}
    profile = client.get("/api/auth/me", headers=member_headers).json()
    assert profile["permissions"]["mute_deafen"]
    assert not profile["admin"]
    assert client.get("/api/admin/logs", headers=member_headers).status_code == 403
    assert client.get("/api/admin/users", headers=member_headers).status_code == 403
    bot = client.app.state.bot
    channel = Mock(id=123)
    channel.name = "Test"
    channel.members = []
    guild = Mock(voice_client=Mock(channel=channel, disconnect=AsyncMock()))
    bot.client.is_ready = lambda: True
    bot.client.get_guild = lambda _: guild
    bot.channels = Mock(return_value=[{"id": "123"}])
    auth.member = AsyncMock(return_value=Mock(guild=guild))
    bot.state.flags = AsyncMock()
    voice = f"/api/guilds/{GUILD}/voice/state"
    assert client.put(voice, json={"muted": True, "deafened": True}, headers=member_headers).status_code == 200
    bot.state.flags.assert_awaited_once()
    client.delete(endpoint, headers=headers(admin))
    assert client.put(voice, json={"muted": True, "deafened": True}, headers=member_headers).status_code == 403
    assert bot.state.flags.await_count == 1
    bot.client.get_guild = lambda _: None


def test_permission_defaults_and_persistence(client: TestClient) -> None:
    login(client)
    override(client, {"view_audit": False})
    assert not client.get("/api/auth/me").json()["permissions"]["view_audit"]
    client.app.state.db.conn.commit()
    assert json.loads(
        client.app.state.db.one("SELECT permission_overrides FROM users WHERE id='100'")["permission_overrides"]
    ) == {"view_audit": False}


def test_reopened_permissions_and_existing_accounts(tmp_path: Path) -> None:
    path = tmp_path / "legacy.sqlite3"
    db = Database(path)
    db.execute(
        "INSERT INTO users(id,username,display_name,created_at,last_login,preferences) VALUES (?,?,?,?,?,?)",
        ("100", "tester", "Test User", 1, 1, '{"preview_volume":0.3}'),
    )
    db.execute(
        "INSERT INTO sessions(id,user_id,csrf,credentials,expires_at,last_seen) VALUES (?,?,?,?,?,?)",
        ("session", "100", "csrf", "encrypted", time.time() + 3600, 1),
    )
    db.execute(
        "INSERT INTO sources(id,url,title,duration,created_at) VALUES (?,?,?,?,?)",
        ("s", "https://example.com", "Video", 10, 1),
    )
    db.execute(
        "INSERT INTO clips(id,source_id,name,emoji,tags,start,end,volume,created_at) VALUES (?,?,?,?,?,?,?,?,?)",
        ("clip", "s", "Sound", "", "[]", 0, 1, 1, 1),
    )
    db.execute(
        "INSERT INTO jobs(id,url,status,created_at) VALUES (?,?,?,?)", ("job", "https://example.com", "running", 1)
    )
    tables = {
        "users": "SELECT * FROM users",
        "sessions": "SELECT * FROM sessions",
        "sources": "SELECT * FROM sources",
        "clips": "SELECT * FROM clips",
        "jobs": "SELECT * FROM jobs",
    }
    before = {table: db.rows(query) for table, query in tables.items()}
    before["users"][0].pop("permission_overrides")
    db.close()
    db = Database(path)
    user = db.one("SELECT * FROM users WHERE id='100'")
    assert user.pop("permission_overrides") == "{}"
    assert user == before["users"][0]
    for table, query in tables.items():
        if table != "users":
            assert db.rows(query) == before[table]
    db.execute("UPDATE users SET permission_overrides=? WHERE id='100'", ('{"play_sounds":false,"mute_deafen":true}',))
    db.close()
    db = Database(path)
    saved = json.loads(db.one("SELECT permission_overrides FROM users WHERE id='100'")["permission_overrides"])
    assert saved == {"play_sounds": False, "mute_deafen": True}
    db.close()


def test_admin_user_pagination(client: TestClient) -> None:
    login(client)
    client.app.state.auth.admin_ids.add("100")
    for user_id in range(200, 250):
        add_user(client, str(user_id))
    first = client.get("/api/admin/users").json()
    second = client.get("/api/admin/users?page=2").json()
    assert first["total"] == second["total"] == 51
    assert len(first["users"]) == 50
    assert len(second["users"]) == 1
    assert not {user["id"] for user in first["users"]} & {user["id"] for user in second["users"]}


def test_delegated_admin_and_protected_self_permissions(client: TestClient) -> None:
    user = login(client)
    override(client, {"admin": True, "play_sounds": False})
    profile = client.get("/api/auth/me").json()
    assert profile["admin"]
    assert not profile["protected_admin"]
    assert not profile["permissions"]["play_sounds"]
    assert not profile["permissions"]["high_volume"]
    assert client.get("/api/admin/permissions").status_code == 200
    assert client.post(f"/api/guilds/{GUILD}/clips/clip/play", headers=headers(user)).status_code == 403
    add_user(client)
    client.app.state.auth.admin_ids.add("200")
    target = "/api/admin/users/200/permissions"
    assert client.put(target, json={"overrides": {"play_sounds": False}}, headers=headers(user)).status_code == 403
    assert client.delete(target, headers=headers(user)).status_code == 403
    client.app.state.auth.admin_ids.add("100")
    target = "/api/admin/users/100/permissions"
    result = client.put(target, json={"overrides": {"play_sounds": False}}, headers=headers(user))
    assert result.status_code == 200
    assert result.json()["permissions"]["admin"]
    assert not client.get("/api/auth/me").json()["permissions"]["play_sounds"]
    assert client.put(target, json={"overrides": {"admin": False}}, headers=headers(user)).status_code == 409
    assert all(client.delete(target, headers=headers(user)).json()["permissions"].values())
    client.app.state.auth.admin_ids.remove("100")
    assert client.get("/api/admin/permissions").status_code == 403


@pytest.mark.parametrize("volume", [3.05, 10])
def test_boost_volume_permission_on_all_writes(client: TestClient, volume: float) -> None:
    user = login(client)
    db = client.app.state.db
    db.execute(
        "INSERT INTO sources(id,url,title,duration,created_at) VALUES (?,?,?,?,?)",
        ("source", "https://example.com", "Source", 10, 1),
    )
    db.execute(
        "INSERT INTO clips(id,source_id,name,emoji,tags,start,end,volume,created_at,creator_id) "
        "VALUES (?,?,?,?,?,?,?,?,?,?)",
        ("sound", "source", "Sound", "", "[]", 0, 1, 1, 1, "100"),
    )
    payload = {"name": "Sound", "volume": volume}
    extraction = {**payload, "source_id": "source", "start": 0, "end": 1}
    metadata = {"filename": "sound.mp3", "metadata": json.dumps(payload)}
    assert client.patch("/api/clips/sound", json=payload, headers=headers(user)).status_code == 403
    assert client.post("/api/clips", json=extraction, headers=headers(user)).status_code == 403
    assert client.post("/api/clips/upload", params=metadata, content=b"audio", headers=headers(user)).status_code == 403
    override(client, {"high_volume": True})
    media = client.app.state.media
    media.create_clip = AsyncMock(return_value="created")
    media.upload_clip = AsyncMock(return_value="uploaded")
    assert client.patch("/api/clips/sound", json=payload, headers=headers(user)).status_code == 200
    assert db.one("SELECT volume FROM clips WHERE id='sound'")["volume"] == volume
    assert client.post("/api/clips", json=extraction, headers=headers(user)).status_code == 201
    assert client.post("/api/clips/upload", params=metadata, content=b"audio", headers=headers(user)).status_code == 201
    assert client.patch("/api/clips/sound", json={**payload, "volume": 10.05}, headers=headers(user)).status_code == 422
    override(client, {})
    assert client.patch("/api/clips/sound", json=payload, headers=headers(user)).status_code == 403


@pytest.mark.parametrize(
    "scenario",
    [(False, False, True, 403), (True, False, True, 201), (False, True, True, 201), (False, True, False, 403)],
)
def test_playback_requires_voice_presence_or_explicit_permission(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, scenario: tuple[bool, bool, bool, int]
) -> None:
    present, outside, play, status = scenario
    user = login(client)
    seed(client.app.state.db)
    override(client, {"play_outside_voice": outside, "play_sounds": play})
    channel = SimpleNamespace(members=[SimpleNamespace(id=100)] if present else [])
    state = SimpleNamespace(voice=SimpleNamespace(channel=channel), play=Mock(return_value="instance"), status=dict)
    monkeypatch.setattr("app.main.voice_target", AsyncMock(return_value=state))
    response = client.post(f"/api/guilds/{GUILD}/clips/sound/play", headers=headers(user))
    assert response.status_code == status
    assert state.play.call_count == int(status == 201)
    assert client.get("/api/auth/me").status_code == 200
    assert not DEFAULTS["play_outside_voice"]
