from __future__ import annotations

import array
import asyncio
import copy
import shutil
from itertools import pairwise
from types import SimpleNamespace
from typing import TYPE_CHECKING
from unittest.mock import AsyncMock, Mock

import discord
import pytest

from app.config import Settings
from app.music_player import MusicPlayer
from app.music_sources import MusicSources

if TYPE_CHECKING:
    from pathlib import Path


class MemoryStore:
    def __init__(self, payload: dict | None = None) -> None:
        self.payload = payload or {}
        self.writes: list[dict] = []

    def load_player(self) -> dict:
        return copy.deepcopy(self.payload)

    def save_player(self, payload: dict) -> None:
        self.payload = copy.deepcopy(payload)
        self.writes.append(copy.deepcopy(payload))


class InlineDatabase:
    async def run(self, function: object, *args: object) -> object:
        return function(*args)


class Audio(discord.AudioSource):
    def __init__(self, track: dict, volume: float) -> None:
        self.music_track = copy.deepcopy(track)
        self.volume = volume
        self.cleanups = 0

    def read(self) -> bytes:
        return b""

    def cleanup(self) -> None:
        self.cleanups += 1


def track(title: str) -> dict:
    return {
        "provider": "youtube",
        "source_id": title,
        "youtube_id": title,
        "title": title,
        "artist": "Artist",
        "duration": 120,
        "thumbnail": None,
        "url": f"https://www.youtube.com/watch?v={title}",
    }


def player_parts(payload: dict | None = None) -> tuple:
    store = MemoryStore(payload)
    voice = Mock(spec=discord.VoiceClient)
    voice.source = None
    voice.is_connected.return_value = True
    voice_state = SimpleNamespace(
        voice=voice,
        master_volume=0.8,
        muted=False,
        audio_mode="music",
        loop=asyncio.get_running_loop(),
    )

    def play(source: Audio, *, after: object, bitrate: int) -> None:
        assert bitrate == 384
        voice.source = source
        voice.callback = after

    def stop() -> None:
        if voice.source:
            voice.source.cleanup()
            voice.source = None
            voice.callback(None)

    async def source(item: dict, _position: float, volume: float) -> Audio:
        return Audio(item, volume)

    voice.play.side_effect = play
    voice.stop.side_effect = stop
    sources = SimpleNamespace(source=AsyncMock(side_effect=source))
    player = MusicPlayer(Mock(), InlineDatabase(), Mock(), voice_state, sources=sources, store=store)
    return player, store, sources, voice_state


async def settled(player: MusicPlayer, expected: str = "playing") -> None:
    for _ in range(100):
        if player.state == expected:
            return
        await asyncio.sleep(0)
    assert player.state == expected


def test_queue_restores_paused_and_snapshots_are_isolated() -> None:
    async def scenario() -> None:
        player, store, _, _ = player_parts()
        await player.start()
        assert player.snapshot()["state"] == "idle"
        await player.enqueue([track("one"), track("two")], {"id": "1", "name": "Listener"})
        assert player.snapshot()["current"]["requester_name"] == "Listener"
        await player.command("seek", 25)
        snapshot = player.snapshot()
        snapshot["queue"][0]["track"]["title"] = "Changed"
        assert player.current["track"]["title"] == "one"
        await player.close()
        restored, _, sources, _ = player_parts(store.payload)
        await restored.start()
        assert restored.state == "paused"
        assert restored.position == 25
        assert len(restored.queue) == 2
        sources.source.assert_not_awaited()
        await restored.close()

    asyncio.run(scenario())


def test_play_pause_seek_resume_creates_fresh_source_and_respects_volume() -> None:
    async def scenario() -> None:
        player, store, sources, state = player_parts()
        await player.start()
        await player.enqueue([track("one")], {"id": "1"})
        await player.command("play")
        await settled(player)
        first = state.voice.source
        player.started_at -= 12
        await player.pause()
        assert 12 <= player.position < 13
        assert first.cleanups == 1
        assert 12 <= store.payload["position"] < 13
        state.muted = True
        await player.command("seek", 40)
        await player.command("play")
        await settled(player)
        assert sources.source.await_count == 2
        assert sources.source.await_args.args[1:] == (40, 0)
        state.muted = False
        state.master_volume = 0.4
        player.update_volume()
        assert player.source.volume == 0.4
        await player.close()

    asyncio.run(scenario())


def test_music_uses_the_dedicated_sender_without_changing_soundboard_playback() -> None:
    async def scenario() -> None:
        player, _, sources, state = player_parts()
        audio = Audio(track("one"), 0.8)
        sources.source.side_effect = None
        sources.source.return_value = audio
        state.voice.play_music = Mock(side_effect=state.voice.play.side_effect)
        await player.start()
        await player.enqueue([track("one")], {"id": "1"})
        await player.command("play")
        await settled(player)
        assert state.voice.source is audio
        state.voice.play_music.assert_called_once()
        state.voice.play.assert_not_called()
        await player.close()

    asyncio.run(scenario())


def test_pause_during_resolution_and_late_callback_do_not_restart_audio() -> None:
    async def scenario() -> None:
        player, _, sources, state = player_parts()
        await player.start()
        await player.enqueue([track("one"), track("two")], {"id": "1"})
        entered, release = asyncio.Event(), asyncio.Event()
        late = Audio(track("one"), 0.8)

        async def delayed(_track: dict, _position: float, _volume: float) -> Audio:
            entered.set()
            try:
                await release.wait()
            except asyncio.CancelledError:
                await release.wait()
            return late

        sources.source.side_effect = delayed
        await player.command("play")
        await entered.wait()
        await asyncio.wait_for(player.pause(), 0.2)
        release.set()
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        assert late.cleanups == 1
        state.voice.play.assert_not_called()
        assert player.state == "paused"
        await player.close()

    asyncio.run(scenario())


def test_skip_ignores_stale_resolution_and_completion() -> None:
    async def scenario() -> None:
        player, _, _, state = player_parts()
        await player.start()
        await player.enqueue([track("one"), track("two")], {"id": "1"})
        await player.command("play")
        await settled(player)
        stale = state.voice.callback
        await player.command("next")
        await settled(player)
        stale(None)
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        assert player.current["track"]["title"] == "two"
        assert player.state == "playing"
        assert state.voice.play.call_count == 2
        await player.close()

    asyncio.run(scenario())


def test_natural_completion_advances_then_leaves_mode_idle() -> None:
    async def scenario() -> None:
        player, _, _, state = player_parts()
        await player.start()
        await player.enqueue([track("one"), track("two")], {"id": "1"})
        await player.command("play")
        await settled(player)
        await player.finished(player.generation, None)
        await settled(player)
        assert player.current["track"]["title"] == "two"
        await player.finished(player.generation, None)
        assert player.state == "idle"
        assert player.current is None
        assert len(player.queue) == 2
        assert state.audio_mode == "music"
        await player.close()

    asyncio.run(scenario())


def test_disconnected_sender_completion_keeps_the_current_song_paused() -> None:
    async def scenario() -> None:
        player, store, _, state = player_parts()
        await player.start()
        await player.enqueue([track("one"), track("two")], {"id": "1"})
        await player.command("play")
        await settled(player)
        state.voice.is_connected.return_value = False
        await player.finished(player.generation, None)
        assert player.state == "paused"
        assert player.current["track"]["title"] == "one"
        assert store.payload["queue"][store.payload["index"]]["track"]["title"] == "one"
        await player.close()

    asyncio.run(scenario())


def test_repeat_one_and_all_and_previous() -> None:
    async def scenario() -> None:
        player, _, _, _ = player_parts()
        await player.start()
        await player.enqueue([track("one"), track("two")], {"id": "1"})
        await player.command("repeat", 1)
        await player.command("play")
        await settled(player)
        await player.finished(player.generation, None)
        await settled(player)
        assert player.index == 0
        await player.command("next")
        await settled(player)
        assert player.index == 1
        player.started_at -= 10
        await player.command("previous")
        await settled(player)
        assert player.index == 1
        await player.command("previous")
        await settled(player)
        assert player.index == 0
        await player.command("repeat", 2)
        await player.command("next")
        await settled(player)
        await player.finished(player.generation, None)
        await settled(player)
        assert player.index == 0
        await player.close()

    asyncio.run(scenario())


def test_reorder_and_remove_keep_active_identity() -> None:
    async def scenario() -> None:
        player, _, _, state = player_parts()
        await player.start()
        await player.enqueue([track("one"), track("two"), track("three")], {"id": "1"})
        await player.command("play")
        await settled(player)
        current = player.current["id"]
        ids = [entry["id"] for entry in player.queue]
        await player.reorder(ids[::-1])
        assert player.current["id"] == current
        assert player.index == 2
        assert state.voice.play.call_count == 1
        await player.remove(ids[2])
        assert player.index == 1
        await player.remove(current)
        assert player.state == "idle"
        assert player.current is None
        await player.close()

    asyncio.run(scenario())


def test_failed_resolution_retries_once_before_advancing() -> None:
    async def scenario() -> None:
        player, _, sources, _ = player_parts()
        await player.start()
        await player.enqueue([track("one"), track("two")], {"id": "1"})
        sources.source.side_effect = [
            ValueError("private upstream message"),
            ValueError("secret"),
            Audio(track("two"), 0.8),
        ]
        await player.command("play")
        await settled(player)
        assert sources.source.await_count == 3
        assert "unavailable" in player.queue[0]["error"]
        assert player.current["track"]["title"] == "two"
        assert "secret" not in str(player.snapshot())
        await player.close()

    asyncio.run(scenario())


def test_decoder_error_retries_at_saved_position_then_advances() -> None:
    async def scenario() -> None:
        player, _, sources, _ = player_parts()
        await player.start()
        await player.enqueue([track("one"), track("two")], {"id": "1"})
        await player.command("play")
        await settled(player)
        player.started_at -= 20
        await player.finished(player.generation, RuntimeError("expired"))
        await settled(player)
        assert 20 <= sources.source.await_args.args[1] < 21
        await player.finished(player.generation, RuntimeError("failed again"))
        await settled(player)
        assert player.current["track"]["title"] == "two"
        await player.close()

    asyncio.run(scenario())


def test_many_unavailable_recordings_stop_after_bounded_retries() -> None:
    async def scenario() -> None:
        player, _, sources, _ = player_parts()
        await player.start()
        await player.enqueue([track(str(index)) for index in range(20)], {"id": "1"})
        sources.source.side_effect = ValueError("unavailable")
        await player.command("play")
        await settled(player, "paused")
        assert sources.source.await_count == 10
        assert player.index == 5
        assert "five unavailable" in player.error
        await player.close()

    asyncio.run(scenario())


def test_queue_limits_invalid_order_and_seek_are_atomic() -> None:
    async def scenario() -> None:
        player, store, _, _ = player_parts()
        await player.start()
        await player.enqueue([track("one")], {"id": "1"})
        original = copy.deepcopy(store.payload)
        with pytest.raises(ValueError, match="500"):
            await player.enqueue([track("extra")] * 500, {"id": "1"})
        with pytest.raises(ValueError, match="exactly once"):
            await player.reorder([])
        with pytest.raises(ValueError, match="valid playback position"):
            await player.command("seek", float("nan"))
        with pytest.raises(ValueError, match="no longer"):
            await player.remove("missing")
        assert store.payload == original
        await player.close()

    asyncio.run(scenario())


def test_disconnect_while_buffering_never_starts_after_voice_returns() -> None:
    async def scenario() -> None:
        player, _, sources, state = player_parts()
        await player.start()
        await player.enqueue([track("one")], {"id": "1"})
        release = asyncio.Event()
        source = Audio(track("one"), 0.8)

        async def delayed(_track: dict, _position: float, _volume: float) -> Audio:
            await release.wait()
            return source

        sources.source.side_effect = delayed
        await player.command("play")
        await asyncio.sleep(0)
        state.voice.is_connected.return_value = False
        release.set()
        await settled(player, "paused")
        assert source.cleanups == 1
        state.voice.play.assert_not_called()
        state.voice.is_connected.return_value = True
        await asyncio.sleep(0)
        assert player.state == "paused"
        await player.close()

    asyncio.run(scenario())


def test_music_mode_and_voice_required_for_play() -> None:
    async def scenario() -> None:
        player, _, sources, state = player_parts()
        await player.start()
        await player.enqueue([track("one")], {"id": "1"})
        state.audio_mode = "soundboard"
        with pytest.raises(ValueError, match="Music mode"):
            await player.command("play")
        state.audio_mode = "music"
        state.voice.is_connected.return_value = False
        with pytest.raises(ValueError, match="Connect"):
            await player.command("play")
        sources.source.assert_not_awaited()
        await player.close()

    asyncio.run(scenario())


def test_checkpoint_persists_progress_and_close_cancels_background(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("app.music_player.CHECKPOINT_SECONDS", 0.001)

    async def scenario() -> None:
        player, store, _, _ = player_parts()
        await player.start()
        await player.enqueue([track("one")], {"id": "1"})
        await player.command("play")
        await settled(player)
        player.started_at -= 8
        await asyncio.sleep(0.01)
        assert store.payload["position"] >= 8
        await player.close()
        assert player.state == "paused"
        assert player.checkpoint.done()
        assert not player.background

    asyncio.run(scenario())


def test_pause_cleans_source_after_voice_client_is_removed() -> None:
    async def scenario() -> None:
        player, _, _, state = player_parts()
        await player.start()
        await player.enqueue([track("one")], {"id": "1"})
        await player.command("play")
        await settled(player)
        source = player.source
        state.voice = None
        await player.pause()
        assert source.cleanups == 1
        assert player.source is None
        assert player.state == "paused"
        await player.close()

    asyncio.run(scenario())


@pytest.mark.parametrize("change", ["mode", "member"])
@pytest.mark.parametrize(
    "operation",
    [
        "enqueue",
        "play_now",
        "play_playlist",
        "clear",
        "remove",
        "reorder",
        "play",
        "pause",
        "next",
        "previous",
        "seek",
        "stop",
        "shuffle",
        "repeat",
    ],
)
def test_mutation_rechecks_access_after_waiting_for_player_lock(operation: str, change: str) -> None:
    async def scenario() -> None:
        player, store, sources, state = player_parts()
        await player.start()
        await player.enqueue([track("one"), track("two")], {"id": "1"})
        state.present = True
        before = player.snapshot()
        persisted = copy.deepcopy(store.payload)

        def authorize() -> None:
            if state.audio_mode != "music" or not state.present:
                message = "Music access changed."
                raise ValueError(message)

        guard = Mock(side_effect=authorize)
        entries = [entry["id"] for entry in player.queue]
        options = {
            "enqueue": lambda: player.enqueue([track("three")], {"id": "1"}, guard=guard),
            "play_now": lambda: player.play_now(track("three"), {"id": "1"}, guard=guard),
            "play_playlist": lambda: player.play_playlist(
                [track("three")], {"id": "1"}, {"id": "playlist", "name": "Playlist"}, guard=guard
            ),
            "clear": lambda: player.clear(guard=guard),
            "remove": lambda: player.remove(entries[0], guard=guard),
            "reorder": lambda: player.reorder(entries[::-1], guard=guard),
        }
        await player.lock.acquire()
        mutation = asyncio.create_task(
            options[operation]()
            if operation in options
            else player.command(operation, 15 if operation == "seek" else None, guard=guard)
        )
        await asyncio.sleep(0)
        guard.assert_not_called()
        if change == "mode":
            state.audio_mode = "soundboard"
        else:
            state.present = False
        player.lock.release()
        with pytest.raises(ValueError, match="access changed"):
            await mutation
        assert player.snapshot() == before
        assert store.payload == persisted
        sources.source.assert_not_awaited()
        await player.close()

    asyncio.run(scenario())


def test_clear_playing_queue_preserves_settings_and_invalidates_old_audio_callbacks() -> None:
    async def scenario() -> None:
        player, store, sources, state = player_parts()
        await player.start()
        await player.enqueue([track("one"), track("two")], {"id": "1"})
        await player.command("shuffle", 1)
        await player.command("repeat", 2)
        await player.command("play")
        await settled(player)
        old_source = player.source
        callback = state.voice.callback
        cleared = await player.clear()
        assert cleared["state"] == "idle"
        assert cleared["current"] is None
        assert cleared["queue"] == []
        assert cleared["position"] == 0
        assert cleared["shuffle"] is True
        assert cleared["repeat"] == "all"
        assert store.payload["queue"] == []
        assert store.payload["index"] is None
        assert old_source.cleanups == 1
        await player.enqueue([track("new")], {"id": "1"})
        callback(None)
        callback(RuntimeError("old decoder ended"))
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        assert player.state == "paused"
        assert player.current["track"]["title"] == "new"
        assert sources.source.await_count == 1
        await player.close()

    asyncio.run(scenario())


def test_play_now_interrupts_current_track_preserves_upcoming_and_ignores_old_callback() -> None:
    async def scenario() -> None:
        player, store, _, state = player_parts()
        await player.start()
        await player.enqueue([track("one"), track("two"), track("three")], {"id": "1"})
        await player.command("play")
        await settled(player)
        old_source, old_callback = player.source, state.voice.callback
        await player.play_now(track("instant"), {"id": "2", "display_name": "Other user"})
        await settled(player)
        assert old_source.cleanups == 1
        assert [entry["track"]["title"] for entry in player.queue] == ["one", "instant", "two", "three"]
        assert player.current["track"]["title"] == "instant"
        assert player.current["requester_id"] == "2"
        assert store.payload["index"] == 1
        old_callback(None)
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        assert player.current["track"]["title"] == "instant"
        state.voice.callback(None)
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        await settled(player)
        assert player.current["track"]["title"] == "two"
        await player.close()

    asyncio.run(scenario())


def test_simultaneous_play_now_commands_are_serialized_and_leave_only_latest_audio() -> None:
    async def scenario() -> None:
        player, _, _, state = player_parts()
        await player.start()
        await asyncio.gather(player.play_now(track("first"), {"id": "1"}), player.play_now(track("last"), {"id": "2"}))
        await settled(player)
        assert len(player.queue) == 2
        assert player.current["track"]["title"] == "last"
        assert state.voice.source.music_track["title"] == "last"
        await player.close()

    asyncio.run(scenario())


def test_playlist_context_plays_immediately_then_manual_queue_has_priority() -> None:
    async def scenario() -> None:
        player, _, _, _ = player_parts()
        await player.start()
        await player.enqueue([track("current"), track("manual-one")], {"id": "1"})
        await player.command("play")
        await settled(player)
        playlist = {"id": "playlist", "name": "Saved playlist"}
        tracks = [track("playlist-one"), track("playlist-two"), track("playlist-three")]
        await player.play_playlist(tracks, {"id": "2"}, playlist)
        await settled(player)
        await player.enqueue([track("manual-two")], {"id": "1"})
        tracks[1]["title"] = "Edited playlist"
        snapshot = player.snapshot()
        assert snapshot["current"]["track"]["title"] == "playlist-one"
        assert snapshot["playlist"] == playlist
        assert [entry["track"]["title"] for entry in snapshot["manual_queue"]] == ["manual-one", "manual-two"]
        assert [entry["track"]["title"] for entry in snapshot["playlist_queue"]] == ["playlist-two", "playlist-three"]
        assert all(entry["origin"] == "playlist" for entry in snapshot["playlist_queue"])
        for expected in ("manual-one", "manual-two", "playlist-two", "playlist-three"):
            await player.finished(player.generation, None)
            await settled(player)
            assert player.current["track"]["title"] == expected
        await player.close()

    asyncio.run(scenario())


def test_replacing_playlist_preserves_manual_upcoming_and_invalidates_old_callback() -> None:
    async def scenario() -> None:
        player, _, _, state = player_parts()
        await player.start()
        await player.play_playlist([track("old-one"), track("old-two")], {"id": "1"}, {"id": "old", "name": "Old"})
        await settled(player)
        old_callback = state.voice.callback
        await player.enqueue([track("manual")], {"id": "2"})
        await player.play_playlist([track("new-one"), track("new-two")], {"id": "1"}, {"id": "new", "name": "New"})
        await settled(player)
        old_callback(None)
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        snapshot = player.snapshot()
        assert snapshot["current"]["track"]["title"] == "new-one"
        assert [entry["track"]["title"] for entry in snapshot["manual_queue"]] == ["manual"]
        assert [entry["track"]["title"] for entry in snapshot["playlist_queue"]] == ["new-two"]
        assert all(entry["track"]["title"] != "old-two" for entry in snapshot["queue"])
        assert snapshot["playlist"] == {"id": "new", "name": "New"}
        await player.close()

    asyncio.run(scenario())


def test_recent_tracks_are_persisted_bounded_and_not_duplicated_by_seek_resume_or_retry() -> None:
    async def scenario() -> None:
        player, store, _, _ = player_parts()
        await player.start()
        await player.enqueue([track(str(index)) for index in range(55)], {"id": "1"})
        await player.command("play")
        await settled(player)
        await player.command("seek", 12)
        await settled(player)
        await player.pause()
        await player.command("play")
        await settled(player)
        await player.finished(player.generation, RuntimeError("decoder interrupted"))
        await settled(player)
        assert len(player.snapshot()["recent"]) == 1
        for _ in range(54):
            await player.finished(player.generation, None)
            await settled(player)
        snapshot = player.snapshot()
        assert len(snapshot["recent"]) == 50
        assert len({entry["play_id"] for entry in snapshot["recent"]}) == 50
        assert [entry["track"]["title"] for entry in snapshot["recent"]] == [str(index) for index in range(54, 4, -1)]
        snapshot["recent"][0]["track"]["title"] = "Modified"
        assert player.recent[0]["track"]["title"] == "54"
        assert player.index == 50
        await player.close()
        restored, _, sources, _ = player_parts(store.payload)
        await restored.start()
        assert restored.state == "paused"
        assert len(restored.recent) == 50
        sources.source.assert_not_awaited()
        await restored.command("play")
        await settled(restored)
        assert len(restored.recent) == 50
        assert restored.recent[0]["track"]["title"] == "54"
        await restored.close()

    asyncio.run(scenario())


def test_playlist_context_and_recent_restore_paused_and_clear_preserves_recent() -> None:
    async def scenario() -> None:
        player, store, _, _ = player_parts()
        await player.start()
        await player.play_playlist([track("one"), track("two")], {"id": "1"}, {"id": "saved", "name": "Saved"})
        await settled(player)
        await player.enqueue([track("manual")], {"id": "2"})
        await player.command("seek", 20)
        await settled(player)
        await player.close()
        restored, _, sources, _ = player_parts(store.payload)
        await restored.start()
        snapshot = restored.snapshot()
        assert snapshot["state"] == "paused"
        assert snapshot["position"] >= 20
        assert snapshot["playlist"] == {"id": "saved", "name": "Saved"}
        assert [entry["track"]["title"] for entry in snapshot["manual_queue"]] == ["manual"]
        assert [entry["track"]["title"] for entry in snapshot["playlist_queue"]] == ["two"]
        sources.source.assert_not_awaited()
        await restored.clear()
        assert restored.snapshot()["playlist"] is None
        assert restored.snapshot()["recent"] == snapshot["recent"]
        await restored.close()

    asyncio.run(scenario())


def test_legacy_queue_restores_as_manual_without_inventing_recent_plays() -> None:
    async def scenario() -> None:
        payload = {
            "queue": [
                {"id": str(index), "track": track(str(index)), "requester_id": "1", "requester_name": "User"}
                for index in range(3)
            ],
            "index": 1,
            "position": 10,
        }
        player, _, _, _ = player_parts(payload)
        await player.start()
        snapshot = player.snapshot()
        assert snapshot["current"]["id"] == "1"
        assert snapshot["position"] == 10
        assert snapshot["manual_queue"][0]["id"] == "2"
        assert snapshot["playlist_queue"] == []
        assert snapshot["playlist"] is None
        assert snapshot["recent"] == []
        assert all(entry["origin"] == "manual" for entry in snapshot["queue"])
        await player.close()

    asyncio.run(scenario())


def test_manual_and_playlist_capacity_are_independent_and_failures_are_atomic() -> None:
    async def scenario() -> None:
        player, store, _, _ = player_parts()
        await player.start()
        await player.play_playlist([track(str(index)) for index in range(1_000)], {"id": "1"}, {"id": "p", "name": "P"})
        await settled(player)
        await player.enqueue([track("manual")] * 500, {"id": "2"})
        assert len(player.snapshot()["manual_queue"]) == 500
        assert len(player.snapshot()["playlist_queue"]) == 999
        original = copy.deepcopy(store.payload)
        with pytest.raises(ValueError, match="500"):
            await player.enqueue([track("extra")], {"id": "2"})
        with pytest.raises(ValueError, match="1,000"):
            await player.play_playlist([track("extra")] * 1_001, {"id": "2"}, {"id": "other", "name": "Other"})
        assert store.payload == original
        assert player.playlist["id"] == "p"
        await player.close()

    asyncio.run(scenario())


def test_concurrent_playlist_commands_leave_latest_context_and_single_current_source() -> None:
    async def scenario() -> None:
        player, _, _, state = player_parts()
        await player.start()
        await asyncio.gather(
            player.play_playlist([track("first")], {"id": "1"}, {"id": "first", "name": "First"}),
            player.play_playlist([track("last"), track("next")], {"id": "2"}, {"id": "last", "name": "Last"}),
        )
        await settled(player)
        assert player.playlist["id"] == "last"
        assert player.current["track"]["title"] == "last"
        assert state.voice.source.music_track["title"] == "last"
        assert [entry["track"]["title"] for entry in player.snapshot()["playlist_queue"]] == ["next"]
        await player.close()

    asyncio.run(scenario())


def test_elapsed_tracks_consumed_pcm_instead_of_network_stall_time() -> None:
    async def scenario() -> None:
        player, _, _, _ = player_parts()
        await player.start()
        await player.enqueue([track("one")], {"id": "1"})
        await player.command("play")
        await settled(player)
        player.source.played_seconds = 4.0
        player.started_at -= 30
        assert player.elapsed() == 4.0
        await player.pause()
        assert player.position == 4.0
        await player.close()

    asyncio.run(scenario())


def test_source_priority_uses_current_and_next_five_without_repeating_unchanged_list() -> None:
    async def scenario() -> None:
        player, _, sources, _ = player_parts()
        sources.prioritize = Mock()
        await player.start()
        await player.enqueue([track(str(index)) for index in range(8)], {"id": "1"})
        assert [item["title"] for item in sources.prioritize.call_args.args[0]] == [str(index) for index in range(6)]
        player.notify()
        assert sources.prioritize.call_count == 1
        await player.command("next")
        assert [item["title"] for item in sources.prioritize.call_args.args[0]] == [str(index) for index in range(1, 7)]
        await player.clear()
        assert sources.prioritize.call_args.args[0] == []
        await player.close()

    asyncio.run(scenario())


def test_repeat_all_replays_full_playlist_after_navigation_history_is_bounded() -> None:
    async def scenario() -> None:
        player, _, _, _ = player_parts()
        await player.start()
        await player.play_playlist([track(str(index)) for index in range(55)], {"id": "1"}, {"id": "p", "name": "P"})
        await settled(player)
        await player.command("repeat", 2)
        for _ in range(55):
            await player.finished(player.generation, None)
            await settled(player)
        assert player.current["track"]["title"] == "0"
        assert len(player.snapshot()["playlist_queue"]) == 54
        assert player.index == 50
        assert len(player.snapshot()["recent"]) == 50
        await player.close()

    asyncio.run(scenario())


def test_starting_playlist_preserves_manual_song_selected_but_never_started() -> None:
    async def scenario() -> None:
        player, _, _, _ = player_parts()
        await player.start()
        await player.enqueue([track("selected"), track("other")], {"id": "1"})
        await player.play_playlist([track("playlist")], {"id": "1"}, {"id": "p", "name": "P"})
        await settled(player)
        assert [entry["track"]["title"] for entry in player.snapshot()["manual_queue"]] == ["selected", "other"]
        assert player.current["track"]["title"] == "playlist"
        await player.close()

    asyncio.run(scenario())


def test_play_now_preserves_manual_song_selected_but_never_started() -> None:
    async def scenario() -> None:
        player, _, _, _ = player_parts()
        await player.start()
        await player.enqueue([track("selected")], {"id": "1"})
        await player.play_now(track("instant"), {"id": "2"})
        await settled(player)
        assert player.current["track"]["title"] == "instant"
        assert [entry["track"]["title"] for entry in player.snapshot()["manual_queue"]] == ["selected"]
        assert len(player.recent) == 1
        await player.close()

    asyncio.run(scenario())


def test_valid_generation_logs_failure_details_but_stale_failure_is_ignored(monkeypatch: pytest.MonkeyPatch) -> None:
    diagnostic = Mock()
    monkeypatch.setattr("app.music_player.log_music_failure", diagnostic)

    async def scenario() -> None:
        player, _, _, _ = player_parts()
        await player.start()
        await player.enqueue([track("one")], {"id": "1"})
        await player.command("play")
        await settled(player)
        error = RuntimeError("upstream private message")
        stale = player.generation
        await player.finished(stale, error)
        await settled(player)
        assert diagnostic.call_count == 1
        assert diagnostic.call_args.args == (track("one"), error, "playback")
        await player.failed(stale, error)
        assert diagnostic.call_count == 1
        await player.close()

    asyncio.run(scenario())


def test_skip_at_end_with_repeat_all_restarts_full_playlist_context() -> None:
    async def scenario() -> None:
        player, _, _, _ = player_parts()
        await player.start()
        await player.play_playlist([track(str(index)) for index in range(55)], {"id": "1"}, {"id": "p", "name": "P"})
        await settled(player)
        await player.command("repeat", 2)
        for _ in range(55):
            await player.command("next")
            await settled(player)
        assert player.current["track"]["title"] == "0"
        assert len(player.snapshot()["playlist_queue"]) == 54
        await player.close()

    asyncio.run(scenario())


def test_manual_repeat_all_preserves_earlier_songs_after_navigation_history_limit() -> None:
    async def scenario() -> None:
        player, _, _, _ = player_parts()
        await player.start()
        await player.enqueue([track(str(index)) for index in range(55)], {"id": "1"})
        await player.command("play")
        await settled(player)
        await player.command("repeat", 2)
        for _ in range(55):
            await player.finished(player.generation, None)
            await settled(player)
        assert player.current["track"]["title"] == "0"
        assert len(player.snapshot()["manual_queue"]) == 54
        await player.close()

    asyncio.run(scenario())


@pytest.mark.parametrize("container", ["webm", "m4a"])
@pytest.mark.skipif(not shutil.which("ffmpeg"), reason="FFmpeg is not installed")
def test_restart_resumes_cached_audio_beyond_the_previously_decoded_part(tmp_path: Path, container: str) -> None:
    path = tmp_path / ("restart." + container)

    async def scenario() -> None:
        process = await asyncio.create_subprocess_exec(
            *[
                "ffmpeg",
                "-hide_banner",
                "-loglevel",
                "error",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=440:duration=90",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=880:duration=15",
                "-filter_complex",
                "[0:a][1:a]concat=n=2:v=0:a=1",
                "-c:a",
                "libopus" if container == "webm" else "aac",
                "-b:a",
                "128k",
                str(path),
            ],
        )
        assert await process.wait() == 0
        player, store, _, state = player_parts()
        item = {**track("aaaaaaaaaaa"), "duration": 105}
        await player.start()
        await player.enqueue([item], {"id": "1"})
        await player.command("play")
        await settled(player)
        state.voice.source.played_seconds = 89.0
        await player.close()
        assert store.payload["position"] == 89
        restored, _, _, resumed_state = player_parts(store.payload)
        sources = MusicSources(Settings(_env_file=None, data_dir=tmp_path))
        sources.cache = SimpleNamespace(
            ensure=AsyncMock(return_value={"stream": str(path), "container": container, "track": item}),
            prioritize=Mock(),
        )
        restored.sources = sources
        try:
            await restored.start()
            assert restored.state == "paused"
            assert restored.snapshot()["position"] == 89
            assert resumed_state.voice.source is None
            await restored.command("play")
            await asyncio.wait_for(restored.resolving, timeout=5)
            assert restored.state == "playing"
            audio = resumed_state.voice.source
            resumed = array.array("h", b"".join(audio.read() for _ in range(100)))[::2]
            for samples, frequency in [(resumed[:48000], 440), (resumed[48000:], 880)]:
                crossings = sum(a <= 0 < b for a, b in pairwise(samples))
                assert frequency - 20 <= crossings <= frequency + 20
                assert max(abs(value) for value in samples) > 1000
            assert restored.snapshot()["position"] == pytest.approx(91)
            await restored.command("seek", 94)
            await asyncio.wait_for(restored.resolving, timeout=5)
            audio = resumed_state.voice.source
            samples = array.array("h", b"".join(audio.read() for _ in range(50)))[::2]
            crossings = sum(a <= 0 < b for a, b in pairwise(samples))
            assert 860 <= crossings <= 900
            assert max(abs(value) for value in samples) > 1000
            assert restored.snapshot()["position"] == pytest.approx(95)
        finally:
            await restored.close()
            await sources.close()

    asyncio.run(scenario())
