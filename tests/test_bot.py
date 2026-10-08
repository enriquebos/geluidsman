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

from app.bot import Bot, VoiceError
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
        state.volume(0.2)
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
            cls=VoiceRecvClient, timeout=None, reconnect=True, self_deaf=False, self_mute=False
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
            cls=VoiceRecvClient, timeout=None, reconnect=True, self_deaf=False, self_mute=False
        )
        await bot.close()
        db.close()

    asyncio.run(scenario())
