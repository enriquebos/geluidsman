from __future__ import annotations

from typing import TYPE_CHECKING

import pytest

from app.music_store import MusicStore
from tests.test_music_routes import client as music_fixture
from tests.test_music_routes import patch_playlist, song

if TYPE_CHECKING:
    from collections.abc import Iterator
    from pathlib import Path

    from fastapi.testclient import TestClient


@pytest.fixture
def client(tmp_path: Path) -> Iterator[TestClient]:
    yield from music_fixture.__wrapped__(tmp_path)


def test_playlist_library_artwork_is_bounded_without_loading_song_details(client: TestClient) -> None:
    owner = {"x-member": "200"}
    playlist = client.post("/api/music/playlists", json={"name": "Library artwork"}, headers=owner).json()
    path = "/api/music/playlists/" + playlist["id"]
    assert client.get("/api/music/playlists").json()["playlists"][0]["artwork"] == []
    tracks = [
        song(f"artwork{i:04d}", thumbnail=f"https://i.ytimg.com/vi/artwork{i:04d}/hqdefault.jpg") for i in range(7)
    ]
    tracks[1]["thumbnail"] = tracks[0]["thumbnail"]
    tracks[3]["thumbnail"] = None
    assert patch_playlist(client, path, json={"tracks": tracks}, headers=owner).status_code == 200
    response = client.get("/api/music/playlists?limit=1", headers={"x-member": "300"})
    result = response.json()["playlists"][0]
    assert result["artwork"] == [tracks[0]["thumbnail"], tracks[2]["thumbnail"]]
    assert result["tracks"] == []
    assert result["track_count"] == len(tracks)
    assert len(response.content) < 3000


@pytest.mark.parametrize(
    ("values", "expected"),
    [
        ([None, 123, "https://example.com/image.jpg", "http://i.ytimg.com/image.jpg"], []),
        (["https://[", "https://i.scdn.co/image?id=secret#fragment"], ["https://i.scdn.co/image"]),
        (["https://i.ytimg.com/" + "x" * 2048], []),
        (["https://mosaic.scdn.co/image"] * 8, ["https://mosaic.scdn.co/image"]),
    ],
)
def test_playlist_artwork_sanitizes_and_deduplicates_small_public_image_lists(values: list, expected: list) -> None:
    assert MusicStore.artwork(values) == expected
