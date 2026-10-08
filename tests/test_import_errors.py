from __future__ import annotations

import json
from typing import TYPE_CHECKING

import pytest

from app.db import Database
from app.download_worker import validate_info
from app.import_errors import download_error

if TYPE_CHECKING:
    from pathlib import Path


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("HTTP Error 403: Forbidden", "HTTP 403"),
        ("HTTP 429", "rate-limiting"),
        ("Private video", "restricted access"),
        ("Requested format unavailable", "supported"),
        ("Timed out", "network"),
        ("Sign in to confirm you're not a bot", "verification challenge"),
    ],
)
def test_download_errors_classify_without_exposing_raw_data(raw: str, expected: str) -> None:
    message = download_error(raw + " https://example.com?token=secret-token")
    assert expected in message
    assert "secret-token" not in message


def test_unknown_download_error_is_honest_and_safe() -> None:
    assert "exact cause was not available" in download_error("credentials=secret")
    assert "secret" not in download_error("credentials=secret")


def test_duration_error_includes_actual_limit() -> None:
    with pytest.raises(ValueError, match=r"4000 seconds.*3600 seconds"):
        validate_info({"duration": 4000}, 3600)


def test_reopening_does_not_rewrite_historical_failures(tmp_path: Path) -> None:
    path = tmp_path / "library.sqlite3"
    db = Database(path)
    job_id = db.add_job("https://example.com/video")
    db.execute("UPDATE jobs SET status='failed',error=? WHERE id=?", ("Existing error", job_id))
    db.audit(None, "video.import", job_id, "Existing title", outcome="failed", details={"error": "Existing error"})
    before = db.rows("SELECT * FROM audit")
    db.close()
    db = Database(path)
    assert db.rows("SELECT * FROM audit") == before
    assert json.loads(before[0]["details"])["error"] == "Existing error"
    db.close()
