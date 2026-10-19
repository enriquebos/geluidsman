from __future__ import annotations

import asyncio
import logging
import time
from typing import TYPE_CHECKING

import aiohttp
from fastapi import HTTPException

from app.db import DATABASE_ERRORS, new_id
from app.music_access import music_user, music_voice_access, recheck_music_voice_access
from app.music_models import MusicTrack
from app.music_sources import MusicSourceError

if TYPE_CHECKING:
    from fastapi import FastAPI

MAX_IMPORTS = 8
MAX_IMPORT_HISTORY = 64
PROGRESS_INTERVAL = 0.25


class MusicImports:
    def __init__(self, app: FastAPI) -> None:
        self.app = app
        self.jobs: dict[str, dict] = {}
        self.tasks: dict[str, asyncio.Task] = {}
        self.closed = False

    def snapshot(self, user: dict) -> list[dict]:
        return [
            {key: value for key, value in job.items() if key not in {"owner_id", "published", "applying"}}
            for job in self.jobs.values()
            if job["owner_id"] == user["id"] or user["admin"]
        ]

    async def authorize(self, user_id: str, destination: str) -> dict:
        user = await music_user(self.app, user_id)
        if destination == "queue":
            music_voice_access(self.app, user)
        else:
            row = await self.app.state.db.run(self.app.state.music_store.playlist, destination)
            self.app.state.music_store.editable(row, user)
        return user

    async def start(self, query: str, destination: str, user: dict) -> dict:
        await self.authorize(user["id"], destination)
        if self.closed or len(self.tasks) >= MAX_IMPORTS:
            raise HTTPException(409, "Music imports are busy. Try again shortly.")
        if any(self.jobs[key]["owner_id"] == user["id"] for key in self.tasks):
            raise HTTPException(409, "Finish or cancel your current music import first.")
        while len(self.jobs) >= MAX_IMPORT_HISTORY:
            oldest = next((key for key in self.jobs if key not in self.tasks), None)
            if oldest is None:
                break
            del self.jobs[oldest]
        job_id = new_id()
        job = {
            "id": job_id,
            "owner_id": user["id"],
            "title": "Resolving music…",
            "state": "running",
            "done": 0,
            "total": 0,
            "error": None,
            "warnings": [],
            "published": 0.0,
            "applying": False,
        }
        self.jobs[job_id] = job
        task = asyncio.create_task(self.run(job, query, destination))
        self.tasks[job_id] = task
        task.add_done_callback(lambda _: self.tasks.pop(job_id, None))
        self.app.state.events.publish("music")
        return {key: value for key, value in job.items() if key not in {"owner_id", "published", "applying"}}

    def progress(self, job: dict, done: int, total: int) -> None:
        job.update(done=min(max(0, done), 1000), total=min(max(0, total), 1000))
        if time.monotonic() - job["published"] >= PROGRESS_INTERVAL:
            job["published"] = time.monotonic()
            self.app.state.events.publish("music")

    async def run(self, job: dict, query: str, destination: str) -> None:
        try:
            result = await self.app.state.music_sources.resolve(
                query, lambda done, total: self.progress(job, done, total)
            )
            user = await self.authorize(job["owner_id"], destination)
            maximum = self.app.state.music_sources.settings.max_source_seconds
            tracks = [MusicTrack.model_validate(track).model_dump() for track in result["tracks"]]
            tracks = [track for track in tracks if track["duration"] <= maximum]
            if not tracks:
                job.update(state="failed", error="No playable songs were found within the configured duration limit.")
                return
            job["title"] = str(result.get("title") or "Music import")[:300]
            job["warnings"] = [str(value)[:300] for value in result.get("warnings", [])[:100]]
            job["applying"] = True
            if destination == "queue":
                await self.enqueue(tracks, user)
            else:
                await self.app.state.db.run(self.app.state.music_store.append, destination, user, tracks)
                self.app.state.music_cache.refresh()
                self.app.state.events.publish("music_playlists")
            job.update(state="complete", done=len(tracks), total=len(tracks))
        except asyncio.CancelledError:
            job["state"] = "cancelled"
            raise
        except HTTPException as error:
            job.update(state="failed", error=str(error.detail)[:300])
        except MusicSourceError as error:
            job.update(state="failed", error=str(error)[:300])
        except (aiohttp.ClientError, OSError, TimeoutError, ValueError, TypeError, KeyError, *DATABASE_ERRORS) as error:
            job.update(state="failed", error="Music import failed. Check the source and try again.")
            logging.getLogger("app.music").warning("Music import failed (%s)", type(error).__name__)
        finally:
            self.app.state.events.publish("music")

    async def enqueue(self, tracks: list[dict], user: dict) -> None:
        try:
            await self.app.state.music.enqueue(
                tracks, user, guard=lambda: recheck_music_voice_access(self.app, user["id"])
            )
        except ValueError as error:
            raise HTTPException(409, str(error)) from None

    async def cancel(self, job_id: str, user: dict) -> None:
        job = self.jobs.get(job_id)
        if not job:
            raise HTTPException(404, "Music import not found.")
        if job["owner_id"] != user["id"] and not user["admin"]:
            raise HTTPException(403, "Only the requester or admins can cancel this import.")
        task = self.tasks.get(job_id)
        if task:
            if job["applying"]:
                raise HTTPException(409, "This import is finishing. Its songs have already been accepted.")
            job["state"] = "cancelled"
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
            self.app.state.events.publish("music")

    async def close(self) -> None:
        self.closed = True
        tasks = list(self.tasks.values())
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        self.tasks.clear()
