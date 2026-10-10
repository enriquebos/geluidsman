from __future__ import annotations

import asyncio
import re
import time
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import TYPE_CHECKING
from urllib.parse import parse_qs

from app.db import DATABASE_ERRORS, new_id
from app.network import DownloadProxy, validate_url

if TYPE_CHECKING:
    from app.media import Media

YOUTUBE_HOSTS = {"youtube.com", "www.youtube.com", "m.youtube.com"}
DISCOVERY_BYTES = 50_000_000


def channel_url(url: str) -> str:
    parsed = validate_url(url)
    path = parsed.path.rstrip("/")
    if parsed.hostname not in YOUTUBE_HOSTS or not re.fullmatch(r"/(?:@[\w.-]+|channel/UC[\w-]{22})(?:/videos)?", path):
        message = "Use a YouTube channel URL such as https://www.youtube.com/@KudNL/videos."
        raise ValueError(message)
    return "https://www.youtube.com" + (path if path.endswith("/videos") else path + "/videos")


def video_id(url: str) -> str | None:
    parsed = validate_url(url)
    if parsed.hostname in YOUTUBE_HOSTS:
        value = parse_qs(parsed.query).get("v", [""])[0]
        if parsed.path.startswith(("/shorts/", "/embed/")):
            value = parsed.path.split("/")[2]
    elif parsed.hostname == "youtu.be":
        value = parsed.path.strip("/")
    else:
        return None
    return value if re.fullmatch(r"[A-Za-z0-9_-]{11}", value) else None


class ChannelImports:
    def __init__(self, media: Media) -> None:
        self.media = media
        self.task = None
        self.batch_id = None

    async def update(self, batch_id: str, status: str, error: str | None = None) -> None:
        await self.media.db.run(
            self.media.db.execute,
            "UPDATE channel_batches SET status=?,error=? WHERE id=?",
            (status, error, batch_id),
        )
        if status in ("complete", "failed", "paused"):
            batch = await self.media.db.run(
                self.media.db.one, "SELECT actor_id,title FROM channel_batches WHERE id=?", (batch_id,)
            )
            if batch and batch["actor_id"]:
                await self.media.db.run(
                    self.media.db.audit,
                    batch["actor_id"],
                    "channel.import",
                    batch_id,
                    batch["title"],
                    outcome=status,
                )
        self.media.events.publish("jobs")

    async def start(self, url: str, actor_id: str | None = None) -> str:
        url = channel_url(url)
        await self.media.ensure_import_available()
        try:
            batch_id = new_id()
            await self.media.db.run(
                self.media.db.execute,
                "INSERT INTO channel_batches(id,url,title,status,error,created_at,actor_id) VALUES (?,?,?,?,?,?,?)",
                (batch_id, url, "YouTube channel", "discovering", None, time.time(), actor_id),
            )
            await self.media.db.run(self.media.db.audit, actor_id, "channel.import", batch_id, url, outcome="requested")
            await self.launch(batch_id)
        except BaseException:
            self.media.busy = False
            raise
        else:
            return batch_id

    async def resume(self, batch_id: str, actor_id: str | None = None) -> None:
        await self.media.ensure_import_available()
        try:
            if actor_id:
                await self.media.db.run(
                    self.media.db.execute, "UPDATE channel_batches SET actor_id=? WHERE id=?", (actor_id, batch_id)
                )
            await self.media.db.run(
                self.media.db.execute, "UPDATE channel_batches SET dismissed=0 WHERE id=?", (batch_id,)
            )
            await self.media.db.run(self.media.db.audit, actor_id, "channel.resume", batch_id)
            await self.media.db.run(
                self.media.db.execute,
                "UPDATE channel_items SET status='queued' WHERE batch_id=? AND status IN ('failed','importing')",
                (batch_id,),
            )
            await self.launch(batch_id)
        except BaseException:
            self.media.busy = False
            raise

    async def launch(self, batch_id: str) -> None:
        self.media.busy = True
        await self.update(
            batch_id,
            "running"
            if (
                await self.media.db.run(self.media.db.one, "SELECT id FROM channel_items WHERE batch_id=?", (batch_id,))
            )
            else "discovering",
        )
        self.batch_id = batch_id
        self.task = asyncio.create_task(self.run(batch_id))
        self.media.tasks.add(self.task)
        self.task.add_done_callback(self.media.tasks.discard)

    async def pause(self, batch_id: str) -> None:
        if self.batch_id == batch_id and self.task and not self.task.done():
            self.task.cancel()
            await asyncio.gather(self.task, return_exceptions=True)
            self.media.busy = False
        await self.update(batch_id, "paused")

    async def discover(self, batch: dict) -> None:
        media = self.media
        await self.update(batch["id"], "discovering")
        with (
            TemporaryDirectory(prefix="channel-", dir=media.root) as folder,
            DownloadProxy(
                min(DISCOVERY_BYTES, media.settings.max_import_bytes), media.settings.import_timeout_seconds
            ) as proxy,
        ):
            info = await media.download(batch["url"], Path(folder), proxy, channel=True)
            if proxy.block_reason:
                message = proxy.block_reason
                raise ValueError(message)
        await media.db.run(self.save_discovery, batch, info)

    def save_discovery(self, batch: dict, info: dict) -> None:
        media = self.media
        with media.db.lock, media.db.conn:
            media.db.conn.execute("UPDATE channel_batches SET title=? WHERE id=?", (info["title"], batch["id"]))
            media.db.conn.executemany(
                "INSERT OR IGNORE INTO channel_items(batch_id,url,title,status) VALUES (?,?,?,?)",
                [(batch["id"], item["url"], item["title"], "queued") for item in info["videos"]],
            )

    async def run(self, batch_id: str) -> None:
        operation_token = self.media.operation.set(await self.media.db.run(lambda: self.media.settings))
        try:
            batch = await self.media.db.run(self.media.db.one, "SELECT * FROM channel_batches WHERE id=?", (batch_id,))
            if not (
                await self.media.db.run(self.media.db.one, "SELECT id FROM channel_items WHERE batch_id=?", (batch_id,))
            ):
                await self.discover(batch)
            await self.update(batch_id, "running")
            await self.import_items(batch_id)
        except asyncio.CancelledError:
            await self.media.db.run(
                self.media.db.execute,
                "UPDATE channel_items SET status='queued' WHERE batch_id=? AND status='importing'",
                (batch_id,),
            )
            await self.update(batch_id, "paused")
            raise
        except (ValueError, OSError, TimeoutError, *DATABASE_ERRORS) as error:
            message = str(error) if isinstance(error, ValueError) else "Channel import failed. Retry to continue."
            await self.update(batch_id, "failed", message)
        finally:
            self.media.operation.reset(operation_token)
            self.media.busy = False

    async def import_items(self, batch_id: str) -> None:
        media = self.media
        known = {video_id(item["url"]) for item in (await media.db.run(media.db.sources))}
        items = await media.db.run(
            media.db.rows, "SELECT * FROM channel_items WHERE batch_id=? AND status='queued' ORDER BY id", (batch_id,)
        )
        for item in items:
            if video_id(item["url"]) in known:
                await media.db.run(
                    media.db.execute, "UPDATE channel_items SET status='skipped' WHERE id=?", (item["id"],)
                )
                media.events.publish("jobs")
                continue
            if media.used_bytes() >= media.settings.max_storage_bytes:
                await self.update(batch_id, "paused", "Storage is full. Free space and resume this channel.")
                return
            batch = await media.db.run(media.db.one, "SELECT actor_id FROM channel_batches WHERE id=?", (batch_id,))
            job_id = await media.db.run(media.db.add_job, item["url"], batch["actor_id"])
            await media.db.run(
                media.db.audit, batch["actor_id"], "video.import", job_id, item["title"], outcome="requested"
            )
            await media.db.run(
                media.db.execute,
                "UPDATE channel_items SET status='importing',job_id=? WHERE id=?",
                (job_id, item["id"]),
            )
            media.events.publish("jobs")
            await media.import_job(job_id, item["url"])
            media.busy = True
            job = await media.db.run(media.db.one, "SELECT status FROM jobs WHERE id=?", (job_id,))
            status = "complete" if job["status"] == "complete" else "failed"
            await media.db.run(media.db.execute, "UPDATE channel_items SET status=? WHERE id=?", (status, item["id"]))
            if status == "complete":
                known.add(video_id(item["url"]))
            media.events.publish("jobs")
        await self.update(batch_id, "complete")
