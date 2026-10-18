from __future__ import annotations

import asyncio
import threading
import time
from types import SimpleNamespace
from typing import TYPE_CHECKING
from unittest.mock import AsyncMock, Mock

import discord
import pytest
from pydantic import SecretStr

from app.actions import Actions
from app.bot import Bot, VoiceError
from app.config import Settings
from app.conversation import Conversation
from app.conversation_audio import Speech
from app.db import Database
from app.events import Events
from app.trigger_playback import PlaybackContext
from tests.test_actions import engine, event, rule
from tests.test_conversation import seed
from tests.test_music_routes import client as music_fixture
from tests.test_music_routes import connected

if TYPE_CHECKING:
    from collections.abc import Iterator
    from pathlib import Path

    from fastapi.testclient import TestClient


@pytest.fixture
def client(tmp_path: Path) -> Iterator[TestClient]:
    yield from music_fixture.__wrapped__(tmp_path)


def mode_components(tmp_path: Path) -> tuple:
    db = Database(tmp_path / "mode.sqlite3")
    seed(db)
    db.set_setting("conversation_enabled", value=True)
    settings = Settings(_env_file=None, data_dir=tmp_path, discord_token=SecretStr(""))
    bot = Bot(settings, db, Events())
    voice = Mock()
    voice.is_connected.return_value = True
    voice.is_listening.return_value = True
    voice.channel = SimpleNamespace(id=123, name="Room", members=[])
    voice.disconnect = AsyncMock()
    guild = Mock(voice_client=voice, change_voice_state=AsyncMock())
    bot.client.get_guild = lambda _: guild
    bot.client.is_ready = lambda: True
    conversation = Conversation(settings, db, bot.events, bot)
    actions = Actions(settings, db, bot.events, bot)
    bot.state.receiver = conversation
    bot.actions = actions
    bot.state.actions = actions
    bot.state.music = SimpleNamespace(pause=AsyncMock(), update_volume=Mock())
    mixer = Mock()
    bot.state.mixer = mixer
    conversation.provider = "deepgram"
    conversation.deepgram = SimpleNamespace(close=AsyncMock())
    conversation.session = {"id": "session", "channel_id": "123", "channel_name": "Room"}
    conversation.voice = voice
    conversation.allowed = {"100"}
    conversation.packets.put(("session", ("100", "Owner", None), b"pcm", time.time()))
    conversation.work.put_nowait(("session", Speech("100", "Owner", None, 0, 0, b"pcm")))
    db.execute(
        "INSERT INTO conversations(id,channel_id,channel_name,started_at) VALUES (?,?,?,?)",
        ("session", "123", "Room", time.time()),
    )
    return db, bot, conversation, actions, voice, mixer


def test_switching_to_music_stops_receiver_deepgram_pending_work_and_retains_settings(tmp_path: Path) -> None:
    async def scenario() -> None:
        db, bot, conversation, actions, voice, mixer = mode_components(tmp_path)
        waiting = asyncio.Event()
        action = asyncio.create_task(waiting.wait())
        speech = asyncio.create_task(waiting.wait())
        actions.pending.add(action)
        conversation.delayed.add(speech)
        await asyncio.sleep(0)
        await bot.state.select_mode("music")
        await asyncio.gather(action, speech, return_exceptions=True)
        assert action.cancelled()
        assert speech.cancelled()
        assert bot.state.audio_mode == "music"
        assert bot.state.mixer is None
        mixer.cleanup.assert_called_once()
        voice.stop.assert_called()
        voice.stop_listening.assert_called()
        conversation.deepgram.close.assert_awaited_once()
        assert not conversation.session
        assert not conversation.allowed
        assert conversation.packets.empty()
        assert conversation.work.empty()
        assert conversation.enabled
        assert db.setting("conversation_enabled") is True
        assert db.setting(f"guild:{bot.settings.discord_guild_id}:audio_mode") == "music"
        assert db.rows("SELECT * FROM conversations") == []
        conversation.receive(("100", "Owner", None), b"pcm", time.time())
        assert conversation.packets.empty()
        voice.listen.reset_mock()
        await conversation.synchronize()
        voice.listen.assert_not_called()
        await bot.state.select_mode("soundboard")
        assert bot.state.mixer is not None
        assert conversation.enabled
        await bot.close()
        await conversation.close()
        await actions.close()
        db.close()

    asyncio.run(scenario())


def test_direct_soundboard_playback_is_rejected_in_music_mode(tmp_path: Path) -> None:
    async def scenario() -> None:
        db = Database(tmp_path / "sound.sqlite3")
        bot = Bot(Settings(_env_file=None, data_dir=tmp_path, discord_token=SecretStr("")), db, Events())
        bot.state.audio_mode = "music"
        with pytest.raises(VoiceError, match="Music mode"):
            bot.play(tmp_path / "never-opened.wav", {"id": "clip", "name": "Clip"})
        await bot.close()
        db.close()

    asyncio.run(scenario())


def test_music_mode_blocks_manual_play_and_stop_apis_without_touching_player(client: TestClient) -> None:
    voice = connected(client, "100")
    seed(client.app.state.db)
    client.app.state.bot.channels = lambda *_args: [{"id": "123"}]
    state = client.app.state.bot.state
    state.audio_mode = "music"
    mixer = Mock()
    state.mixer = mixer
    state.music.pause = AsyncMock()
    prefix = "/api/guilds/1352422295402057759"
    assert client.post(prefix + "/clips/sound/play").status_code == 409
    assert client.post(prefix + "/playbacks/stop").status_code == 409
    assert client.delete(prefix + "/playbacks/not-a-real-playback").status_code == 409
    mixer.stop.assert_not_called()
    state.music.pause.assert_not_awaited()
    voice.stop.assert_not_called()
    assert not client.app.state.db.one("SELECT id FROM audit WHERE action='sound.play'")


@pytest.mark.parametrize("action", ["play", "stop_all"])
def test_delayed_actions_cannot_run_after_mode_changes(tmp_path: Path, action: str) -> None:
    async def scenario() -> None:
        value = engine(tmp_path)
        saved = rule(value, action=action, clip_id="" if action == "stop_all" else "sound", delay=0.01)
        pending = asyncio.create_task(value.run(saved, event(value)))
        await asyncio.sleep(0)
        value.bot.state.audio_mode = "music"
        await pending
        value.bot.state.play.assert_not_called()
        value.bot.state.mixer.stop.assert_not_called()
        record = value.db.one("SELECT * FROM audit WHERE action='action_trigger.fire'")
        assert record["outcome"] == "rejected"
        await value.close()
        value.db.close()

    asyncio.run(scenario())


@pytest.mark.parametrize("action", ["play", "stop_all"])
def test_music_mode_rechecked_after_async_automatic_playback_preflight(tmp_path: Path, action: str) -> None:
    async def scenario() -> None:
        value = engine(tmp_path)
        saved = rule(value, action=action)

        async def prepare(_trigger: dict, _context: PlaybackContext) -> tuple:
            value.bot.state.audio_mode = "music"
            return {"id": "sound", "name": "Sound"}, None

        value.playback.prepare = prepare
        context = PlaybackContext({}, lambda: True, participant_id="100", channel_id=123, namespace="actions")
        await value.playback.execute(saved, context)
        value.bot.state.play.assert_not_called()
        value.bot.state.mixer.stop.assert_not_called()
        assert value.db.one("SELECT * FROM audit WHERE action='action_trigger.fire'")["outcome"] == "rejected"
        await value.close()
        value.db.close()

    asyncio.run(scenario())


def test_gateway_interruption_preserves_music_actual_voice_failure_pauses(tmp_path: Path) -> None:
    async def scenario() -> None:
        db = Database(tmp_path / "disconnect.sqlite3")
        bot = Bot(Settings(_env_file=None, data_dir=tmp_path, discord_token=SecretStr("")), db, Events())
        bot.state.music = SimpleNamespace(pause=AsyncMock(), update_volume=Mock())
        bot.state.receiver = SimpleNamespace(close_session=AsyncMock())
        bot.actions = SimpleNamespace(invalidate=Mock())
        bot.state.audio_mode = "music"
        await bot.client.on_disconnect()
        bot.state.music.pause.assert_not_awaited()
        await bot.voice_disconnected()
        bot.state.music.pause.assert_awaited_once()
        bot.state.receiver = None
        await bot.close()
        db.close()

    asyncio.run(scenario())


def test_mode_persists_across_process_initialization_without_joining(tmp_path: Path) -> None:
    async def scenario() -> None:
        db = Database(tmp_path / "restart.sqlite3")
        settings = Settings(_env_file=None, data_dir=tmp_path, discord_token=SecretStr(""))
        bot = Bot(settings, db, Events())
        await bot.state.select_mode("music")
        await bot.close()
        restored = Bot(settings, db, Events())
        assert restored.state.audio_mode == "music"
        assert restored.voice is None
        await restored.close()
        db.close()

    asyncio.run(scenario())


@pytest.mark.parametrize("deafened", [False, True])
def test_music_forces_deafen_and_restores_soundboard_preference_after_restart(
    tmp_path: Path, *, deafened: bool
) -> None:
    async def scenario() -> None:
        db, bot, conversation, actions, _voice, _ = mode_components(tmp_path)
        bot.state.deafened = deafened
        await bot.state.select_mode("music")
        assert bot.state.deafened is True
        guild = bot.client.get_guild(bot.settings.discord_guild_id)
        assert guild.change_voice_state.await_args.kwargs["self_deaf"] is True
        with pytest.raises(VoiceError, match="keeps the bot deafened"):
            await bot.state.flags(muted=False, deafened=False)
        restored = Bot(bot.settings, db, Events())
        assert restored.state.deafened is True
        assert restored.state.soundboard_deafened is deafened
        await restored.close()
        await bot.state.select_mode("soundboard")
        assert bot.state.deafened is deafened
        assert guild.change_voice_state.await_args.kwargs["self_deaf"] is deafened
        await bot.close()
        await conversation.close()
        await actions.close()
        db.close()

    asyncio.run(scenario())


def test_failed_discord_deafen_keeps_the_previous_mode(tmp_path: Path) -> None:
    async def scenario() -> None:
        db, bot, conversation, actions, voice, mixer = mode_components(tmp_path)
        bot.state.deafened = False
        bot.state.muted = True
        guild = bot.client.get_guild(bot.settings.discord_guild_id)
        guild.change_voice_state.side_effect = discord.DiscordException("Unavailable")
        with pytest.raises(VoiceError, match="deafen setting"):
            await bot.state.select_mode("music")
        assert bot.state.audio_mode == "soundboard"
        assert bot.state.deafened is False
        assert guild.change_voice_state.await_count == 1
        assert bot.state.mixer is not None
        assert bot.state.mixer is not mixer
        assert bot.state.mixer.muted is True
        assert bot.state.mixer.volume == bot.state.master_volume
        voice.is_paused.return_value = True
        bot.state.mixer.add = Mock(return_value="recovered")
        assert bot.state.play(tmp_path / "unused.wav", {"id": "sound", "name": "Sound"}) == "recovered"
        voice.resume.assert_called_once()
        await bot.state.select_mode("soundboard")
        assert bot.state.mixer is not None
        assert db.setting(f"guild:{bot.settings.discord_guild_id}:audio_mode", "soundboard") == "soundboard"
        await bot.close()
        await conversation.close()
        await actions.close()
        db.close()

    asyncio.run(scenario())


def test_music_reasserts_deafen_when_discord_reports_an_undeafened_bot(tmp_path: Path) -> None:
    async def scenario() -> None:
        db, bot, conversation, actions, voice, _ = mode_components(tmp_path)
        await bot.state.select_mode("music")
        guild = bot.client.get_guild(bot.settings.discord_guild_id)
        guild.change_voice_state.reset_mock()
        state = SimpleNamespace(channel=voice.channel, self_mute=True, self_deaf=False)
        await bot.state.enforce_music_deafen(state)
        guild.change_voice_state.assert_awaited_once_with(channel=voice.channel, self_mute=True, self_deaf=True)
        state.self_deaf = True
        await bot.state.enforce_music_deafen(state)
        assert guild.change_voice_state.await_count == 1
        state.self_deaf = False
        guild.change_voice_state.side_effect = discord.DiscordException("Unavailable")
        await bot.state.enforce_music_deafen(state)
        assert bot.state.deafened is True
        await bot.close()
        await conversation.close()
        await actions.close()
        db.close()

    asyncio.run(scenario())


@pytest.mark.parametrize("previous", ["soundboard", "music"])
def test_mode_persistence_failure_restores_discord_deafen_and_the_previous_mode(tmp_path: Path, previous: str) -> None:
    async def scenario() -> None:
        db, bot, conversation, actions, _voice, _mixer = mode_components(tmp_path)
        bot.state.deafened = False
        if previous == "music":
            await bot.state.select_mode(previous)
        guild = bot.client.get_guild(bot.settings.discord_guild_id)
        guild.change_voice_state.reset_mock()
        target = "music" if previous == "soundboard" else "soundboard"
        original = db.set_setting
        failure = RuntimeError("Simulated mode persistence failure")

        def save_setting(key: str, value: object) -> None:
            if key.endswith(":audio_mode") and value == target:
                raise failure
            original(key, value)

        db.set_setting = save_setting
        with pytest.raises(RuntimeError) as raised:
            await bot.state.select_mode(target)
        assert raised.value is failure
        assert bot.state.audio_mode == previous
        assert bot.state.deafened is (previous == "music")
        assert (bot.state.mixer is not None) is (previous == "soundboard")
        assert [call.kwargs["self_deaf"] for call in guild.change_voice_state.await_args_list] == [
            target == "music",
            previous == "music",
        ]
        assert db.setting(f"guild:{bot.settings.discord_guild_id}:audio_mode", previous) == previous
        await bot.close()
        await conversation.close()
        await actions.close()
        db.close()

    asyncio.run(scenario())


@pytest.mark.parametrize("previous", ["soundboard", "music"])
def test_mode_cancellation_after_committed_write_restores_persisted_and_discord_state(
    tmp_path: Path, previous: str
) -> None:
    async def scenario() -> None:
        db, bot, conversation, actions, _voice, _mixer = mode_components(tmp_path)
        bot.state.deafened = False
        if previous == "music":
            await bot.state.select_mode(previous)
        guild = bot.client.get_guild(bot.settings.discord_guild_id)
        guild.change_voice_state.reset_mock()
        target = "music" if previous == "soundboard" else "soundboard"
        original = db.set_setting
        committed = asyncio.Event()
        release = threading.Event()
        loop = asyncio.get_running_loop()

        def save_setting(key: str, value: object) -> None:
            original(key, value)
            if key.endswith(":audio_mode") and value == target:
                loop.call_soon_threadsafe(committed.set)
                release.wait(timeout=5)

        db.set_setting = save_setting
        change = asyncio.create_task(bot.state.select_mode(target))
        try:
            await asyncio.wait_for(committed.wait(), timeout=2)
            assert db.setting(f"guild:{bot.settings.discord_guild_id}:audio_mode") == target
            change.cancel()
            await asyncio.sleep(0)
        finally:
            release.set()
        with pytest.raises(asyncio.CancelledError):
            await change
        assert bot.state.audio_mode == previous
        assert bot.state.deafened is (previous == "music")
        assert (bot.state.mixer is not None) is (previous == "soundboard")
        assert db.setting(f"guild:{bot.settings.discord_guild_id}:audio_mode") == previous
        assert [call.kwargs["self_deaf"] for call in guild.change_voice_state.await_args_list] == [
            target == "music",
            previous == "music",
        ]
        await bot.close()
        await conversation.close()
        await actions.close()
        db.close()

    asyncio.run(scenario())


def test_failed_mode_compensation_preserves_the_original_error(tmp_path: Path) -> None:
    async def scenario() -> None:
        db, bot, conversation, actions, _voice, _mixer = mode_components(tmp_path)
        guild = bot.client.get_guild(bot.settings.discord_guild_id)
        guild.change_voice_state.side_effect = [None, discord.DiscordException("Compensation unavailable")]
        original = db.set_setting
        failure = RuntimeError("Original persistence failure")

        def save_setting(key: str, value: object) -> None:
            if key.endswith(":audio_mode"):
                if value == "music":
                    raise failure
                message = "Compensation persistence failure"
                raise OSError(message)
            original(key, value)

        db.set_setting = save_setting
        with pytest.raises(RuntimeError) as raised:
            await bot.state.select_mode("music")
        assert raised.value is failure
        assert bot.state.audio_mode == "soundboard"
        assert bot.state.mixer is not None
        assert guild.change_voice_state.await_count == 2
        await bot.close()
        await conversation.close()
        await actions.close()
        db.close()

    asyncio.run(scenario())
