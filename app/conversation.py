from __future__ import annotations

import asyncio
import json
import logging
import queue
import re
import time
import unicodedata
from http import HTTPStatus
from typing import TYPE_CHECKING

import aiohttp
import discord

from app.conversation_audio import ReceiveSink, Segmenter
from app.db import DATABASE_ERRORS, new_id
from app.permissions import effective_permissions
from app.trigger_playback import PlaybackContext, TriggerPlayback, cancel_pending, reserve_cooldown

if TYPE_CHECKING:
    from discord.ext.voice_recv import VoiceRecvClient

    from app.bot import Bot
    from app.config import Settings
    from app.conversation_audio import Speech
    from app.db import Database
    from app.events import Events

MAX_QUEUE = 32
MAX_BATCH = 4
BATCH_WAIT_SECONDS = 0.04
MAX_AGE = 30
MESSAGE_DEDUP_LIMIT = 1024
CLEANUP_INTERVAL = 3600


def normalize_speech(value: str) -> str:
    return " ".join(
        "".join(" " if unicodedata.category(char).startswith("P") else char for char in value.casefold()).split()
    )


def matches(text: str, phrase: str, mode: str) -> bool:
    text, phrase = normalize_speech(text), normalize_speech(phrase)
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
        self.playback = TriggerPlayback(settings, db, events, bot)
        self.model_status: dict = {}
        self.model_retry = 0.0
        self.model_lock = asyncio.Lock()

    async def start(self) -> None:
        await asyncio.to_thread(self.db.execute, "DELETE FROM conversations")
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
        await cancel_pending(self.delayed)
        if getattr(self.bot, "actions", None) and self.voice:
            self.bot.actions.release_speech()
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
            await asyncio.to_thread(self.db.execute, "DELETE FROM conversations WHERE id=?", (session["id"],))
            self.events.publish("conversation")

    async def select_model(self, name: str) -> dict:
        async with self.model_lock:
            async with self.http.put(self.settings.transcription_url + "/model", json={"model": name}) as response:
                response.raise_for_status()
                status = await response.json()
            await asyncio.to_thread(self.db.set_setting, "transcription_model", name)
            self.model_status = status
            if status.get("target"):
                await self.close_session()
            self.model_retry = time.monotonic() + 60
            return status

    async def synchronize_model(self) -> dict:
        async with self.model_lock:
            return await self.check_model()

    async def check_model(self) -> dict:
        desired = await asyncio.to_thread(self.db.setting, "transcription_model", "large-v3-turbo")
        if self.http is None:
            return {"model": desired, "phase": "unavailable", "ready": False}
        try:
            async with self.http.get(self.settings.transcription_url + "/health") as response:
                response.raise_for_status()
                status = await response.json()
            if status.get("error") and status.get("ready") and status.get("model") != desired:
                await asyncio.to_thread(self.db.set_setting, "transcription_model", status["model"])
                desired = status["model"]
            if status.get("model") != desired and status.get("ready") and time.monotonic() >= self.model_retry:
                await self.close_session()
                async with self.http.put(
                    self.settings.transcription_url + "/model", json={"model": desired}
                ) as response:
                    response.raise_for_status()
                    status = await response.json()
                self.model_retry = time.monotonic() + 60
            self.model_status = status
        except (aiohttp.ClientError, TimeoutError, ValueError):
            self.model_status = {"model": desired, "phase": "unavailable", "ready": False}
        return {"selected": desired, **self.model_status}

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
        if time.monotonic() < self.receiver_retry or self.model_status.get("target") or not await self.worker_ready():
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
        if not self.enabled:
            await asyncio.to_thread(self.db.execute, "DELETE FROM conversations WHERE id=?", (session["id"],))
            return
        if voice is not self.bot.voice or not voice.is_connected() or self.bot.state.deafened:
            await asyncio.to_thread(self.db.execute, "DELETE FROM conversations WHERE id=?", (session["id"],))
            return
        self.allowed = {str(member.id) for member in voice.channel.members if not member.bot}
        self.session, self.voice = session, voice
        try:
            actions = getattr(self.bot, "actions", None)
            if actions:
                actions.release_speech()
            voice.listen(
                ReceiveSink(
                    lambda speaker, pcm, timestamp: self.receive(speaker, pcm, timestamp, session["id"]),
                    self.allowed,
                    actions.speaking_callback(voice) if actions else None,
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
                if tick % 100 == 0 and self.bot.client.is_ready():
                    await self.synchronize_model()
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
        await asyncio.to_thread(self.db.execute, "DELETE FROM conversations WHERE ended_at IS NOT NULL")
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

    async def next_batch(self) -> list[tuple[str, Speech]]:
        first = await self.work.get()
        batch = [first]
        deadline = asyncio.get_running_loop().time() + BATCH_WAIT_SECONDS
        while len(batch) < MAX_BATCH:
            try:
                remaining = max(0, deadline - asyncio.get_running_loop().time())
                item = (
                    self.work.get_nowait()
                    if not self.work.empty()
                    else await asyncio.wait_for(self.work.get(), remaining)
                )
            except (asyncio.QueueEmpty, TimeoutError):
                break
            batch.append(item)
        current = []
        for session_id, speech in batch:
            if self.current(session_id, speech):
                current.append((session_id, speech))
            else:
                self.dropped += 1
        return current

    async def process(self) -> None:
        while True:
            batch = await self.next_batch()
            if not batch:
                continue
            try:
                params = [("language", self.language)]
                if len(batch) > 1:
                    params.extend(("lengths", str(len(speech.pcm))) for _, speech in batch)
                async with self.http.post(
                    self.settings.transcription_url + ("/transcribe/batch" if len(batch) > 1 else "/transcribe"),
                    data=b"".join(speech.pcm for _, speech in batch),
                    params=params,
                    headers={"Content-Type": "application/octet-stream"},
                ) as response:
                    if response.status != HTTPStatus.OK:
                        self.error = "Local transcription failed or is still loading; speech was dropped."
                        self.dropped += len(batch)
                        continue
                    payload = await response.json()
                results = payload.get("results") if len(batch) > 1 else [payload]
                self.validate_results(results, len(batch))
                for (session_id, speech), result in zip(batch, results, strict=True):
                    await self.save_transcript(session_id, speech, result)
            except (aiohttp.ClientError, TimeoutError, ValueError, *DATABASE_ERRORS):
                self.error = "Local transcription worker failed; speech was dropped."
                self.dropped += len(batch)

    @staticmethod
    def validate_results(results: object, count: int) -> None:
        if (
            not isinstance(results, list)
            or len(results) != count
            or not all(isinstance(result, dict) for result in results)
        ):
            message = "Invalid transcription batch response."
            raise ValueError(message)

    async def save_transcript(self, session_id: str, speech: Speech, result: dict) -> None:
        if not self.current(session_id, speech):
            self.dropped += 1
            return
        text = str(result.get("text", "")).strip()[:4000]
        if not text or result.get("language") not in {"nl", "en"}:
            return
        await asyncio.to_thread(
            self.db.execute,
            "INSERT INTO conversation_messages(id,session_id,speaker_id,speaker_name,avatar,started_at,"
            "ended_at,text,language) VALUES (?,?,?,?,?,?,?,?,?)",
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
            if not self.current(session_id, speech) or not any(
                matches(text, phrase, trigger["mode"]) for phrase in trigger["phrase"].splitlines()
            ):
                continue
            if trigger["target"] == "self" and speech.speaker_id != trigger["owner_id"]:
                continue
            if trigger["target"] == "selected" and speech.speaker_id not in json.loads(trigger["speakers"]):
                continue
            if not reserve_cooldown(self.cooldowns, trigger):
                continue
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
        await self.playback.execute(
            trigger,
            PlaybackContext(
                {
                    "trigger_id": trigger["id"],
                    "speaker_id": speech.speaker_id,
                    "action": trigger.get("action", "play"),
                    "delay": trigger.get("delay", 0),
                },
                lambda: self.current(session_id, speech, trigger.get("delay", 0)),
            ),
        )

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
