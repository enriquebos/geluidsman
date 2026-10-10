from __future__ import annotations

import asyncio
import wave
from typing import TYPE_CHECKING
from unittest.mock import AsyncMock, MagicMock, Mock, patch

import discord
import numpy as np
import pytest
from discord.ext.voice_recv import VoiceRecvClient
from pydantic import SecretStr

from app.bot import VOICE_HANDSHAKE_TIMEOUT, VOICE_RECOVERY_GRACE, Bot, VoiceError
from app.config import Settings
from app.db import Database
from app.events import Events
from app.mixer import Mixer

if TYPE_CHECKING:
    from pathlib import Path


def test_idle_voice_stream_pauses_and_resumes_without_restarting(tmp_path: Path) -> None:
    path = tmp_path / "sound.wav"
    with wave.open(str(path), "wb") as writer:
        writer.setparams((2, 2, 48000, 960, "NONE", "not compressed"))
        writer.writeframes(np.full(1920, 1000, dtype="<i2").tobytes())

    async def scenario() -> None:
        db = Database(tmp_path / "library.sqlite3")
        bot = Bot(Settings(_env_file=None, discord_token=SecretStr(""), data_dir=tmp_path), db, Events())
        voice = Mock(spec=discord.VoiceClient)
        voice.is_connected.return_value = True
        voice.is_playing.return_value = False
        voice.is_paused.return_value = True

        def pause() -> None:
            voice.is_playing.return_value = False
            voice.is_paused.return_value = True

        def resume() -> None:
            voice.is_playing.return_value = True
            voice.is_paused.return_value = False

        voice.pause.side_effect = pause
        voice.resume.side_effect = resume
        guild = Mock(voice_client=voice)
        bot.client.is_ready = lambda: True
        bot.client.get_guild = lambda _: guild
        bot.mixer = Mixer(on_change=bot.notify_playback)
        instance_id = bot.play(path, {"id": "test", "name": "Tone", "volume": 1})
        assert bot.mixer.snapshot()[0]["id"] == instance_id
        voice.resume.assert_called_once()
        voice.play.assert_not_called()
        voice.is_playing.return_value = True
        bot.mixer.read()
        bot.mixer.read()
        await asyncio.sleep(0)
        voice.pause.assert_called_once()
        assert bot.mixer.snapshot() == []
        bot.play(path, {"id": "test", "name": "Tone", "volume": 1})
        assert voice.resume.call_count == 2
        voice.play.assert_not_called()
        bot.mixer.cleanup()
        await bot.client.close()
        db.close()

    asyncio.run(scenario())


def test_only_configured_guild_has_voice_state(tmp_path: Path) -> None:
    async def scenario() -> None:
        db = Database(tmp_path / "single.sqlite3")
        settings = Settings(_env_file=None, discord_token=SecretStr(""), data_dir=tmp_path)
        bot = Bot(settings, db, Events())
        state = bot.guild_state()
        assert bot.guild_state(settings.discord_guild_id) is state
        with pytest.raises(VoiceError, match="configured Discord server"):
            bot.guild_state(222)
        voice = Mock(spec=discord.VoiceClient)
        voice.is_connected.return_value = True
        voice.disconnect = AsyncMock()
        bot.client.get_guild = lambda _: Mock(voice_client=voice)
        state.mixer = Mixer(on_change=state.notify_playback)
        await state.volume(0.2)
        assert state.mixer.volume == 0.2
        await state.disconnect()
        voice.disconnect.assert_awaited_once()
        await bot.close()
        db.close()

    asyncio.run(scenario())


def test_voice_reconnect_waits_for_discord_and_explicit_disconnect_cancels(tmp_path: Path) -> None:
    async def scenario() -> None:
        db = Database(tmp_path / "voice.sqlite3")
        bot = Bot(Settings(_env_file=None, discord_token=SecretStr(""), data_dir=tmp_path), db, Events())
        state = bot.state
        guild = Mock(voice_client=None)
        bot.client.is_ready = lambda: True
        bot.client.get_guild = lambda _: guild
        state.connect_unlocked = AsyncMock()
        await state.reconnect()
        state.connect_unlocked.assert_not_awaited()
        state.desired_channel_id = "123"
        bot.client.is_ready = lambda: False
        await state.reconnect()
        state.connect_unlocked.assert_not_awaited()
        bot.client.is_ready = lambda: True
        guild.voice_client = Mock(spec=discord.VoiceClient)
        guild.voice_client.is_connected.return_value = False
        await state.reconnect()
        state.connect_unlocked.assert_not_awaited()
        guild.voice_client = None
        await state.reconnect()
        state.connect_unlocked.assert_awaited_once_with("123")
        await state.disconnect()
        assert state.desired_channel_id is None
        await state.reconnect()
        assert state.connect_unlocked.await_count == 1
        await bot.close()
        db.close()

    asyncio.run(scenario())


def test_voice_reconnect_backoff_and_permission_checks(tmp_path: Path) -> None:
    async def scenario() -> None:
        db = Database(tmp_path / "retry.sqlite3")
        bot = Bot(Settings(_env_file=None, discord_token=SecretStr(""), data_dir=tmp_path), db, Events())
        state = bot.state
        guild = Mock(voice_client=None)
        channel = Mock(spec=discord.VoiceChannel)
        channel.id = 123
        channel.connect = AsyncMock(return_value=Mock(spec=discord.VoiceClient))
        guild.get_channel.return_value = channel
        bot.client.is_ready = lambda: True
        bot.client.get_guild = lambda _: guild
        state.channels = list
        state.desired_channel_id = "123"
        with patch("app.bot.time.monotonic", return_value=100):
            await state.reconnect()
            channel.connect.assert_not_awaited()
            assert state.retry_at == 105
            assert state.retry_delay == 10
            assert state.desired_channel_id == "123"
            assert "Retrying" in state.error
            state.channels = lambda: [{"id": "123"}]
            await state.reconnect()
            channel.connect.assert_not_awaited()
        with patch("app.bot.time.monotonic", return_value=106):
            await state.reconnect()
        channel.connect.assert_awaited_once_with(
            cls=VoiceRecvClient, timeout=VOICE_HANDSHAKE_TIMEOUT, reconnect=True, self_deaf=False, self_mute=False
        )
        assert state.error is None
        assert state.retry_delay == 5
        await bot.close()
        db.close()

    asyncio.run(scenario())


def test_server_emojis_use_configured_guild_and_hide_unavailable(tmp_path: Path) -> None:
    async def scenario() -> None:
        db = Database(tmp_path / "emoji.sqlite3")
        bot = Bot(Settings(_env_file=None, discord_token=SecretStr(""), data_dir=tmp_path), db, Events())
        emojis = []
        for emoji_id, name, available in ((123, "Dance", True), (456, "hidden", False)):
            emoji = MagicMock(spec=discord.Emoji)
            emoji.id, emoji.name, emoji.available, emoji.animated = emoji_id, name, available, True
            emoji.__str__.return_value = f"<a:{name}:{emoji_id}>"
            emojis.append(emoji)
        bot.client.get_guild = Mock(return_value=Mock(emojis=emojis))
        assert bot.emojis() == [{"id": "123", "name": "Dance", "value": "<a:Dance:123>", "animated": True}]
        bot.client.get_guild.assert_called_once_with(bot.settings.discord_guild_id)
        assert bot.client.intents.emojis_and_stickers
        bot.client.get_guild.return_value = None
        assert bot.emojis() == []
        await bot.close()
        db.close()

    asyncio.run(scenario())


def test_disconnect_cancels_connection_without_deadline(tmp_path: Path) -> None:
    async def scenario() -> None:
        db = Database(tmp_path / "pending.sqlite3")
        bot = Bot(Settings(_env_file=None, discord_token=SecretStr(""), data_dir=tmp_path), db, Events())
        entered = asyncio.Event()

        async def held(**_options: object) -> None:
            entered.set()
            await asyncio.Future()

        channel = Mock(spec=discord.VoiceChannel)
        channel.id = 123
        channel.connect = AsyncMock(side_effect=held)
        guild = Mock(voice_client=None)
        guild.get_channel.return_value = channel
        bot.client.get_guild = lambda _: guild
        bot.client.is_ready = lambda: True
        bot.state.channels = lambda: [{"id": "123"}]
        pending = asyncio.create_task(bot.state.connect("123"))
        await asyncio.wait_for(entered.wait(), timeout=1)
        await asyncio.wait_for(bot.state.disconnect(), timeout=1)
        with pytest.raises(VoiceError, match="cancelled"):
            await pending
        assert bot.state.desired_channel_id is None
        assert bot.state.connection_task is None
        channel.connect.assert_awaited_once_with(
            cls=VoiceRecvClient, timeout=VOICE_HANDSHAKE_TIMEOUT, reconnect=True, self_deaf=False, self_mute=False
        )
        await bot.close()
        db.close()

    asyncio.run(scenario())


def test_guild_directory_paginates_excludes_bots_and_shares_cache(tmp_path: Path) -> None:
    async def scenario() -> None:
        db = Database(tmp_path / "directory.sqlite3")
        bot = Bot(Settings(_env_file=None, data_dir=tmp_path), db, Events())
        page = [
            {"user": {"id": str(index), "username": f"Person {index}", "bot": index == 1}} for index in range(1, 1001)
        ]
        bot.client.is_ready = Mock(return_value=True)
        bot.client.http.get_members = AsyncMock(
            side_effect=[page, [{"user": {"id": "1001", "username": "Guest"}, "nick": "Guest nickname"}]]
        )
        first, second = await asyncio.gather(bot.guild_members(), bot.guild_members())
        assert first == second
        assert len(first) == 1000
        assert not any(member["id"] == "1" for member in first)
        assert any(member["name"] == "Guest nickname" for member in first)
        assert bot.client.http.get_members.await_count == 2
        assert bot.client.http.get_members.call_args.kwargs["after"] == 1000
        await bot.guild_members()
        assert bot.client.http.get_members.await_count == 2
        db.close()

    asyncio.run(scenario())


def test_status_connected_users_excludes_bots(tmp_path: Path) -> None:
    async def scenario() -> None:
        db = Database(tmp_path / "participants.sqlite3")
        bot = Bot(Settings(_env_file=None, data_dir=tmp_path), db, Events())
        human = Mock(id=100, bot=False, display_name="Human", display_avatar=Mock(url="avatar"))
        robot = Mock(id=200, bot=True, display_name="Robot")
        voice = Mock(is_connected=Mock(return_value=True))
        voice.channel.members = [human, robot]
        bot.client.get_guild = Mock(return_value=Mock(voice_client=voice))
        assert bot.status()["participants"] == [{"id": "100", "name": "Human", "avatar": "avatar"}]
        db.close()

    asyncio.run(scenario())


@pytest.mark.parametrize("present", [True, False])
def test_startup_recovers_only_discord_reported_voice_once(tmp_path: Path, *, present: bool) -> None:
    async def scenario() -> None:
        db = Database(tmp_path / "startup.sqlite3")
        bot = Bot(Settings(_env_file=None, discord_token=SecretStr(""), data_dir=tmp_path), db, Events())
        voice_state = Mock(channel=Mock(id=123), self_mute=True, self_deaf=True, deaf=False) if present else None
        guild = Mock(voice_client=None, me=Mock(voice=voice_state))
        bot.client.get_guild = lambda _: guild
        bot.state.connect = AsyncMock()
        db.set_setting(f"guild:{bot.settings.discord_guild_id}:selected_channel_id", "456")
        await bot.recover_startup_voice()
        await bot.recover_startup_voice()
        if present:
            bot.state.connect.assert_awaited_once_with("123")
            assert bot.state.muted
            assert bot.state.deafened
        else:
            bot.state.connect.assert_not_awaited()
        await bot.close()
        db.close()

    asyncio.run(scenario())


def test_gateway_disconnect_cleans_voice_and_retains_network_recovery_target(tmp_path: Path) -> None:
    async def scenario() -> None:
        db = Database(tmp_path / "gateway.sqlite3")
        bot = Bot(Settings(_env_file=None, discord_token=SecretStr(""), data_dir=tmp_path), db, Events())
        bot.state.desired_channel_id = "123"
        bot.state.disconnect_unlocked = AsyncMock()
        await bot.client.on_disconnect()
        bot.state.disconnect_unlocked.assert_awaited_once()
        assert bot.state.desired_channel_id == "123"
        await bot.close()
        assert bot.state.desired_channel_id is None
        db.close()

    asyncio.run(scenario())


def test_connection_snapshot_tracks_connecting_and_reconnecting(tmp_path: Path) -> None:
    async def scenario() -> None:
        db = Database(tmp_path / "status.sqlite3")
        bot = Bot(Settings(_env_file=None, discord_token=SecretStr(""), data_dir=tmp_path), db, Events())
        bot.client.get_guild = Mock(return_value=None)
        assert bot.state.status()["connection_state"] == "disconnected"
        bot.state.desired_channel_id = "123"
        assert bot.state.status()["connection_state"] == "reconnecting"
        pending = asyncio.create_task(asyncio.sleep(60))
        bot.state.connection_task = pending
        assert bot.state.status()["connection_state"] == "connecting"
        pending.cancel()
        await asyncio.gather(pending, return_exceptions=True)
        bot.state.connection_task = None
        voice = Mock(channel=Mock(id=123, name="Voice", members=[]))
        voice.is_connected.return_value = True
        bot.client.get_guild = Mock(return_value=Mock(voice_client=voice))
        assert bot.state.status()["connection_state"] == "connected"
        bot.client.get_guild = Mock(return_value=None)
        await bot.close()
        assert bot.state.status()["connection_state"] == "disconnected"
        db.close()

    asyncio.run(scenario())


def test_excluded_channel_is_not_listed_and_cannot_be_connected(tmp_path: Path) -> None:
    async def scenario() -> None:
        db = Database(tmp_path / "excluded.sqlite3")
        bot = Bot(Settings(_env_file=None, discord_token=SecretStr(""), data_dir=tmp_path), db, Events())
        blocked = Mock(spec=discord.VoiceChannel, id=1355614484797980723, category=None)
        allowed = Mock(spec=discord.VoiceChannel, id=123, category=None)
        guild = Mock(me=Mock(), voice_channels=[blocked, allowed], voice_client=None)
        guild.get_channel.return_value = blocked
        bot.client.get_guild = Mock(return_value=guild)
        bot.client.is_ready = Mock(return_value=True)
        assert [channel["id"] for channel in bot.channels()] == ["123"]
        with pytest.raises(VoiceError, match="accessible voice channel"):
            await bot.state.connect_unlocked(str(blocked.id))
        blocked.connect.assert_not_called()
        await bot.close()
        db.close()

    asyncio.run(scenario())


def test_playback_progress_publishes_only_actual_mixer_positions(tmp_path: Path) -> None:
    async def scenario() -> None:
        db = Database(tmp_path / "progress.sqlite3")
        events = Events()
        bot = Bot(Settings(_env_file=None, discord_token=SecretStr(""), data_dir=tmp_path), db, events)
        queue = asyncio.Queue()
        events.clients.add(queue)
        bot.state.mixer = Mock()
        bot.state.mixer.snapshot.return_value = [{"id": "instance", "position": 1.25, "name": "Sound"}]
        bot.publish_playback_progress()
        message = queue.get_nowait()
        assert '"positions": {"instance": 1.25}' in message
        assert "playback_progress" in message
        assert "Sound" not in message
        bot.state.mixer.snapshot.return_value = []
        bot.publish_playback_progress()
        assert queue.empty()
        bot.state.mixer = None
        await bot.close()
        db.close()

    asyncio.run(scenario())


def test_stale_voice_client_recovers_after_grace_but_healthy_calls_remain(tmp_path: Path) -> None:
    async def scenario() -> None:
        db = Database(tmp_path / "recovery.sqlite3")
        bot = Bot(Settings(_env_file=None, discord_token=SecretStr(""), data_dir=tmp_path), db, Events())
        voice = Mock(spec=discord.VoiceClient)
        voice.is_connected.return_value = False
        guild = Mock(voice_client=voice)
        bot.client.get_guild = lambda _: guild
        bot.client.is_ready = lambda: True
        bot.state.desired_channel_id = "123"
        bot.state.connect_unlocked = AsyncMock()
        with patch("app.bot.time.monotonic", return_value=100):
            await bot.state.reconnect()
        bot.state.connect_unlocked.assert_not_awaited()
        with patch("app.bot.time.monotonic", return_value=100 + VOICE_RECOVERY_GRACE):
            await bot.state.reconnect()
        bot.state.connect_unlocked.assert_awaited_once_with("123")
        voice.is_connected.return_value = True
        with patch("app.bot.time.monotonic", return_value=10000):
            await bot.state.reconnect()
        assert bot.state.connect_unlocked.await_count == 1
        assert bot.state.disconnected_since is None
        await bot.close()
        db.close()

    asyncio.run(scenario())


def test_handshake_timeout_cleans_up_and_retains_retry_target(tmp_path: Path) -> None:
    async def scenario() -> None:
        db = Database(tmp_path / "timeout.sqlite3")
        bot = Bot(Settings(_env_file=None, discord_token=SecretStr(""), data_dir=tmp_path), db, Events())
        channel = Mock(spec=discord.VoiceChannel)
        channel.id = 123
        channel.connect = AsyncMock(side_effect=TimeoutError)
        guild = Mock(voice_client=None)
        guild.get_channel.return_value = channel
        bot.client.get_guild = lambda _: guild
        bot.client.is_ready = lambda: True
        bot.state.channels = lambda: [{"id": "123"}]
        bot.state.disconnect_unlocked = AsyncMock()
        with pytest.raises(VoiceError, match="handshake timed out"):
            await bot.state.connect("123")
        assert bot.state.disconnect_unlocked.await_count == 2
        assert bot.state.connection_task is None
        assert bot.state.desired_channel_id == "123"
        assert bot.state.retry_at > 0
        assert bot.state.mixer is None
        await bot.state.disconnect()
        assert bot.state.desired_channel_id is None
        await bot.close()
        db.close()

    asyncio.run(scenario())
