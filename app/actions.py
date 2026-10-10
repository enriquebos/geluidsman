from __future__ import annotations

import asyncio
import json
import logging
import time
from dataclasses import dataclass
from typing import TYPE_CHECKING

import discord

from app.conversation_audio import SpeakingSink
from app.db import DATABASE_ERRORS
from app.trigger_playback import PlaybackContext, TriggerPlayback, cancel_pending, reserve_cooldown

if TYPE_CHECKING:
    from collections.abc import Callable

    from discord.ext.voice_recv import VoiceRecvClient

    from app.bot import Bot
    from app.config import Settings
    from app.db import Database
    from app.events import Events

MAX_PENDING = 128
MAX_STATES = 1024
MAX_EVENT_AGE = 5
FLAGS = {"self_video": "camera", "self_mute": "mute", "self_deaf": "deafen", "self_stream": "stream"}
EVENTS = {
    "camera_on": "Camera enabled",
    "camera_off": "Camera disabled",
    "mute_on": "Self muted",
    "mute_off": "Self unmuted",
    "deafen_on": "Self deafened",
    "deafen_off": "Self undeafened",
    "stream_on": "Stream started",
    "stream_off": "Stream stopped",
    "join": "Joined channel",
    "leave": "Left channel",
    "first_join": "First person joins",
    "speaking_start": "Someone starts speaking",
    "speaking_stop": "Someone stops speaking",
}


def fingerprint(state: discord.VoiceState) -> tuple:
    return (state.channel.id if state.channel else None, *(bool(getattr(state, key, False)) for key in FLAGS))


def transitions(before: discord.VoiceState, after: discord.VoiceState, channel_id: int) -> list[str]:
    old, new = fingerprint(before), fingerprint(after)
    if old[0] != new[0]:
        return (["leave"] if old[0] == channel_id else []) + (["join"] if new[0] == channel_id else [])
    if new[0] != channel_id:
        return []
    return [
        f"{name}_{'on' if new[index] else 'off'}"
        for index, name in enumerate(FLAGS.values(), 1)
        if old[index] != new[index]
    ]


@dataclass(frozen=True)
class VoiceEvent:
    actor_id: str
    name: str
    event: str
    generation: int
    channel_id: int
    received_at: float


class Actions:
    def __init__(self, settings: Settings, db: Database, events: Events, bot: Bot) -> None:
        self.settings, self.db, self.events, self.bot = settings, db, events, bot
        self.playback = TriggerPlayback(settings, db, events, bot)
        self.queue = asyncio.Queue(maxsize=MAX_PENDING)
        self.pending: set[asyncio.Task] = set()
        self.cooldowns: dict[str, float] = {}
        self.states: dict[str, tuple] = {}
        self.signature = None
        self.generation = 0
        self.processing = 0
        self.dropped = 0
        self.reported_dropped = 0
        self.overflow: VoiceEvent | None = None
        self.tasks: list[asyncio.Task] = []
        self.error: str | None = None
        self.speakers: set[str] = set()
        self.speech_epoch = 0
        self.speech_voice = None
        self.speech_sink = None
        self.speech_check = 0.0
        self.speech_wanted = False

    def invalidate(self) -> None:
        self.generation += 1
        self.signature = None
        self.release_speech()
        self.speakers.clear()
        self.states.clear()
        self.cooldowns.clear()
        for task in tuple(self.pending):
            task.cancel()
        while not self.queue.empty():
            self.queue.get_nowait()
        self.events.publish("actions")

    def synchronize(self) -> None:
        voice = self.bot.voice
        signature = (voice, voice.channel.id) if voice and voice.is_connected() and self.bot.client.is_ready() else None
        if signature == self.signature:
            return
        self.invalidate()
        self.signature = signature
        if voice and signature:
            self.states = {
                str(member.id): fingerprint(member.voice)
                for member in voice.channel.members
                if not member.bot and getattr(member, "voice", None)
            }
        self.events.publish("actions")

    def receive(self, member: discord.Member, before: discord.VoiceState, after: discord.VoiceState) -> None:
        if member.bot or member.guild.id != self.settings.discord_guild_id:
            return
        self.synchronize()
        if not self.signature:
            return
        actor = str(member.id)
        state = fingerprint(after)
        if self.states.get(actor) == state:
            return
        self.states[actor] = state
        if len(self.states) > MAX_STATES:
            del self.states[next(iter(self.states))]
        changes = transitions(before, after, self.signature[1])
        if "leave" in changes:
            self.speakers.discard(actor)
        if "join" in changes and not any(
            not participant.bot and str(participant.id) != actor for participant in self.bot.voice.channel.members
        ):
            changes.append("first_join")
        for event in changes:
            self.enqueue_event(member, event)

    def enqueue_event(self, member: discord.Member, event: str) -> None:
        item = VoiceEvent(
            str(member.id), member.display_name, event, self.generation, self.signature[1], time.monotonic()
        )
        if self.backlog() >= MAX_PENDING:
            self.dropped += 1
            self.overflow = item
        else:
            self.queue.put_nowait(item)

    def release_speech(self) -> None:
        self.speech_epoch += 1
        if self.speech_voice and self.speech_voice.sink is self.speech_sink and self.speech_voice.is_listening():
            self.speech_voice.stop_listening()
        self.speech_voice, self.speech_sink = None, None

    def speaking_callback(self, voice: VoiceRecvClient) -> Callable:
        loop = asyncio.get_running_loop()
        self.speech_epoch += 1
        generation, epoch = self.generation, self.speech_epoch

        def callback(member: discord.Member | None, kind: str) -> None:
            if not loop.is_closed():
                loop.call_soon_threadsafe(self.speaking_changed, member, kind, (generation, epoch, voice))

        return callback

    def speaking_changed(self, member: discord.Member | None, kind: str, connection: tuple) -> None:
        generation, epoch, voice = connection
        active = kind == "speaking_start"
        if (
            not member
            or member.bot
            or member.guild.id != self.settings.discord_guild_id
            or generation != self.generation
            or epoch != self.speech_epoch
            or voice is not self.bot.voice
            or not self.signature
            or self.bot.state.deafened
        ):
            return
        item = VoiceEvent(
            str(member.id), member.display_name, "speaking_start", generation, voice.channel.id, time.monotonic()
        )
        if not self.current(item) or (str(member.id) in self.speakers) == active:
            return
        if active:
            self.speakers.add(str(member.id))
        else:
            self.speakers.discard(str(member.id))
        if self.speech_wanted:
            self.enqueue_event(member, "speaking_start" if active else "speaking_stop")

    async def synchronize_speech(self) -> None:
        if time.monotonic() < self.speech_check:
            return
        self.speech_check = time.monotonic() + 1
        wanted = await self.db.run(
            self.db.one,
            "SELECT id FROM action_triggers WHERE enabled=1 AND event IN ('speaking_start','speaking_stop') LIMIT 1",
        )
        self.speech_wanted = bool(wanted)
        voice = self.bot.voice
        if not wanted or not self.signature or self.bot.state.deafened:
            if self.speech_voice:
                self.release_speech()
            if self.bot.state.deafened:
                self.speakers.clear()
            return
        if not voice.is_listening():
            self.speech_voice = voice
            self.speech_sink = SpeakingSink(self.speaking_callback(voice))
            voice.listen(self.speech_sink)

    def backlog(self) -> int:
        return self.queue.qsize() + len(self.pending) + self.processing

    def current(self, event: VoiceEvent) -> bool:
        voice = self.bot.voice
        if (
            event.generation != self.generation
            or not voice
            or not voice.is_connected()
            or not self.bot.client.is_ready()
            or voice.channel.id != event.channel_id
            or not self.signature
            or voice is not self.signature[0]
        ):
            return False
        if event.event.startswith("speaking_") and self.bot.state.deafened:
            return False
        return event.event == "leave" or any(str(member.id) == event.actor_id for member in voice.channel.members)

    def snapshot(self) -> dict:
        self.synchronize()
        voice = self.bot.voice if self.signature else None
        return {
            "connected": bool(voice),
            "deafened": self.bot.state.deafened,
            "channel_name": voice.channel.name if voice else None,
            "backlog": self.backlog(),
            "dropped": self.dropped,
            "error": self.error,
            "events": EVENTS,
            "participants": [
                {"id": str(member.id), "name": member.display_name, "avatar": str(member.display_avatar.url)}
                for member in voice.channel.members
                if not member.bot
            ]
            if voice
            else [],
        }

    async def start(self) -> None:
        self.tasks = [asyncio.create_task(self.monitor()), asyncio.create_task(self.process())]

    def report_drops(self) -> None:
        if self.dropped > self.reported_dropped:
            logging.getLogger("app.actions").warning(
                "Dropped %s actions because processing could not keep up or work became unavailable (total: %s)",
                self.dropped - self.reported_dropped,
                self.dropped,
            )
            self.reported_dropped = self.dropped

    async def monitor(self) -> None:
        while True:
            self.synchronize()
            try:
                self.report_drops()
                await self.flush_overflow()
                await self.synchronize_speech()
            except (*DATABASE_ERRORS, discord.DiscordException, RuntimeError, ValueError) as error:
                self.error = "Action queue audit failed. Check the admin console."
                logging.getLogger("app.actions").exception("Action queue audit failed (%s)", type(error).__name__)
                self.events.publish("actions")
            await asyncio.sleep(0.25)

    async def flush_overflow(self) -> None:
        if self.overflow:
            item, self.overflow = self.overflow, None
            await self.db.run(
                self.db.audit,
                None,
                "action_trigger.fire",
                name="Voice event queue",
                outcome="rejected",
                details={
                    "reason": "Action queue is full.",
                    "speaker_id": item.actor_id,
                    "speaker_name": item.name,
                    "event": item.event,
                    "event_label": EVENTS[item.event],
                    "dropped": self.dropped,
                },
            )
            self.events.publish("audit")

    async def process(self) -> None:
        while True:
            event = await self.queue.get()
            self.processing = 1
            try:
                await self.match(event)
            except (*DATABASE_ERRORS, discord.DiscordException, RuntimeError, ValueError) as error:
                self.error = "Action processing failed. Check the admin console."
                logging.getLogger("app.actions").exception("Action processing failed (%s)", type(error).__name__)
                self.events.publish("actions")
            finally:
                self.processing = 0

    async def match(self, event: VoiceEvent) -> None:
        if not self.current(event) or time.monotonic() - event.received_at > MAX_EVENT_AGE:
            return
        rules = await self.db.run(
            self.db.rows,
            "SELECT * FROM action_triggers WHERE enabled=1 AND event=? ORDER BY created_at,id",
            (event.event,),
        )
        matching = [rule for rule in rules if self.matches_speaker(rule, event.actor_id)]
        specific = any(rule["target"] != "everyone" for rule in matching)
        for rule in matching:
            if specific and rule["target"] == "everyone":
                await self.skipped(rule, event, "Ignored because a user-specific action matches this event.")
                continue
            if not self.current(event) or not reserve_cooldown(self.cooldowns, rule):
                continue
            if self.backlog() >= MAX_PENDING:
                self.dropped += 1
                await self.skipped(rule, event, "Action queue is full.")
                continue
            task = asyncio.create_task(self.run(rule, event))
            self.pending.add(task)
            task.add_done_callback(self.finish)

    @staticmethod
    def selected_speakers(rule: dict) -> list:
        return json.loads(rule["speakers"])

    @classmethod
    def matches_speaker(cls, rule: dict, actor_id: str) -> bool:
        if rule["target"] == "self":
            return actor_id == rule["owner_id"]
        return rule["target"] == "everyone" or actor_id in cls.selected_speakers(rule)

    async def overridden(self, rule: dict, event: VoiceEvent) -> bool:
        if rule["target"] != "everyone":
            return False
        specific = await self.db.run(
            self.db.rows,
            "SELECT * FROM action_triggers WHERE enabled=1 AND event=? AND target<>'everyone'",
            (event.event,),
        )
        return any(self.matches_speaker(candidate, event.actor_id) for candidate in specific)

    def finish(self, task: asyncio.Task) -> None:
        self.pending.discard(task)
        if not task.cancelled() and task.exception():
            self.error = "Action execution failed. Check the admin console."
            logging.getLogger("app.actions").error("Action execution failed (%s)", type(task.exception()).__name__)
        self.events.publish("actions")

    async def skipped(self, rule: dict, event: VoiceEvent, reason: str) -> None:
        await self.db.run(
            self.db.audit,
            rule["owner_id"],
            "action_trigger.fire",
            rule["id"],
            EVENTS[event.event],
            outcome="rejected",
            details={
                "speaker_id": event.actor_id,
                "speaker_name": event.name,
                "event": event.event,
                "event_label": EVENTS[event.event],
                "trigger_id": rule["id"],
                "reason": reason,
            },
        )
        self.events.publish("audit")

    async def unchanged(self, rule: dict, event: VoiceEvent) -> bool:
        latest = await self.db.run(self.db.one, "SELECT * FROM action_triggers WHERE id=?", (rule["id"],))
        return (
            latest == rule
            and not await self.overridden(rule, event)
            and self.current(event)
            and time.monotonic() - event.received_at <= rule["delay"] + MAX_EVENT_AGE
        )

    async def run(self, rule: dict, event: VoiceEvent) -> None:
        await asyncio.sleep(rule["delay"])
        latest = await self.db.run(self.db.one, "SELECT * FROM action_triggers WHERE id=?", (rule["id"],))
        if (
            latest != rule
            or not latest["enabled"]
            or not self.current(event)
            or time.monotonic() - event.received_at > rule["delay"] + MAX_EVENT_AGE
        ):
            await self.skipped(rule, event, "Rule changed or participant/connection is no longer eligible.")
            return
        if await self.overridden(rule, event):
            await self.skipped(rule, event, "Ignored because a user-specific action matches this event.")
            return
        await self.playback.execute(
            rule,
            PlaybackContext(
                {
                    "trigger_id": rule["id"],
                    "speaker_id": event.actor_id,
                    "speaker_name": event.name,
                    "event": event.event,
                    "event_label": EVENTS[event.event],
                    "action": rule["action"],
                    "delay": rule["delay"],
                },
                lambda: self.current(event),
                participant_id=event.actor_id,
                channel_id=event.channel_id,
                departed=event.event == "leave",
                namespace="actions",
                access="view_actions",
                preflight=lambda: self.unchanged(rule, event),
            ),
        )

    async def close(self) -> None:
        self.invalidate()
        await cancel_pending(self.pending)
        for task in self.tasks:
            task.cancel()
        await asyncio.gather(*self.tasks, return_exceptions=True)
