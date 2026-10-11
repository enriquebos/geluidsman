from __future__ import annotations

import asyncio
import json
import signal
from types import SimpleNamespace
from typing import TYPE_CHECKING
from unittest.mock import AsyncMock

import pytest
import uvicorn
from fastapi.testclient import TestClient
from pydantic import SecretStr

from app.config import Settings
from app.events import Events
from app.frontend import FrontendBuild
from app.main import create_app
from app.server import AppServer
from tests.helpers import authenticated_fixture

if TYPE_CHECKING:
    from pathlib import Path


@pytest.mark.parametrize("data", [None, {}, {"build_id": 12, "assets": []}, {"build_id": "build", "assets": None}])
def test_missing_or_invalid_build_metadata_is_safe(tmp_path: Path, data: object) -> None:
    assert FrontendBuild.read(tmp_path).build_id is None
    (tmp_path / "build.json").write_text(json.dumps(data), encoding="utf-8")
    assert FrontendBuild.read(tmp_path) == FrontendBuild()
    (tmp_path / "build.json").write_text("broken", encoding="utf-8")
    assert FrontendBuild.read(tmp_path) == FrontendBuild()


def test_build_identity_and_static_cache_policies(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    dist = tmp_path / "frontend" / "dist"
    assets = dist / "assets"
    assets.mkdir(parents=True)
    (dist / "index.html").write_text("<html>Frontend</html>", encoding="utf-8")
    names = ("index-abcdefgh.js", "plain.js", "unlisted-abcdefgh.js")
    for name in names:
        (assets / name).write_text("export const value = 1", encoding="utf-8")
    metadata = {
        "build_id": "stable-build-id",
        "assets": ["assets/index-abcdefgh.js", "assets/plain.js", "../secret", 12],
    }
    (dist / "build.json").write_text(json.dumps(metadata), encoding="utf-8")
    build = FrontendBuild.read(dist)
    assert build == FrontendBuild.read(dist)
    assert build.assets == frozenset({"assets/index-abcdefgh.js"})
    monkeypatch.setattr("app.main.ROOT", tmp_path)
    settings = Settings(_env_file=None, discord_token=SecretStr(""), data_dir=tmp_path / "data")
    with TestClient(create_app(settings)) as client:
        authenticated_fixture(client.app)
        for url in ("/", "/login", "/soundboard?mode=compact", "/videos/fixture/cut?t=2", "/admin?tab=fun"):
            assert client.get(url).headers["cache-control"] == "no-cache"
        response = client.get("/assets/index-abcdefgh.js")
        assert response.headers["cache-control"] == "public, max-age=31536000, immutable"
        cached = client.get("/assets/index-abcdefgh.js", headers={"If-None-Match": response.headers["etag"]})
        assert cached.status_code == 304
        assert cached.headers["cache-control"] == response.headers["cache-control"]
        for name in names[1:]:
            assert client.get(f"/assets/{name}").headers["cache-control"] == "no-cache"
        assert "immutable" not in client.get("/assets/missing-abcdefgh.js").headers.get("cache-control", "")
        assert client.get("/api/state").json()["build_id"] == build.build_id
        assert client.app.state.events.build_id == build.build_id
        assert client.get("/api/state").headers["cache-control"] == "private, no-store"


def test_sse_initial_and_reconnected_streams_report_served_build() -> None:
    async def scenario() -> None:
        request = SimpleNamespace(
            app=SimpleNamespace(state=SimpleNamespace(auth=SimpleNamespace(current=AsyncMock()))),
            is_disconnected=AsyncMock(return_value=False),
        )
        for build_id in ("first-build", "replacement-build", None):
            events = Events(build_id)
            stream = events.stream(request)
            message = await anext(stream)
            assert message.startswith("event: refresh\n")
            assert json.loads(message.split("data: ")[1])["build_id"] == build_id
            await stream.aclose()
            assert not events.clients

    asyncio.run(scenario())


def test_server_shutdown_closes_sse_without_waiting_for_heartbeat() -> None:
    async def scenario() -> None:
        events = Events("deployed-build")
        app = SimpleNamespace(state=SimpleNamespace(events=events, auth=SimpleNamespace(current=AsyncMock())))
        request = SimpleNamespace(app=app, is_disconnected=AsyncMock(return_value=False))
        stream = events.stream(request)
        await anext(stream)
        pending = asyncio.create_task(anext(stream))
        await asyncio.sleep(0)
        server = AppServer(uvicorn.Config(app))
        server.handle_exit(signal.SIGTERM, None)
        assert server.should_exit
        assert events.closing
        with pytest.raises(StopAsyncIteration):
            await asyncio.wait_for(pending, 1)
        assert not events.clients

    asyncio.run(scenario())
