from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from functools import partial
from typing import TYPE_CHECKING
from unittest.mock import patch

import pytest
from fastapi import HTTPException

from app.db import Database
from app.music_models import MusicTrack
from app.music_store import MusicStore
from tests.test_music_routes import client, override, patch_playlist, song

if TYPE_CHECKING:
    from fastapi.testclient import TestClient

__all__ = ["client"]


def test_library_membership_is_visible_and_updates_require_playlist_editing(client: TestClient) -> None:
    owner = {"x-member": "200"}
    member = {"x-member": "300"}
    playlist = client.post("/api/music/playlists", headers=owner, json={"name": "Drums"}).json()
    path = "/api/music/playlists/" + playlist["id"] + "/membership"
    query = "/api/music/library?provider=youtube&source_id=abcdefghijk"
    assert client.get(query, headers=member).json()["playlists"][0]["editable"] is False
    assert client.put(path, headers=member, json={"track": song(), "saved": True}).status_code == 403
    saved = client.put(path, headers=owner, json={"track": song(), "saved": True})
    assert saved.status_code == 200
    assert saved.json()["track_count"] == 1
    assert client.put(path, headers=owner, json={"track": song(title="Renamed"), "saved": True}).json() == saved.json()
    row = client.get(query, headers=member).json()["playlists"][0]
    assert row["saved"] is True
    assert "tracks" not in row
    assert client.get(query.replace("library?", "library/status?"), headers=member).json() == {"saved": True}
    patch_playlist(client, "/api/music/playlists/" + playlist["id"], headers=owner, json={"collaborative": True})
    assert client.put(path, headers=member, json={"track": song(), "saved": False}).status_code == 200
    assert client.get(query.replace("library?", "library/status?"), headers=member).json() == {"saved": False}
    override(client, "300", view_music=False)
    assert client.get(query, headers=member).status_code == 403
    assert client.put(path, headers=member, json={"track": song(), "saved": True}).status_code == 403


def test_membership_changes_are_atomic_preserve_pinned_tracks_and_remove_only_matching_songs(
    client: TestClient,
) -> None:
    store = client.app.state.music_store
    user = {"id": "200", "display_name": "Member", "admin": False}
    playlist = store.create("Drums", user)
    pinned = MusicTrack.model_validate(song(title="Pinned", match_locked=True)).model_dump()
    store.append(playlist["id"], user, [pinned])
    tracks = [MusicTrack.model_validate(song(f"{index:011d}")).model_dump() for index in range(12)]
    with ThreadPoolExecutor(max_workers=4) as pool:
        list(pool.map(lambda track: store.set_membership(playlist["id"], user, track, saved=True), tracks * 2))
    store.set_membership(playlist["id"], user, MusicTrack.model_validate(song()).model_dump(), saved=True)
    result = store.playlist(playlist["id"])
    assert len(result["tracks"]) == 13
    assert result["tracks"][0] == pinned
    store.set_membership(playlist["id"], user, pinned, saved=False)
    assert len(store.playlist(playlist["id"])["tracks"]) == 12
    assert store.saved("youtube", "abcdefghijk") == {"saved": False}


def test_library_search_pagination_and_literal_wildcards_are_bounded(client: TestClient) -> None:
    store = client.app.state.music_store
    user = {"id": "200", "display_name": "Member", "admin": False}
    for index in range(61):
        store.create("Drums " + str(index), user)
    special = store.create("100%_beats!", user)
    prefix = "/api/music/library?provider=youtube&source_id=abcdefghijk"
    first = client.get(prefix).json()
    assert first["total"] == 62
    assert len(first["playlists"]) == 50
    second = client.get(prefix + "&offset=50").json()
    assert len(second["playlists"]) == 12
    assert not {row["id"] for row in first["playlists"]} & {row["id"] for row in second["playlists"]}
    filtered = client.get(
        "/api/music/library", params={"provider": "youtube", "source_id": "abcdefghijk", "q": "%_beats!"}
    ).json()
    assert filtered["total"] == 1
    assert filtered["playlists"][0]["id"] == special["id"]
    assert client.get(prefix + "&limit=51").status_code == 422
    assert client.get(prefix + "&offset=-1").status_code == 422


def test_batch_library_status_is_bounded_distinguishes_providers_and_requires_music_access(client: TestClient) -> None:
    store = client.app.state.music_store
    user = {"id": "200", "display_name": "Member", "admin": False}
    saved = MusicTrack.model_validate(song()).model_dump()
    for name in ("First", "Second"):
        playlist = store.create(name, user)
        store.append(playlist["id"], user, [saved])
    tracks = [
        {"provider": "youtube", "source_id": "abcdefghijk"},
        {"provider": "spotify", "source_id": "abcdefghijk"},
        {"provider": "youtube", "source_id": "missing"},
        {"provider": "youtube", "source_id": "abcdefghijk"},
    ]
    endpoint = "/api/music/library/status"
    assert client.post(endpoint, json={"tracks": tracks}).json() == {"keys": ["youtube:abcdefghijk"]}
    assert client.post(endpoint, json={"tracks": tracks[:1] * 1000}).status_code == 200
    for invalid in ([], tracks[:1] * 1001, [{"provider": "other", "source_id": "id"}]):
        assert client.post(endpoint, json={"tracks": invalid}).status_code == 422
    override(client, "300", view_music=False)
    assert client.post(endpoint, headers={"x-member": "300"}, json={"tracks": tracks}).status_code == 403


@pytest.mark.parametrize("operation", ["membership", "track"])
def test_intervening_connection_write_cannot_be_overwritten_by_internal_playlist_updates(
    client: TestClient, operation: str
) -> None:
    store = client.app.state.music_store
    user = {"id": "200", "display_name": "Member", "admin": False}
    playlist = store.create("Concurrent", user)
    original = MusicTrack.model_validate(song()).model_dump()
    row = store.append(playlist["id"], user, [original])
    replacement = MusicTrack.model_validate(song(title="Edited")).model_dump()
    addition = MusicTrack.model_validate(song("newrecord01")).model_dump()
    database_path = client.app.state.media.base_settings.data_dir / "library.sqlite3"
    other = Database(database_path)
    update = store.update

    def intervening(playlist_id: str, actor: dict, changes: dict) -> dict:
        MusicStore(other).append(playlist_id, actor, [addition])
        return update(playlist_id, actor, changes)

    mutate = (
        partial(store.set_membership, playlist["id"], user, original, saved=False)
        if operation == "membership"
        else partial(
            store.update_track,
            playlist["id"],
            0,
            user,
            {"track": replacement, "expected_updated_at": row["updated_at"]},
        )
    )
    try:
        with patch.object(store, "update", side_effect=intervening), pytest.raises(HTTPException) as rejected:
            mutate()
        assert rejected.value.status_code == 409
        assert store.playlist(playlist["id"])["tracks"] == [original, addition]
    finally:
        other.close()
