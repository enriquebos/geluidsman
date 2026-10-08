from __future__ import annotations

from typing import TYPE_CHECKING

import pytest

from tests.test_auth import GUILD, headers, login
from tests.test_auth import client as auth_fixture
from tests.test_conversation import seed

if TYPE_CHECKING:
    from collections.abc import Iterator
    from pathlib import Path

    from fastapi.testclient import TestClient


@pytest.fixture
def client(tmp_path: Path) -> Iterator[TestClient]:
    yield from auth_fixture.__wrapped__(tmp_path)


def test_sound_usage_counts_only_successful_configured_server_plays(client: TestClient) -> None:
    login(client)
    db = client.app.state.db
    seed(db)
    for actor, guild, outcome in [
        ("100", GUILD, "success"),
        ("200", GUILD, "success"),
        ("100", GUILD, "rejected"),
        ("100", "other", "success"),
    ]:
        db.audit(actor, "sound.play", "sound", "Sound", guild_id=guild, outcome=outcome)
    sound = db.clips("100", GUILD)[0]
    assert sound["play_count"] == 2
    assert sound["user_play_count"] == 1


def test_soundboard_mode_is_validated_and_persists(client: TestClient) -> None:
    user = login(client)
    assert user["preferences"]["soundboard_mode"] == "default"
    body = {"preview_volume": 0.4, "caption_language": "nl", "soundboard_mode": "compact"}
    assert client.put("/api/settings/personal", json=body, headers=headers(user)).status_code == 200
    assert client.get("/api/auth/me").json()["preferences"] == body
    assert (
        client.put(
            "/api/settings/personal", json={**body, "soundboard_mode": "invalid"}, headers=headers(user)
        ).status_code
        == 422
    )
