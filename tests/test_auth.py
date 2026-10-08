from __future__ import annotations

import asyncio
import json
import time
from types import SimpleNamespace
from typing import TYPE_CHECKING
from unittest.mock import AsyncMock, Mock
from urllib.parse import parse_qs, urlsplit

import pytest
from cryptography.fernet import Fernet
from fastapi import HTTPException, Request
from fastapi.testclient import TestClient
from pydantic import SecretStr

from app.auth import Auth, digest
from app.config import Settings
from app.main import create_app

if TYPE_CHECKING:
    from collections.abc import Iterator
    from pathlib import Path

GUILD = "1352422295402057759"
ORIGIN = "http://127.0.0.2:8687"


@pytest.fixture
def client(tmp_path: Path) -> Iterator[TestClient]:
    settings = Settings(
        _env_file=None,
        discord_token=SecretStr(""),
        discord_client_secret=SecretStr("test-oauth-private"),
        auth_encryption_key=SecretStr(Fernet.generate_key().decode()),
        data_dir=tmp_path,
    )
    with TestClient(create_app(settings), base_url=ORIGIN) as browser:
        auth = browser.app.state.auth
        auth.exchange = AsyncMock(
            return_value={
                "access_token": "test-access-private",
                "refresh_token": "test-refresh-private",
                "expires_in": 3600,
            }
        )
        auth.discord_request = AsyncMock(
            return_value={"id": "100", "username": "tester", "global_name": "Test User", "avatar": None}
        )
        auth.shared_guilds = AsyncMock(return_value=[{"id": GUILD, "name": "Shared server"}])
        yield browser


def begin(client: TestClient, destination: str = "/videos/fixture/cut?t=2") -> str:
    response = client.get("/api/auth/discord/login", params={"next": destination}, follow_redirects=False)
    assert response.status_code == 302
    params = parse_qs(urlsplit(response.headers["location"]).query)
    assert params["client_id"] == ["1502044170406199416"]
    assert params["redirect_uri"] == [ORIGIN + "/api/auth/discord/callback"]
    assert params["scope"] == ["identify guilds guilds.members.read"]
    assert "httponly" in response.headers["set-cookie"].lower()
    return params["state"][0]


def login(client: TestClient) -> dict:
    state = begin(client)
    response = client.get(
        "/api/auth/discord/callback", params={"state": state, "code": "test-code"}, follow_redirects=False
    )
    assert response.status_code == 302
    assert response.headers["location"] == "/videos/fixture/cut?t=2"
    return client.get("/api/auth/me").json()


def headers(user: dict) -> dict:
    return {"Origin": ORIGIN, "X-CSRF-Token": user["csrf"]}


def test_login_persists_profile_and_encrypts_tokens(client: TestClient) -> None:
    user = login(client)
    assert user["display_name"] == "Test User"
    assert not user["admin"]
    db = client.app.state.db
    session = db.one("SELECT * FROM sessions")
    assert session["id"] != client.cookies.get("session")
    assert session["id"] == digest(client.cookies.get("session"))
    assert "test-access-private" not in session["credentials"]
    assert "test-refresh-private" not in session["credentials"]
    assert (
        client.app.state.auth.unseal(session["credentials"])["access_token"]
        == client.app.state.auth.exchange.return_value["access_token"]
    )
    assert db.one("SELECT * FROM users")["id"] == "100"
    for secret in ("test-oauth-private", "test-access-private", "test-refresh-private"):
        assert secret not in json.dumps(user)
    client.app.state.auth.member = AsyncMock(return_value=None)
    assert client.get("/api/state").status_code == 200
    assert client.get("/api/state?guild_id=999").status_code == 403


def test_oauth_state_replay_mismatch_expiry_and_safe_redirect(client: TestClient) -> None:
    state = begin(client, "//evil.example/path")
    callback = "/api/auth/discord/callback?code=test-code&state=" + state
    assert client.get(callback, follow_redirects=False).headers["location"] == "/soundboard"
    assert client.get(callback, follow_redirects=False).status_code == 400
    state = begin(client)
    client.cookies.delete("oauth_browser")
    assert client.get("/api/auth/discord/callback", params={"state": state, "code": "test-code"}).status_code == 400
    state = begin(client)
    client.app.state.db.execute("UPDATE oauth_states SET expires_at=0")
    assert client.get("/api/auth/discord/callback", params={"state": state, "code": "test-code"}).status_code == 400


def test_denied_and_ineligible_login_does_not_create_account(client: TestClient) -> None:
    state = begin(client)
    response = client.get(
        "/api/auth/discord/callback", params={"state": state, "error": "access_denied"}, follow_redirects=False
    )
    assert response.headers["location"] == "/login?error=cancelled"
    client.app.state.auth.shared_guilds.return_value = []
    state = begin(client)
    response = client.get(
        "/api/auth/discord/callback", params={"state": state, "code": "test-code"}, follow_redirects=False
    )
    assert response.headers["location"] == "/login?error=ineligible"
    assert client.app.state.db.rows("SELECT * FROM users") == []


def test_private_endpoints_and_csrf(client: TestClient) -> None:
    for endpoint in (
        "/api/state",
        "/api/playback",
        "/api/media/fixture/video.mp4",
        "/api/events",
        "/api/audit",
        "/api/settings/personal",
    ):
        assert client.get(endpoint).status_code == 401
    assert client.get("/api/health").json() == {"ok": True, "application": "geluidsman"}
    user = login(client)
    body = {"preview_volume": 0.4, "caption_language": "nl"}
    assert client.put("/api/settings/personal", json=body).status_code == 403
    assert "default_guild_id" not in client.get("/api/settings/personal").json()
    assert client.get("/api/settings/app").status_code == 403
    assert client.put("/api/settings/app", json={}, headers=headers(user)).status_code == 403


def test_refresh_membership_loss_and_transient_failure(client: TestClient) -> None:
    login(client)
    auth, db = client.app.state.auth, client.app.state.db
    session = db.one("SELECT * FROM sessions")
    credentials = auth.unseal(session["credentials"])
    credentials["expires_at"] = 0
    db.execute("UPDATE sessions SET credentials=?,checked_at=0", (auth.seal(credentials),))
    assert client.get("/api/auth/me").status_code == 200
    assert auth.exchange.call_count == 2
    auth.shared_guilds.side_effect = HTTPException(503, "Discord unavailable")
    db.execute("UPDATE sessions SET checked_at=0")
    assert client.get("/api/auth/me").status_code == 503
    assert db.one("SELECT id FROM sessions") is not None
    auth.shared_guilds.side_effect = None
    auth.shared_guilds.return_value = []
    assert client.get("/api/auth/me").status_code == 403
    assert db.rows("SELECT * FROM sessions") == []
    assert db.one("SELECT id FROM users") is not None


@pytest.mark.parametrize("column", ["expires_at", "last_seen"])
def test_session_expiry(client: TestClient, column: str) -> None:
    login(client)
    sql = "UPDATE sessions SET expires_at=0" if column == "expires_at" else "UPDATE sessions SET last_seen=0"
    client.app.state.db.execute(sql)
    assert client.get("/api/auth/me").status_code == 401


def test_logout_current_and_all_sessions(client: TestClient) -> None:
    first = login(client)
    saved = client.cookies.get("session")
    client.cookies.delete("session")
    second = login(client)
    assert len(client.app.state.db.rows("SELECT id FROM sessions")) == 2
    assert client.post("/api/auth/logout", headers=headers(second), follow_redirects=False).status_code == 303
    assert len(client.app.state.db.rows("SELECT id FROM sessions")) == 1
    client.cookies.set("session", saved)
    assert client.post("/api/auth/logout-all", headers=headers(first), follow_redirects=False).status_code == 303
    assert client.app.state.db.rows("SELECT id FROM sessions") == []


def test_only_configured_admins_are_allowed(client: TestClient) -> None:
    auth = client.app.state.auth
    bot = client.app.state.bot
    bot.client.is_ready = lambda: True
    bot.client.application_info = AsyncMock(return_value=Mock(team=None, owner=Mock(id=100)))
    user = login(client)
    assert not user["admin"]
    assert (
        client.put(
            f"/api/guilds/{GUILD}/voice/state", json={"muted": True, "deafened": True}, headers=headers(user)
        ).status_code
        == 403
    )
    assert client.get("/api/admin/logs").status_code == 403
    assert client.get("/api/settings/app").status_code == 403
    bot.client.application_info.assert_not_awaited()
    auth.admin_ids.add("100")
    assert client.get("/api/auth/me").json()["admin"]
    assert client.get("/api/admin/logs").status_code == 200


def test_target_membership_and_private_channel_checks(client: TestClient) -> None:
    user = login(client)
    bot = client.app.state.bot
    bot.client.is_ready = lambda: True
    auth = client.app.state.auth
    auth.member = AsyncMock(side_effect=HTTPException(403, "Not a member"))
    url = f"/api/guilds/{GUILD}/voice/connect"
    assert client.post(url, json={"channel_id": "123"}, headers=headers(user)).status_code == 403
    channel = Mock(id=123)
    guild = Mock(voice_client=None)
    guild.get_channel.return_value = channel
    member = Mock(guild=guild)
    auth.member.side_effect = None
    auth.member.return_value = member
    bot.channels = Mock(return_value=[])
    bot.client.get_guild = lambda _: guild
    state = bot.guild_state(int(GUILD))
    state.connect = AsyncMock()
    assert client.post(url, json={"channel_id": "123"}, headers=headers(user)).status_code == 403
    state.connect.assert_not_called()
    bot.channels.return_value = [{"id": "123", "name": "Allowed"}]
    assert client.post(url, json={"channel_id": "123"}, headers=headers(user)).status_code == 200
    state.connect.assert_awaited_once_with("123")


def test_app_settings_audit_filters_retention_and_snapshot(client: TestClient) -> None:
    user = login(client)
    client.app.state.auth.admin_ids.add(user["id"])
    settings = client.get("/api/settings/app").json()["settings"]
    settings["max_source_seconds"] = 12
    assert client.put("/api/settings/app", json=settings, headers=headers(user)).status_code == 200
    media, db = client.app.state.media, client.app.state.db
    assert media.settings.max_source_seconds == 12
    snapshot = media.settings
    settings["max_source_seconds"] = 24
    assert client.put("/api/settings/app", json=settings, headers=headers(user)).status_code == 200
    assert snapshot.max_source_seconds == 12
    assert media.settings.max_source_seconds == 24
    db.audit(user["id"], "sound.create", "deleted-clip", "Remember me")
    db.audit(user["id"], "sound.play", "deleted-clip", "Remember me", guild_id=GUILD)
    db.execute("UPDATE audit SET timestamp=0 WHERE action='sound.create'")
    rows = client.get(
        "/api/audit",
        params={"actor_id": user["id"], "action": "sound.play", "resource_id": "deleted-clip", "guild_id": GUILD},
    ).json()["results"]
    assert rows[0]["resource_name"] == "Remember me"
    assert rows[0]["actor_name"] == "Test User"
    assert db.one("SELECT id FROM audit WHERE action='sound.create'") is None
    first = client.get("/api/audit?limit=1").json()
    assert first["next_cursor"] is not None
    assert (
        client.get(f"/api/audit?limit=1&before={first['next_cursor']}").json()["results"][0]["id"]
        < first["results"][0]["id"]
    )
    assert client.get("/api/audit", params={"action": "' OR 1=1 --"}).json()["results"] == []


def test_fail_closed_without_configuration(tmp_path: Path) -> None:
    with TestClient(create_app(Settings(_env_file=None, discord_token=SecretStr(""), data_dir=tmp_path))) as client:
        assert client.get("/api/state").status_code == 503
        assert client.get("/api/auth/discord/login").status_code == 503


def test_audit_options_are_private_named_and_keep_deleted_sound_emoji(client: TestClient) -> None:
    assert client.get("/api/audit/options").status_code == 401
    login(client)
    db = client.app.state.db
    db.execute(
        "INSERT INTO sources(id,url,title,duration,created_at) VALUES (?,?,?,?,?)",
        ("source", "https://example.com/video", "Source title", 10, time.time()),
    )
    db.execute(
        "INSERT INTO clips(id,source_id,name,emoji,tags,start,end,volume,created_at,creator_id) "
        "VALUES (?,?,?,?,?,?,?,?,?,?)",
        ("clip", "source", "Funny sound", "😂", "[]", 0, 1, 1, time.time(), "100"),
    )
    db.audit("100", "sound.create", "clip", "Funny sound", guild_id=GUILD)
    db.set_setting(f"guild:{GUILD}:name", "Friendly server")
    options = client.get("/api/audit/options").json()
    assert options["users"] == [{"id": "100", "name": "Test User", "avatar": None}]
    assert {"id": "clip", "name": "Funny sound", "emoji": "😂"} in options["resources"]
    assert "guilds" not in options
    db.change("DELETE FROM clips WHERE id=?", ("clip",), "100", "sound.delete", resource_id="clip", name="Funny sound")
    assert {"id": "clip", "name": "Funny sound", "emoji": "😂"} in client.get("/api/audit/options").json()["resources"]
    assert "credentials" not in str(options)


def test_import_failures_have_named_persistent_audit_details(client: TestClient) -> None:
    login(client)
    db, media = client.app.state.db, client.app.state.media
    job_id = db.add_job("https://www.youtube.com/watch?v=abcdefghijk", "100")
    db.execute("UPDATE jobs SET title=? WHERE id=?", ("Named video", job_id))
    media.update_job(job_id, "failed", error="Source duration is 4000 seconds; the configured maximum is 3600 seconds.")
    entries = client.get("/api/audit", params={"resource_id": job_id}).json()["results"]
    assert entries[0]["resource_name"] == "Named video"
    assert entries[0]["outcome"] == "failed"
    assert "4000" in entries[0]["details"]["error"]
    assert "Admin page" in entries[0]["details"]["suggestion"]
    assert entries[0]["details"]["job_id"] == job_id
    assert db.jobs()[0]["title"] == "Named video"
    db.execute("DELETE FROM jobs WHERE id=?", (job_id,))
    assert (
        client.get("/api/audit", params={"resource_id": job_id}).json()["results"][0]["details"]
        == entries[0]["details"]
    )


def test_audit_result_filter_and_cursor_pages(client: TestClient) -> None:
    login(client)
    db = client.app.state.db
    for number in range(4):
        db.audit("100", "video.import", f"result-{number}", f"Video {number}", outcome="failed")
    db.audit("100", "video.import", "success", "Success", outcome="complete")
    first = client.get("/api/audit", params={"outcome": "failed", "limit": 2}).json()
    assert first["total"] == 4
    assert len(first["results"]) == 2
    assert all(row["outcome"] == "failed" for row in first["results"])
    second = client.get("/api/audit", params={"outcome": "failed", "limit": 2, "before": first["next_cursor"]}).json()
    assert len(second["results"]) == 2
    assert second["total"] == 4
    assert second["next_cursor"] is None
    assert not {r["id"] for r in first["results"]} & {r["id"] for r in second["results"]}
    assert client.get("/api/audit", params={"outcome": "' OR 1=1 --"}).json()["results"] == []


def test_other_server_membership_cannot_grant_access_or_voice(client: TestClient) -> None:
    login(client)
    auth = client.app.state.auth
    bot = client.app.state.bot
    bot.client.is_ready = lambda: True
    bot.client._connection._guilds = {
        int(GUILD): SimpleNamespace(id=int(GUILD), name="De Mannen", voice_client=None),
        222: SimpleNamespace(id=222, name="Other", voice_client=None),
    }
    auth.discord_request = AsyncMock(return_value=[{"id": "222"}])
    assert client.portal.call(Auth.shared_guilds, auth, "test-token") == []
    auth.discord_request.return_value = [{"id": "222"}, {"id": GUILD}]
    assert client.portal.call(Auth.shared_guilds, auth, "test-token") == [{"id": GUILD, "name": "De Mannen"}]
    assert client.get("/api/state?guild_id=222").status_code == 403
    user = client.get("/api/auth/me").json()
    assert (
        client.post("/api/guilds/222/voice/connect", json={"channel_id": "123"}, headers=headers(user)).status_code
        == 403
    )
    auth.shared_guilds.return_value = []
    client.app.state.db.execute("UPDATE sessions SET guilds=?", ('[{"id":"222","name":"Other"}]',))
    assert client.get("/api/auth/me").status_code == 403


def test_live_membership_uses_bot_and_dashboard_reads_share_cache(client: TestClient) -> None:
    login(client)
    auth = client.app.state.auth
    bot = client.app.state.bot
    bot.client.is_ready = lambda: True
    member = Mock()
    guild = Mock(fetch_member=AsyncMock(return_value=member))
    bot.client.get_guild = lambda _: guild
    session = client.app.state.db.one("SELECT * FROM sessions")
    request = Request({"type": "http", "state": {"session": session}})
    auth.discord_request.reset_mock()

    async def verify() -> None:
        results = await asyncio.gather(*(auth.member(request, GUILD, fresh=False) for _ in range(8)))
        assert results == [member] * 8
        guild.fetch_member.assert_awaited_once_with(100)
        await asyncio.gather(*(auth.member(request, GUILD, fresh=False, max_age=15) for _ in range(8)))
        guild.fetch_member.assert_awaited_once_with(100)
        auth.members[(session["id"], GUILD)] = (time.time() - 16, member)
        await auth.member(request, GUILD, fresh=False, max_age=15)
        assert guild.fetch_member.await_count == 2
        await auth.member(request, GUILD)
        assert guild.fetch_member.await_count == 3
        auth.discord_request.assert_not_awaited()

    client.portal.call(verify)
    bot.client.get_guild = lambda _: None
