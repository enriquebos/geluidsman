from __future__ import annotations

import asyncio
import time
from typing import TYPE_CHECKING
from unittest.mock import AsyncMock, patch

import pytest

from app.download_worker import DownloadProgress
from app.music_cache import MusicCache, cache_key
from tests.test_music_cache import song

if TYPE_CHECKING:
    from fastapi.testclient import TestClient

pytest_plugins = ("tests.test_api",)


def video_files(client: TestClient, identity: str = "source") -> int:
    state = client.app.state
    folder = state.media.root / identity
    folder.mkdir(exist_ok=True)
    (folder / "video.mp4").write_bytes(b"video" * 20)
    (folder / "audio.m4a").write_bytes(b"audio" * 10)
    state.media.storage.commit(folder)
    return 150


def music_item(client: TestClient, *, saved: bool = True) -> tuple[str, dict]:
    state = client.app.state
    client.portal.call(state.music_cache.close)
    user = client.get("/api/auth/me").json()
    track = song()
    key = cache_key(track)
    if saved:
        playlist = state.music_store.create("Shared playlist", user)
        state.music_store.append(playlist["id"], user, [track])
    return key, track


def test_shared_limit_initialization_and_legacy_settings_preserve_budget(client: TestClient) -> None:
    initial = client.get("/api/settings/app").json()
    assert initial["settings"]["media_max_bytes"] == 20_000_000_000
    settings = initial["settings"]
    settings["media_max_bytes"] = 30_000_000_000
    assert (
        client.put("/api/settings/app", json={**settings, "expected_revision": initial["revision"]}).status_code == 200
    )
    del settings["media_max_bytes"]
    settings["max_storage_bytes"] = 1
    assert client.put("/api/settings/app", json=settings).status_code == 200
    assert client.get("/api/settings/app").json()["settings"]["media_max_bytes"] == 30_000_000_000


def test_shared_reservations_account_for_both_roots(client: TestClient) -> None:
    video_files(client)
    state = client.app.state
    state.music_cache.used = 100
    budget = state.media.budget
    budget.limit = 500
    assert budget.reserve("music", 200) == 200
    assert budget.reserve("video", 200) == 50
    assert budget.reserve("upload", 200) == 0
    budget.release("music")
    assert budget.reserve("upload", 200) == 200
    assert sum(budget.reservations.values()) + budget.used() == 500


def test_inventory_measures_files_and_keeps_host_space_separate(client: TestClient) -> None:
    expected = video_files(client)
    result = client.get("/api/admin/storage")
    assert result.status_code == 200
    data = result.json()
    assert data["summary"]["used_bytes"] == expected
    assert data["summary"]["categories"]["video"] == expected
    assert data["summary"]["disk_free_bytes"] > 0
    assert data["items"][0]["last_used"] is None
    assert data["items"][0]["removable"]
    (client.app.state.media.root / "source" / "extra").write_bytes(b"external")
    changed = client.get("/api/admin/storage", headers={"If-None-Match": result.headers["etag"]})
    assert changed.status_code == 200
    assert changed.json()["summary"]["used_bytes"] == expected + 8


def test_review_removes_only_downloads_and_preserves_source(client: TestClient) -> None:
    video_files(client)
    review = client.post("/api/admin/storage/review", json={"ids": ["video:source"]}).json()
    result = client.post("/api/admin/storage/remove", json={"ids": ["video:source"], "token": review["token"]})
    assert result.status_code == 200, result.text
    assert result.json() == {"removed": ["video:source"], "errors": [], "reclaimed_bytes": 150}
    source = client.app.state.db.one("SELECT * FROM sources WHERE id='source'")
    assert source["title"] == "Example source"
    assert source["media_available"] == 0
    assert client.get("/api/admin/storage").json()["summary"]["used_bytes"] == 0


def test_changed_files_invalidate_removal_review(client: TestClient) -> None:
    video_files(client)
    review = client.post("/api/admin/storage/review", json={"ids": ["video:source"]}).json()
    (client.app.state.media.root / "source" / "video.mp4").write_bytes(b"new version")
    assert (
        client.post("/api/admin/storage/remove", json={"ids": ["video:source"], "token": review["token"]}).status_code
        == 409
    )
    assert client.app.state.db.one("SELECT media_available FROM sources")["media_available"] == 1


def test_editor_lease_blocks_cleanup_and_rejects_old_requests(client: TestClient) -> None:
    video_files(client)
    review = client.post("/api/admin/storage/review", json={"ids": ["video:source"]}).json()
    manager = client.app.state.media_management
    manager.connect("browser", "100", connected=True)
    body = {"client_id": "browser", "source_id": "source", "media_version": "source", "sequence": 2}
    assert client.post("/api/media/lease", json=body).status_code == 200
    assert (
        client.post("/api/admin/storage/remove", json={"ids": ["video:source"], "token": review["token"]}).status_code
        == 409
    )
    body.update(source_id=None, sequence=1)
    assert client.post("/api/media/lease", json=body).status_code == 409
    assert "browser" in manager.leases
    body["sequence"] = 3
    assert client.post("/api/media/lease", json=body).status_code == 200
    assert not manager.leases


def test_legacy_clients_and_disconnected_editor_grace_protect_source(client: TestClient) -> None:
    video_files(client)
    manager = client.app.state.media_management
    manager.connect("legacy:old", "100", connected=True)
    assert not client.get("/api/admin/storage").json()["items"][0]["removable"]
    manager.clients.clear()
    manager.connect("browser", "100", connected=True)
    client.portal.call(manager.lease, "browser", "100", {"id": "source", "media_id": None})
    manager.connect("browser", "100", connected=False)
    assert not client.get("/api/admin/storage").json()["items"][0]["removable"]
    manager.clients["browser"] = ("100", time.monotonic() - 1)
    assert client.get("/api/admin/storage").json()["items"][0]["removable"]


def test_music_cancel_persists_and_explicit_retry_clears_pause(client: TestClient) -> None:
    key, _track = music_item(client)
    result = client.post("/api/downloads/music:" + key, json={"action": "cancel"})
    assert result.status_code == 200, result.text
    cache = client.app.state.music_cache
    assert key in cache.paused
    restored = MusicCache(cache.db, cache.sources, cache.store, cache.events)
    restored.load()
    assert key in restored.paused
    assert client.get("/api/downloads?kind=music").json()["groups"]["attention"][0]["status"] == "cancelled"
    assert client.post("/api/downloads/music:" + key, json={"action": "retry"}).status_code == 200
    assert key not in cache.paused


def test_downloads_share_references_and_protect_playback(client: TestClient) -> None:
    key, track = music_item(client)
    state = client.app.state
    user = client.get("/api/auth/me").json()
    second = state.music_store.create("Second playlist", user)
    state.music_store.append(second["id"], user, [track])
    state.music_cache.prioritize([track])
    data = client.get("/api/downloads?kind=music").json()
    assert data["counts"]["waiting"] == 1
    row = data["groups"]["waiting"][0]
    assert len(row["origins"]) == 2
    assert not row["can_cancel"]
    assert client.post("/api/downloads/music:" + key, json={"action": "cancel"}).status_code == 409


def test_video_progress_is_measured_and_processing_is_not_a_percentage(client: TestClient) -> None:
    state = client.app.state
    client.get("/api/auth/me")
    job = state.db.add_job("https://example.com/new", "100")
    state.db.execute("UPDATE jobs SET status='downloading',downloaded_bytes=25,total_bytes=100 WHERE id=?", (job,))
    row = client.get("/api/downloads").json()["groups"]["active"][0]
    assert row["downloaded_bytes"] == 25
    assert row["total_bytes"] == 100
    state.db.execute("UPDATE jobs SET status='processing',total_bytes=NULL WHERE id=?", (job,))
    row = client.get("/api/downloads").json()["groups"]["active"][0]
    assert row["status"] == "processing"
    assert row["total_bytes"] is None


def test_shared_reads_are_read_only_and_admin_access_rechecked(client: TestClient) -> None:
    video_files(client)
    with patch.object(client.app.state.media, "import_url") as start:
        assert client.get("/api/downloads").status_code == 200
        initial = client.get("/api/admin/storage")
        assert initial.status_code == 200
        summary = client.get("/api/admin/storage/summary")
        assert summary.status_code == 200
        assert client.get("/api/downloads/summary").status_code == 200
        start.assert_not_called()
    current = client.app.state.auth.current

    async def denied(*args: object, **kwargs: object) -> dict:
        user = await current(*args, **kwargs)
        user["admin"] = False
        user["permissions"]["admin"] = False
        return user

    with patch.object(client.app.state.auth, "current", denied):
        assert client.get("/api/admin/storage", headers={"If-None-Match": initial.headers["etag"]}).status_code == 403
        assert client.post("/api/admin/storage/review", json={"ids": ["video:source"]}).status_code == 403
        assert (
            client.get("/api/admin/storage/summary", headers={"If-None-Match": summary.headers["etag"]}).status_code
            == 403
        )


def test_music_cancel_stops_partial_download_without_deleting_playlist(client: TestClient) -> None:
    key, _track = music_item(client)
    cache = client.app.state.music_cache

    async def scenario() -> None:
        partial = cache.root / (key + ".part")
        partial.write_bytes(b"partial")

        async def transfer() -> None:
            try:
                await asyncio.Future()
            finally:
                partial.unlink(missing_ok=True)

        cache.active_downloads[key] = asyncio.create_task(transfer())
        await asyncio.sleep(0)
        await cache.cancel_download(key)
        assert not partial.exists()
        assert key in cache.paused

    client.portal.call(scenario)
    assert client.app.state.db.one("SELECT track_count FROM music_playlists")["track_count"] == 1


def test_shared_recording_alias_survives_restart_and_original_reference_removal(client: TestClient) -> None:
    key, track = music_item(client, saved=False)
    cache = client.app.state.music_cache
    (cache.root / (key + ".part")).write_bytes(b"recording")
    entry = {"track": track, "original": track, "container": "webm", "bytes": 9}
    cache.commit(key, entry)
    cache.entries[key] = entry
    cache.used = 9
    alternate = {**track, "provider": "spotify", "source_id": "a" * 22, "youtube_id": None}
    alias = cache_key(alternate)
    result = client.portal.call(cache.share_recording, track, alias)
    assert result["reuse"] == key
    user = client.get("/api/auth/me").json()
    playlist = client.app.state.music_store.create("Remaining reference", user)
    client.app.state.music_store.append(playlist["id"], user, [alternate])
    restored = MusicCache(cache.db, cache.sources, cache.store, cache.events)
    restored.load()
    assert restored.entry_key(alternate) == key
    assert key in client.portal.call(restored.plan)
    assert len(restored.entries) == 1


def test_progress_adds_formats_and_preserves_unknown_totals() -> None:
    progress = DownloadProgress(1000)
    progress.configure({"requested_formats": [{"format_id": "video", "filesize": 100}, {"format_id": "audio"}]})
    with patch("app.download_worker.emit") as emit:
        progress({"info_dict": {"format_id": "video"}, "downloaded_bytes": 100, "total_bytes": 100})
        assert emit.call_args.args[0]["total_bytes"] is None
        progress({"info_dict": {"format_id": "audio"}, "downloaded_bytes": 20, "total_bytes_estimate": 40})
        assert emit.call_args.args[0]["downloaded_bytes"] == 120
        assert emit.call_args.args[0]["total_bytes"] == 140
        assert emit.call_args.args[0]["total_estimated"]
        progress({"info_dict": {"format_id": "audio"}, "downloaded_bytes": 30, "total_bytes": 30})
        assert emit.call_args.args[0]["downloaded_bytes"] == 130
        assert not emit.call_args.args[0]["total_estimated"]
        with pytest.raises(ValueError, match="size limit"):
            progress({"downloaded_bytes": 1001})


def test_private_likes_never_leak_through_downloads(client: TestClient) -> None:
    _key, track = music_item(client, saved=False)
    state = client.app.state
    private = {**track, "title": "Private metadata"}
    state.db.set_setting("music_likes:200", {"tracks": [private]})
    assert not client.get("/api/downloads?kind=music").json()["groups"]["waiting"]
    state.db.set_setting("music_likes:100", {"tracks": [{**track, "title": "Own metadata"}]})
    response = client.get("/api/downloads?kind=music")
    assert "Private metadata" not in response.text
    assert response.json()["groups"]["waiting"][0]["name"] == "Own metadata"
    current = state.auth.current

    async def ordinary(*args: object, **kwargs: object) -> dict:
        user = await current(*args, **kwargs)
        user["admin"] = False
        user["permissions"]["admin"] = False
        return user

    with patch.object(state.auth, "current", ordinary):
        row = client.get("/api/downloads?kind=music").json()["groups"]["waiting"][0]
        assert not row["can_cancel"]
        assert client.post("/api/downloads/" + row["id"], json={"action": "cancel"}).status_code == 409


def test_failed_file_validation_never_reports_completed_music(client: TestClient) -> None:
    key, track = music_item(client)
    state = client.app.state
    state.music_cache.entries[key] = {"track": track, "original": track, "bytes": 9}
    row = client.get("/api/downloads?kind=music").json()["groups"]["attention"][0]
    assert row["bytes"] is None
    assert row["can_retry"]


def test_obsolete_limit_write_rejected_and_lower_limit_keeps_files(client: TestClient) -> None:
    video_files(client)
    initial = client.get("/api/settings/app").json()
    body = {**initial["settings"], "expected_revision": initial["revision"], "media_max_bytes": 100}
    assert client.put("/api/settings/app", json=body).status_code == 200
    assert client.put("/api/settings/app", json={**body, "media_max_bytes": 200}).status_code == 409
    assert (client.app.state.media.root / "source" / "video.mp4").is_file()
    assert client.get("/api/admin/storage").json()["summary"]["remaining_bytes"] == 0


def test_linked_sound_and_partial_removal_failure_keep_required_data(client: TestClient) -> None:
    video_files(client)
    state = client.app.state
    review = client.post("/api/admin/storage/review", json={"ids": ["video:source"]}).json()
    state.db.execute(
        "INSERT INTO clips(id,source_id,name,emoji,tags,start,end,volume,created_at) VALUES (?,?,?,?,?,?,?,?,?)",
        ("linked", "source", "Linked sound", "", "[]", 0, 1, 1, 1),
    )
    assert (
        client.post("/api/admin/storage/remove", json={"ids": ["video:source"], "token": review["token"]}).status_code
        == 409
    )
    state.db.execute("UPDATE clips SET source_id=NULL")
    review = client.post("/api/admin/storage/review", json={"ids": ["video:source"]}).json()
    with patch.object(state.media.storage, "remove"):
        result = client.post(
            "/api/admin/storage/remove", json={"ids": ["video:source"], "token": review["token"]}
        ).json()
    assert not result["removed"]
    assert result["errors"]
    assert state.db.one("SELECT id FROM sources")
    assert client.get("/api/media/source/video.mp4").status_code == 404


def test_inventory_rejects_changes_during_collection(client: TestClient) -> None:
    manager = client.app.state.media_management
    collect = manager.collect

    async def changing() -> dict:
        result = await collect()
        client.app.state.events.publish("library")
        return result

    with patch.object(manager, "collect", changing):
        result = client.get("/api/admin/storage")
        assert result.status_code == 409
        assert "items" not in result.json()


def test_video_retry_queue_is_serial_and_cancelling_one_keeps_the_rest(client: TestClient) -> None:
    media = client.app.state.media
    client.get("/api/auth/me")

    async def scenario() -> None:
        entered, release = asyncio.Event(), asyncio.Event()
        finished = []

        async def transfer(identity: str, _url: str, _source: str | None) -> None:
            await media.notify_job(identity, "downloading")
            if not finished:
                entered.set()
                await release.wait()
            finished.append(identity)
            await media.notify_job(identity, "complete")

        with (
            patch.object(media, "import_job", side_effect=transfer),
            patch.object(media, "dependencies", return_value=[]),
        ):
            await media.retry_jobs([{"url": "https://example.com/" + str(index)} for index in range(3)], "100")
            await entered.wait()
            rows = await media.db.run(media.db.rows, "SELECT * FROM jobs ORDER BY created_at")
            assert len(media.job_tasks) == 1
            await media.cancel_job(rows[1]["id"])
            release.set()
            await asyncio.gather(*tuple(media.tasks))
            assert finished == [rows[0]["id"], rows[2]["id"]]
            assert (await media.db.run(media.db.one, "SELECT status FROM jobs WHERE id=?", (rows[1]["id"],)))[
                "status"
            ] == "cancelled"

    client.portal.call(scenario)


def test_cancel_after_committed_video_keeps_completion(client: TestClient) -> None:
    media = client.app.state.media
    job = media.db.add_job("https://example.com/video")
    media.cancelled_jobs.add(job)
    client.portal.call(lambda: media.interrupt_import(job, None, "source", committed=True))
    assert media.db.one("SELECT status FROM jobs WHERE id=?", (job,))["status"] == "complete"


def test_download_identity_stays_stable_across_retry_and_recording_urls(client: TestClient) -> None:
    state = client.app.state
    job = state.db.add_job("https://youtu.be/abcdefghijk")
    state.db.execute("UPDATE jobs SET status='failed' WHERE id=?", (job,))
    first = client.get("/api/downloads").json()["groups"]["attention"][0]
    newer = state.db.add_job("https://www.youtube.com/watch?v=abcdefghijk")
    state.db.execute("UPDATE jobs SET status='failed' WHERE id=?", (newer,))
    rows = client.get("/api/downloads").json()["groups"]["attention"]
    assert len(rows) == 1
    assert rows[0]["id"] == first["id"]


def test_retry_all_applies_search_and_rechecks_available_actions(client: TestClient) -> None:
    key, _track = music_item(client)
    state = client.app.state
    state.music_cache.states[key] = {"state": "failed", "error": "Failed"}
    with patch.object(state.media, "retry_jobs", new=AsyncMock()) as retry:
        response = client.post("/api/downloads/retry-all?kind=music&q=Song")
    assert response.status_code == 200
    assert response.json()["queued"] == 1
    assert key not in state.music_cache.states
    retry.assert_awaited_once_with([], "100")


def test_cancelling_a_channel_item_continues_its_batch(client: TestClient) -> None:
    media = client.app.state.media
    media.db.execute(
        "INSERT INTO channel_batches(id,url,title,status,created_at) VALUES (?,?,?,?,?)",
        ("batch", "https://www.youtube.com/@test/videos", "Batch", "running", 1),
    )
    for letter in "ab":
        media.db.execute(
            "INSERT INTO channel_items(batch_id,url,title,status) VALUES (?,?,?,?)",
            ("batch", "https://youtu.be/" + letter * 11, letter, "queued"),
        )

    async def scenario() -> None:
        entered = asyncio.Event()

        async def transfer(identity: str, url: str) -> None:
            try:
                await media.notify_job(identity, "downloading")
                if url.endswith("a" * 11):
                    entered.set()
                    await asyncio.Future()
                await media.notify_job(identity, "complete")
            except asyncio.CancelledError:
                await media.notify_job(identity, "cancelled")
                raise

        with patch.object(media, "import_job", side_effect=transfer):
            batch = asyncio.create_task(media.channels.run("batch"))
            await entered.wait()
            row = await media.db.run(media.db.one, "SELECT id FROM channel_items WHERE title='a'")
            await media.channels.cancel_item(row["id"])
            await batch
            assert (await media.db.run(media.db.one, "SELECT status FROM channel_batches WHERE id='batch'"))[
                "status"
            ] == "complete"
            assert [
                row["status"]
                for row in await media.db.run(media.db.rows, "SELECT status FROM channel_items ORDER BY id")
            ] == ["cancelled", "complete"]

    client.portal.call(scenario)


def test_media_operation_start_invalidates_an_earlier_removal_review(client: TestClient) -> None:
    video_files(client)
    review = client.post("/api/admin/storage/review", json={"ids": ["video:source"]}).json()
    client.app.state.media.busy = True
    assert (
        client.post("/api/admin/storage/remove", json={"ids": ["video:source"], "token": review["token"]}).status_code
        == 409
    )
    assert (client.app.state.media.root / "source" / "video.mp4").is_file()
    client.app.state.media.busy = False


def test_summary_reads_confirm_current_usage_without_filtering(client: TestClient) -> None:
    expected = video_files(client)
    initial = client.get("/api/downloads/summary")
    assert initial.json()["used_bytes"] == expected
    assert client.get("/api/downloads/summary", headers={"If-None-Match": initial.headers["etag"]}).status_code == 304
    client.app.state.media.budget.limit += 100
    changed = client.get("/api/downloads/summary", headers={"If-None-Match": initial.headers["etag"]})
    assert changed.status_code == 200
    assert changed.json()["max_bytes"] == initial.json()["max_bytes"] + 100
    storage = client.get("/api/admin/storage/summary")
    assert storage.json()["summary"]["used_bytes"] == expected
    assert "items" not in storage.json()
    (client.app.state.media.root / "source" / "extra").write_bytes(b"external")
    changed = client.get("/api/admin/storage/summary", headers={"If-None-Match": storage.headers["etag"]})
    assert changed.status_code == 200
    assert changed.json()["summary"]["used_bytes"] == expected + 8
