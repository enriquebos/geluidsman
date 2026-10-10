from __future__ import annotations

import asyncio
import logging
import time
from typing import TYPE_CHECKING

import aiohttp
import discord
from discord.ext.voice_recv import VoiceRecvClient

from app.mixer import Mixer

if TYPE_CHECKING:
    from pathlib import Path

    from app.config import Settings
    from app.db import Database
    from app.events import Events
    from app.types import JsonObject


GUILD_MEMBER_PAGE_SIZE = 1000
EXCLUDED_VOICE_CHANNEL_ID = 1355614484797980723
VOICE_HANDSHAKE_TIMEOUT = 60.0
VOICE_RECOVERY_GRACE = 30.0


class VoiceError(ValueError):
    pass


class GuildVoice:
    def __init__(self, settings: Settings, db: Database, events: Events, client: discord.Client, guild_id: int) -> None:
        self.settings = settings.model_copy(update={"discord_guild_id": guild_id})
        self.db, self.events, self.client = db, events, client
        self.error = None
        self.mixer = None
        self.lock = asyncio.Lock()
        self.loop = asyncio.get_running_loop()
        self.muted = False
        self.deafened = not db.setting("conversation_enabled", default=True)
        self.desired_channel_id = None
        self.retry_at = 0.0
        self.retry_delay = 5.0
        self.connection_task = None
        self.disconnected_since = None
        self.receiver = None
        self.actions = None
        self.master_volume = db.setting(f"guild:{guild_id}:master_volume", 0.8)
        self.selected_channel_id = db.setting(f"guild:{guild_id}:selected_channel_id")

    @property
    def voice(self) -> discord.VoiceClient | None:
        guild = self.client.get_guild(self.settings.discord_guild_id)
        return guild.voice_client if guild else None

    def notify_playback(self) -> None:
        def changed() -> None:
            voice = self.voice
            if voice and self.mixer and not self.mixer.snapshot() and voice.is_playing():
                voice.pause()
            self.events.publish("playback")

        if not self.loop.is_closed():
            self.loop.call_soon_threadsafe(changed)

    def channels(self) -> list[JsonObject]:
        guild = self.client.get_guild(self.settings.discord_guild_id)
        if not guild or not guild.me:
            return []
        return [
            {"id": str(c.id), "name": c.name, "category": c.category.name if c.category else None}
            for c in guild.voice_channels
            if c.id != EXCLUDED_VOICE_CHANNEL_ID
            and c.permissions_for(guild.me).view_channel
            and c.permissions_for(guild.me).connect
            and c.permissions_for(guild.me).speak
        ]

    def status(self) -> JsonObject:
        voice = self.voice
        token = bool(self.settings.discord_token.get_secret_value())
        connected = bool(voice and voice.is_connected())
        connection_state = (
            "connecting"
            if self.connection_task and not self.connection_task.done()
            else "connected"
            if connected
            else "reconnecting"
            if self.desired_channel_id
            else "disconnected"
        )
        return {
            "connection_state": connection_state,
            "snapshot_at": time.time(),
            "bot_ready": self.client.is_ready(),
            "configured": token,
            "error": self.error or (None if token else "Add DISCORD_TOKEN to .env and restart to connect your bot."),
            "guild_id": str(self.settings.discord_guild_id),
            "connected": connected,
            "channel_id": str(voice.channel.id) if voice else None,
            "channel_name": voice.channel.name if voice else None,
            "selected_channel_id": self.selected_channel_id,
            "master_volume": self.master_volume,
            "muted": self.muted,
            "deafened": self.deafened,
            "max_playbacks": self.settings.max_playbacks,
            "playbacks": self.mixer.snapshot() if self.mixer else [],
            "participants": [
                {"id": str(member.id), "name": member.display_name, "avatar": str(member.display_avatar.url)}
                for member in (voice.channel.members if voice and voice.is_connected() else [])
                if not member.bot
            ],
        }

    async def connect(self, channel_id: str) -> None:
        async with self.lock:
            self.desired_channel_id = None
            await self.connect_unlocked(channel_id)
            self.desired_channel_id = channel_id
            self.retry_delay = 5.0
            self.error = None

    async def connect_unlocked(self, channel_id: str) -> None:
        if not self.client.is_ready():
            msg = "Bot is offline. Configure the token and wait for Discord to connect."
            raise VoiceError(msg)
        guild = self.client.get_guild(self.settings.discord_guild_id)
        if not guild:
            msg = "Bot is not in the configured Discord server."
            raise VoiceError(msg)
        channel = guild.get_channel(int(channel_id))
        if not isinstance(channel, discord.VoiceChannel) or str(channel.id) not in {c["id"] for c in self.channels()}:
            msg = "Choose an accessible voice channel in the configured server."
            raise VoiceError(msg)
        await self.disconnect_unlocked()
        self.desired_channel_id = channel_id
        self.disconnected_since = None
        try:
            self.connection_task = asyncio.create_task(
                channel.connect(
                    cls=VoiceRecvClient,
                    timeout=VOICE_HANDSHAKE_TIMEOUT,
                    reconnect=True,
                    self_deaf=self.deafened,
                    self_mute=self.muted,
                )
            )
            self.events.publish("status")
            await asyncio.wait_for(self.connection_task, timeout=VOICE_HANDSHAKE_TIMEOUT + 15)
            self.mixer = Mixer(self.settings.max_playbacks, self.master_volume, self.notify_playback)
            self.mixer.muted = self.muted
            if self.actions:
                self.actions.synchronize()
        except asyncio.CancelledError:
            await self.disconnect_unlocked()
            if asyncio.current_task().cancelling():
                raise
            message = "Voice connection cancelled."
            raise VoiceError(message) from None
        except TimeoutError as exc:
            await self.disconnect_unlocked()
            self.retry_at = time.monotonic() + self.retry_delay
            self.error = "Voice handshake timed out. Retrying automatically."
            logging.getLogger("app.bot").warning(self.error)
            self.events.publish("status")
            raise VoiceError(self.error) from exc
        except Exception as exc:
            logging.getLogger("app.bot").exception("Voice connection failed")
            await self.disconnect_unlocked()
            msg = "Could not join voice. Check Connect/Speak permissions and DAVE/Opus dependencies."
            raise VoiceError(msg) from exc
        finally:
            self.connection_task = None
        await self.db.run(
            self.db.set_setting, f"guild:{self.settings.discord_guild_id}:selected_channel_id", str(channel.id)
        )
        self.selected_channel_id = str(channel.id)
        self.events.publish("status")

    async def reconnect(self) -> None:
        async with self.lock:
            if not self.desired_channel_id or not self.client.is_ready():
                return
            voice = self.voice
            now = time.monotonic()
            if voice and voice.is_connected():
                self.disconnected_since = None
                self.retry_delay = 5.0
                self.retry_at = now + 5.0
                return
            if voice:
                if self.disconnected_since is None:
                    self.disconnected_since = now
                if now - self.disconnected_since < VOICE_RECOVERY_GRACE:
                    return
            if now < self.retry_at:
                return
            if voice:
                logging.getLogger("app.bot").warning("Voice recovery stalled; replacing disconnected voice client")
            try:
                await self.connect_unlocked(self.desired_channel_id)
            except VoiceError:
                self.error = "Voice connection interrupted. Retrying automatically."
                self.retry_at = time.monotonic() + self.retry_delay
                self.retry_delay = min(self.retry_delay * 2, 60.0)
                self.events.publish("status")
            else:
                self.error = None
                self.retry_delay = 5.0

    async def disconnect_unlocked(self) -> None:
        if self.actions:
            self.actions.invalidate()
        if self.receiver:
            await self.receiver.close_session()
        if self.mixer:
            self.mixer.cleanup()
            self.mixer = None
        voice = self.voice
        if voice:
            voice.stop()
            try:
                await asyncio.wait_for(voice.disconnect(force=True), timeout=10)
            except TimeoutError:
                voice.cleanup()
                logging.getLogger("app.bot").warning(
                    "Voice disconnect confirmation unavailable; local cleanup completed"
                )
        self.events.publish("status")

    async def disconnect(self) -> None:
        task = self.connection_task
        if task:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
        async with self.lock:
            self.desired_channel_id = None
            self.error = None
            await self.disconnect_unlocked()

    def play(self, path: Path, clip: JsonObject) -> str:
        if not self.client.is_ready() or not self.voice or not self.voice.is_connected() or not self.mixer:
            msg = "Connect the bot to a voice channel before playing a sound."
            raise VoiceError(msg)
        if self.voice.is_paused() and not self.mixer.closed:
            instance_id = self.mixer.add(path, clip)
            self.voice.resume()
            return instance_id
        if not self.voice.is_playing():
            self.mixer = Mixer(self.settings.max_playbacks, self.master_volume, self.notify_playback)
            self.mixer.muted = self.muted
            instance_id = self.mixer.add(path, clip)
            self.voice.play(self.mixer, after=lambda _error: self.notify_playback())
            return instance_id
        return self.mixer.add(path, clip)

    def update_flags(self, *, muted: bool, deafened: bool) -> None:
        self.muted, self.deafened = muted, deafened
        if self.mixer:
            with self.mixer.lock:
                self.mixer.muted = muted

    async def flags(self, *, muted: bool, deafened: bool) -> None:
        async with self.lock:
            voice = self.voice
            if not voice or not voice.is_connected():
                msg = "Connect the bot before changing mute or deafen."
                raise VoiceError(msg)
            guild = self.client.get_guild(self.settings.discord_guild_id)
            try:
                await guild.change_voice_state(channel=voice.channel, self_mute=muted, self_deaf=deafened)
            except discord.DiscordException as exc:
                logging.getLogger("app.bot").exception("Could not change bot voice state")
                msg = "Discord could not change the bot voice state. Try again shortly."
                raise VoiceError(msg) from exc
            self.update_flags(muted=muted, deafened=deafened)
            if deafened and self.receiver:
                await self.receiver.close_session()
            self.events.publish("status")

    async def volume(self, value: float) -> None:
        self.master_volume = value
        if self.mixer:
            with self.mixer.lock:
                self.mixer.volume = value
        await self.db.run(self.db.set_setting, f"guild:{self.settings.discord_guild_id}:master_volume", value)
        self.events.publish("status")


class Bot:
    def __init__(self, settings: Settings, db: Database, events: Events) -> None:
        self.settings, self.db, self.events = settings, db, events
        self.actions = None
        self.startup_recovery_checked = False
        self.closing = False
        self.directory_cache = []
        self.directory_expires = 0.0
        self.directory_lock = asyncio.Lock()
        intents = discord.Intents.none()
        intents.guilds = True
        intents.voice_states = True
        intents.emojis_and_stickers = True
        self.client = discord.Client(intents=intents, application_id=settings.discord_application_id)
        self.state = GuildVoice(settings, db, events, self.client, settings.discord_guild_id)
        self.task = None
        self.monitor_task = None
        self.progress_task = None
        self.error = None
        self.guild_state()

        @self.client.event
        async def on_ready() -> None:
            self.error = None
            self.directory_expires = 0.0
            logging.getLogger("app.bot").info("Discord bot connected")
            await self.remember_guild_names()
            await self.recover_startup_voice()
            self.events.publish("refresh")

        @self.client.event
        async def on_disconnect() -> None:
            async with self.state.lock:
                await self.state.disconnect_unlocked()
            self.events.publish("status")

        @self.client.event
        async def on_guild_emojis_update(
            guild: discord.Guild, _before: tuple[discord.Emoji, ...], _after: tuple[discord.Emoji, ...]
        ) -> None:
            self.emojis_changed(guild.id)

        @self.client.event
        async def on_voice_state_update(
            member: discord.Member, before: discord.VoiceState, after: discord.VoiceState
        ) -> None:
            await self.voice_state_changed(member, before, after)

    async def voice_state_changed(
        self, member: discord.Member, before: discord.VoiceState, after: discord.VoiceState
    ) -> None:
        if member.guild.id == self.settings.discord_guild_id and not member.bot:
            self.events.publish("status")
        if self.actions:
            self.actions.receive(member, before, after)
            if self.client.user and member.id == self.client.user.id and before.channel != after.channel:
                self.actions.invalidate()
        if self.client.user and member.id == self.client.user.id:
            state = self.state if member.guild.id == self.settings.discord_guild_id else None
            if state:
                state.update_flags(muted=after.self_mute, deafened=after.self_deaf or after.deaf)
                if state.receiver and (before.channel != after.channel or after.self_deaf or after.deaf):
                    await state.receiver.close_session()
                if after.channel and state.desired_channel_id:
                    state.desired_channel_id = str(after.channel.id)
            if before.channel != after.channel and state and state.mixer:
                state.mixer.stop()
            self.events.publish("status")

    async def recover_startup_voice(self) -> None:
        if self.startup_recovery_checked or self.closing:
            return
        self.startup_recovery_checked = True
        guild = self.client.get_guild(self.settings.discord_guild_id)
        member_voice = guild.me.voice if guild and guild.me else None
        if not member_voice or not member_voice.channel or self.state.voice or self.state.desired_channel_id:
            return
        self.state.update_flags(muted=member_voice.self_mute, deafened=member_voice.self_deaf or member_voice.deaf)
        try:
            await self.state.connect(str(member_voice.channel.id))
        except VoiceError:
            self.state.error = "Could not recover the existing Discord voice connection. Connect manually to retry."
            self.events.publish("status")

    async def guild_members(self) -> list[JsonObject]:
        async with self.directory_lock:
            if time.monotonic() < self.directory_expires:
                return self.directory_cache
            if not self.client.is_ready():
                message = "Discord is offline. Try the speaker list again shortly."
                raise VoiceError(message)
            members = []
            after = None
            while True:
                page = await self.client.http.get_members(
                    self.settings.discord_guild_id, limit=GUILD_MEMBER_PAGE_SIZE, after=after
                )
                for member in page:
                    user = member["user"]
                    if not user.get("bot", False):
                        avatar = user.get("avatar")
                        members.append(
                            {
                                "id": user["id"],
                                "name": member.get("nick") or user.get("global_name") or user["username"],
                                "avatar": f"https://cdn.discordapp.com/avatars/{user['id']}/{avatar}.png"
                                if avatar
                                else None,
                            }
                        )
                if len(page) < GUILD_MEMBER_PAGE_SIZE:
                    break
                after = int(page[-1]["user"]["id"])
            self.directory_cache = sorted(members, key=lambda member: member["name"].casefold())
            self.directory_expires = time.monotonic() + 60
            return self.directory_cache

    def emojis_changed(self, guild_id: int) -> None:
        if guild_id == self.settings.discord_guild_id:
            self.events.publish("refresh")

    async def remember_guild_names(self) -> None:
        for guild in self.client.guilds:
            if guild.id != self.settings.discord_guild_id:
                continue
            await self.db.run(self.db.set_setting, f"guild:{guild.id}:name", guild.name)

    def emojis(self) -> list[JsonObject]:
        guild = self.client.get_guild(self.settings.discord_guild_id)
        if not guild:
            return []
        return [
            {"id": str(emoji.id), "name": emoji.name, "value": str(emoji), "animated": emoji.animated}
            for emoji in sorted(guild.emojis, key=lambda emoji: emoji.name.casefold())
            if emoji.available
        ]

    def guild_state(self, guild_id: int | None = None) -> GuildVoice:
        guild_id = guild_id or self.settings.discord_guild_id
        if guild_id != self.settings.discord_guild_id:
            message = "This app only supports the configured Discord server."
            raise VoiceError(message)
        return self.state

    @property
    def mixer(self) -> Mixer | None:
        return self.guild_state().mixer

    @mixer.setter
    def mixer(self, value: Mixer | None) -> None:
        self.guild_state().mixer = value

    @property
    def voice(self) -> discord.VoiceClient | None:
        return self.guild_state().voice

    def notify_playback(self) -> None:
        self.guild_state().notify_playback()

    def status(self, guild_id: int | None = None) -> JsonObject:
        state = self.guild_state(guild_id).status()
        state["error"] = self.error or state["error"]
        return state

    def channels(self, guild_id: int | None = None, member: discord.Member | None = None) -> list[JsonObject]:
        state = self.guild_state(guild_id)
        channels = state.channels()
        if member:
            return [
                item
                for item in channels
                if (channel := member.guild.get_channel(int(item["id"])))
                and channel.permissions_for(member).view_channel
                and channel.permissions_for(member).connect
            ]
        return channels

    def stop_clip(self, clip_id: str) -> None:
        if self.state.mixer:
            for playback in self.state.mixer.snapshot():
                if playback["clip_id"] == clip_id:
                    self.state.mixer.stop(playback["id"])

    def play(self, path: Path, clip: JsonObject, guild_id: int | None = None) -> str:
        return self.guild_state(guild_id).play(path, clip)

    async def start(self) -> None:
        if not self.settings.discord_token.get_secret_value():
            return
        logging.getLogger("discord").setLevel(logging.INFO)
        logging.getLogger("discord.ext.voice_recv").setLevel(logging.WARNING)

        async def run() -> None:
            try:
                await self.client.start(self.settings.discord_token.get_secret_value(), reconnect=True)
            except discord.LoginFailure:
                logging.getLogger("app.bot").exception("Discord rejected the bot credentials")
                self.error = "Discord rejected the bot token. Update .env and restart."
                self.events.publish("status")
            except (discord.DiscordException, aiohttp.ClientError, OSError, RuntimeError):
                logging.getLogger("app.bot").exception("Discord connection failed")
                self.error = "Discord connection failed. Check network and voice dependencies, then restart."
                self.events.publish("status")

        self.task = asyncio.create_task(run())

        async def monitor() -> None:
            connected = False
            while True:
                voice = self.state.voice
                current = bool(voice and voice.is_connected() and self.client.is_ready())
                if connected and not current and self.state.mixer:
                    self.state.mixer.stop()
                    self.events.publish("status")
                connected = current
                await self.state.reconnect()
                await asyncio.sleep(1)

        self.monitor_task = asyncio.create_task(monitor())

        async def progress() -> None:
            while True:
                self.publish_playback_progress()
                await asyncio.sleep(0.5)

        self.progress_task = asyncio.create_task(progress())

    def publish_playback_progress(self) -> None:
        if not self.events.clients or not self.state.mixer:
            return
        items = self.state.mixer.snapshot()
        if items:
            self.events.publish(
                "playback_progress",
                {"snapshot_at": time.time(), "positions": {item["id"]: item["position"] for item in items}},
            )

    async def close(self) -> None:
        self.closing = True
        if self.progress_task:
            self.progress_task.cancel()
            await asyncio.gather(self.progress_task, return_exceptions=True)
        if self.monitor_task:
            self.monitor_task.cancel()
            await asyncio.gather(self.monitor_task, return_exceptions=True)
        try:
            await self.state.disconnect()
        finally:
            await self.client.close()
        if self.task:
            self.task.cancel()
            await asyncio.gather(self.task, return_exceptions=True)
