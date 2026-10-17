from __future__ import annotations

import logging

import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient

from app.bot import VoiceError
from app.config import Settings
from app.main import register_private_responses, register_state_routes
from app.mixer import CapacityError


@pytest.mark.parametrize(
    ("code", "level"),
    [
        (400, logging.INFO),
        (401, logging.INFO),
        (403, logging.INFO),
        (404, logging.INFO),
        (409, logging.INFO),
        (422, logging.INFO),
        (429, logging.WARNING),
        (500, logging.ERROR),
        (503, logging.ERROR),
    ],
)
def test_http_error_severity_matches_response(caplog: pytest.LogCaptureFixture, code: int, level: int) -> None:
    app = FastAPI()
    register_private_responses(app)

    @app.get("/api/failure")
    async def fail() -> None:
        raise HTTPException(code, "Request unavailable")

    with caplog.at_level(logging.INFO, logger="app.http"), TestClient(app) as client:
        response = client.get("/api/failure")

    assert response.status_code == code
    assert response.headers["Cache-Control"] == "private, no-store"
    assert response.headers["Referrer-Policy"] == "same-origin"
    records = [record for record in caplog.records if record.name == "app.http"]
    assert len(records) == 1
    assert records[0].levelno == level
    assert records[0].getMessage() == f"GET /api/failure returned {code}"
    assert records[0].exc_info is None


@pytest.mark.parametrize(
    ("failure", "code", "level", "traceback"),
    [
        (VoiceError("Bot is not connected to voice."), 409, logging.INFO, False),
        (CapacityError("All playback slots are occupied."), 409, logging.WARNING, False),
        (ValueError("Unexpected operation failure."), 400, logging.ERROR, True),
    ],
)
def test_operation_errors_preserve_diagnostics(
    caplog: pytest.LogCaptureFixture,
    failure: ValueError,
    code: int,
    level: int,
    *,
    traceback: bool,
) -> None:
    app = FastAPI()
    register_private_responses(app)
    register_state_routes(app, Settings(_env_file=None))

    @app.get("/failure")
    async def fail() -> None:
        raise failure

    with caplog.at_level(logging.INFO, logger="app.http"), TestClient(app) as client:
        response = client.get("/failure")

    assert response.status_code == code
    assert response.json() == {"detail": str(failure)}
    records = [record for record in caplog.records if record.name == "app.http"]
    assert len(records) == 2
    assert records[0].levelno == level
    assert bool(records[0].exc_info) is traceback
    assert records[1].levelno == logging.INFO


def test_unhandled_http_failure_keeps_traceback(caplog: pytest.LogCaptureFixture) -> None:
    app = FastAPI()
    register_private_responses(app)

    @app.get("/failure")
    async def fail() -> None:
        message = "Unexpected server failure"
        raise RuntimeError(message)

    with caplog.at_level(logging.INFO, logger="app.http"), TestClient(app, raise_server_exceptions=False) as client:
        response = client.get("/failure")

    assert response.status_code == 500
    records = [record for record in caplog.records if record.name == "app.http"]
    assert len(records) == 1
    assert records[0].levelno == logging.ERROR
    assert records[0].exc_info is not None
    assert records[0].getMessage() == "Unhandled request failure: GET /failure"
