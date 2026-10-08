from __future__ import annotations

import asyncio
import json
import logging
import queue
import re
import time
from http import HTTPStatus
from typing import TYPE_CHECKING

import aiohttp
import discord

from app.conversation_audio import ReceiveSink, Segmenter
from app.db import DATABASE_ERRORS, new_id
from app.permissions import effective_permissions

if TYPE_CHECKING:
    from discord.ext.voice_recv import VoiceRecvClient

    from app.bot import Bot
    from app.config import Settings
    from app.conversation_audio import Speech
    from app.db import Database
    from app.events import Events

MAX_QUEUE = 32
MAX_AGE = 30
MESSAGE_DEDUP_LIMIT = 1024
CLEANUP_INTERVAL = 3600


def matches(text: str, phrase: str, mode: str) -> bool:
    text, phrase = text.casefold(), phrase.strip().casefold()
    if not phrase:
        return False
    if mode == "contains":
        return phrase in text
    pattern = r"(?<!\w)" + r"\s+".join(re.escape(word) for word in phrase.split()) + r"(?!\w)"
    return bool(re.search(pattern, text))


def log_failure(category: str, error: Exception) -> None:
    logging.getLogger("app.conversation").error("%s: %s", category, type(error).__name__)


class Conversation:
    def __init__(self, settings: Settings, db: Database, events: Events, bot: Bot) -> None:
        self.settings, self.db, self.events, self.bot = settings, db, events, bot
        self.language = db.setting("conversation_language", default="nl")
        self.enabled = db.setting("conversation_enabled", default=True)
        self.session: dict | None = None
        self.voice = None
        self.allowed: set[str] = set()
        self.packets = queue.Queue(maxsize=512)
        self.work = asyncio.Queue(maxsize=MAX_QUEUE)
        self.segmenter = Segmenter()
        self.tasks: list[asyncio.Task] = []
        self.delayed: set[asyncio.Task] = set()
        self.http = None
        self.error: str | None = None
        self.dropped = 0
        self.cooldowns: dict[str, float] = {}
        self.fired_messages: dict[str, None] = {}
        self.last_cleanup = 0.0
        self.receiver_retry = 0.0
        self.last_status = ""

    async def start(self) -> None:
        await asyncio.to_thread(
            self.db.execute, "UPDATE conversations SET ended_at=? WHERE ended_at IS NULL", (time.time(),)
        )
        self.http = aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=25))
        self.tasks = [asyncio.create_task(self.monitor()), asyncio.create_task(self.process())]

    def snapshot(self) -> dict:
        voice = self.bot.voice
        members = voice.channel.members if voice and voice.is_connected() else []
        return {
            "enabled": self.enabled,
            "language": self.language,
            "recording": self.session is not None,
            "session": self.session,
            "backlog": self.work.qsize(),
            "dropped": self.dropped,
            "error": self.error,
            "participants": [
                {"id": str(member.id), "name": member.display_name, "avatar": str(member.display_avatar.url)}
                for member in members
                if not member.bot
            ],
        }

    def receive(self, speaker: tuple, pcm: bytes, timestamp: float, session_id: str | None = None) -> None:
        if not self.enabled or not self.session:
            return
        session_id = session_id or self.session["id"]
        try:
            self.packets.put_nowait((session_id, speaker, pcm, timestamp))
        except queue.Full:
            self.dropped += 1

    async def close_session(self) -> None:
        for task in self.delayed:
            task.cancel()
        await asyncio.gather(*self.delayed, return_exceptions=True)
        self.delayed.clear()
        self.allowed.clear()
        if self.voice and self.voice.is_listening():
            self.voice.stop_listening()
        self.voice = None
        session, self.session = self.session, None
        self.segmenter = Segmenter()
        while not self.packets.empty():
            try:
                self.packets.get_nowait()
            except queue.Empty:
                break
        while not self.work.empty():
            self.work.get_nowait()
        if session:
            await asyncio.to_thread(
                self.db.execute, "UPDATE conversations SET ended_at=? WHERE id=?", (time.time(), session["id"])
            )
            self.events.publish("conversation")

    async def worker_ready(self) -> bool:
        try:
            async with self.http.get(self.settings.transcription_url + "/health") as response:
                ready = response.status == HTTPStatus.OK and (await response.json()).get("ready", False)
            if not ready:
                self.error = "Transcription model is unavailable or still loading."
        except (aiohttp.ClientError, TimeoutError):
            self.error = "Local transcription worker is unavailable."
            return False
        else:
            return ready

    async def synchronize(self) -> None:
        voice = self.bot.voice
        connected = bool(voice and voice.is_connected() and self.bot.client.is_ready())
        if self.session and (
            not self.enabled
            or not connected
            or voice is not self.voice
            or self.bot.state.deafened
            or voice.channel.id != int(self.session["channel_id"])
        ):
            await self.close_session()
        if not self.enabled or not connected:
            self.error = None
            return
        if self.bot.state.deafened:
            self.error = "Recording paused: the bot is deafened. A user with voice-toggle permission can undeafen it."
            return
        if not self.session:
            await self.open_session(voice)
        elif self.voice and not self.voice.is_listening():
            self.error = "Audio receiving stopped. Restarting the conversation receiver."
            await self.close_session()
        else:
            self.update_participants(voice)

    async def open_session(self, voice: VoiceRecvClient) -> None:
        if time.monotonic() < self.receiver_retry or not await self.worker_ready():
            return
        session = {
            "id": new_id(),
            "channel_id": str(voice.channel.id),
            "channel_name": voice.channel.name,
            "started_at": time.time(),
            "ended_at": None,
        }
        await asyncio.to_thread(
            self.db.execute,
            "INSERT INTO conversations(id,channel_id,channel_name,started_at) VALUES (?,?,?,?)",
            (session["id"], session["channel_id"], session["channel_name"], session["started_at"]),
        )
        if not self.enabled or voice is not self.bot.voice or not voice.is_connected() or self.bot.state.deafened:
            await asyncio.to_thread(
                self.db.execute, "UPDATE conversations SET ended_at=? WHERE id=?", (time.time(), session["id"])
            )
            return
        self.allowed = {str(member.id) for member in voice.channel.members if not member.bot}
        self.session, self.voice = session, voice
        try:
            voice.listen(
                ReceiveSink(
                    lambda speaker, pcm, timestamp: self.receive(speaker, pcm, timestamp, session["id"]), self.allowed
                )
            )
        except (discord.ClientException, RuntimeError) as error:
            await self.close_session()
            self.error = "Could not start the Discord audio receiver. Check the admin console."
            log_failure("Voice receive initialization failed", error)
            self.receiver_retry = time.monotonic() + 15
            return
        self.error = None
        await asyncio.to_thread(self.db.audit, None, "conversation.start", session["id"], session["channel_name"])
        self.events.publish("conversation")

    def update_participants(self, voice: VoiceRecvClient) -> None:
        members = {str(member.id) for member in voice.channel.members if not member.bot}
        self.allowed.intersection_update(members)
        self.allowed.update(members)

    def enqueue(self, speech: Speech) -> None:
        if not self.session:
            return
        speech.id = new_id()
        if self.work.full():
            self.dropped += 1
            self.error = "Transcription is overloaded; some speech was dropped."
            return
        self.work.put_nowait((self.session["id"], speech))

    async def monitor(self) -> None:
        tick = 0
        while True:
            try:
                if tick % 50 == 0:
                    await self.synchronize()
                if self.session:
                    self.drain_packets()
                if time.monotonic() - self.last_cleanup > CLEANUP_INTERVAL:
                    await self.cleanup()
                state = json.dumps(self.snapshot(), sort_keys=True) if tick % 50 == 0 else self.last_status
                if state != self.last_status:
                    self.last_status = state
                    self.events.publish("conversation")
                tick += 1
            except (discord.DiscordException, RuntimeError, ValueError, AttributeError, *DATABASE_ERRORS) as error:
                log_failure("Conversation processing failed; capture stopped", error)
                await self.close_session()
                self.error = "Conversation processing failed. Check the admin console."
            await asyncio.sleep(0.02)

    def drain_packets(self) -> None:
        for _ in range(128):
            try:
                session_id, speaker, pcm, timestamp = self.packets.get_nowait()
            except queue.Empty:
                break
            if not self.session or session_id != self.session["id"]:
                continue
            for speech in self.segmenter.feed(speaker, pcm, timestamp):
                self.enqueue(speech)
        for speech in self.segmenter.flush(time.time()):
            self.enqueue(speech)

    async def cleanup(self) -> None:
        days = await asyncio.to_thread(self.db.setting, "conversation_retention_days", default=30)
        await asyncio.to_thread(
            self.db.execute,
            "DELETE FROM conversations WHERE ended_at IS NOT NULL AND ended_at<?",
            (time.time() - days * 86400,),
        )
        await asyncio.to_thread(
            self.db.execute, "DELETE FROM conversation_messages WHERE started_at<?", (time.time() - days * 86400,)
        )
        self.last_cleanup = time.monotonic()

    def current(self, session_id: str, speech: Speech, delay: float = 0) -> bool:
        return bool(
            self.enabled
            and self.session
            and self.session["id"] == session_id
            and self.bot.voice is self.voice
            and self.voice.is_connected()
            and self.bot.client.is_ready()
            and not self.bot.state.deafened
            and time.time() - speech.ended_at <= MAX_AGE + delay
        )

    async def process(self) -> None:
        while True:
            session_id, speech = await self.work.get()
            if not self.current(session_id, speech):
                self.dropped += 1
                continue
            try:
                async with self.http.post(
                    self.settings.transcription_url + "/transcribe",
                    data=speech.pcm,
                    params={"language": self.language},
                    headers={"Content-Type": "application/octet-stream"},
                ) as response:
                    if response.status != HTTPStatus.OK:
                        self.error = "Local transcription failed or is still loading; speech was dropped."
                        self.dropped += 1
                        continue
                    result = await response.json()
                if not self.current(session_id, speech):
                    self.dropped += 1
                    continue
                text = str(result.get("text", "")).strip()[:4000]
                if not text or result.get("language") not in {"nl", "en"}:
                    continue
                await asyncio.to_thread(
                    self.db.execute,
                    "INSERT INTO conversation_messages(id,session_id,speaker_id,speaker_name,avatar,started_at,"
                    "ended_at,"
                    "text,language) VALUES (?,?,?,?,?,?,?,?,?)",
                    (
                        speech.id,
                        session_id,
                        speech.speaker_id,
                        speech.name,
                        speech.avatar,
                        speech.started_at,
                        speech.ended_at,
                        text,
                        result["language"],
                    ),
                )
                self.error = None
                self.events.publish("conversation", {"session_id": session_id})
                await self.fire_triggers(session_id, speech, text)
            except (aiohttp.ClientError, TimeoutError, ValueError, *DATABASE_ERRORS):
                self.error = "Local transcription worker failed; speech was dropped."
                self.dropped += 1

    async def fire_triggers(self, session_id: str, speech: Speech, text: str) -> None:
        if speech.id:
            if speech.id in self.fired_messages:
                return
            self.fired_messages[speech.id] = None
            if len(self.fired_messages) > MESSAGE_DEDUP_LIMIT:
                del self.fired_messages[next(iter(self.fired_messages))]
        triggers = await asyncio.to_thread(
            self.db.rows, "SELECT * FROM conversation_triggers WHERE enabled=1 ORDER BY created_at,id"
        )
        for trigger in triggers:
            if not self.current(session_id, speech) or not matches(text, trigger["phrase"], trigger["mode"]):
                continue
            if trigger["target"] == "self" and speech.speaker_id != trigger["owner_id"]:
                continue
            if trigger["target"] == "selected" and speech.speaker_id not in json.loads(trigger["speakers"]):
                continue
            now = time.monotonic()
            if now - self.cooldowns.get(trigger["id"], float("-inf")) < trigger["cooldown"]:
                continue
            self.cooldowns[trigger["id"]] = now
            await self.schedule_trigger(trigger, session_id, speech)

    async def schedule_trigger(self, trigger: dict, session_id: str, speech: Speech) -> None:
        if trigger.get("delay", 0):
            if len(self.delayed) >= MAX_QUEUE:
                await asyncio.to_thread(
                    self.db.audit,
                    trigger["owner_id"],
                    "trigger.play",
                    trigger["id"],
                    "Delayed action",
                    outcome="rejected",
                    details={"reason": "Too many pending trigger actions."},
                )
                self.events.publish("audit")
                return
            task = asyncio.create_task(self.fire_delayed(trigger, session_id, speech))
            self.delayed.add(task)
            task.add_done_callback(self.finish_delayed)
        else:
            await self.fire(trigger, session_id, speech)

    def finish_delayed(self, task: asyncio.Task) -> None:
        self.delayed.discard(task)
        if not task.cancelled() and task.exception():
            self.error = "Delayed trigger action failed."
            logging.getLogger("app.conversation").error(
                "Delayed trigger action failed (%s)", type(task.exception()).__name__
            )
            self.events.publish("conversation")

    async def fire_delayed(self, trigger: dict, session_id: str, speech: Speech) -> None:
        await asyncio.sleep(trigger["delay"])
        latest = await asyncio.to_thread(
            self.db.one, "SELECT * FROM conversation_triggers WHERE id=?", (trigger["id"],)
        )
        if latest == trigger and latest["enabled"] and self.current(session_id, speech, trigger["delay"]):
            await self.fire(latest, session_id, speech)

    async def fire(self, trigger: dict, session_id: str, speech: Speech) -> None:
        user = await asyncio.to_thread(
            self.db.one, "SELECT permission_overrides FROM users WHERE id=?", (trigger["owner_id"],)
        )
        clip = await asyncio.to_thread(self.db.one, "SELECT * FROM clips WHERE id=?", (trigger["clip_id"],))
        stopping = trigger.get("action", "play") == "stop_all"
        permission = "stop_sounds" if stopping else "play_sounds"
        reason = None
        instance = None
        if (
            not user
            or not effective_permissions(
                json.loads(user["permission_overrides"]), admin=trigger["owner_id"] in self.settings.app_admin_ids
            )[permission]
        ):
            reason = "Creator no longer has permission for this trigger action."
        elif not stopping and not clip:
            reason = "The selected sound was deleted."
        else:
            guild = self.bot.client.get_guild(self.settings.discord_guild_id)
            try:
                member = None
                if guild:
                    member = guild.get_member(int(trigger["owner_id"])) or await guild.fetch_member(
                        int(trigger["owner_id"])
                    )
                if (
                    not self.current(session_id, speech, trigger.get("delay", 0))
                    or not member
                    or not self.voice
                    or not self.voice.channel.permissions_for(member).view_channel
                    or not self.voice.channel.permissions_for(member).connect
                    or not await asyncio.to_thread(self.permitted, trigger["owner_id"], permission)
                ):
                    reason = "Creator no longer has playback permission or access to the active voice channel."
                elif stopping:
                    await self.stop_trigger(trigger, speech)
                else:
                    instance = self.bot.state.play(self.settings.data_dir / "media" / clip["id"] / "sound.wav", clip)
            except (discord.DiscordException, ValueError, OSError):
                reason = "Playback unavailable, permission denied, or all playback slots are in use."
        details = {
            "trigger_id": trigger["id"],
            "speaker_id": speech.speaker_id,
            "action": trigger.get("action", "play"),
            "delay": trigger.get("delay", 0),
        }
        if reason:
            details["reason"] = reason
        if instance:
            await asyncio.to_thread(
                self.db.audit,
                trigger["owner_id"],
                "sound.play",
                clip["id"],
                clip["name"],
                guild_id=str(self.settings.discord_guild_id),
                details=details,
            )
        await asyncio.to_thread(
            self.db.audit,
            trigger["owner_id"],
            "trigger.play",
            trigger["id"],
            "Stop all sounds" if stopping else clip["name"] if clip else "Deleted sound",
            outcome="rejected" if reason else "success",
            details=details,
        )
        self.events.publish("audit")
        self.events.publish("conversation")

    async def stop_trigger(self, trigger: dict, speech: Speech) -> None:
        if self.bot.state.mixer:
            self.bot.state.mixer.stop()
        await asyncio.to_thread(
            self.db.audit,
            trigger["owner_id"],
            "sound.stop_all",
            guild_id=str(self.settings.discord_guild_id),
            details={"trigger_id": trigger["id"], "speaker_id": speech.speaker_id},
        )
        self.events.publish("playback")

    def permitted(self, owner_id: str, permission: str = "play_sounds") -> bool:
        user = self.db.one("SELECT permission_overrides FROM users WHERE id=?", (owner_id,))
        return bool(
            user
            and effective_permissions(
                json.loads(user["permission_overrides"]), admin=owner_id in self.settings.app_admin_ids
            )[permission]
        )

    async def close(self) -> None:
        for task in self.tasks:
            task.cancel()
        await asyncio.gather(*self.tasks, return_exceptions=True)
        await self.close_session()
        if self.http:
            await self.http.close()
