from __future__ import annotations

import asyncio
import hashlib
import json
import shutil
import threading
from typing import TYPE_CHECKING
from unittest.mock import AsyncMock

import httpx
import pytest

from app.audio_processing import measure_loudness, process
from app.music_cache import MAX_MANIFEST_BYTES, MusicCache, cache_key
from app.music_sources import MusicSourceError
from app.music_uploads import MusicUpload
from tests.test_music_cache import until
from tests.test_music_playlist_tracks import playlist, spotify_song
from tests.test_music_routes import client as music_fixture
from tests.test_music_routes import override, patch_playlist, song

if TYPE_CHECKING:
    from collections.abc import AsyncIterator, Iterator
    from pathlib import Path

    from fastapi.testclient import TestClient


@pytest.fixture
def client(tmp_path: Path) -> Iterator[TestClient]:
    yield from music_fixture.__wrapped__(tmp_path)


@pytest.fixture(scope="module")
def mp3(tmp_path_factory: pytest.TempPathFactory) -> bytes:
    path = tmp_path_factory.mktemp("playlist-mp3") / "recording.mp3"
    asyncio.run(process([shutil.which("ffmpeg"), "-v", "error", "-f", "lavfi", "-i", "sine=duration=0.5", str(path)]))
    return path.read_bytes()


def upload(client: TestClient, row: dict, data: bytes, **options: str) -> httpx.Response:
    return client.post(
        f"/api/music/playlists/{row['id']}/tracks/0/upload",
        params={
            "filename": options.get("filename", "recording.mp3"),
            "metadata": json.dumps({"name": "Local recording", "expected_updated_at": row["updated_at"]}),
        },
        content=data,
        headers={"x-member": options.get("member", "200")},
    )


def assert_clean(client: TestClient) -> None:
    cache = client.app.state.music_cache
    with cache.metadata_lock:
        assert not list(cache.root.glob("*.part"))
    assert not any(key.startswith("upload-") for key in cache.budget.reservations)
    assert not client.app.state.clip_tasks


def test_mp3_replaces_only_playlist_recording_and_survives_restart(client: TestClient, mp3: bytes) -> None:
    row = playlist(client, spotify_song())
    state = client.app.state
    state.music.queue = [{"id": "queued", "track": dict(row["tracks"][0])}]
    response = upload(client, row, mp3, filename="C:\\music\\recording.MP3")
    assert response.status_code == 200, response.text
    track = response.json()["tracks"][0]
    assert track["upload_id"] == hashlib.sha256(mp3).hexdigest()
    assert track["upload_name"] == "recording.MP3"
    assert track["original_title"] == "Round Ere"
    assert track["source_id"] == row["tracks"][0]["source_id"]
    assert 0.4 < track["duration"] < 0.7
    assert response.json()["cache"][0]["state"] == "cached"
    assert response.json()["cache"][0]["source_url"] is None
    assert not state.music.queue[0]["track"].get("upload_id")
    cache = state.music_cache
    key = cache_key(track)
    assert (cache.root / (key + ".audio")).read_bytes() == mp3
    assert cache.entry_key(row["tracks"][0]) != key
    assert cache.used == len(mp3)
    restored = MusicCache(state.db, state.music_sources, state.music_store, state.events)
    restored.load()
    assert restored.status(track)["state"] == "cached"
    assert restored.used == len(mp3)
    assert_clean(client)


def test_same_mp3_reuses_file_across_song_identities_and_storage_references(client: TestClient, mp3: bytes) -> None:
    first = upload(client, playlist(client, song()), mp3).json()
    second = upload(client, playlist(client, spotify_song()), mp3).json()
    state = client.app.state
    key = cache_key(first["tracks"][0])
    assert key == cache_key(second["tracks"][0])
    assert len(list(state.music_cache.root.glob("*.audio"))) == 1
    assert state.music_cache.used == len(mp3)
    inventory = client.get("/api/admin/storage").json()
    item = next(item for item in inventory["items"] if item["id"] == "music:" + key)
    assert not item["removable"]
    assert len(item["references"]) == 2
    assert inventory["summary"]["used_bytes"] == len(mp3) + sum(state.music_cache.manifest_sizes.values())
    downloads = client.get("/api/downloads", headers={"x-member": "200"}).json()
    assert len([item for item in downloads["groups"]["completed"] if item["id"] == "music:" + key]) == 1
    assert_clean(client)


def test_local_mp3_decodes_without_network_or_voice(client: TestClient, mp3: bytes) -> None:
    track = upload(client, playlist(client, song()), mp3).json()["tracks"][0]
    sources = client.app.state.music_sources
    sources.match = AsyncMock(side_effect=AssertionError("Network matching must not run"))

    async def verify() -> None:
        source = await sources.source(track, 0.1, 1)
        try:
            assert await asyncio.to_thread(source.read)
        finally:
            source.cleanup()

    client.portal.call(verify)
    sources.match.assert_not_awaited()


def test_uploaded_analysis_failure_retry_is_authorized_and_reuses_measurement(
    client: TestClient, mp3: bytes, monkeypatch: pytest.MonkeyPatch
) -> None:
    measure = AsyncMock(side_effect=TimeoutError)
    monkeypatch.setattr("app.music_normalization.measure_loudness", measure)
    row = upload(client, playlist(client, song()), mp3).json()
    track = row["tracks"][0]
    state = client.app.state
    cache = state.music_cache
    key = cache.entry_key(track)
    client.portal.call(until, lambda: cache.entries[key]["normalization"]["state"] == "failed")
    failed = client.get("/api/downloads", headers={"x-member": "200"}).json()["groups"]["attention"]
    item = next(item for item in failed if item["id"] == "music:" + key)
    assert item["can_retry"]
    assert item["status"] == "analysis_failed"
    assert item["bytes"] == len(mp3)
    assert item["guidance"] is None
    assert client.post(
        f"/api/downloads/music:{key}", json={"action": "retry"}, headers={"x-member": "300"}
    ).status_code in {403, 404, 409}
    measure = AsyncMock(wraps=measure_loudness)
    monkeypatch.setattr("app.music_normalization.measure_loudness", measure)
    response = client.post(f"/api/downloads/music:{key}", json={"action": "retry"}, headers={"x-member": "200"})
    assert response.is_success, response.text
    client.portal.call(until, lambda: cache.entries[key]["normalization"]["state"] == "ready")
    assert measure.await_count == 1
    normalized = dict(cache.entries[key]["normalization"])
    assert normalized["integrated_lufs"] is not None
    second = upload(client, playlist(client, spotify_song()), mp3).json()
    assert cache.entry_key(second["tracks"][0]) == key
    assert cache.entries[key]["normalization"] == normalized
    assert (cache.root / (key + ".audio")).read_bytes() == mp3
    assert measure.await_count == 1
    assert_clean(client)


def test_uploads_are_retained_until_reviewed_cleanup_and_missing_files_never_fall_back(
    client: TestClient,
    mp3: bytes,
) -> None:
    row = upload(client, playlist(client, song()), mp3).json()
    track = row["tracks"][0]
    cache = client.app.state.music_cache
    key = cache_key(track)
    assert client.delete("/api/music/playlists/" + row["id"], headers={"x-member": "200"}).is_success
    client.portal.call(cache.prune, set())
    assert key in cache.entries
    review = client.post("/api/admin/storage/review", json={"ids": ["music:" + key]}).json()
    result = client.post("/api/admin/storage/remove", json={"ids": ["music:" + key], "token": review["token"]})
    assert result.status_code == 200, result.text
    assert key not in cache.entries
    with pytest.raises(MusicSourceError, match="Upload it again"):
        client.portal.call(cache.ensure, track)
    assert cache.status(track)["state"] == "failed"
    assert not cache.active_downloads.get(key)


@pytest.mark.parametrize("member", ["100", "200", "300"])
def test_upload_authorization_before_reading_body(client: TestClient, mp3: bytes, member: str) -> None:
    row = playlist(client, song())
    response = upload(client, row, mp3, member=member)
    assert response.status_code == (403 if member == "300" else 200), response.text
    assert_clean(client)


@pytest.mark.parametrize("change", ["permission", "revision", "sharing", "limit"])
def test_upload_rechecks_changes_during_validation(
    client: TestClient,
    mp3: bytes,
    monkeypatch: pytest.MonkeyPatch,
    change: str,
) -> None:
    row = playlist(client, song(), collaborative=True)
    validate = MusicUpload.probe
    state = client.app.state

    async def probe(self: MusicUpload) -> float:
        duration = await validate(self)
        if change == "permission":
            override(client, "300", view_music=False)
        elif change == "limit":
            state.music_cache.budget.limit = 1
        else:
            owner = {"id": "200", "admin": False}
            state.music_store.update(row["id"], owner, {"name": "Changed", "collaborative": change != "sharing"})
        return duration

    monkeypatch.setattr(MusicUpload, "probe", probe)
    result = upload(client, row, mp3, member="300")
    assert result.status_code == (403 if change in {"permission", "sharing"} else 409), result.text
    assert not state.music_store.playlist(row["id"])["tracks"][0].get("upload_id")
    assert not list(state.music_cache.root.glob("*.audio"))
    assert_clean(client)


@pytest.mark.parametrize("invalid", ["extension", "empty", "corrupt", "oversize", "duration", "disk"])
def test_invalid_uploads_leave_original_and_no_partial_files(
    client: TestClient,
    mp3: bytes,
    monkeypatch: pytest.MonkeyPatch,
    invalid: str,
) -> None:
    row = playlist(client, song())
    state = client.app.state
    filename = "song.wav" if invalid == "extension" else "song.mp3"
    data = b"" if invalid == "empty" else b"not audio" if invalid == "corrupt" else mp3
    if invalid == "oversize":
        state.music_sources.settings.max_import_bytes = len(mp3) - 1
    elif invalid == "duration":
        state.music_sources.settings.max_source_seconds = 0.1
    elif invalid == "disk":
        monkeypatch.setattr(state.music_cache.budget, "reserve", lambda *_args: MAX_MANIFEST_BYTES)
    response = upload(client, row, data, filename=filename)
    assert response.status_code in {400, 409, 422}, response.text
    assert state.music_store.playlist(row["id"])["tracks"] == row["tracks"]
    assert not list(state.music_cache.root.glob("*.audio"))
    assert_clean(client)


def test_switching_upload_back_to_same_youtube_id_resolves_recording(client: TestClient, mp3: bytes) -> None:
    row = upload(client, playlist(client, song()), mp3).json()
    sources = client.app.state.music_sources
    sources.resolve = AsyncMock(return_value={"tracks": [song()], "warnings": []})
    response = client.patch(
        f"/api/music/playlists/{row['id']}/tracks/0",
        json={"source_url": song()["url"], "expected_updated_at": row["updated_at"]},
        headers={"x-member": "200"},
    )
    assert response.status_code == 200, response.text
    assert response.json()["tracks"][0]["upload_id"] is None
    assert response.json()["tracks"][0]["duration"] == 120
    sources.resolve.assert_awaited_once()


def test_cancelled_transfer_releases_storage_and_preserves_song(client: TestClient, mp3: bytes) -> None:
    row = playlist(client, song())

    async def verify() -> None:
        started, waiting = asyncio.Event(), asyncio.Event()

        async def body() -> AsyncIterator[bytes]:
            yield mp3
            started.set()
            await waiting.wait()

        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=client.app), base_url="http://test") as http:
            task = asyncio.create_task(
                http.post(
                    f"/api/music/playlists/{row['id']}/tracks/0/upload",
                    params={
                        "filename": "song.mp3",
                        "metadata": json.dumps(
                            {
                                "name": "Cancelled",
                                "expected_updated_at": row["updated_at"],
                            }
                        ),
                    },
                    headers={"x-member": "200"},
                    content=body(),
                )
            )
            await asyncio.wait_for(started.wait(), 5)
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task

    client.portal.call(verify)
    assert client.app.state.music_store.playlist(row["id"])["tracks"] == row["tracks"]
    assert_clean(client)


def test_new_upload_does_not_remove_previous_uploaded_queue_snapshot(client: TestClient, mp3: bytes) -> None:
    row = upload(client, playlist(client, song()), mp3).json()
    previous = row["tracks"][0]
    client.app.state.music.queue = [{"id": "saved", "track": previous}]
    row = patch_playlist(
        client,
        "/api/music/playlists/" + row["id"],
        json={"tracks": [song()]},
        headers={"x-member": "200"},
    ).json()
    assert not row["tracks"][0].get("upload_id")
    cache = client.app.state.music_cache
    client.portal.call(cache.prune, set())
    assert client.portal.call(cache.local, previous)["container"] == "mp3"
    item = next(item for item in client.get("/api/admin/storage").json()["items"] if item["key"] == cache_key(previous))
    assert not item["removable"]


def test_partial_install_failure_removes_files_and_releases_reservation(
    client: TestClient,
    mp3: bytes,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    row = playlist(client, song())
    cache = client.app.state.music_cache

    def failed(key: str, _entry: dict) -> None:
        (cache.root / (key + ".part")).replace(cache.root / (key + ".audio"))
        message = "Disk full"
        raise OSError(message)

    monkeypatch.setattr(cache, "commit", failed)
    result = upload(client, row, mp3)
    assert result.status_code == 507, result.text
    assert client.app.state.music_store.playlist(row["id"])["tracks"] == row["tracks"]
    assert not list(cache.root.glob("*.audio"))
    assert cache.used == 0
    assert_clean(client)


def test_cancellation_during_commit_finishes_a_consistent_save(
    client: TestClient,
    mp3: bytes,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    row = playlist(client, song())
    installed, release = threading.Event(), threading.Event()
    install = MusicUpload.install

    def delayed(self: MusicUpload, track: dict) -> None:
        install(self, track)
        installed.set()
        assert release.wait(5)

    monkeypatch.setattr(MusicUpload, "install", delayed)

    async def verify() -> None:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=client.app), base_url="http://test") as http:
            task = asyncio.create_task(
                http.post(
                    f"/api/music/playlists/{row['id']}/tracks/0/upload",
                    params={
                        "filename": "song.mp3",
                        "metadata": json.dumps(
                            {
                                "name": "Saved",
                                "expected_updated_at": row["updated_at"],
                            }
                        ),
                    },
                    headers={"x-member": "200"},
                    content=mp3,
                )
            )
            try:
                assert await asyncio.to_thread(installed.wait, 5)
                task.cancel()
            finally:
                release.set()
            with pytest.raises(asyncio.CancelledError):
                await task

    client.portal.call(verify)
    track = client.app.state.music_store.playlist(row["id"])["tracks"][0]
    assert track["title"] == "Saved"
    assert client.portal.call(client.app.state.music_cache.local, track)["container"] == "mp3"
    assert_clean(client)


def test_liked_song_upload_is_private_and_rejects_a_stale_revision(client: TestClient, mp3: bytes) -> None:
    track = spotify_song()
    assert (
        client.put("/api/music/likes", json={"track": track, "liked": True}, headers={"x-member": "200"}).status_code
        == 200
    )
    liked = client.get("/api/music/likes/playlist", headers={"x-member": "200"}).json()
    params = {
        "filename": "local.mp3",
        "metadata": json.dumps({"name": "My local song", "expected_updated_at": liked["updated_at"]}),
    }
    response = client.post("/api/music/likes/tracks/0/upload", params=params, content=mp3, headers={"x-member": "200"})
    assert response.status_code == 200, response.text
    assert response.json()["tracks"][0]["upload_id"] == hashlib.sha256(mp3).hexdigest()
    assert client.get("/api/music/likes/playlist", headers={"x-member": "100"}).json()["tracks"] == []
    assert (
        client.post(
            "/api/music/likes/tracks/0/upload", params=params, content=mp3, headers={"x-member": "200"}
        ).status_code
        == 409
    )
    downloads = client.get("/api/downloads", headers={"x-member": "200"}).json()
    row = next(row for row in downloads["groups"]["completed"] if row["name"] == "My local song")
    assert row["editable_references"][0]["playlist_id"] == "liked"
    assert_clean(client)


def test_source_replacement_updates_only_matching_future_saved_entries(client: TestClient, mp3: bytes) -> None:
    row = playlist(client, spotify_song())
    state = client.app.state
    original = dict(row["tracks"][0])
    entries = [
        {"id": key, "track": dict(original), "playlist_id": playlist_id, "requester_id": "200", "origin": "playlist"}
        for key, playlist_id in [("current", row["id"]), ("future", row["id"]), ("other", "another")]
    ]
    entries.append({"id": "independent", "track": dict(original), "requester_id": "200", "origin": "manual"})
    state.music.queue = entries
    state.music.index = 0
    state.music.state = "paused"
    state.music.position = 12
    state.music.playlist_entries = [dict(entry, track=dict(entry["track"])) for entry in entries[:3]]
    result = upload(client, row, mp3)
    assert result.status_code == 200, result.text
    replacement = result.json()["tracks"][0]
    assert state.music.queue[0]["track"] == original
    assert state.music.queue[1]["track"] == replacement
    assert state.music.queue[2]["track"] == original
    assert state.music.queue[3]["track"] == original
    assert state.music.position == 12
    assert state.music.state == "paused"
    assert state.music.playlist_entries[0]["track"] == replacement
    assert [entry["id"] for entry in state.music.queue] == ["current", "future", "other", "independent"]
    assert state.music_store.load_player()["queue"][1]["track"] == replacement


def test_restoration_reconciles_old_saved_sources_without_playing(client: TestClient, mp3: bytes) -> None:
    row = playlist(client, spotify_song())
    original = dict(row["tracks"][0])
    replacement = upload(client, row, mp3).json()["tracks"][0]
    state = client.app.state
    state.music.queue = [
        {"id": key, "track": dict(original), "playlist_id": row["id"], "requester_id": "200"}
        for key in ["current", "future"]
    ]
    state.music.index = 0
    state.music.state = "paused"
    client.portal.call(state.music.restore_saved_sources)
    assert state.music.queue[0]["track"] == original
    assert state.music.queue[1]["track"] == replacement
    assert state.music.state == "paused"
    rows = client.get("/api/downloads", headers={"x-member": "200"}).json()
    assert any(row["id"] == "music:" + cache_key(replacement) for row in rows["groups"]["completed"])
    assert not any(row["id"] == "music:" + cache_key(replacement) for row in rows["groups"]["waiting"])


def test_saved_queue_provenance_rejects_a_replaced_recording(client: TestClient, mp3: bytes) -> None:
    row = playlist(client, spotify_song())
    original = row["tracks"][0]
    replacement = upload(client, row, mp3).json()["tracks"][0]
    player = client.app.state.music
    user = {"id": "200", "display_name": "Member"}

    async def verify() -> None:
        with pytest.raises(ValueError, match="saved recording changed"):
            await player.enqueue([original], user, saved_origin={"playlist_id": row["id"], "owner_id": "200"})
        await player.enqueue([replacement], user, saved_origin={"playlist_id": row["id"], "owner_id": "200"})

    client.portal.call(verify)
    assert len(player.queue) == 1
    assert player.queue[0]["saved_origin"]["playlist_id"] == row["id"]
    assert client.app.state.music_store.load_player()["queue"][0]["track"] == replacement


def test_legacy_liked_collection_reconciliation_keeps_account_and_current_recording(client: TestClient) -> None:
    state = client.app.state
    old, new = spotify_song(), {**spotify_song(), "upload_id": "a" * 64}
    state.music.queue = [
        {"id": str(index), "track": dict(old), "playlist_id": "liked:200", "requester_id": owner}
        for index, owner in enumerate(["200", "200", "100"])
    ]
    state.music.index = 0
    assert state.music.replace_saved_entries("liked", "200", old, new)
    assert [item["track"].get("upload_id") for item in state.music.queue] == [None, "a" * 64, None]
