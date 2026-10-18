from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING
from unittest.mock import AsyncMock, Mock

import httpx
import pytest

from app.music_sources import MusicSourceError
from tests.test_music_routes import client as music_fixture
from tests.test_music_routes import override, patch_playlist, song

if TYPE_CHECKING:
    from collections.abc import Iterator
    from pathlib import Path

    from fastapi.testclient import TestClient


@pytest.fixture
def client(tmp_path: Path) -> Iterator[TestClient]:
    yield from music_fixture.__wrapped__(tmp_path)


def playlist(client: TestClient, track: dict, *, collaborative: bool = False) -> dict:
    owner = {"x-member": "200"}
    created = client.post(
        "/api/music/playlists", json={"name": "Songs", "collaborative": collaborative}, headers=owner
    ).json()
    return patch_playlist(
        client, "/api/music/playlists/" + created["id"], json={"tracks": [track]}, headers=owner
    ).json()


def spotify_song(**changes: object) -> dict:
    return song("A" * 22, provider="spotify", title="Round Ere", artist="K Motionz", **changes)


def test_playlist_name_edit_preserves_spotify_metadata_and_cached_audio(client: TestClient) -> None:
    row = playlist(client, spotify_song(youtube_id="abcdefghijk"))
    sources = client.app.state.music_sources
    sources.resolve = AsyncMock()
    cache = client.app.state.music_cache
    cache.replace = AsyncMock()
    response = client.patch(
        f"/api/music/playlists/{row['id']}/tracks/0",
        json={"name": " My own name ", "expected_updated_at": row["updated_at"]},
        headers={"x-member": "200"},
    )
    assert response.status_code == 200, response.text
    track = response.json()["tracks"][0]
    assert track["title"] == "My own name"
    assert track["original_title"] == "Round Ere"
    assert track["provider"] == "spotify"
    assert track["source_id"] == "A" * 22
    assert track["youtube_id"] == "abcdefghijk"
    assert track["match_locked"] is False
    assert len(response.json()["cache"]) == 1
    sources.resolve.assert_not_awaited()
    cache.replace.assert_not_awaited()
    second = client.patch(
        f"/api/music/playlists/{row['id']}/tracks/0",
        json={"name": "Another name", "expected_updated_at": response.json()["updated_at"]},
        headers={"x-member": "200"},
    )
    assert second.json()["tracks"][0]["original_title"] == "Round Ere"


@pytest.mark.parametrize("provider", ["spotify", "youtube"])
def test_source_edit_resolves_before_atomic_update_and_replaces_cached_recording(
    client: TestClient, provider: str
) -> None:
    row = playlist(client, spotify_song(youtube_id="abcdefghijk") if provider == "spotify" else song())
    chosen = song("2ZVgOWAflII", title="K Motionz - Round Ere", duration=121)
    sources = client.app.state.music_sources
    sources.resolve = AsyncMock(return_value={"tracks": [chosen], "warnings": []})
    cache = client.app.state.music_cache
    cache.replace = AsyncMock()
    response = client.patch(
        f"/api/music/playlists/{row['id']}/tracks/0",
        json={
            "name": "Round Ere (correct recording)",
            "source_url": "https://youtu.be/2ZVgOWAflII?si=discarded",
            "expected_updated_at": row["updated_at"],
        },
        headers={"x-member": "200"},
    )
    assert response.status_code == 200, response.text
    track = response.json()["tracks"][0]
    assert track["youtube_id"] == "2ZVgOWAflII"
    assert track["youtube_title"] == "K Motionz - Round Ere"
    assert track["match_locked"] is True
    assert track["title"] == "Round Ere (correct recording)"
    assert track["source_id"] == ("A" * 22 if provider == "spotify" else "2ZVgOWAflII")
    assert track["duration"] == (120 if provider == "spotify" else 121)
    sources.resolve.assert_awaited_once_with("https://www.youtube.com/watch?v=2ZVgOWAflII")
    cache.replace.assert_awaited_once_with(row["tracks"][0], track)


@pytest.mark.parametrize("automatic", [False, True])
def test_unchanged_source_does_not_download_again_or_lock_automatic_match(
    client: TestClient, *, automatic: bool
) -> None:
    row = playlist(client, spotify_song(**({} if automatic else {"youtube_id": "abcdefghijk"})))
    sources = client.app.state.music_sources
    sources.resolve = AsyncMock()
    cache = client.app.state.music_cache
    cache.recording = Mock(return_value={"youtube_id": "abcdefghijk"})
    cache.replace = AsyncMock()
    response = client.patch(
        f"/api/music/playlists/{row['id']}/tracks/0",
        json={
            "name": "Custom name",
            "source_url": "https://www.youtube.com/watch?v=abcdefghijk",
            "expected_updated_at": row["updated_at"],
        },
        headers={"x-member": "200"},
    )
    assert response.status_code == 200, response.text
    assert response.json()["tracks"][0]["match_locked"] is False
    sources.resolve.assert_not_awaited()
    cache.replace.assert_not_awaited()


@pytest.mark.parametrize(
    "source_url",
    [
        "https://127.0.0.1/abcdefghijk",
        "https://www.youtube.com/playlist?list=PL1234567890123456",
        "https://www.youtube.com/watch?v=abcdefghijk&list=PL1234567890123456",
        "https://open.spotify.com/track/" + "A" * 22,
        "file:///etc/passwd",
        "Artist song",
    ],
)
def test_source_edit_only_accepts_individual_youtube_video_links(client: TestClient, source_url: str) -> None:
    row = playlist(client, song())
    sources = client.app.state.music_sources
    sources.resolve = AsyncMock()
    response = client.patch(
        f"/api/music/playlists/{row['id']}/tracks/0",
        json={"source_url": source_url, "expected_updated_at": row["updated_at"]},
        headers={"x-member": "200"},
    )
    assert response.status_code == 422
    assert client.get("/api/music/playlists/" + row["id"]).json()["tracks"] == row["tracks"]
    sources.resolve.assert_not_awaited()


@pytest.mark.parametrize("failure", ["unavailable", "wrong_video", "malformed", "too_long"])
def test_source_failures_leave_the_original_track_and_cache_intact(client: TestClient, failure: str) -> None:
    row = playlist(client, spotify_song(youtube_id="abcdefghijk"))
    sources = client.app.state.music_sources
    chosen = song("2ZVgOWAflII")
    if failure == "wrong_video":
        chosen["source_id"] = "lmnopqrstuv"
    elif failure == "malformed":
        chosen["duration"] = 0
    elif failure == "too_long":
        chosen["duration"] = sources.settings.max_source_seconds + 1
    sources.resolve = AsyncMock(return_value={"tracks": [chosen]})
    if failure == "unavailable":
        sources.resolve.side_effect = MusicSourceError("This recording is unavailable.")
    cache = client.app.state.music_cache
    cache.replace = AsyncMock()
    response = client.patch(
        f"/api/music/playlists/{row['id']}/tracks/0",
        json={
            "source_url": "https://www.youtube.com/watch?v=2ZVgOWAflII",
            "expected_updated_at": row["updated_at"],
        },
        headers={"x-member": "200"},
    )
    assert response.status_code == (422 if failure == "too_long" else 400), response.text
    assert client.get("/api/music/playlists/" + row["id"]).json()["tracks"] == row["tracks"]
    cache.replace.assert_not_awaited()


@pytest.mark.parametrize("change", ["reordered", "private", "permission_revoked"])
def test_source_edit_rechecks_revision_and_permissions_after_slow_resolution(client: TestClient, change: str) -> None:
    row = playlist(client, song(), collaborative=True)
    path = "/api/music/playlists/" + row["id"]
    started, release = asyncio.Event(), asyncio.Event()

    async def resolve(_query: str) -> dict:
        started.set()
        await release.wait()
        return {"tracks": [song("2ZVgOWAflII")]}

    client.app.state.music_sources.resolve = resolve
    client.app.state.music_cache.replace = AsyncMock()

    async def race() -> None:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=client.app), base_url="http://testserver"
        ) as browser:
            pending = asyncio.create_task(
                browser.patch(
                    path + "/tracks/0",
                    json={
                        "source_url": "https://youtu.be/2ZVgOWAflII",
                        "expected_updated_at": row["updated_at"],
                    },
                    headers={"x-member": "300"},
                )
            )
            await started.wait()
            if change == "permission_revoked":
                override(client, "300", view_music=False)
            else:
                result = await browser.patch(
                    path,
                    json={
                        "expected_updated_at": row["updated_at"],
                        **({"tracks": [song("lmnopqrstuv")]} if change == "reordered" else {"collaborative": False}),
                    },
                    headers={"x-member": "200"},
                )
                assert result.status_code == 200
            release.set()
            response = await pending
            assert response.status_code == (409 if change == "reordered" else 403), response.text

    client.portal.call(race)
    track = client.get(path).json()["tracks"][0]
    assert track["source_id"] == ("lmnopqrstuv" if change == "reordered" else "abcdefghijk")
    client.app.state.music_cache.replace.assert_not_awaited()


def test_playlist_edit_rejects_stale_revision_and_missing_song_before_resolving(client: TestClient) -> None:
    row = playlist(client, song())
    path = "/api/music/playlists/" + row["id"]
    sources = client.app.state.music_sources
    sources.resolve = AsyncMock()
    body = {"source_url": "https://youtu.be/2ZVgOWAflII", "expected_updated_at": row["updated_at"]}
    assert client.patch(path + "/tracks/1", json=body, headers={"x-member": "200"}).status_code == 404
    assert patch_playlist(client, path, json={"name": "Changed"}, headers={"x-member": "200"}).status_code == 200
    assert client.patch(path + "/tracks/0", json=body, headers={"x-member": "200"}).status_code == 409
    sources.resolve.assert_not_awaited()


def test_atomic_track_append_respects_collaboration_and_preserves_concurrent_additions(client: TestClient) -> None:
    row = playlist(client, song())
    path = "/api/music/playlists/" + row["id"]
    visitor = {"x-member": "300"}
    assert client.post(path + "/tracks", json={"track": song("lmnopqrstuv")}, headers=visitor).status_code == 403
    assert patch_playlist(client, path, json={"collaborative": True}, headers={"x-member": "200"}).status_code == 200

    async def append() -> None:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=client.app), base_url="http://testserver"
        ) as browser:
            responses = await asyncio.gather(
                *(
                    browser.post(path + "/tracks", json={"track": song(identity)}, headers=visitor)
                    for identity in ("lmnopqrstuv", "2ZVgOWAflII")
                )
            )
        assert all(response.status_code == 200 for response in responses)

    client.portal.call(append)
    result = client.get(path).json()
    assert result["track_count"] == 3
    assert {track["source_id"] for track in result["tracks"]} == {"abcdefghijk", "lmnopqrstuv", "2ZVgOWAflII"}
    assert client.get("/api/music").json()["queue"] == []
    override(client, "300", view_music=False)
    assert client.post(path + "/tracks", json={"track": song()}, headers=visitor).status_code == 403


def test_editable_playlist_picker_filters_before_pagination_and_keeps_my_playlists_first(client: TestClient) -> None:
    mine = playlist(client, song())
    hidden = client.post("/api/music/playlists", json={"name": "Hidden"}, headers={"x-member": "300"}).json()
    shared = client.post(
        "/api/music/playlists", json={"name": "Shared", "collaborative": True}, headers={"x-member": "300"}
    ).json()
    query = "/api/music/playlists?editable_only=true&limit=1"
    first = client.get(query, headers={"x-member": "200"}).json()
    assert first["total"] == 2
    assert [row["id"] for row in first["playlists"]] == [mine["id"]]
    second = client.get(query + "&offset=1", headers={"x-member": "200"}).json()
    assert [row["id"] for row in second["playlists"]] == [shared["id"]]
    assert hidden["id"] not in {row["id"] for row in [*first["playlists"], *second["playlists"]]}
    assert client.get(query).json()["total"] == 3


@pytest.mark.parametrize(
    "changes",
    [{}, {"name": " "}, {"name": "x" * 301}, {"source_url": " "}, {"expected_updated_at": -1}],
)
def test_playlist_track_edit_validates_partial_input(client: TestClient, changes: dict) -> None:
    row = playlist(client, song())
    response = client.patch(
        f"/api/music/playlists/{row['id']}/tracks/0",
        json={"expected_updated_at": row["updated_at"], **changes},
        headers={"x-member": "200"},
    )
    assert response.status_code == 422
