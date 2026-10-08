from __future__ import annotations

import asyncio
import os
import shutil
import subprocess
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import TYPE_CHECKING

import uvicorn
from pydantic import SecretStr

from app.config import ROOT, Settings
from app.db import Database
from app.events import Events
from app.main import create_app
from app.media import Media
from tests.helpers import authenticated_fixture

if TYPE_CHECKING:
    from collections.abc import AsyncIterator

    from fastapi import FastAPI


def prepare(folder: Path) -> Settings:
    db = Database(folder / "library.sqlite3")
    db.execute("DELETE FROM clips")
    db.execute("UPDATE users SET preferences='{}'")
    root = folder / "media"
    media_folder = root / "fixture"
    media_folder.mkdir(parents=True, exist_ok=True)
    if not (media_folder / "video.mp4").exists():
        subprocess.run(
            [
                shutil.which("ffmpeg"),
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                "-f",
                "lavfi",
                "-i",
                "testsrc2=size=640x360:rate=25:duration=10",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=440:duration=10",
                "-c:v",
                "libx264",
                "-preset",
                "ultrafast",
                "-c:a",
                "aac",
                "-movflags",
                "+faststart",
                str(media_folder / "video.mp4"),
            ],
            check=True,
        )
        subprocess.run(
            [
                shutil.which("ffmpeg"),
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                "-i",
                str(media_folder / "video.mp4"),
                "-vn",
                "-c:a",
                "copy",
                str(media_folder / "audio.m4a"),
            ],
            check=True,
        )
        subprocess.run(
            [
                shutil.which("ffmpeg"),
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                "-i",
                str(media_folder / "video.mp4"),
                "-frames:v",
                "1",
                str(media_folder / "thumbnail.jpg"),
            ],
            check=True,
        )
    db.save_source(
        {
            "id": "fixture",
            "url": "https://example.com/test-video",
            "title": "Test video \u00b7 Sound & color",
            "duration": 10,
            "media_id": "fixture",
        },
        [
            {
                "language": language,
                "kind": "manual",
                "status": "ready",
                "cues": [{"text": text, "start": 2, "end": 4, "words": []}],
            }
            for language, text in (("nl", "Hallo mooie wereld"), ("en", "Hello beautiful world"))
        ],
    )
    db.execute(
        "INSERT OR IGNORE INTO users(id,username,display_name,created_at,last_login) VALUES (?,?,?,?,?)",
        ("200", "fixture-member", "Fixture Member", time.time(), time.time()),
    )
    settings = Settings(_env_file=None, discord_token=SecretStr(""), data_dir=folder, host="127.0.0.1", port=8001)

    async def peaks() -> None:
        await Media(settings, db, Events()).make_peaks(media_folder / "audio.m4a", media_folder / "peaks.json", 10)

    asyncio.run(peaks())
    db.close()
    return settings


if __name__ == "__main__":
    folder = Path(os.environ.get("BROWSER_TEST_DATA", str(ROOT / ".runtime" / "browser-tests")))
    application = create_app(prepare(folder))
    original_lifespan = application.router.lifespan_context

    @asynccontextmanager
    async def fixture_lifespan(app: FastAPI) -> AsyncIterator[None]:
        async with original_lifespan(app):
            authenticated_fixture(app)
            yield

    application.router.lifespan_context = fixture_lifespan
    uvicorn.run(application, host="127.0.0.1", port=8001, access_log=False)
