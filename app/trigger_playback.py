from __future__ import annotations

import asyncio
import json
import time
from dataclasses import dataclass
from typing import TYPE_CHECKING

import discord

from app.permissions import effective_permissions

if TYPE_CHECKING:
    from collections.abc import Awaitable, Callable

    from app.bot import Bot
    from app.config import Settings
    from app.db import Database
    from app.events import Events


async def cancel_pending(tasks: set[asyncio.Task]) -> None:
    for task in tuple(tasks):
        task.cancel()
    await asyncio.gather(*tuple(tasks), return_exceptions=True)
    tasks.clear()


def reserve_cooldown(cooldowns: dict[str, float], trigger: dict) -> bool:
    now = time.monotonic()
    if now - cooldowns.get(trigger["id"], float("-inf")) < trigger["cooldown"]:
        return False
    cooldowns[trigger["id"]] = now
    return True


@dataclass(frozen=True)
class PlaybackContext:
    details: dict
    valid: Callable[[], bool]
    participant_id: str
    channel_id: int
    departed: bool = False
    namespace: str = "trigger"
    access: str | None = None
    preflight: Callable[[], Awaitable[bool]] | None = None


class TriggerPlayback:
    def __init__(self, settings: Settings, db: Database, events: Events, bot: Bot) -> None:
        self.settings, self.db, self.events, self.bot = settings, db, events, bot

    def permitted(self, owner: str, permissions: tuple[str, ...]) -> bool:
        user = self.db.one("SELECT permission_overrides FROM users WHERE id=?", (owner,))
        if not user:
            return False
        effective = effective_permissions(
            json.loads(user["permission_overrides"]), admin=owner in self.settings.app_admin_ids
        )
        return all(effective[key] for key in permissions)

    async def guild_member(self, guild: discord.Guild | None, user_id: str) -> discord.Member | None:
        if not guild:
            return None
        return guild.get_member(int(user_id)) or await asyncio.wait_for(guild.fetch_member(int(user_id)), 5)

    def participant_eligible(self, member: discord.Member | None, context: PlaybackContext) -> bool:
        voice = self.bot.voice
        if not member or member.bot or not voice or not voice.is_connected() or voice.channel.id != context.channel_id:
            return False
        permissions = voice.channel.permissions_for(member)
        present = any(str(person.id) == context.participant_id for person in voice.channel.members)
        return bool(permissions.view_channel and permissions.connect and (context.departed or present))

    async def authorization(self, trigger: dict, context: PlaybackContext) -> str | None:
        permission = "stop_sounds" if trigger.get("action") == "stop_all" else "play_sounds"
        required = (permission, context.access) if context.access else (permission,)
        if not await self.db.run(self.permitted, trigger["owner_id"], required):
            return "Creator no longer has permission for this trigger action."
        guild = self.bot.client.get_guild(self.settings.discord_guild_id)
        member = await self.guild_member(guild, trigger["owner_id"])
        participant = (
            member
            if context.participant_id == trigger["owner_id"]
            else await self.guild_member(guild, context.participant_id)
        )
        voice = self.bot.voice
        if not context.valid() or not member or not voice:
            return "Voice connection or creator membership is unavailable."
        permissions = voice.channel.permissions_for(member)
        if not permissions.view_channel or not permissions.connect:
            return "Creator cannot access the active voice channel."
        if not self.participant_eligible(participant, context):
            return "Triggering participant is no longer eligible for the active voice channel."
        if (
            not await self.db.run(self.permitted, trigger["owner_id"], required)
            or not context.valid()
            or not self.participant_eligible(participant, context)
        ):
            return "Creator permission, participant eligibility or voice connection changed."
        return None

    async def prepare(self, trigger: dict, context: PlaybackContext) -> tuple[dict | None, str | None]:
        reason = await self.authorization(trigger, context)
        if not reason and context.preflight and not await context.preflight():
            reason = "Rule changed or participant/connection is no longer eligible."
        clip = await self.db.run(self.db.one, "SELECT * FROM clips WHERE id=?", (trigger["clip_id"],))
        if not reason and not context.valid():
            reason = "Voice connection is no longer eligible."
        if not reason and trigger.get("action", "play") != "stop_all" and not clip:
            reason = "The selected sound was deleted."
        return clip, reason

    async def execute(self, trigger: dict, context: PlaybackContext) -> None:
        details = context.details
        stopping = trigger.get("action", "play") == "stop_all"
        clip = None
        reason, instance = None, None
        try:
            clip, reason = await self.prepare(trigger, context)
            if not reason:
                if stopping:
                    if self.bot.state.mixer:
                        self.bot.state.mixer.stop()
                    await self.db.run(
                        self.db.audit,
                        trigger["owner_id"],
                        "sound.stop_all",
                        guild_id=str(self.settings.discord_guild_id),
                        details=details,
                    )
                    self.events.publish("playback")
                else:
                    instance = self.bot.state.play(self.settings.data_dir / "media" / clip["id"] / "sound.wav", clip)
        except (discord.DiscordException, ValueError, OSError, TimeoutError):
            reason = "Playback unavailable, permission denied, or all playback slots are in use."
        if instance:
            await self.db.run(
                self.db.audit,
                trigger["owner_id"],
                "sound.play",
                clip["id"],
                clip["name"],
                guild_id=str(self.settings.discord_guild_id),
                details=details,
            )
        if reason:
            details = {**details, "reason": reason}
        await self.db.run(
            self.db.audit,
            trigger["owner_id"],
            "action_trigger.fire" if context.namespace == "actions" else "trigger.play",
            trigger["id"],
            "Stop all sounds" if stopping else clip["name"] if clip else "Deleted sound",
            outcome="rejected" if reason else "success",
            details=details,
        )
        self.events.publish("audit")
        self.events.publish(context.namespace if context.namespace == "actions" else "conversation")
