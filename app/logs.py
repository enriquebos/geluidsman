from __future__ import annotations

import logging
import re
import threading
import time
from collections import deque
from typing import TYPE_CHECKING
from urllib.parse import urlsplit, urlunsplit

if TYPE_CHECKING:
    from app.config import Settings


def clean_url(match: re.Match) -> str:
    try:
        url = urlsplit(match.group())
        return urlunsplit((url.scheme, url.netloc.rsplit("@", 1)[-1], url.path, "", ""))
    except ValueError:
        return "[redacted URL]"


class ConsoleLogs(logging.Handler):
    def __init__(self, settings: Settings) -> None:
        super().__init__(logging.INFO)
        self.entries: deque[dict] = deque(maxlen=2000)
        self.counter = 0
        self.guard = threading.Lock()
        self.output = logging.StreamHandler()
        self.output.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s %(message)s"))
        self.secrets = [
            value.get_secret_value()
            for value in (
                settings.discord_token,
                settings.discord_client_secret,
                settings.auth_encryption_key,
                settings.database_url,
            )
            if value.get_secret_value()
        ]

    def redact(self, message: str) -> str:
        for secret in self.secrets:
            message = message.replace(secret, "[redacted]")
        message = re.sub(r"(?i)(Bearer|Bot)\s+[\w.\-]+", r"\1 [redacted]", message)
        message = re.sub(
            r"(?i)((?:access_token|refresh_token|client_secret|authorization|cookie|code|state)"
            r"[\"']?\s*[:=]\s*[\"']?)[^\s\"'&,}]+",
            r"\1[redacted]",
            message,
        )
        message = re.sub(r"(?im)((?:authorization|cookie|set-cookie)\s*:\s*).*$", r"\1[redacted]", message)
        return re.sub(r"(?:https?|postgresql)://[^\s\"'<>]+", clean_url, message)[:16000]

    def emit(self, record: logging.LogRecord) -> None:
        message = self.redact(logging.Formatter("%(message)s").format(record))
        self.output.emit(
            logging.LogRecord(record.name, record.levelno, record.pathname, record.lineno, message, (), None)
        )
        with self.guard:
            self.counter += 1
            self.entries.append(
                {
                    "id": self.counter,
                    "timestamp": time.time(),
                    "level": record.levelname,
                    "source": record.name,
                    "message": message,
                }
            )

    def snapshot(self, after: int, limit: int) -> dict:
        with self.guard:
            reset = after > self.counter
            if reset:
                after = 0
            available = [entry for entry in self.entries if entry["id"] > after]
            rows = available[:limit] if after else available[-limit:]
            return {
                "entries": rows,
                "reset": reset,
                "cursor": rows[-1]["id"] if rows else after,
                "truncated": bool(self.entries and after and after < self.entries[0]["id"] - 1),
            }
