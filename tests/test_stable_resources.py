from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace
from typing import TYPE_CHECKING
from unittest.mock import AsyncMock, patch

from app.events import Events

if TYPE_CHECKING:
    from fastapi.testclient import TestClient

pytest_plugins = ("tests.test_api",)


def test_source_validation_is_independent_of_unrelated_dashboard_changes(client: TestClient) -> None:
    first = client.get("/api/state/sources/source")
    assert first.status_code == 200
    client.app.state.events.publish("status")
    client.app.state.events.publish("jobs")
    same = client.get("/api/state/sources/source", headers={"If-None-Match": first.headers["etag"]})
    assert same.status_code == 304
    client.app.state.db.execute("UPDATE sources SET media_id=? WHERE id=?", ("replacement", "source"))
    changed = client.get("/api/state/sources/source", headers={"If-None-Match": first.headers["etag"]})
    assert changed.status_code == 200
    assert changed.json()["media_id"] == "replacement"
    assert changed.headers["x-resource-epoch"] == client.app.state.events.epoch


def test_domain_reads_do_not_fetch_storage_or_transcription(client: TestClient) -> None:
    state = client.app.state
    with (
        patch.object(state.media, "summary", AsyncMock(side_effect=AssertionError("Unrelated storage read"))),
        patch.object(
            state.conversation, "inspect_model", AsyncMock(side_effect=AssertionError("Unrelated worker read"))
        ),
    ):
        for path in [
            "/state/interface",
            "/state/sounds",
            "/state/library",
            "/state/editor-options",
            "/state/fun",
            "/admin/transcription/settings",
        ]:
            assert client.get("/api" + path).status_code == 200


def test_unrelated_events_do_not_invalidate_media_inventory(client: TestClient) -> None:
    state = client.app.state
    collect = state.media_management.collect

    async def changed() -> dict:
        value = await collect()
        state.events.publish("playback_progress", {"position": 1})
        state.events.publish("conversation", {"scope": "transcription.runtime"})
        return value

    with patch.object(state.media_management, "collect", changed):
        assert client.get("/api/admin/storage").status_code == 200


def test_events_include_revisions_and_only_media_changes_advance_media_guard() -> None:
    events = Events()
    events.publish("status")
    assert events.revision == 1
    assert events.media_revision == 0
    events.publish("music_cache", {"ids": ["music:recording"]})
    assert events.media_revision == 1


def test_rule_updates_supply_an_authoritative_resource(client: TestClient) -> None:
    with patch.object(client.app.state.events, "publish") as publish:
        response = client.post("/api/actions/triggers", json={"event": "camera_on", "action": "stop_all"})
    assert response.status_code == 201, response.text
    change = next(call.args[1] for call in publish.call_args_list if call.args[0] == "actions")
    assert change["resource"] == "/actions/triggers"
    assert change["value"] == client.get("/api/actions/triggers").json()
    assert response.json()["items"] == change["value"]["items"]
    assert json.dumps(change)


def test_media_events_publish_authoritative_usage_without_private_metadata() -> None:
    events = Events()
    events.download_usage = lambda: {"used_bytes": 42, "max_bytes": 1000}
    queue = asyncio.Queue()
    events.clients.add(queue)
    events.publish("music_cache", {"ids": ["music:key"], "counts_changed": False})
    payload = json.loads(queue.get_nowait().split("data: ")[1])
    assert payload["downloads_usage"] == {"used_bytes": 42, "max_bytes": 1000}
    assert payload["revision"] == events.revision
    events.publish("music", {"scope": "music.playback"})
    assert "downloads_usage" not in json.loads(queue.get_nowait().split("data: ")[1])


def test_admin_settings_events_strip_values_for_non_admins() -> None:
    message = 'event: settings\ndata: {"resource":"/settings/app","value":{"private":"value"},"revision":5}\n\n'
    request = SimpleNamespace(state=SimpleNamespace(user={"id": "200", "admin": False}))
    public = Events.for_viewer(message, request)
    assert json.loads(public.split("data: ")[1]) == {"revision": 5}
    request.state.user["admin"] = True
    assert Events.for_viewer(message, request) == message
