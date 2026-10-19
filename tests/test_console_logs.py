from __future__ import annotations

import logging
from typing import TYPE_CHECKING

import pytest
from pydantic import SecretStr

from app.config import Settings
from app.logs import ConsoleLogs

if TYPE_CHECKING:
    from pathlib import Path


@pytest.mark.parametrize("field", ["deepgram_api_key", "transcription_api_token"])
def test_console_redacts_configured_transcription_credentials(
    tmp_path: Path, capsys: pytest.CaptureFixture[str], field: str
) -> None:
    credential = "private-transcription-credential"
    settings = Settings(_env_file=None, data_dir=tmp_path, **{field: SecretStr(credential)})
    console = ConsoleLogs(settings)
    record = logging.LogRecord("app.test", logging.ERROR, "", 1, "Connection rejected: %s", (credential,), None)

    console.emit(record)

    assert console.snapshot(0, 1)["entries"][0]["message"] == "Connection rejected: [redacted]"
    output = capsys.readouterr().err
    assert credential not in output
    assert "Connection rejected: [redacted]" in output


@pytest.mark.parametrize("scheme", ["Bearer", "Bot", "Token", "tOkEn"])
def test_console_redacts_authentication_schemes(tmp_path: Path, scheme: str) -> None:
    console = ConsoleLogs(Settings(_env_file=None, data_dir=tmp_path))

    assert console.redact(f"Credentials rejected: {scheme} unknown-private-key") == (
        f"Credentials rejected: {scheme} [redacted]"
    )


def test_console_preserves_words_containing_authentication_scheme(tmp_path: Path) -> None:
    console = ConsoleLogs(Settings(_env_file=None, data_dir=tmp_path))
    message = "robot connected and tokenizer loaded"

    assert console.redact(message) == message


@pytest.mark.parametrize("outcome", ["requested_stop", "completed", "unexpected_exit"])
def test_music_cleanup_outcome_survives_secret_redaction(tmp_path: Path, outcome: str) -> None:
    console = ConsoleLogs(Settings(_env_file=None, data_dir=tmp_path))
    message = f"Music decoder cleanup: pid=123 outcome={outcome} exit_before_cleanup=None"
    assert console.redact(message) == message
