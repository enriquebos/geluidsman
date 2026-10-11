from __future__ import annotations

from typing import TYPE_CHECKING

import uvicorn

if TYPE_CHECKING:
    from types import FrameType


class AppServer(uvicorn.Server):
    def handle_exit(self, sig: int, frame: FrameType | None) -> None:
        super().handle_exit(sig, frame)
        state = getattr(self.config.app, "state", None)
        events = getattr(state, "events", None)
        if events is not None:
            events.shutdown()
