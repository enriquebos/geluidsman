from __future__ import annotations

import asyncio
import json
from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace
from typing import TYPE_CHECKING
from unittest.mock import AsyncMock

from app.db import Database
from app.events import Events
from app.music_models import MusicTrack
from app.music_store import MusicStore
from tests.test_music_routes import client, connected, override, song

if TYPE_CHECKING:
    from pathlib import Path

    from fastapi.testclient import TestClient

__all__ = ["client"]


def test_likes_are_personal_idempotent_and_available_outside_voice(client: TestClient) -> None:
    headers = {"x-member": "200"}
    first = client.put("/api/music/likes", headers=headers, json={"track": song(), "liked": True})
    assert first.status_code == 200
    assert first.json()["keys"] == ["youtube:abcdefghijk"]
    assert client.put("/api/music/likes", headers=headers, json={"track": song(), "liked": True}).json() == first.json()
    assert client.get("/api/music/likes").json()["total"] == 0
    assert client.get("/api/music/likes/playlist").json()["tracks"] == []
    playlist = client.get("/api/music/likes/playlist", headers=headers).json()
    assert playlist["creator_id"] == "200"
    assert playlist["liked"] is True
    assert len(playlist["tracks"]) == 1
    restored = MusicStore(client.app.state.db).liked({"id": "200", "display_name": "Member"})
    assert restored["tracks"] == playlist["tracks"]
    assert client.get("/api/music/playlists").json()["total"] == 0
    assert client.put("/api/music/likes", headers=headers, json={"track": song(), "liked": False}).json()["total"] == 0
    assert client.get("/api/music/likes/playlist", headers=headers).json()["tracks"] == []


def test_likes_permissions_and_source_validation(client: TestClient) -> None:
    headers = {"x-member": "200"}
    override(client, "200", control_music=False)
    response = client.put(
        "/api/music/likes",
        headers=headers,
        json={"track": song(url="http://127.0.0.1", thumbnail="http://localhost/a"), "liked": True},
    )
    assert response.status_code == 200
    saved = client.get("/api/music/likes/playlist", headers=headers).json()["tracks"][0]
    assert saved["url"] == "https://www.youtube.com/watch?v=abcdefghijk"
    assert saved["thumbnail"] is None
    for track in (song("not-valid"), song(duration=0), song(duration=86400)):
        assert client.put("/api/music/likes", headers=headers, json={"track": track, "liked": True}).status_code == 422
    assert client.put("/api/music/likes", headers=headers, json={"track": song(), "liked": "yes"}).status_code == 422
    override(client, "200", view_music=False)
    for path in ("", "/playlist", "/cache"):
        assert client.get("/api/music/likes" + path, headers=headers).status_code == 403
    assert client.put("/api/music/likes", headers=headers, json={"track": song(), "liked": False}).status_code == 403


def test_concurrent_likes_do_not_lose_songs_and_limit_is_enforced(client: TestClient) -> None:
    store = client.app.state.music_store
    user = {"id": "200", "display_name": "Member"}
    tracks = [MusicTrack.model_validate(song(f"{index:011d}")).model_dump() for index in range(20)]
    with ThreadPoolExecutor(max_workers=4) as pool:
        list(pool.map(lambda track: store.set_like(user, track, liked=True), tracks * 2))
    assert store.like_summary(user)["total"] == 20
    tracks = [MusicTrack.model_validate(song(f"{index:011d}")).model_dump() for index in range(1000)]
    client.app.state.db.set_setting("music_likes:200", {"tracks": tracks, "updated_at": 1})
    headers = {"x-member": "200"}
    assert client.put("/api/music/likes", headers=headers, json={"track": song(), "liked": True}).status_code == 409
    assert client.put("/api/music/likes", headers=headers, json={"track": tracks[0], "liked": True}).status_code == 200
    assert client.put("/api/music/likes", headers=headers, json={"track": tracks[0], "liked": False}).status_code == 200
    assert client.put("/api/music/likes", headers=headers, json={"track": song(), "liked": True}).status_code == 200


def test_likes_playback_requires_voice_permission_and_music_mode(client: TestClient) -> None:
    headers = {"x-member": "200"}
    client.put("/api/music/likes", headers=headers, json={"track": song(), "liked": True})
    voice = connected(client, "300")
    client.app.state.bot.state.audio_mode = "music"
    for action in ("play", "queue"):
        assert client.post("/api/music/likes/" + action, headers=headers).status_code == 403
    voice.channel.members.append(SimpleNamespace(id=200, bot=False))
    client.app.state.bot.state.audio_mode = "soundboard"
    assert client.post("/api/music/likes/play", headers=headers).status_code == 409
    client.app.state.bot.state.audio_mode = "music"
    music = client.app.state.music
    music.play_playlist = AsyncMock(return_value={"ok": True})
    assert client.post("/api/music/likes/play", headers=headers).status_code == 200
    args = music.play_playlist.call_args.args
    assert args[0][0]["title"] == "Song"
    assert args[1]["id"] == "200"
    assert args[2] == {"id": "liked:200", "name": "Liked Songs"}
    response = client.post("/api/music/likes/queue", headers=headers)
    assert response.status_code == 200
    assert response.json()["queue"][0]["track"]["source_id"] == "abcdefghijk"
    client.put("/api/music/likes", headers=headers, json={"track": song(), "liked": False})
    assert client.post("/api/music/likes/play", headers=headers).status_code == 409
    override(client, "200", control_music=False)
    assert client.post("/api/music/likes/queue", headers=headers).status_code == 403


def test_likes_refresh_is_filtered_to_its_account() -> None:
    message = 'event: music_likes\ndata: {"user_id":"200"}\n\n'
    viewer = SimpleNamespace(state=SimpleNamespace(user={"id": "200"}))
    stranger = SimpleNamespace(state=SimpleNamespace(user={"id": "100"}))
    assert Events.for_viewer(message, viewer) == "event: music_likes\ndata: {}\n\n"
    assert Events.for_viewer(message, stranger) is None


def test_liked_tracks_join_existing_bounded_download_plan(client: TestClient) -> None:
    user = {"id": "200", "display_name": "Member"}
    track = MusicTrack.model_validate(song()).model_dump()
    store = client.app.state.music_store
    playlist = store.create("Shared", user)
    store.append(playlist["id"], user, [track])
    store.set_like(user, track, liked=True)
    pages = store.liked_cache_page("")
    assert json.loads(pages[0]["tracks"]) == [track]
    plan = asyncio.run(client.app.state.music_cache.plan())
    assert len(plan) == 1
    store.delete(playlist["id"], {**user, "admin": False})
    assert len(asyncio.run(client.app.state.music_cache.plan())) == 1
    store.set_like(user, track, liked=False)
    assert asyncio.run(client.app.state.music_cache.plan()) == {}


def test_likes_survive_database_reopening(tmp_path: Path) -> None:
    path = tmp_path / "likes.sqlite3"
    user = {"id": "200", "display_name": "Member"}
    db = Database(path)
    track = MusicTrack.model_validate(song()).model_dump()
    MusicStore(db).set_like(user, track, liked=True)
    db.close()
    reopened = Database(path)
    assert MusicStore(reopened).liked(user)["tracks"] == [track]
    assert MusicStore(reopened).like_summary(user)["keys"] == ["youtube:abcdefghijk"]
    reopened.close()
