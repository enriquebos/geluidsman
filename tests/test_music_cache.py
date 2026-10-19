from __future__ import annotations

import asyncio
import json
import threading
import time
from typing import TYPE_CHECKING
from unittest.mock import AsyncMock, Mock, patch

import pytest

from app.config import Settings
from app.db import Database
from app.music_cache import DISK_RESERVE, MusicCache, cache_key
from app.music_models import MusicTrack
from app.music_sources import MusicSourceError, MusicSources
from app.music_store import MusicStore

if TYPE_CHECKING:
    from collections.abc import Callable
    from pathlib import Path


def song(identity: str = "abcdefghijk") -> dict:
    return MusicTrack(
        provider="youtube", source_id=identity, title="Song " + identity, artist="Artist", duration=120
    ).model_dump()


def parts(tmp_path: Path, **overrides: int) -> tuple:
    db = Database(tmp_path / "test.sqlite3")
    db.execute(
        "INSERT INTO users(id,username,display_name,created_at,last_login) VALUES (?,?,?,?,?)",
        ("100", "user", "User", time.time(), time.time()),
    )
    store = MusicStore(db)
    sources = MusicSources(Settings(_env_file=None, data_dir=tmp_path, **overrides))
    cache = MusicCache(db, sources, store, Mock())
    sources.cache = cache
    return db, store, sources, cache, {"id": "100", "admin": True}


async def until(check: Callable[[], bool]) -> None:
    for _ in range(300):
        if check():
            return
        await asyncio.sleep(0.01)
    assert check()


async def download(track: dict, path: Path, _limit: int) -> dict:
    await asyncio.to_thread(path.write_bytes, b"recording")
    return {"track": track, "container": "webm", "bytes": 9}


def test_existing_playlists_backfill_deduplicate_and_restore_without_downloading(tmp_path: Path) -> None:
    async def verify() -> None:
        db, store, sources, cache, user = parts(tmp_path)
        first = store.create("Existing", user)
        second = store.create("Also existing", user)
        store.append(first["id"], user, [song(), song("lmnopqrstuv")])
        store.append(second["id"], user, [song()])
        sources.download = AsyncMock(side_effect=download)
        await cache.start()
        await until(lambda: len(cache.entries) == 2)
        assert sources.download.await_count == 2
        assert cache.used == 18
        assert cache.status(song())["state"] == "cached"
        assert (await cache.local(song()))["stream"].endswith(".audio")
        await cache.close()
        restored = MusicCache(db, sources, store, Mock())
        await restored.start()
        assert len(restored.entries) == 2
        await asyncio.sleep(0.05)
        assert sources.download.await_count == 2
        assert restored.used == 18
        assert "stream" not in json.loads(next(cache.root.glob("*.json")).read_text())
        await restored.close()
        await sources.close()
        db.close()

    asyncio.run(verify())


def test_failure_discards_partial_and_requires_explicit_retry(tmp_path: Path) -> None:
    async def verify() -> None:
        db, store, sources, cache, user = parts(tmp_path)
        playlist = store.create("Existing", user)
        store.append(playlist["id"], user, [song()])

        async def fail(_track: dict, path: Path, _limit: int) -> dict:
            await asyncio.to_thread(path.write_bytes, b"partial")
            message = "Recording unavailable."
            raise MusicSourceError(message)

        sources.download = AsyncMock(side_effect=fail)
        await cache.start()
        await until(lambda: cache.status(song())["state"] == "failed")
        cache.refresh()
        await asyncio.sleep(0.05)
        assert sources.download.await_count == 1
        assert not list(cache.root.glob("*.part"))
        assert not cache.entries
        sources.download.side_effect = download
        cache.retry([song()])
        await until(lambda: cache.status(song())["state"] == "cached")
        assert sources.download.await_count == 2
        await cache.close()
        await sources.close()
        db.close()

    asyncio.run(verify())


def test_playback_retries_a_failed_download_without_repeating_background_failures(tmp_path: Path) -> None:
    async def verify() -> None:
        db, store, sources, cache, user = parts(tmp_path)
        playlist = store.create("Existing", user)
        store.append(playlist["id"], user, [song()])
        sources.download = AsyncMock(side_effect=MusicSourceError("Temporary connection failure."))
        await cache.start()
        await until(lambda: cache.status(song())["state"] == "failed")
        sources.download.side_effect = download
        local = await asyncio.wait_for(cache.ensure(song()), 3)
        assert local["track"]["source_id"] == song()["source_id"]
        assert sources.download.await_count == 2
        assert cache.status(song())["state"] == "cached"
        await cache.close()
        await sources.close()
        db.close()

    asyncio.run(verify())


def test_failed_playback_download_retries_once_per_request_and_stays_bounded(tmp_path: Path) -> None:
    async def verify() -> None:
        db, _store, sources, cache, _user = parts(tmp_path)
        sources.download = AsyncMock(side_effect=MusicSourceError("Temporary connection failure."))
        await cache.start()
        for attempts in (1, 2):
            with pytest.raises(MusicSourceError, match="connection failure"):
                await asyncio.wait_for(cache.ensure(song()), 3)
            assert sources.download.await_count == attempts
        cache.refresh()
        await asyncio.sleep(0.05)
        assert sources.download.await_count == 2
        assert not cache.required
        assert not cache.waiters
        await cache.close()
        await sources.close()
        db.close()

    asyncio.run(verify())


def test_cache_limits_storage_and_reclaims_removed_playlist_songs(tmp_path: Path) -> None:
    async def verify() -> None:
        db, store, sources, cache, user = parts(tmp_path, music_cache_max_bytes=9)
        playlist = store.create("Existing", user)
        store.append(playlist["id"], user, [song(), song("lmnopqrstuv")])
        sources.download = AsyncMock(side_effect=download)
        await cache.start()
        await until(lambda: cache.status(song("lmnopqrstuv"))["state"] == "failed")
        assert cache.used == 9
        assert sources.download.await_count == 1
        assert "storage is full" in cache.status(song("lmnopqrstuv"))["error"]
        await db.run(store.update, playlist["id"], user, {"tracks": [song("lmnopqrstuv")]})
        cache.retry([song("lmnopqrstuv")])
        await until(lambda: cache.status(song("lmnopqrstuv"))["state"] == "cached")
        assert cache_key(song()) not in cache.entries
        assert cache.used == 9
        assert len(list(cache.root.glob("*.audio"))) == 1
        await cache.close()
        await sources.close()
        db.close()

    asyncio.run(verify())


def test_shutdown_cancels_download_without_publishing_partial_cache(tmp_path: Path) -> None:
    async def verify() -> None:
        db, store, sources, cache, user = parts(tmp_path)
        playlist = store.create("Existing", user)
        store.append(playlist["id"], user, [song()])
        started = asyncio.Event()

        async def pending(_track: dict, path: Path, _limit: int) -> dict:
            await asyncio.to_thread(path.write_bytes, b"partial")
            started.set()
            await asyncio.Future()
            return {}

        sources.download = AsyncMock(side_effect=pending)
        await cache.start()
        await started.wait()
        await cache.close()
        assert not cache.entries
        assert not list(cache.root.iterdir())
        await sources.close()
        db.close()

    asyncio.run(verify())


def test_missing_cache_file_is_rebuilt_and_runtime_duration_limit_is_enforced(tmp_path: Path) -> None:
    async def verify() -> None:
        db, store, sources, cache, user = parts(tmp_path)
        playlist = store.create("Existing", user)
        store.append(playlist["id"], user, [song()])
        sources.download = AsyncMock(side_effect=download)
        await cache.start()
        await until(lambda: bool(cache.entries))
        sources.settings.max_source_seconds = 60
        with pytest.raises(MusicSourceError, match="duration limit"):
            await cache.local(song())
        sources.settings.max_source_seconds = 3600
        (cache.root / (cache_key(song()) + ".audio")).unlink()
        assert await cache.local(song()) is None
        await until(lambda: sources.download.await_count == 2 and bool(cache.entries))
        assert cache.used == 9
        await cache.close()
        await sources.close()
        db.close()

    asyncio.run(verify())


def test_spotify_cached_match_survives_player_metadata_enrichment(tmp_path: Path) -> None:
    async def verify() -> None:
        db, store, sources, cache, user = parts(tmp_path)
        original = MusicTrack(
            provider="spotify", source_id="a" * 22, title="Song", artist="Artist", duration=120
        ).model_dump()
        matched = {**original, "youtube_id": "abcdefghijk", "youtube_title": "Matched recording"}
        playlist = store.create("Spotify", user)
        store.append(playlist["id"], user, [original])

        async def matching(_track: dict, path: Path, limit: int) -> dict:
            return await download(matched, path, limit)

        sources.download = AsyncMock(side_effect=matching)
        await cache.start()
        await until(lambda: cache.status(original)["state"] == "cached")
        assert (await cache.local(matched))["track"]["youtube_id"] == "abcdefghijk"
        assert await cache.local({**matched, "youtube_id": "lmnopqrstuv"}) is None
        await db.run(store.update, playlist["id"], user, {"tracks": [matched]})
        cache.refresh()
        await asyncio.sleep(0.05)
        assert sources.download.await_count == 1
        assert cache.status(matched)["state"] == "cached"
        await cache.close()
        await sources.close()
        db.close()

    asyncio.run(verify())


def test_current_and_upcoming_playlist_songs_get_download_priority(tmp_path: Path) -> None:
    async def verify() -> None:
        db, store, sources, cache, user = parts(tmp_path)
        playlist = store.create("Existing", user)
        tracks = [song(), song("lmnopqrstuv"), song("wxyz1234567")]
        store.append(playlist["id"], user, tracks)
        sources.download = AsyncMock(side_effect=download)
        cache.prioritize([tracks[2], tracks[1]])
        await cache.start()
        await until(lambda: len(cache.entries) == 3)
        assert [call.args[0]["source_id"] for call in sources.download.await_args_list] == [
            "wxyz1234567",
            "lmnopqrstuv",
            "abcdefghijk",
        ]
        assert cache.used == 27
        await cache.close()
        await sources.close()
        db.close()

    asyncio.run(verify())


def test_rename_preserves_audio_and_overlays_current_display_metadata(tmp_path: Path) -> None:
    async def verify() -> None:
        db, store, sources, cache, user = parts(tmp_path)
        playlist = store.create("Existing", user)
        track = song()
        store.append(playlist["id"], user, [track])
        sources.download = AsyncMock(side_effect=download)
        await cache.start()
        await until(lambda: cache.status(track)["state"] == "cached")
        renamed = {**track, "title": "Custom title"}
        await db.run(store.update, playlist["id"], user, {"tracks": [renamed]})
        cache.refresh()
        assert (await cache.local(renamed))["track"]["title"] == "Custom title"
        assert sources.download.await_count == 1
        assert cache.recording(renamed)["source_url"].endswith("abcdefghijk")
        await cache.close()
        await sources.close()
        db.close()

    asyncio.run(verify())


def test_source_change_removes_orphan_recording_and_downloads_replacement(tmp_path: Path) -> None:
    async def verify() -> None:
        db, store, sources, cache, user = parts(tmp_path)
        playlist = store.create("Existing", user)
        old, new = song(), song("lmnopqrstuv")
        store.append(playlist["id"], user, [old])
        sources.download = AsyncMock(side_effect=download)
        await cache.start()
        await until(lambda: cache.status(old)["state"] == "cached")
        await db.run(store.update, playlist["id"], user, {"tracks": [new]})
        await cache.replace(old, new)
        await until(lambda: cache.status(new)["state"] == "cached")
        assert not (cache.root / (cache_key(old) + ".audio")).exists()
        assert cache.used == 9
        assert sources.download.await_count == 2
        await cache.close()
        await sources.close()
        db.close()

    asyncio.run(verify())


def test_source_change_keeps_recording_referenced_by_another_playlist(tmp_path: Path) -> None:
    async def verify() -> None:
        db, store, sources, cache, user = parts(tmp_path)
        first, second = store.create("First", user), store.create("Second", user)
        old, new = song(), song("lmnopqrstuv")
        store.append(first["id"], user, [old])
        store.append(second["id"], user, [old])
        sources.download = AsyncMock(side_effect=download)
        await cache.start()
        await until(lambda: cache.status(old)["state"] == "cached")
        await db.run(store.update, first["id"], user, {"tracks": [new]})
        await cache.replace(old, new)
        await until(lambda: cache.status(new)["state"] == "cached")
        assert cache.status(old)["state"] == "cached"
        assert cache.used == 18
        await cache.close()
        await sources.close()
        db.close()

    asyncio.run(verify())


def test_source_change_cancels_obsolete_inflight_download(tmp_path: Path) -> None:
    async def verify() -> None:
        db, store, sources, cache, user = parts(tmp_path)
        playlist = store.create("Existing", user)
        old, new = song(), song("lmnopqrstuv")
        store.append(playlist["id"], user, [old])
        started = asyncio.Event()
        cancelled = asyncio.Event()

        async def pending(track: dict, path: Path, limit: int) -> dict:
            if track["source_id"] == old["source_id"]:
                await asyncio.to_thread(path.write_bytes, b"partial")
                started.set()
                try:
                    await asyncio.Future()
                finally:
                    cancelled.set()
            return await download(track, path, limit)

        sources.download = AsyncMock(side_effect=pending)
        await cache.start()
        await started.wait()
        await db.run(store.update, playlist["id"], user, {"tracks": [new]})
        await cache.replace(old, new)
        await until(lambda: cache.status(new)["state"] == "cached")
        assert cancelled.is_set()
        assert not (cache.root / (cache_key(old) + ".part")).exists()
        assert not (cache.root / (cache_key(old) + ".audio")).exists()
        assert not cache.task.done()
        await cache.close()
        await sources.close()
        db.close()

    asyncio.run(verify())


def test_source_readded_during_pending_removal_is_cached_again(tmp_path: Path) -> None:
    async def verify() -> None:
        db, store, sources, cache, user = parts(tmp_path)
        first, second = store.create("First", user), store.create("Second", user)
        old, new = song(), song("lmnopqrstuv")
        store.append(first["id"], user, [old])
        store.append(second["id"], user, [new])
        sources.download = AsyncMock(side_effect=download)
        await cache.start()
        await until(lambda: len(cache.entries) == 2)
        await db.run(store.update, first["id"], user, {"tracks": [new]})
        started, release = asyncio.Event(), asyncio.Event()
        original_remove = cache.remove_entry
        replace_task = None

        async def delayed_remove(key: str) -> None:
            if asyncio.current_task() is replace_task:
                started.set()
                await release.wait()
            await original_remove(key)

        cache.remove_entry = delayed_remove
        replace_task = asyncio.create_task(cache.replace(old, new))
        try:
            await asyncio.wait_for(started.wait(), 3)
            await until(lambda: cache_key(old) not in cache.entries)
            await db.run(store.append, second["id"], user, [old])
            cache.refresh()
            await until(lambda: cache.status(old)["state"] == "cached")
        finally:
            release.set()
        await replace_task
        await until(lambda: cache.status(old)["state"] == "cached")
        assert sources.download.await_count == 4
        assert cache.used == 18
        assert (await cache.local(old))["track"]["source_id"] == old["source_id"]
        assert len(list(cache.root.glob("*.audio"))) == 2
        await cache.close()
        await sources.close()
        db.close()

    asyncio.run(verify())


def test_source_change_during_shielded_commit_removes_committed_obsolete_files(tmp_path: Path) -> None:
    async def verify() -> None:
        db, store, sources, cache, user = parts(tmp_path)
        playlist = store.create("Existing", user)
        old, new = song(), song("lmnopqrstuv")
        store.append(playlist["id"], user, [old])
        sources.download = AsyncMock(side_effect=download)
        original_commit = cache.commit
        started, release = threading.Event(), threading.Event()

        def blocked_commit(key: str, entry: dict) -> None:
            original_commit(key, entry)
            if key == cache_key(old):
                started.set()
                assert release.wait(5)

        cache.commit = blocked_commit
        await cache.start()
        try:
            await until(started.is_set)
            assert (cache.root / (cache_key(old) + ".audio")).exists()
            assert cache_key(old) not in cache.entries
            await db.run(store.update, playlist["id"], user, {"tracks": [new]})
            replaced = asyncio.create_task(cache.replace(old, new))
            await until(lambda: any(task.cancelling() for task in cache.active_downloads.values()))
            assert not replaced.done()
            release.set()
            await replaced
            await until(lambda: cache.status(new)["state"] == "cached")
            assert not (cache.root / (cache_key(old) + ".audio")).exists()
            assert not (cache.root / (cache_key(old) + ".json")).exists()
            assert not list(cache.root.glob("*.part"))
            assert cache.used == 9
            assert len(cache.entries) == 1
            assert not cache.task.done()
        finally:
            release.set()
            await cache.close()
            await sources.close()
            db.close()

    asyncio.run(verify())


def test_parallel_downloads_fill_two_workers_and_keep_pending_songs_bounded(tmp_path: Path) -> None:
    async def verify() -> None:
        db, store, sources, cache, user = parts(tmp_path)
        playlist = store.create("Existing", user)
        tracks = [song(), song("lmnopqrstuv"), song("wxyz1234567")]
        store.append(playlist["id"], user, tracks)
        release = asyncio.Event()
        active, maximum = set(), 0

        async def pending(track: dict, path: Path, limit: int) -> dict:
            nonlocal maximum
            active.add(track["source_id"])
            maximum = max(maximum, len(active))
            try:
                await release.wait()
                return await download(track, path, limit)
            finally:
                active.remove(track["source_id"])

        sources.download = AsyncMock(side_effect=pending)
        try:
            await cache.start()
            await until(lambda: len(active) == 2)
            assert sources.download.await_count == 2
            assert cache.status(tracks[2])["state"] == "queued"
            assert sum(cache.reservations.values()) == 2 * sources.settings.max_import_bytes
            release.set()
            await until(lambda: len(cache.entries) == 3)
            assert maximum == 2
            assert cache.used == 27
        finally:
            release.set()
            await cache.close()
            await sources.close()
            db.close()
        assert not cache.active_downloads
        assert not cache.reservations

    asyncio.run(verify())


@pytest.mark.parametrize("disk_limited", [False, True])
def test_parallel_downloads_reserve_shared_capacity_without_overcommitting(
    tmp_path: Path, *, disk_limited: bool
) -> None:
    async def verify() -> None:
        db, store, sources, cache, user = parts(
            tmp_path, music_cache_max_bytes=100 if disk_limited else 18, max_import_bytes=9
        )
        playlist = store.create("Existing", user)
        tracks = [song(), song("lmnopqrstuv"), song("wxyz1234567")]
        store.append(playlist["id"], user, tracks)
        release = asyncio.Event()

        async def pending(track: dict, path: Path, limit: int) -> dict:
            assert limit == 9
            await release.wait()
            return await download(track, path, limit)

        def disk_usage(_path: Path) -> Mock:
            return Mock(free=DISK_RESERVE + (18 - cache.used if disk_limited else 100))

        sources.download = AsyncMock(side_effect=pending)
        try:
            with patch("app.music_cache.shutil.disk_usage", side_effect=disk_usage):
                await cache.start()
                await until(lambda: sources.download.await_count == 2)
                assert sum(cache.reservations.values()) == 18
                assert cache.used + sum(cache.reservations.values()) <= 18
                release.set()
                await until(lambda: cache.status(tracks[2])["state"] == "failed")
                assert sources.download.await_count == 2
                assert cache.used == 18
                assert len(list(cache.root.glob("*.audio"))) == 2
        finally:
            release.set()
            await cache.close()
            await sources.close()
            db.close()

    asyncio.run(verify())


def test_cancelled_parallel_download_does_not_interrupt_shared_recording(tmp_path: Path) -> None:
    async def verify() -> None:
        db, store, sources, cache, user = parts(tmp_path)
        playlist = store.create("Existing", user)
        old, shared, replacement = song(), song("lmnopqrstuv"), song("wxyz1234567")
        store.append(playlist["id"], user, [old, shared])
        started, cancelled, finish_shared = asyncio.Event(), asyncio.Event(), asyncio.Event()

        async def pending(track: dict, path: Path, limit: int) -> dict:
            if track["source_id"] == old["source_id"]:
                await asyncio.to_thread(path.write_bytes, b"partial")
                started.set()
                try:
                    await asyncio.Future()
                finally:
                    cancelled.set()
            if track["source_id"] == shared["source_id"]:
                await finish_shared.wait()
            return await download(track, path, limit)

        sources.download = AsyncMock(side_effect=pending)
        try:
            await cache.start()
            await started.wait()
            await until(lambda: sources.download.await_count == 2)
            shared_task = cache.active_downloads[cache_key(shared)]
            await db.run(store.update, playlist["id"], user, {"tracks": [replacement, shared]})
            await cache.replace(old, replacement)
            await until(lambda: cache.status(replacement)["state"] == "cached")
            assert cancelled.is_set()
            assert not shared_task.done()
            assert not (cache.root / (cache_key(old) + ".part")).exists()
            finish_shared.set()
            await until(lambda: len(cache.entries) == 2)
            assert cache.used == 18
            assert sources.download.await_count == 3
        finally:
            finish_shared.set()
            await cache.close()
            await sources.close()
            db.close()

    asyncio.run(verify())


def test_shutdown_cancels_both_workers_and_restart_resumes_unfinished_songs(tmp_path: Path) -> None:
    async def verify() -> None:
        db, store, sources, cache, user = parts(tmp_path)
        playlist = store.create("Existing", user)
        store.append(playlist["id"], user, [song(), song("lmnopqrstuv")])
        cancelled = []

        async def pending(track: dict, path: Path, _limit: int) -> dict:
            await asyncio.to_thread(path.write_bytes, b"partial")
            try:
                await asyncio.Future()
            finally:
                cancelled.append(track["source_id"])
            return {}

        sources.download = AsyncMock(side_effect=pending)
        await cache.start()
        await until(lambda: sources.download.await_count == 2 and len(list(cache.root.glob("*.part"))) == 2)
        await cache.close()
        assert len(cancelled) == 2
        assert not cache.active_downloads
        assert not cache.reservations
        assert not list(cache.root.iterdir())
        sources.download.side_effect = download
        restored = MusicCache(db, sources, store, Mock())
        try:
            await restored.start()
            await until(lambda: len(restored.entries) == 2)
            assert restored.used == 18
            assert sources.download.await_count == 4
        finally:
            await restored.close()
            await sources.close()
            db.close()

    asyncio.run(verify())


def test_queue_only_songs_cache_current_and_five_ahead_and_release_old_window(tmp_path: Path) -> None:
    async def verify() -> None:
        db, _, sources, cache, _ = parts(tmp_path)
        tracks = [song(f"{index:011d}") for index in range(8)]
        sources.download = AsyncMock(side_effect=download)
        cache.prioritize(tracks)
        try:
            await cache.start()
            await until(lambda: len(cache.entries) == 6)
            assert {call.args[0]["source_id"] for call in sources.download.await_args_list} == {
                track["source_id"] for track in tracks[:6]
            }
            assert (await cache.ensure(tracks[0]))["stream"].endswith(".audio")
            cache.prioritize(tracks[1:7])
            await until(lambda: cache_key(tracks[6]) in cache.entries and cache_key(tracks[0]) not in cache.entries)
            assert len(cache.entries) == 6
            cache.prioritize([])
            await until(lambda: not cache.entries)
        finally:
            await cache.close()
            await sources.close()
            db.close()

    asyncio.run(verify())


def test_playing_song_preempts_one_backfill_worker_and_downloads_fully_before_use(tmp_path: Path) -> None:
    async def verify() -> None:
        db, store, sources, cache, user = parts(tmp_path)
        playlist = store.create("Backfill", user)
        backfill = [song("00000000001"), song("00000000002")]
        urgent = song("00000000003")
        store.append(playlist["id"], user, backfill)
        release = asyncio.Event()
        cancelled = []

        async def pending(track: dict, path: Path, limit: int) -> dict:
            if track in backfill:
                try:
                    await release.wait()
                except asyncio.CancelledError:
                    cancelled.append(track["source_id"])
                    raise
            return await download(track, path, limit)

        sources.download = AsyncMock(side_effect=pending)
        try:
            await cache.start()
            await until(lambda: sources.download.await_count == 2)
            cache.prioritize([urgent])
            local = await cache.ensure(urgent)
            assert await asyncio.to_thread((cache.root / (cache_key(urgent) + ".audio")).read_bytes) == b"recording"
            assert len(cancelled) == 1
            assert len(cache.active_downloads) <= 2
            assert await cache.ensure(urgent) == local
            assert [call.args[0]["source_id"] for call in sources.download.await_args_list].count(
                urgent["source_id"]
            ) == 1
            release.set()
            await until(lambda: len(cache.entries) == 3)
        finally:
            release.set()
            await cache.close()
            await sources.close()
            db.close()

    asyncio.run(verify())


def test_shared_download_waiters_do_not_cancel_each_other_and_failures_are_reported(tmp_path: Path) -> None:
    async def verify() -> None:
        db, _, sources, cache, _ = parts(tmp_path)
        release = asyncio.Event()

        async def pending(track: dict, path: Path, limit: int) -> dict:
            await release.wait()
            return await download(track, path, limit)

        sources.download = AsyncMock(side_effect=pending)
        try:
            await cache.start()
            first = asyncio.create_task(cache.ensure(song()))
            second = asyncio.create_task(cache.ensure(song()))
            await until(lambda: sources.download.await_count == 1)
            first.cancel()
            with pytest.raises(asyncio.CancelledError):
                await first
            release.set()
            assert (await second)["stream"].endswith(".audio")
            assert not cache.waiters
            assert not cache.required
            sources.download.side_effect = MusicSourceError("Recording refused.")
            with pytest.raises(MusicSourceError, match="Recording refused"):
                await cache.ensure(song("lmnopqrstuv"))
            assert not cache.required
        finally:
            release.set()
            await cache.close()
            await sources.close()
            db.close()

    asyncio.run(verify())


def test_progress_distinguishes_group_changes_from_byte_updates(tmp_path: Path) -> None:
    db, _store, sources, cache, _user = parts(tmp_path)
    key = cache_key(song())
    cache.progress(key, 1, None)
    first = cache.events.publish.call_args.args[1]
    assert first["counts_changed"] is True
    cache.progress_at.clear()
    cache.progress(key, 20, 100)
    second = cache.events.publish.call_args.args[1]
    assert second["counts_changed"] is False
    assert second["download_update"] == {"downloaded_bytes": 20, "total_bytes": 100}
    assert second["ids"] == ["music:" + key]
    db.close()
    asyncio.run(sources.close())
