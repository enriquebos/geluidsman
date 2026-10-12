from __future__ import annotations

import time
from collections import deque
from dataclasses import dataclass, field
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, StrictBool, StrictStr, model_validator

SOUND_EFFECTS = {
    "2beec8ee6e7148f89e44770189b2b555": "flashbang",
    "325a0351de6e4b27a6bc1a6799b05e2f": "vine_boom",
    "c48f9c6f2bdf4cd99536f594c9ef2f1b": "sus",
    "75dcb32953744dbdaa0c4f6aa5445c0f": "patapim",
    "1e5721474c58461ebfd99751b681bb3b": "tung_sahur",
    "abfeb407046948a2a78a0e693bd35bfa": "skibidi",
    "5592b9d7f19a418796c2c8a47dcefe52": "spion",
}


class FunSettings(BaseModel):
    model_config = ConfigDict(extra="forbid")
    flashbang: StrictBool = False
    vine_boom: StrictBool = False
    dvd: StrictBool = False
    sus: StrictBool = False
    patapim: StrictBool = False
    tung_sahur: StrictBool = False
    skibidi: StrictBool = False
    spion: StrictBool = False
    goose: StrictBool = False
    kirby: StrictBool = False
    kirby_threshold: int = Field(default=20, ge=1, le=100, strict=True)
    kirby_window: float = Field(default=5, ge=1, le=60, strict=True, allow_inf_nan=False)
    dvd_speed: float = Field(default=1, ge=0.25, le=5, strict=True, allow_inf_nan=False)


class GooseMessage(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    text: StrictStr = Field(min_length=1, max_length=30)


class GooseAction(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    action: Literal["raid", "draw", "deliver"]
    text: StrictStr = Field(default="", max_length=30)
    sketch: Literal["random", "smiley", "goose", "word", "shrek"] = "smiley"

    sketch_id: StrictStr | None = Field(default=None, min_length=1, max_length=64)

    @model_validator(mode="after")
    def delivery_text(self) -> GooseAction:
        if self.action == "deliver" and not self.text:
            message = "A message is required for delivery."
            raise ValueError(message)
        return self


KIRBY_PAUSE_SECONDS = 5
MAX_KIRBY_ACCOUNTS = 4096
KIRBY_ACCOUNT_TTL_SECONDS = 60


@dataclass
class KirbyAccount:
    attempts: deque[float] = field(default_factory=deque)
    until: float = 0
    touched: float = 0


class KirbyGuard:
    def __init__(self) -> None:
        self.accounts: dict[str, KirbyAccount] = {}
        self.pruned_at = 0.0

    def clear(self) -> None:
        self.accounts.clear()

    def remaining(self, user_id: str) -> float:
        account = self.accounts.get(user_id)
        return max(0, (account.until - time.monotonic()) * 1000) if account else 0

    def attempt(self, user_id: str, settings: dict) -> tuple[float, bool]:
        if not settings.get("kirby", False):
            return 0, False
        now = time.monotonic()
        if now - self.pruned_at >= 1:
            self.accounts = {
                key: value for key, value in self.accounts.items() if now - value.touched <= KIRBY_ACCOUNT_TTL_SECONDS
            }
            self.pruned_at = now
        account = self.accounts.get(user_id)
        if account is None:
            if len(self.accounts) >= MAX_KIRBY_ACCOUNTS:
                msg = "Playback protection is busy. Try again shortly."
                raise OverflowError(msg)
            account = KirbyAccount()
            self.accounts[user_id] = account
        account.touched = now
        if account.until > now:
            return (account.until - now) * 1000, False
        account.until = 0
        while account.attempts and account.attempts[0] <= now - settings["kirby_window"]:
            account.attempts.popleft()
        account.attempts.append(now)
        if len(account.attempts) >= settings["kirby_threshold"]:
            account.attempts.clear()
            account.until = now + KIRBY_PAUSE_SECONDS
            return KIRBY_PAUSE_SECONDS * 1000, True
        return 0, False
