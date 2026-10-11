from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import TYPE_CHECKING

from starlette.staticfiles import StaticFiles

if TYPE_CHECKING:
    from pathlib import Path

    from starlette.responses import Response
    from starlette.types import Scope


HASHED_ASSET = re.compile(r"^assets/[^/]+-[A-Za-z0-9_-]{8,}\.[a-z0-9]+$")


@dataclass(frozen=True)
class FrontendBuild:
    build_id: str | None = None
    assets: frozenset[str] = frozenset()

    @classmethod
    def read(cls, directory: Path) -> FrontendBuild:
        try:
            data = json.loads((directory / "build.json").read_text(encoding="utf-8"))
            build_id, assets = data["build_id"], data["assets"]
            if not isinstance(build_id, str) or not build_id or not isinstance(assets, list):
                return cls()
            return cls(
                build_id, frozenset(path for path in assets if isinstance(path, str) and HASHED_ASSET.fullmatch(path))
            )
        except (OSError, ValueError, KeyError, TypeError):
            return cls()


class FrontendAssets(StaticFiles):
    def __init__(self, directory: Path, build: FrontendBuild) -> None:
        super().__init__(directory=directory)
        self.build = build

    async def get_response(self, path: str, scope: Scope) -> Response:
        response = await super().get_response(path, scope)
        response.headers["Cache-Control"] = (
            "public, max-age=31536000, immutable" if f"assets/{path}" in self.build.assets else "no-cache"
        )
        return response
