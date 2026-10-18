from __future__ import annotations

import io
import json
import logging
import threading
from errno import ENOSPC
from types import SimpleNamespace
from unittest.mock import patch

import pytest
import yt_dlp
from discord.utils import MISSING

from app.music_diagnostics import MusicSourceError, classify_failure, log_music_failure, source_error
from app.music_sources import MusicDecoder
from app.music_worker import main


@pytest.mark.parametrize(
    ("text", "reason", "status"),
    [
        ("Private video. Sign in to view.", "private_recording", None),
        ("Sign in to confirm your age", "age_restricted", None),
        ("The uploader has not made this video available in your country", "country_restricted", None),
        ("Removed on copyright grounds", "copyright_restricted", None),
        ("This video has been removed", "recording_removed", None),
        ("Sign in to confirm you are not a bot", "bot_check", None),
        ("HTTP Error 429: Too Many Requests", "rate_limited", 429),
        ("HTTP error 403 Forbidden", "http_forbidden", 403),
        ("Server returned 404 Not Found", "http_not_found", 404),
        ("HTTP status 503 Service Unavailable", "http_error", 503),
        ("Connection timed out", "network_timeout", None),
        ("Requested format is not available", "unsupported_format", None),
        ("moov atom not found", "invalid_media", None),
        ("Temporary failure in name resolution", "network_error", None),
    ],
)
def test_provider_failures_are_classified_without_retaining_sensitive_text(text: str, reason: str, status: int) -> None:
    result = classify_failure(text + " https://media.test/audio?signature=private Authorization: Bearer secret")
    assert result["reason"] == reason
    assert result.get("http_status") == status
    assert "signature" not in json.dumps(result)
    assert "secret" not in json.dumps(result)


def test_worker_returns_safe_diagnostic_instead_of_raw_provider_exception(capsys: pytest.CaptureFixture) -> None:
    message = "HTTP Error 403: Forbidden https://media.test/audio?signature=private-token"
    with (
        patch(
            "sys.argv", ["music_worker", "https://youtube.com/watch?v=aaaaaaaaaaa", "stream", "proxy", "3600", "deno"]
        ),
        patch("app.music_worker.extract", side_effect=yt_dlp.utils.DownloadError(message)),
    ):
        main()
    output = capsys.readouterr().out
    assert "private-token" not in output
    assert "media.test" not in output
    assert json.loads(output)["diagnostic"] == {"reason": "http_forbidden", "http_status": 403}


def test_decoder_stderr_becomes_safe_error_and_bounded_log(caplog: pytest.LogCaptureFixture) -> None:
    decoder = object.__new__(MusicDecoder)
    decoder.stderr_done = threading.Event()
    decoder.diagnostic_details = {"reason": "source_unavailable"}
    decoder.music_error = None
    decoder._stopped = False
    decoder._process = SimpleNamespace(
        stderr=io.BytesIO(b"x" * 20000 + b"\nHTTP error 403 https://media.test/audio?signature=private-token\n"),
        poll=lambda: 1,
    )
    decoder.consume_stderr(decoder._process)
    decoder._check_process_returncode()
    assert isinstance(decoder.music_error, MusicSourceError)
    assert decoder.music_error.details == {"reason": "http_forbidden", "http_status": 403, "decoder_exit": 1}
    with caplog.at_level(logging.WARNING, logger="app.music"):
        log_music_failure({"provider": "youtube", "source_id": "aaaaaaaaaaa"}, decoder.music_error, "playback")
    assert "reason=http_forbidden" in caplog.text
    assert "http_status=403" in caplog.text
    assert "source_id=aaaaaaaaaaa" in caplog.text
    assert "decoder_exit=1" in caplog.text
    assert "private-token" not in caplog.text
    assert "media.test" not in caplog.text
    decoder._process = MISSING


def test_logging_ignores_raw_exception_payloads_and_records_spotify_identity(caplog: pytest.LogCaptureFixture) -> None:
    with caplog.at_level(logging.WARNING, logger="app.music"):
        log_music_failure(
            {"provider": "spotify", "source_id": "a" * 22, "title": "private title"},
            ValueError("https://media.test/?secret=private-token"),
            "resolve",
        )
        log_music_failure({}, OSError(ENOSPC, "private/path"), "cache")
    assert "source_id=" + "a" * 22 in caplog.text
    assert "reason=storage_limit" in caplog.text
    assert "private" not in caplog.text
    assert "media.test" not in caplog.text


def test_diagnostics_accept_only_known_categories_and_valid_public_identifiers() -> None:
    error = source_error("early_eof", youtube_id="https://private/?token=secret", raw="secret", decoder_exit=99999)
    assert error.details == {"reason": "early_eof"}
    assert source_error("not-a-reason").details == {"reason": "source_unavailable"}
