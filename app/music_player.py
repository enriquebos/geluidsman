from __future__ import annotations

import asyncio
import contextlib
import copy
import math
import random
import time
import uuid
from typing import TYPE_CHECKING, Protocol

import discord

from app.music_cache import QUEUE_PREFETCH
from app.music_diagnostics import log_music_failure

if TYPE_CHECKING:
    from collections.abc import Callable

    from app.bot import GuildVoice
    from app.config import Settings
    from app.db import Database
    from app.events import Events


QUEUE_LIMIT = 500
RECENT_LIMIT = 50
PLAYLIST_LIMIT = 1_000
QUEUE_STORAGE_LIMIT = QUEUE_LIMIT + PLAYLIST_LIMIT + RECENT_LIMIT + 1
CHECKPOINT_SECONDS = 15
MAX_FAILURES = 5
PREVIOUS_RESTART_SECONDS = 3
REPEAT_MODES = ("off", "one", "all")


class PlayerSources(Protocol):
    async def source(self, track: dict, position: float, volume: float) -> discord.AudioSource: ...


class PlayerStore(Protocol):
    def load_player(self) -> dict: ...

    def save_player(self, payload: dict) -> None: ...


class MusicPlayer:
    def __init__(
        self,
        settings: Settings,
        db: Database,
        events: Events,
        voice_state: GuildVoice,
        *,
        sources: PlayerSources,
        store: PlayerStore,
    ) -> None:
        self.settings, self.db, self.events = settings, db, events
        self.voice_state, self.sources, self.store = voice_state, sources, store
        self.lock = asyncio.Lock()
        self.queue: list[dict] = []
        self.playlist: dict | None = None
        self.playlist_entries: list[dict] = []
        self.manual_entries: list[dict] = []
        self.recent: list[dict] = []
        self.started_entry_id: str | None = None
        self.index: int | None = None
        self.position = 0.0
        self.started_at = 0.0
        self.state = "idle"
        self.shuffle = False
        self.repeat = "off"
        self.error: str | None = None
        self.source: discord.AudioSource | None = None
        self.resolving: asyncio.Task | None = None
        self.checkpoint: asyncio.Task | None = None
        self.generation = 0
        self.failures = 0
        self.retry = 0
        self.closed = False
        self.background: set[asyncio.Task] = set()
        self.priority: tuple[tuple[str, str, str], ...] = ()

    async def start(self) -> None:
        async with self.lock:
            payload = await self.db.run(self.store.load_player)
            self.queue = copy.deepcopy(payload.get("queue", []))[:QUEUE_STORAGE_LIMIT]
            for entry in self.queue:
                entry["origin"] = "playlist" if entry.get("origin") == "playlist" else "manual"
            index = payload.get("index")
            self.index = index if isinstance(index, int) and 0 <= index < len(self.queue) else None
            position = payload.get("position", 0)
            self.position = (
                max(0, float(position)) if isinstance(position, (int, float)) and math.isfinite(position) else 0
            )
            self.shuffle = bool(payload.get("shuffle", False))
            self.repeat = payload.get("repeat") if payload.get("repeat") in REPEAT_MODES else "off"
            playlist = payload.get("playlist")
            self.playlist = (
                {"id": playlist["id"], "name": playlist["name"]}
                if isinstance(playlist, dict)
                and isinstance(playlist.get("id"), str)
                and isinstance(playlist.get("name"), str)
                else None
            )
            self.recent = copy.deepcopy(payload.get("recent", []))[:RECENT_LIMIT]
            self.playlist_entries = copy.deepcopy(payload.get("playlist_entries", []))[:PLAYLIST_LIMIT]
            self.manual_entries = copy.deepcopy(payload.get("manual_entries", self.queue))[-QUEUE_LIMIT:]
            self.started_entry_id = payload.get("started_entry_id")
            self.prioritize_manual()
            self.prune_history()
            self.state = "paused" if self.current else "idle"
            self.closed = False
            self.checkpoint = asyncio.create_task(self.checkpoints())
            self.notify()

    @property
    def current(self) -> dict | None:
        return self.queue[self.index] if self.index is not None and self.index < len(self.queue) else None

    def elapsed(self) -> float:
        progress = 0
        if self.state == "playing":
            progress = getattr(self.source, "played_seconds", time.monotonic() - self.started_at)
        position = self.position + progress
        duration = self.current["track"].get("duration", 0) if self.current else 0
        return max(0, min(position, duration)) if duration else max(0, position)

    def snapshot(self) -> dict:
        upcoming = self.queue[self.index + 1 :] if self.index is not None else []
        return {
            "state": self.state,
            "current": copy.deepcopy(self.current),
            "current_id": self.current["id"] if self.current else None,
            "index": self.index,
            "queue": copy.deepcopy(self.queue),
            "manual_queue": copy.deepcopy([entry for entry in upcoming if entry.get("origin") != "playlist"]),
            "playlist_queue": copy.deepcopy([entry for entry in upcoming if entry.get("origin") == "playlist"]),
            "playlist": copy.deepcopy(self.playlist),
            "recent": copy.deepcopy(self.recent),
            "position": self.elapsed(),
            "shuffle": self.shuffle,
            "repeat": self.repeat,
            "error": self.error,
        }

    def notify(self) -> None:
        tracks = (
            [entry["track"] for entry in self.queue[self.index : self.index + QUEUE_PREFETCH + 1]]
            if self.index is not None
            else []
        )
        priority = tuple((track["provider"], track["source_id"], track.get("youtube_id") or "") for track in tracks)
        prioritize = getattr(self.sources, "prioritize", None)
        if priority != self.priority and callable(prioritize):
            self.priority = priority
            prioritize(tracks)
        self.events.publish("music")

    async def save(self) -> None:
        await self.db.run(
            self.store.save_player,
            {
                "queue": copy.deepcopy(self.queue),
                "index": self.index,
                "position": self.elapsed(),
                "shuffle": self.shuffle,
                "repeat": self.repeat,
                "playlist": copy.deepcopy(self.playlist),
                "playlist_entries": copy.deepcopy(self.playlist_entries),
                "manual_entries": copy.deepcopy(self.manual_entries),
                "recent": copy.deepcopy(self.recent),
                "started_entry_id": self.started_entry_id,
            },
        )

    async def checkpoints(self) -> None:
        while not self.closed:
            await asyncio.sleep(CHECKPOINT_SECONDS)
            async with self.lock:
                if self.state == "playing":
                    self.report_timing()
                    await self.save()
                    self.notify()

    def report_timing(self) -> None:
        timing = getattr(self.source, "music_timing", None)
        if timing is not None:
            buffer = getattr(self.source, "buffer", None)
            timing.report(getattr(buffer, "silent", 0))

    def halt(self) -> None:
        self.report_timing()
        self.position = self.elapsed()
        self.generation += 1
        if self.resolving and not self.resolving.done():
            self.resolving.cancel()
        self.resolving = None
        source, self.source = self.source, None
        voice = self.voice_state.voice
        self.state = "paused" if self.current else "idle"
        if source is not None:
            if voice and voice.source is source:
                voice.stop()
            else:
                source.cleanup()

    def launch(self, *, retry: bool = False) -> None:
        if not self.current:
            return
        if not retry:
            self.retry = 0
        self.generation += 1
        self.state = "buffering"
        self.resolving = asyncio.create_task(self.resolve(self.generation, copy.deepcopy(self.current)))
        self.background.add(self.resolving)
        self.resolving.add_done_callback(self.background.discard)

    async def resolve(self, generation: int, entry: dict) -> None:
        source = None
        transferred = False
        try:
            source = await self.sources.source(entry["track"], self.position, self.volume())
            async with self.lock:
                if generation != self.generation or self.closed:
                    return
                voice = self.voice_state.voice
                if self.voice_state.audio_mode != "music" or not voice or not voice.is_connected():
                    self.state = "paused"
                    await self.save()
                    self.notify()
                    return
                self.current["track"] = copy.deepcopy(getattr(source, "music_track", entry["track"]))
                self.source = source
                self.update_volume()
                self.started_at = time.monotonic()
                self.state = "playing"
                play = getattr(voice, "play_music", None) or voice.play
                play(source, bitrate=384, after=lambda error: self.completed(generation, error))
                transferred = True
                self.remember()
                self.error = None
                self.current.pop("error", None)
                await self.save()
                self.notify()
        except (ValueError, RuntimeError, OSError, discord.DiscordException) as error:
            await self.failed(generation, error, stage="resolve")
        finally:
            if source is not None and not transferred:
                source.cleanup()

    def completed(self, generation: int, error: Exception | None) -> None:
        if not self.voice_state.loop.is_closed():
            self.voice_state.loop.call_soon_threadsafe(self.schedule_finished, generation, error)

    def schedule_finished(self, generation: int, error: Exception | None) -> None:
        if not self.closed:
            task = asyncio.create_task(self.finished(generation, error))
            self.background.add(task)
            task.add_done_callback(self.background.discard)

    async def failed(self, generation: int, error: Exception | None = None, *, stage: str = "playback") -> None:
        async with self.lock:
            if generation != self.generation or self.closed:
                return
            self.report_timing()
            if self.current:
                log_music_failure(self.current["track"], error, stage)
            self.position = self.elapsed()
            self.source = None
            self.error = "This recording could not be played. Retrying with a fresh audio stream."
            if self.retry == 0:
                self.retry = 1
                self.launch(retry=True)
            else:
                self.failures += 1
                self.error = "A recording could not be played and was skipped."
                if self.current:
                    self.current["error"] = "This recording is unavailable. Choose another recording to try again."
                self.advance(ignore_repeat=True)
                if self.current and self.failures < MAX_FAILURES:
                    self.launch()
                else:
                    self.state = "paused" if self.current else "idle"
                    if self.failures >= MAX_FAILURES:
                        self.error = (
                            "Playback paused after five unavailable recordings. Choose another recording and try again."
                        )
            await self.save()
            self.notify()

    async def finished(self, generation: int, error: Exception | None) -> None:
        if error:
            await self.failed(generation, error)
            return
        async with self.lock:
            if generation != self.generation or self.closed or self.state != "playing":
                return
            self.report_timing()
            voice = self.voice_state.voice
            if not voice or not voice.is_connected():
                self.halt()
                await self.save()
                self.notify()
                return
            self.source = None
            self.failures = 0
            self.advance()
            if self.current:
                self.launch()
            else:
                self.state = "idle"
            await self.save()
            self.notify()

    def advance(self, *, ignore_repeat: bool = False) -> None:
        self.position = 0.0
        self.started_entry_id = None
        if self.index is None:
            return
        if self.repeat == "one" and not ignore_repeat:
            return
        self.index += 1
        if self.index >= len(self.queue):
            if self.repeat == "all" and not ignore_repeat:
                self.restart_cycle()
            else:
                self.index = None
            self.prioritize_manual()
        self.prune_history()

    def restart_cycle(self) -> None:
        cycle = self.playlist_entries or self.manual_entries
        if not cycle:
            self.index = 0 if self.queue else None
            return
        entries = copy.deepcopy(cycle)
        for entry in entries:
            entry["id"] = uuid.uuid4().hex
            entry.pop("error", None)
        if self.shuffle:
            random.SystemRandom().shuffle(entries)
        history = self.queue[-RECENT_LIMIT:] if self.playlist_entries else []
        if self.playlist_entries:
            self.playlist_entries = copy.deepcopy(entries)
        else:
            self.manual_entries = copy.deepcopy(entries)
        self.queue = history + entries
        self.index = len(history)
        self.started_entry_id = None

    def remember(self) -> None:
        if self.current and self.started_entry_id != self.current["id"]:
            self.started_entry_id = self.current["id"]
            self.recent.insert(
                0, {**copy.deepcopy(self.current), "play_id": uuid.uuid4().hex, "played_at": time.time()}
            )
            del self.recent[RECENT_LIMIT:]

    def prioritize_manual(self) -> None:
        if self.index is not None:
            start = self.index + 1
            upcoming = self.queue[start:]
            self.queue[start:] = [entry for entry in upcoming if entry.get("origin") != "playlist"] + [
                entry for entry in upcoming if entry.get("origin") == "playlist"
            ]

    def prune_history(self) -> None:
        if self.index is not None and self.index > RECENT_LIMIT:
            removed = self.index - RECENT_LIMIT
            del self.queue[:removed]
            self.index -= removed
        elif self.index is None:
            self.queue = self.queue[-RECENT_LIMIT:]

    @staticmethod
    def entry(track: dict, user: dict, playlist: dict | None = None) -> dict:
        entry = {
            "id": uuid.uuid4().hex,
            "track": copy.deepcopy(track),
            "requester_id": user["id"],
            "requester_name": user.get("display_name") or user.get("name") or user["id"],
            "origin": "playlist" if playlist else "manual",
        }
        if playlist:
            entry.update(playlist_id=playlist["id"], playlist_name=playlist["name"])
        return entry

    def queue_capacity(self, count: int, *, interrupt: bool = False) -> None:
        start = self.index + int(interrupt) if self.index is not None else len(self.queue)
        manual = sum(entry.get("origin") != "playlist" for entry in self.queue[start:])
        if manual + count > QUEUE_LIMIT:
            msg = "The shared queue can contain at most 500 songs."
            raise ValueError(msg)
        self.prune_history()

    def pending_start(self) -> int:
        if self.index is None:
            return len(self.queue)
        if self.started_entry_id != self.current["id"] and self.position == 0:
            return self.index
        return self.index + 1

    def volume(self) -> float:
        return 0 if self.voice_state.muted else self.voice_state.master_volume

    def update_volume(self) -> None:
        if self.source is not None:
            self.source.volume = self.volume()

    def require_voice(self) -> None:
        voice = self.voice_state.voice
        if self.closed or self.voice_state.audio_mode != "music" or not voice or not voice.is_connected():
            msg = "Connect the bot to voice and switch to Music mode before playing."
            raise ValueError(msg)

    async def pause(self) -> dict:
        async with self.lock:
            self.halt()
            await self.save()
            self.notify()
            return self.snapshot()

    async def close(self) -> None:
        await self.pause()
        self.closed = True
        if self.checkpoint:
            self.checkpoint.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self.checkpoint
        for task in tuple(self.background):
            task.cancel()
        if self.background:
            await asyncio.gather(*tuple(self.background), return_exceptions=True)

    async def command(
        self, action: str, value: float | None = None, *, guard: Callable[[], None] | None = None
    ) -> dict:
        async with self.lock:
            if guard:
                guard()
            self.error = None
            if action == "pause":
                self.halt()
            elif action == "play":
                self.play()
            elif action in {"next", "previous", "seek", "stop"}:
                self.transport(action, value)
            elif action == "shuffle":
                enabled = not self.shuffle if value is None else bool(value)
                if enabled and not self.shuffle:
                    start = self.index + 1 if self.index is not None else 0
                    upcoming = self.queue[start:]
                    random.SystemRandom().shuffle(upcoming)
                    self.queue[start:] = upcoming
                    self.prioritize_manual()
                self.shuffle = enabled
            elif action == "repeat":
                self.repeat = (
                    REPEAT_MODES[(REPEAT_MODES.index(self.repeat) + 1) % len(REPEAT_MODES)]
                    if value is None
                    else REPEAT_MODES[max(0, min(2, int(value)))]
                )
            else:
                msg = "Unknown music player command."
                raise ValueError(msg)
            await self.save()
            self.notify()
            return self.snapshot()

    def play(self) -> None:
        self.require_voice()
        if self.state in {"playing", "buffering"}:
            return
        if self.index is None and self.queue:
            self.restart_cycle()
        if not self.current:
            msg = "Add a song to the queue first."
            raise ValueError(msg)
        self.failures = 0
        self.launch()

    def transport(self, action: str, value: float | None) -> None:
        active = self.state in {"playing", "buffering"}
        position = self.elapsed()
        if action == "seek" and (value is None or not math.isfinite(value) or value < 0):
            msg = "Choose a valid playback position."
            raise ValueError(msg)
        self.halt()
        if action == "next":
            self.advance(ignore_repeat=True)
            if self.index is None and self.queue and self.repeat == "all":
                self.restart_cycle()
        elif action == "previous":
            previous_id = self.current["id"] if self.current else None
            if position <= PREVIOUS_RESTART_SECONDS and self.index is not None:
                self.index = max(0, self.index - 1)
            elif self.index is None and self.queue:
                self.index = len(self.queue) - 1
            if self.current and self.current["id"] != previous_id:
                self.started_entry_id = None
            self.prioritize_manual()
            self.position = 0
        elif action == "seek":
            self.position = min(float(value), self.current["track"]["duration"]) if self.current else 0
        else:
            self.position = 0
            active = False
        self.state = "paused" if self.current else "idle"
        if active and self.current:
            self.require_voice()
            self.launch()

    async def play_now(self, track: dict, user: dict, *, guard: Callable[[], None] | None = None) -> dict:
        async with self.lock:
            if guard:
                guard()
            self.require_voice()
            pending = self.pending_start()
            self.queue_capacity(1, interrupt=self.index is not None and pending > self.index)
            index = self.pending_start()
            self.halt()
            entry = self.entry(track, user)
            self.queue.insert(index, entry)
            self.manual_entries = [*self.manual_entries, copy.deepcopy(entry)][-QUEUE_LIMIT:]
            self.index, self.position, self.failures, self.error = index, 0, 0, None
            self.launch()
            await self.save()
            self.notify()
            return self.snapshot()

    async def play_playlist(
        self, tracks: list[dict], user: dict, playlist: dict, *, guard: Callable[[], None] | None = None
    ) -> dict:
        async with self.lock:
            if guard:
                guard()
            self.require_voice()
            if not tracks:
                msg = "Add a song to this playlist before playing."
                raise ValueError(msg)
            start = self.pending_start()
            manual = [entry for entry in self.queue[start:] if entry.get("origin") != "playlist"]
            if len(tracks) > PLAYLIST_LIMIT:
                msg = "A playlist can contain at most 1,000 songs."
                raise ValueError(msg)
            self.halt()
            self.playlist = {"id": playlist["id"], "name": playlist["name"]}
            entries = [self.entry(track, user, self.playlist) for track in tracks]
            self.playlist_entries = copy.deepcopy(entries)
            if self.shuffle:
                random.SystemRandom().shuffle(entries)
            history = self.queue[:start][-RECENT_LIMIT:]
            self.queue = history + entries[:1] + manual + entries[1:]
            self.index, self.position, self.failures, self.error = len(history), 0, 0, None
            self.launch()
            await self.save()
            self.notify()
            return self.snapshot()

    async def enqueue(self, tracks: list[dict], user: dict, *, guard: Callable[[], None] | None = None) -> dict:
        async with self.lock:
            if guard:
                guard()
            self.queue_capacity(len(tracks))
            first = len(self.queue)
            entries = [self.entry(track, user) for track in tracks]
            self.queue.extend(entries)
            self.manual_entries = [*self.manual_entries, *copy.deepcopy(entries)][-QUEUE_LIMIT:]
            if self.index is None and tracks:
                self.index = first
                self.position = 0
                self.state = "paused"
            self.prioritize_manual()
            await self.save()
            self.notify()
            return self.snapshot()

    async def clear(self, *, guard: Callable[[], None] | None = None) -> dict:
        async with self.lock:
            if guard:
                guard()
            self.halt()
            self.queue.clear()
            self.index = None
            self.playlist = None
            self.playlist_entries.clear()
            self.manual_entries.clear()
            self.started_entry_id = None
            self.position = 0.0
            self.state = "idle"
            self.error = None
            await self.save()
            self.notify()
            return self.snapshot()

    async def remove(self, entry_id: str, *, guard: Callable[[], None] | None = None) -> dict:
        async with self.lock:
            if guard:
                guard()
            index = self.entry_index(entry_id)
            active = self.state in {"playing", "buffering"}
            current = index == self.index
            if current:
                self.halt()
                self.position = 0
            self.queue.pop(index)
            self.manual_entries = [entry for entry in self.manual_entries if entry["id"] != entry_id]
            if current:
                self.started_entry_id = None
                self.index = index if index < len(self.queue) else None
                self.state = "paused" if self.current else "idle"
                if active and self.current:
                    self.launch()
            elif self.index is not None and index < self.index:
                self.index -= 1
            await self.save()
            self.notify()
            return self.snapshot()

    async def reorder(self, ids: list[str], *, guard: Callable[[], None] | None = None) -> dict:
        async with self.lock:
            if guard:
                guard()
            if (
                len(ids) != len(self.queue)
                or len(set(ids)) != len(ids)
                or set(ids) != {entry["id"] for entry in self.queue}
            ):
                msg = "Queue order must contain every song exactly once."
                raise ValueError(msg)
            current_id = self.current["id"] if self.current else None
            entries = {entry["id"]: entry for entry in self.queue}
            self.queue = [entries[entry_id] for entry_id in ids]
            self.index = ids.index(current_id) if current_id is not None else None
            self.prioritize_manual()
            await self.save()
            self.notify()
            return self.snapshot()

    def entry_index(self, entry_id: str) -> int:
        for index, entry in enumerate(self.queue):
            if entry["id"] == entry_id:
                return index
        msg = "This song is no longer in the queue."
        raise ValueError(msg)
