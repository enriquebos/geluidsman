from __future__ import annotations

import time
from typing import TYPE_CHECKING
from unittest.mock import AsyncMock, Mock, patch

if TYPE_CHECKING:
    from fastapi.testclient import TestClient

pytest_plugins = ("tests.test_api",)


def test_conditional_settings_validate_current_authorized_representation(client: TestClient) -> None:
    initial = client.get("/api/settings/app")
    tag = initial.headers["etag"]
    same = client.get("/api/settings/app", headers={"If-None-Match": tag})
    assert same.status_code == 304
    assert same.content == b""
    assert same.headers["cache-control"] == "private, no-store"
    client.app.state.db.set_setting("app_settings", {"max_source_seconds": 321})
    changed = client.get("/api/settings/app", headers={"If-None-Match": tag})
    assert changed.status_code == 200
    assert changed.headers["etag"] != tag
    assert changed.json()["settings"]["max_source_seconds"] == 321
    original = client.app.state.auth.current

    async def denied(*args: object, **kwargs: object) -> dict:
        user = await original(*args, **kwargs)
        user["admin"] = False
        user["permissions"]["admin"] = False
        return user

    with patch.object(client.app.state.auth, "current", denied):
        assert client.get("/api/settings/app", headers={"If-None-Match": changed.headers["etag"]}).status_code == 403


def test_conditional_user_pages_include_changed_metadata(client: TestClient) -> None:
    initial = client.get("/api/admin/users")
    client.app.state.db.execute("UPDATE users SET display_name=? WHERE id=?", ("Renamed elsewhere", "100"))
    changed = client.get("/api/admin/users", headers={"If-None-Match": initial.headers["etag"]})
    assert changed.status_code == 200
    assert changed.json()["users"][0]["display_name"] == "Renamed elsewhere"


def test_media_version_must_match_the_current_source(client: TestClient) -> None:
    app = client.app
    app.state.db.execute("UPDATE sources SET media_id=? WHERE id=?", ("current-media", "source"))
    folder = app.state.media.root / "current-media"
    folder.mkdir()
    (folder / "peaks.json").write_text('{"peaks": [0, 1]}', encoding="utf-8")
    assert client.get("/api/media/source/peaks.json?v=previous-media").status_code == 409
    assert client.get("/api/media/source/peaks.json?v=current-media").json() == {"peaks": [0, 1]}


def test_transcription_status_does_not_switch_or_persist_models(client: TestClient) -> None:
    manager = client.app.state.conversation
    db = client.app.state.db
    db.set_setting("transcription_model", "large-v3")
    response = Mock()
    response.json = AsyncMock(return_value={"model": "large-v3-turbo", "ready": True, "models": ["large-v3-turbo"]})
    context = Mock()
    context.__aenter__ = AsyncMock(return_value=response)
    context.__aexit__ = AsyncMock(return_value=False)
    http = Mock()
    http.get.return_value = context
    http.put.side_effect = AssertionError("Status reads must not switch models")
    with patch.object(manager, "http", http), patch.object(manager, "close_session", AsyncMock()) as close:
        result = client.get("/api/admin/transcription")
        assert result.status_code == 200
        assert result.json()["model"] == "large-v3-turbo"
        assert db.setting("transcription_model") == "large-v3"
        close.assert_not_awaited()
        http.put.assert_not_called()


def test_audit_read_applies_retention_without_deleting_data(client: TestClient) -> None:
    db = client.app.state.db
    db.audit("100", "sound.play")
    db.execute("UPDATE audit SET timestamp=?", (time.time() - 86400 * 120,))
    before = db.one("SELECT COUNT(*) AS total FROM audit")["total"]
    assert client.get("/api/audit").json()["results"] == []
    assert db.one("SELECT COUNT(*) AS total FROM audit")["total"] == before
