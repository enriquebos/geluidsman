from __future__ import annotations

import json
from concurrent.futures import ThreadPoolExecutor
from typing import TYPE_CHECKING
from unittest.mock import Mock

import pytest

from app.goose_sketches import Sketch, change_library
from tests.test_auth import client as auth_fixture
from tests.test_auth import headers, login

if TYPE_CHECKING:
    from collections.abc import Iterator
    from pathlib import Path

    from fastapi.testclient import TestClient


@pytest.fixture
def client(tmp_path: Path) -> Iterator[TestClient]:
    yield from auth_fixture.__wrapped__(tmp_path)


def drawing() -> dict:
    return {"name": "Portrait", "strokes": [{"color": "#79c94c", "points": [[0, 0], [75, 65], [150, 130]]}]}


def test_library_authorization_persistence_snapshot_and_deletion(client: TestClient) -> None:
    user = login(client)
    assert client.get("/api/goose/sketches").json() == []
    assert client.post("/api/admin/goose/sketches", headers=headers(user), json=drawing()).status_code == 403
    client.app.state.auth.admin_ids.add("100")
    result = client.post("/api/admin/goose/sketches", headers=headers(user), json=drawing())
    assert result.status_code == 200
    saved = result.json()
    assert 1000 <= saved["duration_ms"] <= 60000
    assert client.app.state.db.setting("goose_sketches") == [saved]
    publish = Mock()
    client.app.state.events.publish = publish
    response = client.post(
        "/api/admin/goose/action", headers=headers(user), json={"action": "draw", "sketch_id": saved["id"]}
    )
    assert response.status_code == 200
    broadcast = publish.call_args.args[1]
    assert broadcast["drawing"] == saved
    replacement = {**drawing(), "name": "Edited"}
    assert (
        client.put(f"/api/admin/goose/sketches/{saved['id']}", headers=headers(user), json=replacement).status_code
        == 200
    )
    assert broadcast["drawing"]["name"] == "Portrait"
    assert publish.call_args.args[0] == "fun.goose.library"
    assert client.delete(f"/api/admin/goose/sketches/{saved['id']}", headers=headers(user)).status_code == 200
    assert broadcast["drawing"]["strokes"] == saved["strokes"]
    assert client.get("/api/goose/sketches").json() == []
    assert (
        client.post(
            "/api/admin/goose/action", headers=headers(user), json={"action": "draw", "sketch_id": saved["id"]}
        ).status_code
        == 404
    )
    client.cookies.clear()
    assert client.get("/api/goose/sketches").status_code == 401


@pytest.mark.parametrize(
    "body",
    [
        {"name": "", "strokes": drawing()["strokes"]},
        {"name": "x" * 61, "strokes": drawing()["strokes"]},
        {"name": "Bad", "strokes": [{"color": "url(javascript:alert(1))", "points": [[0, 0], [1, 1]]}]},
        {"name": "Bad", "strokes": [{"color": "#ef3340", "points": [[0, 0], [151, 1]]}]},
        {"name": "Bad", "strokes": [{"color": "#ef3340", "points": [[True, 0], [1, 1]]}]},
        {"name": "Bad", "strokes": [{"color": "#ef3340", "points": [["1", 0], [1, 1]]}]},
        {"name": "Bad", "strokes": drawing()["strokes"] * 33},
        {"name": "Bad", "strokes": [{"color": "#ef3340", "points": [[0, 0], [150, 130]] * 128}] * 3},
        {"name": "Too long", "strokes": [{"color": "#ef3340", "points": [[0, 0], [150, 130]] * 32}]},
        {"name": "Markup", "strokes": [], "svg": "<script/>"},
    ],
)
def test_library_rejects_unsafe_or_excessive_input(client: TestClient, body: dict) -> None:
    user = login(client)
    client.app.state.auth.admin_ids.add("100")
    assert client.post("/api/admin/goose/sketches", headers=headers(user), json=body).status_code == 422
    assert client.app.state.db.setting("goose_sketches", []) == []


def test_library_concurrent_updates_and_capacity(client: TestClient) -> None:
    db = client.app.state.db
    db.set_setting("unrelated", {"preserve": True})
    with ThreadPoolExecutor(max_workers=4) as pool:
        saved = list(pool.map(lambda _: change_library(db, Sketch.model_validate(drawing())), range(16)))
    assert len(db.setting("goose_sketches")) == 16
    assert len({item["id"] for item in saved}) == 16
    user = login(client)
    client.app.state.auth.admin_ids.add("100")
    assert client.post("/api/admin/goose/sketches", headers=headers(user), json=drawing()).status_code == 409
    assert db.setting("unrelated") == {"preserve": True}
    value = db.one("SELECT value FROM settings WHERE key='goose_sketches'")["value"]
    assert len(json.loads(value)) == 16


@pytest.mark.parametrize("method", ["put", "delete"])
def test_library_modification_requires_admin(client: TestClient, method: str) -> None:
    user = login(client)
    request = getattr(client, method)
    options = {"headers": headers(user)}
    if method == "put":
        options["json"] = drawing()
    assert request("/api/admin/goose/sketches/missing", **options).status_code == 403
