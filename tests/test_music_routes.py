from __future__ import annotations

import asyncio
import json
import time
from types import SimpleNamespace
from typing import TYPE_CHECKING
from unittest.mock import AsyncMock, Mock, patch

import discord
import httpx
import pytest
from fastapi.testclient import TestClient
from pydantic import SecretStr

from app.config import Settings
from app.main import create_app
from app.music_sources import MusicSourceError
from app.permissions import effective_permissions
from tests.helpers import authenticated_fixture

if TYPE_CHECKING:
    from collections.abc import Iterator
    from pathlib import Path

    from fastapi import Request


GUILD = "1352422295402057759"


def song(identity: str = "abcdefghijk", **changes: object) -> dict:
    return {
        "provider": "youtube",
        "source_id": identity,
        "title": "Song",
        "artist": "Artist",
        "duration": 120,
        "url": "https://www.youtube.com/watch?v=" + identity,
        **changes,
    }


@pytest.fixture
def client(tmp_path: Path) -> Iterator[TestClient]:
    settings = Settings(_env_file=None, data_dir=tmp_path, discord_token=SecretStr(""), app_admin_ids=["100"])
    with TestClient(create_app(settings)) as value:
        value.app.state.music_sources.download = AsyncMock(side_effect=MusicSourceError("Recording unavailable."))
        authenticated_fixture(value.app)
        for identity in ("100", "200", "300"):
            value.app.state.db.execute(
                "INSERT OR IGNORE INTO users(id,username,display_name,created_at,last_login) VALUES (?,?,?,?,?)",
                (identity, "member" + identity, "Member " + identity, time.time(), time.time()),
            )
        value.app.state.conversation.enabled = False

        async def current(request: Request, *, csrf: bool = True) -> dict:
            if not csrf:
                request.state.fixture = True
            identity = request.headers.get("x-member", "100")
            profile = value.app.state.db.one("SELECT * FROM users WHERE id=?", (identity,))
            permissions = effective_permissions(json.loads(profile["permission_overrides"]), admin=identity == "100")
            profile.update(
                admin=permissions["admin"],
                protected_admin=identity == "100",
                permissions=permissions,
                guilds=[{"id": GUILD, "name": "Test server"}],
                preferences={},
            )
            request.state.user = profile
            return profile

        value.app.state.auth.current = current
        yield value


def connected(client: TestClient, *members: str) -> Mock:
    bot = client.app.state.bot
    voice = Mock(spec=discord.VoiceClient)
    voice.is_connected.return_value = True
    voice.channel = SimpleNamespace(
        id=123,
        name="Music room",
        members=[
            SimpleNamespace(
                id=int(identity), bot=False, display_name="Member " + identity, display_avatar=SimpleNamespace(url="")
            )
            for identity in members
        ],
        permissions_for=lambda _member: SimpleNamespace(view_channel=True, connect=True),
    )
    guild = Mock(voice_client=voice, change_voice_state=AsyncMock())
    bot.client.get_guild = lambda _: guild
    bot.client.is_ready = lambda: True
    return voice


def patch_playlist(client: TestClient, path: str, *, json: dict, headers: dict | None = None) -> httpx.Response:
    current = client.get(path, headers=headers).json()
    return client.patch(path, json={**json, "expected_updated_at": current["updated_at"]}, headers=headers)


def test_playlist_reorder_publishes_the_confirmed_detail_and_download_order(client: TestClient) -> None:
    playlist = client.post("/api/music/playlists", json={"name": "Reorder"}).json()
    path = "/api/music/playlists/" + playlist["id"]
    first = song(thumbnail="https://i.ytimg.com/vi/abcdefghijk/default.jpg")
    second = song("lmnopqrstuv", title="Second")
    initial = patch_playlist(client, path, json={"tracks": [first, second]}).json()
    with patch.object(client.app.state.events, "publish") as publish:
        response = client.patch(path, json={"tracks": [second, first], "expected_updated_at": initial["updated_at"]})
    assert response.status_code == 200, response.text
    change = next(call.args[1] for call in publish.call_args_list if call.args[0] == "music_playlists")
    assert change["ids"] == [playlist["id"]]
    assert change["resource"] == path.removeprefix("/api")
    assert change["value"] == response.json()
    assert [item["source_id"] for item in change["value"]["tracks"]] == [second["source_id"], first["source_id"]]
    assert len(change["value"]["cache"]) == 2
    assert change["value"]["artwork"] == [first["thumbnail"]]
    assert change["value"]["updated_at"] > initial["updated_at"]
    with patch.object(client.app.state.events, "publish") as publish:
        rejected = client.patch(path, json={"tracks": [first, second], "expected_updated_at": initial["updated_at"]})
    assert rejected.status_code == 409
    assert not any(call.args[0] == "music_playlists" for call in publish.call_args_list)
    assert client.get(path).json()["tracks"] == response.json()["tracks"]


def override(client: TestClient, identity: str, **permissions: bool) -> None:
    client.app.state.db.execute(
        "UPDATE users SET permission_overrides=? WHERE id=?", (json.dumps(permissions), identity)
    )


def test_music_browsing_outside_voice_and_required_permissions(client: TestClient) -> None:
    assert client.get("/api/music", headers={"x-member": "200"}).status_code == 200
    assert client.get("/api/music/playlists", headers={"x-member": "200"}).status_code == 200
    override(client, "200", view_music=False)
    for path in ("/api/music", "/api/music/playlists", "/api/music/search?q=song"):
        assert client.get(path, headers={"x-member": "200"}).status_code == 403
    assert client.post("/api/music/playlists", json={"name": "Private"}, headers={"x-member": "200"}).status_code == 403


@pytest.mark.parametrize("identity", ["100", "200"])
def test_members_without_outside_permission_must_be_in_active_voice(client: TestClient, identity: str) -> None:
    headers = {"x-member": identity}
    override(client, identity, outside_voice_control=False)
    voice = connected(client, "300")
    client.app.state.bot.state.audio_mode = "music"
    requests = [
        ("put", "/api/audio-mode", {"mode": "soundboard"}),
        ("post", "/api/music/player", {"action": "play"}),
        ("post", "/api/music/play", {"track": song()}),
        ("post", "/api/music/queue", {"tracks": [song()]}),
        ("put", "/api/music/queue/order", {"ids": []}),
        ("delete", "/api/music/queue/missing", None),
        ("post", "/api/music/imports", {"query": "song"}),
    ]
    for method, path, body in requests:
        response = client.request(method, path, json=body, headers=headers)
        assert response.status_code == 403, response.text
    voice.is_connected.return_value = False
    assert client.post("/api/music/player", json={"action": "pause"}, headers=headers).status_code == 409


def test_mode_permission_is_independent_of_queue_controls(client: TestClient) -> None:
    connected(client, "200")
    override(client, "200", switch_audio_mode=True, control_music=False)
    headers = {"x-member": "200"}
    response = client.put("/api/audio-mode", json={"mode": "music"}, headers=headers)
    assert response.status_code == 200, response.text
    assert response.json()["status"]["audio_mode"] == "music"
    assert client.post("/api/music/player", json={"action": "play"}, headers=headers).status_code == 403
    override(client, "200", switch_audio_mode=False, control_music=True)
    assert client.put("/api/audio-mode", json={"mode": "soundboard"}, headers=headers).status_code == 403
    assert client.post("/api/music/queue", json={"tracks": [song()]}, headers=headers).status_code == 200


def test_queue_requires_music_and_canonicalizes_untrusted_track_destinations(client: TestClient) -> None:
    connected(client, "200")
    headers = {"x-member": "200"}
    assert client.post("/api/music/queue", json={"tracks": [song()]}, headers=headers).status_code == 409
    client.app.state.bot.state.audio_mode = "music"
    response = client.post(
        "/api/music/queue",
        json={"tracks": [song(url="http://127.0.0.1/private", thumbnail="http://localhost/private")]},
        headers=headers,
    )
    assert response.status_code == 200, response.text
    current = response.json()["current"]
    assert current["requester_id"] == "200"
    assert current["track"]["url"] == "https://www.youtube.com/watch?v=abcdefghijk"
    assert current["track"]["thumbnail"] is None
    assert response.json()["state"] == "paused"
    assert (
        client.post("/api/music/queue", json={"tracks": [song("file:///etc/passwd")]}, headers=headers).status_code
        == 422
    )
    assert client.post("/api/music/queue", json={"tracks": [song(duration=0)]}, headers=headers).status_code == 422
    assert client.post("/api/music/queue", json={"tracks": [song(duration=86400)]}, headers=headers).status_code == 422


def test_queue_snapshots_survive_playlist_changes_and_reject_track_editing(client: TestClient) -> None:
    connected(client, "200")
    client.app.state.bot.state.audio_mode = "music"
    headers = {"x-member": "200"}
    created = client.post("/api/music/playlists", json={"name": "My songs"}, headers=headers).json()
    path = "/api/music/playlists/" + created["id"]
    assert patch_playlist(client, path, json={"tracks": [song()]}, headers=headers).status_code == 200
    queued = client.post(path + "/queue", headers=headers)
    assert queued.status_code == 200, queued.text
    entry = queued.json()["current"]["id"]
    assert patch_playlist(client, path, json={"tracks": []}, headers=headers).status_code == 200
    assert client.delete(path, headers=headers).status_code == 200
    assert client.get("/api/music", headers=headers).json()["current"]["track"]["source_id"] == "abcdefghijk"
    corrected = client.put(
        f"/api/music/queue/{entry}/track",
        json={"track": song("lmnopqrstuv", title="Correct recording")},
        headers=headers,
    )
    assert corrected.status_code == 404
    assert client.get("/api/music", headers=headers).json()["current"]["track"]["title"] == "Song"
    assert client.delete(f"/api/music/queue/{entry}", headers=headers).json()["state"] == "idle"


def test_all_playlists_visible_my_first_and_collaboration_preserves_owner_controls(client: TestClient) -> None:
    first = client.post("/api/music/playlists", json={"name": "  Owner playlist  "}, headers={"x-member": "200"}).json()
    other = client.post("/api/music/playlists", json={"name": "Other playlist"}, headers={"x-member": "300"}).json()
    owner_path = "/api/music/playlists/" + first["id"]
    own = {"x-member": "200"}
    visitor = {"x-member": "300"}
    assert first["name"] == "Owner playlist"
    assert patch_playlist(client, owner_path, json={"tracks": [song()]}, headers=own).status_code == 200
    rows = client.get("/api/music/playlists?limit=1", headers=own).json()
    assert rows["total"] == 2
    assert len(rows["playlists"]) == 1
    assert rows["playlists"][0]["id"] == first["id"]
    assert rows["playlists"][0]["creator_name"] == "Member 200"
    assert rows["playlists"][0]["track_count"] == 1
    assert rows["playlists"][0]["tracks"] == []
    assert client.get(owner_path, headers=visitor).json()["tracks"][0]["title"] == "Song"
    assert patch_playlist(client, owner_path, json={"name": "Denied"}, headers=visitor).status_code == 403
    assert patch_playlist(client, owner_path, json={"collaborative": True}, headers=own).status_code == 200
    assert (
        patch_playlist(
            client, owner_path, json={"name": "Shared name", "tracks": [song("lmnopqrstuv")]}, headers=visitor
        ).status_code
        == 200
    )
    assert patch_playlist(client, owner_path, json={"collaborative": False}, headers=visitor).status_code == 403
    assert client.delete(owner_path, headers=visitor).status_code == 403
    assert patch_playlist(client, owner_path, json={"collaborative": False}).status_code == 200
    assert client.delete(owner_path).status_code == 200
    remaining = client.get("/api/music/playlists", headers=visitor).json()
    assert [row["id"] for row in remaining["playlists"]] == [other["id"]]


@pytest.mark.parametrize("payload", [{"name": " "}, {"name": "x" * 101}])
def test_playlist_name_validation(client: TestClient, payload: dict) -> None:
    assert client.post("/api/music/playlists", json=payload).status_code == 422


def test_search_provider_and_unsupported_inputs_are_bounded(client: TestClient) -> None:
    sources = client.app.state.music_sources
    sources.search = AsyncMock(return_value=[song()])
    response = client.get("/api/music/search", params={"q": "Artist song"}, headers={"x-member": "200"})
    assert response.status_code == 200
    sources.search.assert_awaited_once_with("Artist song")
    assert client.get("/api/music/search", params={"q": "x" * 1000}).status_code == 200
    assert client.get("/api/music/search", params={"q": "x" * 1001}).status_code == 422
    assert client.put("/api/audio-mode", json={"mode": "invalid"}).status_code == 422


def test_import_mock_completion_preserves_order_and_reports_unavailable_items(client: TestClient) -> None:
    connected(client, "200")
    client.app.state.bot.state.audio_mode = "music"
    client.app.state.music_sources.resolve = AsyncMock(
        return_value={
            "title": "Imported songs",
            "tracks": [song(), song("lmnopqrstuv")],
            "warnings": ["One missing song."],
        }
    )
    result = client.post("/api/music/imports", json={"query": "Spotify playlist"}, headers={"x-member": "200"})
    assert result.status_code == 202, result.text

    async def complete() -> None:
        await asyncio.gather(*tuple(client.app.state.music_imports.tasks.values()))

    client.portal.call(complete)
    payload = client.get("/api/music", headers={"x-member": "200"}).json()
    assert [entry["track"]["source_id"] for entry in payload["queue"]] == ["abcdefghijk", "lmnopqrstuv"]
    assert payload["imports"][0]["state"] == "complete"
    assert payload["imports"][0]["warnings"] == ["One missing song."]
    assert client.get("/api/music", headers={"x-member": "300"}).json()["imports"] == []


def test_import_permission_changes_and_cancellation_never_append_late_results(client: TestClient) -> None:
    connected(client, "200", "300")
    client.app.state.bot.state.audio_mode = "music"
    started, release = asyncio.Event(), asyncio.Event()

    async def delayed(_query: str, _progress: object) -> dict:
        started.set()
        await release.wait()
        return {"title": "Late result", "tracks": [song()], "warnings": []}

    client.app.state.music_sources.resolve = delayed
    response = client.post("/api/music/imports", json={"query": "song"}, headers={"x-member": "200"})
    job = response.json()["id"]
    client.portal.call(started.wait)
    assert client.delete(f"/api/music/imports/{job}", headers={"x-member": "300"}).status_code == 403
    override(client, "200", control_music=False)
    client.portal.call(release.set)

    async def complete() -> None:
        await asyncio.gather(*tuple(client.app.state.music_imports.tasks.values()))

    client.portal.call(complete)
    assert client.get("/api/music").json()["queue"] == []
    assert client.get("/api/music").json()["imports"][0]["state"] == "failed"
    override(client, "200", control_music=True)
    client.portal.call(started.clear)
    client.portal.call(release.clear)
    response = client.post("/api/music/imports", json={"query": "song"}, headers={"x-member": "200"})
    job = response.json()["id"]
    client.portal.call(started.wait)
    assert client.delete(f"/api/music/imports/{job}", headers={"x-member": "200"}).status_code == 200
    client.portal.call(release.set)
    assert client.get("/api/music").json()["queue"] == []
    assert client.app.state.music_imports.jobs[job]["state"] == "cancelled"


def test_import_playlist_edit_access_is_rechecked_after_resolving(client: TestClient) -> None:
    playlist = client.post("/api/music/playlists", json={"name": "Shared"}, headers={"x-member": "200"}).json()
    path = "/api/music/playlists/" + playlist["id"]
    assert patch_playlist(client, path, json={"collaborative": True}, headers={"x-member": "200"}).status_code == 200
    started, release = asyncio.Event(), asyncio.Event()

    async def delayed(_query: str, _progress: object) -> dict:
        started.set()
        await release.wait()
        return {"title": "Imported", "tracks": [song()], "warnings": []}

    client.app.state.music_sources.resolve = delayed
    result = client.post(
        "/api/music/imports", json={"query": "song", "destination": playlist["id"]}, headers={"x-member": "300"}
    )
    assert result.status_code == 202
    client.portal.call(started.wait)
    assert patch_playlist(client, path, json={"collaborative": False}, headers={"x-member": "200"}).status_code == 200
    client.portal.call(release.set)

    async def complete() -> None:
        await asyncio.gather(*tuple(client.app.state.music_imports.tasks.values()))

    client.portal.call(complete)
    assert client.get(path).json()["tracks"] == []
    assert client.app.state.music_imports.jobs[result.json()["id"]]["state"] == "failed"


def test_import_rejects_malformed_resolver_tracks_without_queue_mutation(client: TestClient) -> None:
    connected(client, "200")
    client.app.state.bot.state.audio_mode = "music"
    client.app.state.music_sources.resolve = AsyncMock(
        return_value={"tracks": [song("not-a-valid-id")], "warnings": []}
    )
    response = client.post("/api/music/imports", json={"query": "song"}, headers={"x-member": "200"})
    assert response.status_code == 202

    async def complete() -> None:
        await asyncio.gather(*tuple(client.app.state.music_imports.tasks.values()))

    client.portal.call(complete)
    payload = client.get("/api/music").json()
    assert payload["queue"] == []
    assert payload["imports"][0]["state"] == "failed"


def test_create_playlist_collaboration_is_explicit_and_strict(client: TestClient) -> None:
    owner = {"x-member": "200"}
    visitor = {"x-member": "300"}
    private = client.post("/api/music/playlists", json={"name": "Owner only"}, headers=owner)
    assert private.status_code == 201
    assert private.json()["collaborative"] is False
    shared = client.post(
        "/api/music/playlists", json={"name": "Shared at creation", "collaborative": True}, headers=owner
    )
    assert shared.status_code == 201
    assert shared.json()["collaborative"] is True
    path = "/api/music/playlists/" + shared.json()["id"]
    assert patch_playlist(client, path, json={"tracks": [song()]}, headers=visitor).status_code == 200
    assert client.delete(path, headers=visitor).status_code == 403
    assert (
        client.post(
            "/api/music/playlists", json={"name": "Ambiguous", "collaborative": "false"}, headers=owner
        ).status_code
        == 422
    )
    rows = client.get("/api/music/playlists", headers=owner).json()
    assert rows["total"] == 2


def test_admin_duration_changes_apply_to_music_without_restart(client: TestClient) -> None:
    connected(client, "200")
    client.app.state.bot.state.audio_mode = "music"
    response = client.put("/api/settings/app", json={"max_source_seconds": 30})
    assert response.status_code == 200, response.text
    assert client.app.state.music_sources.settings.max_source_seconds == 30
    assert client.app.state.music.settings.max_source_seconds == 30
    headers = {"x-member": "200"}
    assert client.post("/api/music/queue", json={"tracks": [song(duration=31)]}, headers=headers).status_code == 422
    playlist = client.post("/api/music/playlists", json={"name": "Limited"}, headers=headers).json()
    path = "/api/music/playlists/" + playlist["id"]
    assert patch_playlist(client, path, json={"tracks": [song(duration=31)]}, headers=headers).status_code == 422
    assert patch_playlist(client, path, json={"tracks": [song(duration=30)]}, headers=headers).status_code == 200
    client.app.state.music_sources.resolve = AsyncMock(return_value={"tracks": [song(duration=31)], "warnings": []})
    imported = client.post("/api/music/imports", json={"query": "song"}, headers=headers)
    assert imported.status_code == 202

    async def complete() -> None:
        await asyncio.gather(*tuple(client.app.state.music_imports.tasks.values()))

    client.portal.call(complete)
    state = client.get("/api/music", headers=headers).json()
    assert state["queue"] == []
    assert state["imports"][0]["state"] == "failed"
    assert client.put("/api/settings/app", json={"max_source_seconds": 240}).status_code == 200
    assert client.post("/api/music/queue", json={"tracks": [song()]}, headers=headers).status_code == 200


@pytest.mark.parametrize("operation", ["pause", "play_now", "enqueue", "reorder", "remove"])
def test_route_mutations_recheck_mode_when_blocked_behind_another_player_command(
    client: TestClient, operation: str
) -> None:
    connected(client, "200")
    client.app.state.bot.state.audio_mode = "music"
    response = client.post("/api/music/queue", json={"tracks": [song()]}, headers={"x-member": "200"})
    entry = response.json()["current"]["id"]
    requests = {
        "pause": ("POST", "/api/music/player", {"action": "pause"}),
        "play_now": ("POST", "/api/music/play", {"track": song("lmnopqrstuv")}),
        "enqueue": ("POST", "/api/music/queue", {"tracks": [song("lmnopqrstuv")]}),
        "reorder": ("PUT", "/api/music/queue/order", {"ids": [entry]}),
        "remove": ("DELETE", "/api/music/queue/" + entry, None),
    }

    async def race() -> None:
        player = client.app.state.music
        before = player.snapshot()
        await player.lock.acquire()
        method, path, body = requests[operation]
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=client.app), base_url="http://testserver"
        ) as browser:
            pending = asyncio.create_task(browser.request(method, path, json=body, headers={"x-member": "200"}))
            for _ in range(20):
                await asyncio.sleep(0)
            assert not pending.done()
            client.app.state.bot.state.audio_mode = "soundboard"
            player.lock.release()
            rejected = await pending
        assert rejected.status_code == 409, rejected.text
        assert player.snapshot() == before

    client.portal.call(race)


def test_cache_status_is_visible_but_retry_requires_playlist_edit_access(client: TestClient) -> None:
    playlist = client.post("/api/music/playlists", json={"name": "Caching"}).json()
    patch_playlist(client, "/api/music/playlists/" + playlist["id"], json={"tracks": [song()]})
    path = "/api/music/playlists/" + playlist["id"] + "/cache"
    response = client.get(path, headers={"x-member": "200"})
    assert response.status_code == 200
    assert len(response.json()["cache"]) == 1
    assert client.post(path, headers={"x-member": "200"}).status_code == 403

    assert client.post(path).status_code == 200
    patch_playlist(client, "/api/music/playlists/" + playlist["id"], json={"collaborative": True})
    assert client.post(path, headers={"x-member": "200"}).status_code == 200
    override(client, "200", view_music=False)
    assert client.get(path, headers={"x-member": "200"}).status_code == 403
    assert client.post(path, headers={"x-member": "200"}).status_code == 403


def test_playlist_play_copies_context_and_preserves_manual_queue_without_edit_permission(client: TestClient) -> None:
    connected(client, "200")
    client.app.state.bot.state.audio_mode = "music"
    headers = {"x-member": "200"}
    playlist = client.post("/api/music/playlists", json={"name": "Context"}).json()
    path = "/api/music/playlists/" + playlist["id"]
    assert patch_playlist(client, path, json={"tracks": [song("playlist001"), song("playlist002")]}).status_code == 200
    assert (
        client.post(
            "/api/music/queue", json={"tracks": [song("manualsong1"), song("manualsong2")]}, headers=headers
        ).status_code
        == 200
    )

    async def audio(track: dict, _position: float, _volume: float) -> Mock:
        value = Mock(spec=discord.AudioSource)
        value.music_track = track
        return value

    client.app.state.music_sources.source = AsyncMock(side_effect=audio)
    response = client.post(path + "/play", headers=headers)
    assert response.status_code == 200, response.text
    result = response.json()
    assert result["current"]["track"]["source_id"] == "playlist001"
    assert result["playlist"] == {"id": playlist["id"], "name": "Context"}
    assert [item["track"]["source_id"] for item in result["manual_queue"]] == ["manualsong1", "manualsong2"]
    assert [item["track"]["source_id"] for item in result["playlist_queue"]] == ["playlist002"]
    assert patch_playlist(client, path, json={"tracks": [song("replacement")]}).status_code == 200
    assert client.get("/api/music", headers=headers).json()["playlist_queue"] == result["playlist_queue"]
    assert patch_playlist(client, path, json={"name": "Forbidden"}, headers=headers).status_code == 403


def test_playlist_play_requires_voice_control_music_and_valid_current_duration(client: TestClient) -> None:
    playlist = client.post("/api/music/playlists", json={"name": "Context"}).json()
    path = "/api/music/playlists/" + playlist["id"]
    assert patch_playlist(client, path, json={"tracks": [song()]}).status_code == 200
    connected(client, "100")
    client.app.state.bot.state.audio_mode = "music"
    headers = {"x-member": "200"}
    assert client.post(path + "/play", headers=headers).status_code == 403
    connected(client, "200")
    override(client, "200", control_music=False)
    assert client.post(path + "/play", headers=headers).status_code == 403
    override(client, "200", control_music=True)
    client.app.state.bot.state.audio_mode = "soundboard"
    assert client.post(path + "/play", headers=headers).status_code == 409
    client.app.state.bot.state.audio_mode = "music"
    client.app.state.music_sources.settings.max_source_seconds = 60
    assert client.post(path + "/play", headers=headers).status_code == 422
    assert patch_playlist(client, path, json={"tracks": []}).status_code == 200
    assert client.post(path + "/play", headers=headers).status_code == 409


@pytest.mark.parametrize(
    "changes",
    [{"tracks": []}, {"tracks": [song("lmnopqrstuv"), song()]}, {"name": "Old name"}, {"collaborative": False}],
)
def test_stale_playlist_edits_do_not_overwrite_another_members_new_song(client: TestClient, changes: dict) -> None:
    owner = {"x-member": "200"}
    collaborator = {"x-member": "300"}
    created = client.post("/api/music/playlists", json={"name": "Shared", "collaborative": True}, headers=owner).json()
    path = "/api/music/playlists/" + created["id"]
    original = patch_playlist(client, path, json={"tracks": [song(), song("lmnopqrstuv")]}, headers=owner).json()
    assert (
        client.put(
            path + "/membership", json={"track": song("newrecord01"), "saved": True}, headers=collaborator
        ).status_code
        == 200
    )
    current = client.get(path, headers=owner).json()
    response = client.patch(path, json={**changes, "expected_updated_at": original["updated_at"]}, headers=owner)
    assert response.status_code == 409, response.text
    assert response.json()["detail"].startswith("This playlist changed.")
    after = client.get(path, headers=owner).json()
    assert {key: value for key, value in after.items() if key != "cache"} == {
        key: value for key, value in current.items() if key != "cache"
    }
    assert [track["source_id"] for track in current["tracks"]] == ["abcdefghijk", "lmnopqrstuv", "newrecord01"]
    assert current["track_count"] == 3


def test_playlist_replacement_requires_a_version_and_new_version_allows_retry(client: TestClient) -> None:
    created = client.post("/api/music/playlists", json={"name": "Versioned"}).json()
    path = "/api/music/playlists/" + created["id"]
    assert client.patch(path, json={"tracks": []}).status_code == 422
    assert client.get(path).json()["updated_at"] == created["updated_at"]
    updated = client.patch(path, json={"tracks": [song()], "expected_updated_at": created["updated_at"]})
    assert updated.status_code == 200, updated.text
    assert updated.json()["updated_at"] > created["updated_at"]
    assert client.patch(path, json={"tracks": [], "expected_updated_at": created["updated_at"]}).status_code == 409
    retry = client.patch(path, json={"tracks": [], "expected_updated_at": updated.json()["updated_at"]})
    assert retry.status_code == 200, retry.text
    assert retry.json()["tracks"] == []


def test_concurrent_playlist_changes_from_the_same_version_accept_only_one(client: TestClient) -> None:
    created = client.post("/api/music/playlists", json={"name": "Versioned"}).json()
    path = "/api/music/playlists/" + created["id"]

    async def race() -> None:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=client.app), base_url="http://testserver"
        ) as browser:
            responses = await asyncio.gather(
                *(
                    browser.patch(path, json={"tracks": [song(identity)], "expected_updated_at": created["updated_at"]})
                    for identity in ("abcdefghijk", "lmnopqrstuv")
                )
            )
        assert sorted(response.status_code for response in responses) == [200, 409]
        accepted = next(response.json() for response in responses if response.status_code == 200)
        assert client.app.state.music_store.playlist(created["id"])["tracks"] == accepted["tracks"]

    client.portal.call(race)


def test_music_import_query_limit_matches_search(client: TestClient) -> None:
    connected(client, "200")
    client.app.state.bot.state.audio_mode = "music"
    imports = client.app.state.music_imports
    imports.start = AsyncMock(return_value={"id": "import"})
    assert client.post("/api/music/imports", json={"query": "x" * 1000}, headers={"x-member": "200"}).status_code == 202
    assert client.post("/api/music/imports", json={"query": "x" * 1001}, headers={"x-member": "200"}).status_code == 422
    imports.start.assert_awaited_once()


def test_outside_voice_permission_covers_music_without_bypassing_action_permissions(client: TestClient) -> None:
    voice = connected(client, "300")
    headers = {"x-member": "200"}
    override(client, "200", outside_voice_control=True)
    assert client.put("/api/audio-mode", json={"mode": "music"}, headers=headers).status_code == 200
    queued = client.post("/api/music/queue", json={"tracks": [song(), song("lmnopqrstuv")]}, headers=headers)
    assert queued.status_code == 200, queued.text
    ids = [entry["id"] for entry in queued.json()["queue"]]
    assert client.put("/api/music/queue/order", json={"ids": ids}, headers=headers).status_code == 200
    assert client.post("/api/music/player", json={"action": "pause"}, headers=headers).status_code == 200
    override(client, "200", outside_voice_control=True, control_music=False)
    assert client.post("/api/music/queue", json={"tracks": [song()]}, headers=headers).status_code == 403
    assert client.delete("/api/music/queue", headers=headers).status_code == 403
    override(client, "200", outside_voice_control=True, switch_audio_mode=False)
    assert client.put("/api/audio-mode", json={"mode": "soundboard"}, headers=headers).status_code == 403
    override(client, "200", outside_voice_control=False)
    assert client.post("/api/music/player", json={"action": "pause"}, headers=headers).status_code == 403
    assert client.delete("/api/music/queue", headers=headers).status_code == 403
    override(client, "200", outside_voice_control=True)
    voice.is_connected.return_value = False
    assert client.post("/api/music/player", json={"action": "pause"}, headers=headers).status_code == 409


def test_mode_change_rechecks_outside_permission_after_waiting_for_voice_lock(client: TestClient) -> None:
    connected(client, "300")
    override(client, "200", outside_voice_control=True)
    state = client.app.state.bot.state
    original = state.select_mode

    async def revoke(mode: str, user_id: str) -> None:
        override(client, user_id, outside_voice_control=False)
        await original(mode, user_id)

    with patch.object(state, "select_mode", side_effect=revoke):
        response = client.put("/api/audio-mode", json={"mode": "music"}, headers={"x-member": "200"})
    assert response.status_code != 200
    assert state.audio_mode == "soundboard"


def test_queue_rechecks_revoked_outside_permission_at_commit(client: TestClient) -> None:
    connected(client, "300")
    client.app.state.bot.state.audio_mode = "music"
    override(client, "200", outside_voice_control=True)
    player = client.app.state.music
    original = player.enqueue

    async def revoke(*args: object, **kwargs: object) -> dict:
        override(client, "200", outside_voice_control=False)
        return await original(*args, **kwargs)

    with patch.object(player, "enqueue", side_effect=revoke):
        response = client.post("/api/music/queue", json={"tracks": [song()]}, headers={"x-member": "200"})
    assert response.status_code == 403
    assert player.snapshot()["queue"] == []
