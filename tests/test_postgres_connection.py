from __future__ import annotations

import logging
from typing import TYPE_CHECKING
from unittest.mock import MagicMock, Mock, call

import psycopg
import pytest
from psycopg.rows import dict_row

from app.db import Database
from app.postgres import CONNECT_ATTEMPTS, CONNECT_RETRY_SECONDS, CONNECT_TIMEOUT, Connection

if TYPE_CHECKING:
    from pathlib import Path


@pytest.fixture
def connection_mocks(monkeypatch: pytest.MonkeyPatch) -> tuple[Mock, Mock]:
    connect = Mock(return_value=MagicMock(spec=psycopg.Connection))
    sleep = Mock()
    monkeypatch.setattr("app.postgres.psycopg.connect", connect)
    monkeypatch.setattr("app.postgres.time.sleep", sleep)
    return connect, sleep


def test_available_connection_does_not_wait(connection_mocks: tuple[Mock, Mock]) -> None:
    connect, sleep = connection_mocks

    connection = Connection("postgresql://database/example")

    assert connection.raw is connect.return_value
    connect.assert_called_once()
    sleep.assert_not_called()


@pytest.mark.parametrize(
    "error", [psycopg.OperationalError, psycopg.errors.CannotConnectNow, psycopg.errors.ConnectionFailure]
)
def test_initial_connection_recovers(
    connection_mocks: tuple[Mock, Mock], error: type[psycopg.OperationalError]
) -> None:
    connect, sleep = connection_mocks
    raw = Mock(spec=psycopg.Connection)
    connect.side_effect = [error(), error(), raw]

    connection = Connection("postgresql://database/example")

    assert connection.raw is raw
    assert (
        connect.call_args_list
        == [
            call(
                "postgresql://database/example", autocommit=True, row_factory=dict_row, connect_timeout=CONNECT_TIMEOUT
            )
        ]
        * 3
    )
    assert sleep.call_args_list == [call(CONNECT_RETRY_SECONDS)] * 2
    assert connection.transactions == []


def test_initial_connection_retry_is_bounded(connection_mocks: tuple[Mock, Mock]) -> None:
    connect, sleep = connection_mocks
    error = psycopg.OperationalError()
    connect.side_effect = error

    with pytest.raises(psycopg.OperationalError) as raised:
        Connection("postgresql://database/example")

    assert raised.value is error
    assert connect.call_count == CONNECT_ATTEMPTS
    assert sleep.call_count == CONNECT_ATTEMPTS - 1


def test_connection_retry_does_not_log_credentials(
    connection_mocks: tuple[Mock, Mock], caplog: pytest.LogCaptureFixture
) -> None:
    connect, _ = connection_mocks
    url = "postgresql://user:connection-secret@database/example"
    connect.side_effect = [psycopg.OperationalError(url), connect.return_value]

    with caplog.at_level(logging.INFO, logger="app.postgres"):
        Connection(url)

    assert "retrying the initial connection (2/6)" in caplog.text
    assert "connection-secret" not in caplog.text
    assert url not in caplog.text


@pytest.mark.parametrize(
    "error", [psycopg.errors.InvalidPassword, psycopg.errors.InvalidCatalogName, psycopg.ProgrammingError]
)
def test_invalid_connection_settings_fail_immediately(
    connection_mocks: tuple[Mock, Mock], error: type[psycopg.Error]
) -> None:
    connect, sleep = connection_mocks
    connect.side_effect = error()

    with pytest.raises(error):
        Connection("postgresql://database/example")

    connect.assert_called_once()
    sleep.assert_not_called()


@pytest.mark.parametrize("close_fails", [False, True])
def test_schema_failure_does_not_retry_and_closes_connection(
    connection_mocks: tuple[Mock, Mock], tmp_path: Path, *, close_fails: bool
) -> None:
    connect, sleep = connection_mocks
    error = psycopg.OperationalError()
    connect.return_value.execute.side_effect = error
    if close_fails:
        connect.return_value.close.side_effect = OSError

    with pytest.raises(psycopg.OperationalError) as raised:
        Database(tmp_path / "unused.sqlite3", "postgresql://database/example")

    assert raised.value is error
    connect.assert_called_once()
    connect.return_value.close.assert_called_once()
    sleep.assert_not_called()
