from __future__ import annotations

import asyncio
import base64
import json
import shutil
import signal
import socket
import subprocess
import threading
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from types import SimpleNamespace
from typing import TYPE_CHECKING
from unittest.mock import AsyncMock, MagicMock, patch

import discord
import pytest
from pydantic import SecretStr

from app.config import Settings
from app.music_sources import (
    MAX_ITEMS,
    MAX_PENDING,
    MAX_RESPONSE,
    GuardedMusicAudio,
    MusicDecoder,
    MusicSourceError,
    MusicSources,
    environment,
    read_json,
    source_query,
)
from app.music_worker import MusicWorkerError, extract, metadata
from app.network import DownloadProxy, UnsafeURLError

if TYPE_CHECKING:
    from pathlib import Path


def settings(tmp_path: Path) -> Settings:
    return Settings(
        _env_file=None,
        data_dir=tmp_path,
        spotify_client_id="test-app",
        spotify_client_secret=SecretStr("test-secret"),
    )


def youtube(identity: str = "aaaaaaaaaaa", duration: float = 180, title: str = "Song") -> dict:
    return {
        "provider": "youtube",
        "source_id": identity,
        "title": title,
        "artist": "Artist",
        "duration": duration,
        "thumbnail": None,
        "url": "https://www.youtube.com/watch?v=" + identity,
        "youtube_id": identity,
    }


def spotify_item(identity: str = "a" * 22, **kwargs: object) -> dict:
    return {
        "id": identity,
        "name": "Song",
        "artists": [{"name": "Artist"}],
        "duration_ms": 180000,
        "type": "track",
        **kwargs,
    }


def proxy() -> MagicMock:
    result = MagicMock()
    result.url = "http://127.0.0.1:45678"
    result.block_reason = None
    return result


class Audio(discord.AudioSource):
    def __init__(self, frames: int = 0) -> None:
        self.frames = frames
        self.cleaned = 0

    def read(self) -> bytes:
        if not self.frames:
            return b""
        self.frames -= 1
        return b"\0" * 3840

    def cleanup(self) -> None:
        self.cleaned += 1


@pytest.mark.parametrize(
    ("query", "kind", "target"),
    [
        ("Artist Song", "search", "Artist Song"),
        ("https://youtu.be/aaaaaaaaaaa?si=tracking", "track", "https://www.youtube.com/watch?v=aaaaaaaaaaa"),
        ("https://music.youtube.com/watch?v=aaaaaaaaaaa", "track", "https://www.youtube.com/watch?v=aaaaaaaaaaa"),
        ("https://youtube.com/shorts/aaaaaaaaaaa", "track", "https://www.youtube.com/watch?v=aaaaaaaaaaa"),
        (
            "https://youtube.com/watch?v=aaaaaaaaaaa&list=PL000000000000",
            "collection",
            "https://www.youtube.com/playlist?list=PL000000000000",
        ),
        ("spotify:track:" + "a" * 22, "spotify", "track/" + "a" * 22),
        ("https://open.spotify.com/intl-nl/album/" + "b" * 22 + "?si=tracking", "spotify", "album/" + "b" * 22),
    ],
)
def test_music_query_canonicalization(query: str, kind: str, target: str) -> None:
    assert source_query(query) == (kind, target)


@pytest.mark.parametrize(
    "query",
    [
        "",
        "x" * 1001,
        "file:///etc/passwd",
        "ftp://example.com/song",
        "ytsearch100000:song",
        "https://youtube.com.evil.test/watch?v=aaaaaaaaaaa",
        "https://127.0.0.1/song",
        "https://u:p@youtube.com/watch?v=aaaaaaaaaaa",
        "https://youtube.com:8080/watch?v=aaaaaaaaaaa",
        "https://youtu.be/invalid",
        "https://open.spotify.com/artist/" + "a" * 22,
        "spotify:user:private:playlist:123",
    ],
)
def test_unsupported_music_queries_are_rejected(query: str) -> None:
    with pytest.raises(ValueError, match=r"Enter|Only|Use"):
        source_query(query)


@pytest.mark.parametrize(
    "overrides",
    [
        {"duration": None},
        {"duration": 0},
        {"duration": float("nan")},
        {"duration": True},
        {"duration": 3601},
        {"is_live": True},
        {"live_status": "is_upcoming"},
        {"id": "invalid"},
    ],
)
def test_worker_excludes_unbounded_and_live_recordings(overrides: dict) -> None:
    assert metadata({"id": "aaaaaaaaaaa", "duration": 180, **overrides}, 3600) is None


def test_worker_bounds_collections_and_keeps_sound_import_policy_separate() -> None:
    downloader = MagicMock()
    downloader.__enter__.return_value = downloader
    downloader.extract_info.return_value = {
        "title": "Collection",
        "entries": [
            {"id": "aaaaaaaaaaa", "title": "A", "duration": 180, "thumbnail": "http://127.0.0.1/private"},
            {"id": "bbbbbbbbbbb", "title": "Live", "duration": 180, "is_live": True},
        ],
    }
    with (
        patch("app.music_worker.GuardedDownloader", return_value=downloader) as factory,
        patch("app.music_worker.configure_requests"),
    ):
        result = extract("https://youtube.com/playlist?list=PL0000000000", "collection", "proxy", 3600, "deno")
        assert result["unavailable"] == 1
        assert result["tracks"][0]["thumbnail"] == "https://i.ytimg.com/vi/aaaaaaaaaaa/hqdefault.jpg"
        assert factory.call_args.args[0]["noplaylist"] is False
        downloader.extract_info.return_value["entries"] *= MAX_ITEMS
        with pytest.raises(MusicWorkerError, match="1,000"):
            extract("query", "collection", "proxy", 3600, "deno")


def test_stream_worker_only_accepts_direct_audio_protocols() -> None:
    downloader = MagicMock()
    downloader.__enter__.return_value = downloader
    info = {"id": "aaaaaaaaaaa", "duration": 180, "url": "https://public.test/audio", "protocol": "https", "ext": "m4a"}
    downloader.extract_info.return_value = info
    with (
        patch("app.music_worker.GuardedDownloader", return_value=downloader),
        patch("app.music_worker.configure_requests"),
    ):
        assert extract("query", "stream", "proxy", 3600, "deno")["stream"] == info["url"]
        info["protocol"] = "m3u8_native"
        with pytest.raises(MusicWorkerError, match="direct audio"):
            extract("query", "stream", "proxy", 3600, "deno")
        info["url"] = "file:///etc/passwd"
        with pytest.raises(MusicWorkerError, match="unsupported audio destination"):
            extract("query", "stream", "proxy", 3600, "deno")


def test_metadata_reader_handles_split_chunks_and_rejects_oversized_data() -> None:
    async def verify() -> None:
        reader = AsyncMock()
        reader.read.side_effect = [b'{"track":', b' "song"}', b""]
        assert await read_json(reader) == {"track": "song"}
        reader.read.side_effect = [b"x" * (MAX_RESPONSE + 1)]
        with pytest.raises(MusicSourceError, match="too much metadata"):
            await read_json(reader)

    asyncio.run(verify())


def test_search_is_bounded_and_free_query_resolves_first_result(tmp_path: Path) -> None:
    async def verify() -> None:
        sources = MusicSources(settings(tmp_path))
        candidates = [youtube(title=str(index)) for index in range(20)]
        with patch.object(sources, "extract", new=AsyncMock(return_value={"tracks": candidates})) as worker:
            assert len(await sources.search("Artist Song")) == 10
            assert worker.call_args.args == ("ytsearch10:Artist Song", "search")
            assert (await sources.resolve("Artist Song"))["tracks"] == candidates[:1]
        await sources.close()

    asyncio.run(verify())


def test_spotify_token_is_cached_and_never_returned_with_track_metadata(tmp_path: Path) -> None:
    async def verify() -> None:
        sources = MusicSources(settings(tmp_path))
        with patch.object(
            sources, "request", new=AsyncMock(return_value={"access_token": "api-token", "expires_in": 3600})
        ) as request:
            assert await sources.access_token() == "api-token"
            assert await sources.access_token() == "api-token"
            assert request.await_count == 1
            authorization = request.call_args.kwargs["headers"]["Authorization"]
            login, password = base64.b64decode(authorization.removeprefix("Basic ")).decode().split(":", 1)
            assert login == sources.settings.spotify_client_id.get_secret_value()
            assert password == sources.settings.spotify_client_secret.get_secret_value()
        with patch.object(sources, "spotify_get", new=AsyncMock(return_value=spotify_item())):
            result = await sources.resolve("https://open.spotify.com/track/" + "a" * 22)
        assert result["tracks"][0]["provider"] == "spotify"
        assert "api-token" not in json.dumps(result)
        assert "test-secret" not in json.dumps(result)
        assert result["tracks"][0]["youtube_id"] is None
        await sources.close()

    asyncio.run(verify())


def test_spotify_playlist_uses_current_items_endpoint_and_preserves_order(tmp_path: Path) -> None:
    async def verify() -> None:
        sources = MusicSources(settings(tmp_path))
        identity = "p" * 22
        next_url = f"https://api.spotify.com/v1/playlists/{identity}/items?offset=2&limit=50"
        pages = [
            {"name": "Playlist"},
            {"items": [{"item": spotify_item()}, {"item": None}], "total": 3, "next": next_url},
            {"items": [{"item": spotify_item("b" * 22)}], "total": 3, "next": None},
        ]
        progress = MagicMock()
        with patch.object(sources, "spotify_get", new=AsyncMock(side_effect=pages)) as request:
            result = await sources.resolve("https://open.spotify.com/playlist/" + identity, progress)
        assert request.call_args_list[1].args[0] == f"playlists/{identity}/items?market=NL&limit=50"
        assert [item["source_id"] for item in result["tracks"]] == ["a" * 22, "b" * 22]
        assert result["warnings"] == ["1 unavailable or over-length songs were skipped."]
        assert progress.call_count >= 2
        await sources.close()

    asyncio.run(verify())


@pytest.mark.parametrize(
    "next_url", ["https://127.0.0.1/private", "https://evil.test/page", "http://api.spotify.com/v1/albums/a/tracks"]
)
def test_spotify_pagination_rejects_other_destinations(tmp_path: Path, next_url: str) -> None:
    async def verify() -> None:
        sources = MusicSources(settings(tmp_path))
        with (
            patch.object(
                sources,
                "spotify_get",
                new=AsyncMock(return_value={"tracks": {"total": 1, "items": [], "next": next_url}}),
            ),
            pytest.raises(MusicSourceError, match="pagination"),
        ):
            await sources.resolve("https://open.spotify.com/album/" + "a" * 22)
        await sources.close()

    asyncio.run(verify())


def test_spotify_collection_limit_and_pagination_cycle_are_bounded(tmp_path: Path) -> None:
    async def verify() -> None:
        sources = MusicSources(settings(tmp_path))
        with (
            patch.object(
                sources, "spotify_get", new=AsyncMock(return_value={"tracks": {"total": MAX_ITEMS + 1, "items": []}})
            ),
            pytest.raises(MusicSourceError, match="1,000"),
        ):
            await sources.resolve("https://open.spotify.com/album/" + "a" * 22)
        next_url = "https://api.spotify.com/v1/albums/" + "a" * 22 + "/tracks?offset=0"
        page = {"total": 0, "items": [], "next": next_url}
        with patch.object(sources, "spotify_get", new=AsyncMock(side_effect=[{"tracks": page}, page])) as request:
            with pytest.raises(MusicSourceError, match="pagination"):
                await sources.resolve("https://open.spotify.com/album/" + "a" * 22)
            assert request.await_count == 2
        await sources.close()

    asyncio.run(verify())


def test_spotify_forbidden_playlist_has_actionable_error_without_payload(tmp_path: Path) -> None:
    async def verify() -> None:
        sources = MusicSources(settings(tmp_path))
        response = MagicMock()
        response.status = HTTPStatus.FORBIDDEN
        client = MagicMock()
        client.request.return_value.__aenter__.return_value = response
        with (
            patch.object(sources, "client", new=AsyncMock(return_value=client)),
            pytest.raises(MusicSourceError, match="YouTube playlist") as error,
        ):
            await sources.request("GET", "https://api.spotify.com/v1/playlists/" + "p" * 22 + "/items")
        assert "secret" not in str(error.value)
        response.content.read.assert_not_called()
        assert client.request.call_args.kwargs["allow_redirects"] is False
        await sources.close()

    asyncio.run(verify())


def test_spotify_match_prefers_artist_title_and_duration_and_keeps_manual_choice(tmp_path: Path) -> None:
    async def verify() -> None:
        sources = MusicSources(settings(tmp_path))
        track = sources.spotify_track(spotify_item())
        candidates = [youtube("a" * 11, 300, "Song live remix"), youtube("b" * 11, 181, "Artist Song official audio")]
        with patch.object(sources, "search", new=AsyncMock(return_value=candidates)) as search:
            matched = await sources.match(track)
            assert matched["youtube_id"] == "b" * 11
            assert matched["source_id"] == track["source_id"]
            assert matched["youtube_title"] == "Artist Song official audio"
            assert await sources.match(matched) == matched
            assert search.await_count == 1
        await sources.close()

    asyncio.run(verify())


def test_spotify_match_uses_neutral_search_and_retries_without_quotes_after_rejected_candidates(tmp_path: Path) -> None:
    async def verify() -> None:
        sources = MusicSources(settings(tmp_path))
        track = sources.spotify_track(
            spotify_item(name="Round Ere", artists=[{"name": "K Motionz"}], duration_ms=274285)
        )
        mashup = {**youtube("DKWXsaZadKs", 297, "Turno - Asylum X K Motionz - Round Ere"), "artist": "DJ James W"}
        desired = {**youtube("2ZVgOWAflII", 274, "K Motionz - Round Ere"), "artist": "#alldayjumpup #"}
        with patch.object(sources, "search", new=AsyncMock(side_effect=[[mashup], [desired]])) as search:
            matched = await sources.match(track)
            assert matched["youtube_id"] == "2ZVgOWAflII"
            assert search.call_args_list[0].args == ('"K Motionz" "Round Ere"',)
            assert search.call_args_list[1].args == ("K Motionz Round Ere",)
        await sources.close()

    asyncio.run(verify())


def test_spotify_match_refuses_low_confidence_after_bounded_searches(tmp_path: Path) -> None:
    async def verify() -> None:
        sources = MusicSources(settings(tmp_path))
        candidates = [youtube("a" * 11, 180, "Artist Different Song")]
        with patch.object(sources, "search", new=AsyncMock(return_value=candidates)) as search:
            with pytest.raises(MusicSourceError, match="title, artist, version and duration") as error:
                await sources.match(sources.spotify_track(spotify_item()))
            assert search.await_count == 4
            assert error.value.details["reason"] == "match_not_found"
        await sources.close()

    asyncio.run(verify())


def test_spotify_match_only_uses_audio_fallback_after_rejecting_neutral_searches(tmp_path: Path) -> None:
    async def verify() -> None:
        sources = MusicSources(settings(tmp_path))
        desired = youtube("b" * 11, 180, "Artist Song")
        with patch.object(sources, "search", new=AsyncMock(side_effect=[[], [], [desired]])) as search:
            matched = await sources.match(sources.spotify_track(spotify_item()))
            assert matched["youtube_id"] == "b" * 11
            assert search.await_count == 3
            assert search.call_args.args == ("Artist Song audio",)
        await sources.close()

    asyncio.run(verify())


def test_forced_spotify_rematch_keeps_explicit_recording_and_original_display_title(tmp_path: Path) -> None:
    async def verify() -> None:
        sources = MusicSources(settings(tmp_path))
        track = {
            **sources.spotify_track(spotify_item()),
            "title": "Custom name",
            "original_title": "Song",
            "youtube_id": "a" * 11,
            "youtube_title": "Wrong recording",
        }
        desired = youtube("b" * 11, 180, "Artist Song")
        with patch.object(sources, "search", new=AsyncMock(return_value=[desired])) as search:
            assert await sources.match(track) == track
            matched = await sources.match(track, force=True)
            assert matched["youtube_id"] == "b" * 11
            assert matched["title"] == "Custom name"
            assert search.call_args.args == ('"Artist" "Song"',)
            locked = {**track, "match_locked": True}
            assert await sources.match(locked, force=True) == locked
            assert search.await_count == 1
            direct = youtube("c" * 11)
            assert await sources.match(direct, force=True) == direct
            assert search.await_count == 1
        await sources.close()

    asyncio.run(verify())


def test_stream_resolution_refreshes_signed_url_on_each_play_and_revalidates_duration(tmp_path: Path) -> None:
    async def verify() -> None:
        sources = MusicSources(settings(tmp_path))
        active_proxy = proxy()
        data = {"track": youtube(), "container": "webm", "stream": "https://public.test/audio?signature=first"}
        with (
            patch.object(sources, "extract", new=AsyncMock(return_value=data)) as worker,
            patch.object(sources, "open_proxy", new=AsyncMock(return_value=active_proxy)),
            patch("app.music_sources.MusicDecoder", side_effect=lambda *_args, **_kwargs: Audio(500)) as decoder,
        ):
            first = await sources.source(youtube(), 0, 0.7)
            data["stream"] = "https://public.test/audio?signature=second"
            second = await sources.source(youtube(), 60, 0.5)
            assert worker.await_count == 2
            assert "signature=first" in decoder.call_args_list[0].args[0]
            assert "signature=second" in decoder.call_args_list[1].args[0]
            assert "-http_proxy http://127.0.0.1:45678" in decoder.call_args.kwargs["before_options"]
            assert "httpproxy" in decoder.call_args.kwargs["before_options"]
            assert "file" not in decoder.call_args.kwargs["before_options"]
            assert "signature" not in json.dumps(second.music_track)
            assert first.volume == 0.7
            assert second.volume == 0.5
            data["track"]["duration"] = 3601
            with pytest.raises(MusicSourceError, match="over-length"):
                await sources.source(youtube(), 0, 0.5)
        await sources.close()
        assert all(item.done.is_set() for item in sources.audio)

    asyncio.run(verify())


def test_decoder_strips_secret_and_proxy_bypass_environment() -> None:
    arguments = ["ffmpeg", "-http_proxy", "http://127.0.0.1:45678", "-i", "https://public.test/audio?signed=private"]
    with (
        patch.dict(
            "os.environ",
            {
                "SPOTIFY_CLIENT_SECRET": "private-secret",
                "SPOTIFY_CLIENT_ID": "private-app",
                "DEEPGRAM_API_KEY": "private-key",
                "no_proxy": "*",
            },
        ),
        patch("app.music_sources.subprocess.Popen") as popen,
    ):
        MusicDecoder._spawn_process(None, arguments, stderr=subprocess.DEVNULL)
    child_environment = popen.call_args.kwargs["env"]
    assert "SPOTIFY_CLIENT_SECRET" not in child_environment
    assert "SPOTIFY_CLIENT_ID" not in child_environment
    assert "DEEPGRAM_API_KEY" not in child_environment
    assert child_environment["no_proxy"] == ""
    assert child_environment["http_proxy"] == "http://127.0.0.1:45678"
    assert environment("proxy")["NO_PROXY"] == ""


def test_early_stream_eof_is_an_error_but_natural_completion_is_not() -> None:
    failed = GuardedMusicAudio(Audio(), proxy(), youtube(duration=180), (0, 1))
    natural = GuardedMusicAudio(Audio(), proxy(), youtube(duration=1), (0, 1))
    try:
        with pytest.raises(MusicSourceError, match="fresh recording link"):
            failed.read()
        assert natural.read() == b""
        natural.proxy.block_reason = "blocked"
        with pytest.raises(MusicSourceError):
            natural.read()
    finally:
        failed.cleanup()
        natural.cleanup()
        assert failed.done.wait(3)
        assert natural.done.wait(3)


def test_audio_cleanup_is_idempotent_and_does_not_block_the_caller() -> None:
    decoder = Audio()
    started = threading.Event()
    release = threading.Event()
    active_proxy = proxy()

    def clean() -> None:
        started.set()
        release.wait(3)

    with patch.object(decoder, "cleanup", side_effect=clean) as cleanup:
        audio = GuardedMusicAudio(decoder, active_proxy, youtube(), (0, 1))
        audio.cleanup()
        assert started.wait(1)
        audio.cleanup()
        assert not audio.done.is_set()
        release.set()
        assert audio.done.wait(3)
        assert cleanup.call_count == 1
    active_proxy.__exit__.assert_called_once()


def test_cancelled_extraction_kills_worker_and_releases_proxy(tmp_path: Path) -> None:
    async def verify() -> None:
        sources = MusicSources(settings(tmp_path))
        active_proxy = proxy()
        started = asyncio.Event()

        async def read(_size: int) -> bytes:
            started.set()
            await asyncio.Future()
            return b""

        process = MagicMock()
        process.returncode = None
        process.pid = 12345
        process.stdout.read = read
        process.wait = AsyncMock(return_value=-9)
        with (
            patch.object(sources, "open_proxy", new=AsyncMock(return_value=active_proxy)),
            patch("app.music_sources.asyncio.create_subprocess_exec", new=AsyncMock(return_value=process)),
            patch("app.music_sources.os.killpg") as kill,
        ):
            task = asyncio.create_task(sources.extract("query", "search"))
            await started.wait()
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
            kill.assert_called_once_with(12345, signal.SIGKILL)
        active_proxy.__exit__.assert_called_once()
        assert not sources.children
        assert sources.pending == 0
        await sources.close()

    asyncio.run(verify())


def test_pending_resolver_work_is_bounded(tmp_path: Path) -> None:
    async def verify() -> None:
        sources = MusicSources(settings(tmp_path))
        sources.pending = MAX_PENDING
        with pytest.raises(MusicSourceError, match="resolver is busy"):
            await sources.extract("query", "search")
        await sources.close()

    asyncio.run(verify())


def test_spotify_metadata_shares_two_worker_limit_and_pending_admission(tmp_path: Path) -> None:
    async def verify() -> None:
        sources = MusicSources(settings(tmp_path))
        active = 0
        maximum = 0
        started = asyncio.Queue()
        release = asyncio.Queue()

        async def metadata(target: str, _progress: object) -> dict:
            nonlocal active, maximum
            active += 1
            maximum = max(active, maximum)
            started.put_nowait(target)
            try:
                await release.get()
            finally:
                active -= 1
            return {"title": target, "tracks": [], "warnings": []}

        with patch.object(sources, "spotify_metadata", side_effect=metadata):
            tasks = [asyncio.create_task(sources.spotify(str(index), None)) for index in range(3)]
            await started.get()
            await started.get()
            assert sources.pending == 3
            assert active == 2
            sources.pending = MAX_PENDING
            try:
                with pytest.raises(MusicSourceError, match="resolver is busy"):
                    await sources.spotify("another", None)
            finally:
                sources.pending = 3
            release.put_nowait(None)
            assert await started.get() == "2"
            release.put_nowait(None)
            release.put_nowait(None)
            assert len(await asyncio.gather(*tasks)) == 3
            assert maximum == 2
            assert sources.pending == 0
        await sources.close()

    asyncio.run(verify())


def test_spotify_admission_is_restored_when_waiting_or_active_work_is_cancelled(tmp_path: Path) -> None:
    async def verify() -> None:
        sources = MusicSources(settings(tmp_path))
        started = asyncio.Queue()

        async def metadata(target: str, _progress: object) -> dict:
            started.put_nowait(target)
            await asyncio.Future()
            return {}

        with patch.object(sources, "spotify_metadata", side_effect=metadata):
            tasks = [asyncio.create_task(sources.spotify(str(index), None)) for index in range(3)]
            await started.get()
            await started.get()
            assert sources.pending == 3
            tasks[2].cancel()
            with pytest.raises(asyncio.CancelledError):
                await tasks[2]
            assert sources.pending == 2
            for task in tasks[:2]:
                task.cancel()
            await asyncio.gather(*tasks[:2], return_exceptions=True)
            assert sources.pending == 0
            assert sources.workers._value == 2
        await sources.close()

    asyncio.run(verify())


@pytest.mark.skipif(not shutil.which("ffmpeg"), reason="FFmpeg is not installed")
def test_actual_decoder_rechecks_redirect_destinations_through_proxy(tmp_path: Path) -> None:
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args: object) -> None:
            pass

        def do_GET(self) -> None:
            self.send_response(HTTPStatus.FOUND)
            self.send_header("Location", "http://127.0.0.1/private")
            self.send_header("Content-Length", "0")
            self.end_headers()

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server_thread = threading.Thread(target=server.serve_forever, daemon=True)
    server_thread.start()
    checked = []

    def addresses(host: str, _port: int) -> list[tuple]:
        checked.append(host)
        if host != "public.test":
            message = "Blocked private destination."
            raise UnsafeURLError(message)
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", server.server_port))]

    active_proxy = DownloadProxy(100000, 20)
    active_proxy.__enter__()
    try:
        sources = MusicSources(settings(tmp_path))
        with patch("app.network.public_addresses", side_effect=addresses):
            audio = sources.create_source(
                {"stream": "http://public.test/redirect", "container": "m4a"}, active_proxy, youtube(), (0, 1)
            )
            try:
                with pytest.raises(MusicSourceError) as failure:
                    audio.read()
                assert failure.value.details["reason"] == "blocked_destination"
                assert checked == ["public.test", "127.0.0.1"]
                assert active_proxy.block_reason
                checked.clear()

                async def rejected_download() -> None:
                    result = {"stream": "http://public.test/redirect", "container": "m4a", "track": youtube()}
                    with (
                        patch.object(sources, "extract", new=AsyncMock(return_value=result)),
                        pytest.raises(MusicSourceError),
                    ):
                        await sources.download(youtube(), tmp_path / "blocked.part", 100000)
                    await sources.close()

                asyncio.run(rejected_download())
                assert checked == ["public.test", "127.0.0.1"]
            finally:
                audio.cleanup()
                assert audio.done.wait(3)
    finally:
        server.shutdown()
        server.server_close()
        server_thread.join(timeout=2)


@pytest.mark.skipif(not shutil.which("ffmpeg"), reason="FFmpeg is not installed")
def test_actual_https_decoder_uses_validated_tunnel(tmp_path: Path) -> None:
    active_proxy = DownloadProxy(100000, 20)
    active_proxy.__enter__()
    sources = MusicSources(settings(tmp_path))
    audio = sources.create_source(
        {"stream": "https://127.0.0.1/private", "container": "m4a"}, active_proxy, youtube(), (0, 1)
    )
    try:
        with pytest.raises(MusicSourceError) as failure:
            audio.read()
        assert failure.value.details["reason"] == "blocked_destination"
        assert active_proxy.block_reason
    finally:
        audio.cleanup()
        assert audio.done.wait(3)


async def encoded_audio() -> bytes:
    process = await asyncio.create_subprocess_exec(
        "ffmpeg",
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:duration=2",
        "-c:a",
        "aac",
        "-movflags",
        "frag_keyframe+empty_moov",
        "-f",
        "mp4",
        "pipe:1",
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.DEVNULL,
    )
    data, _stderr = await process.communicate()
    assert process.returncode == 0
    return data


async def cached_playback(sources: MusicSources, tmp_path: Path, data: bytes) -> None:
    path = tmp_path / "recording.audio"
    result = {"stream": "http://public.test/audio", "container": "m4a", "track": youtube(duration=2)}
    with patch.object(sources, "extract", new=AsyncMock(return_value=result)):
        entry = await sources.download(youtube(duration=2), path, 100000)
    assert entry["bytes"] == len(data)
    assert "stream" not in entry
    sources.cache = SimpleNamespace(ensure=AsyncMock(return_value={**entry, "stream": str(path)}))
    with patch.object(sources, "extract", new=AsyncMock(side_effect=AssertionError("Network used"))):
        local = await sources.source(youtube(duration=2), 0.5, 0.7)
        try:

            def read_all() -> list[bytes]:
                output = []
                while frame := local.read():
                    output.append(frame)
                return output

            output = await asyncio.to_thread(read_all)
            assert 65 <= len(output) <= 85
            assert all(len(frame) == 3840 for frame in output)
            assert local.proxy is None
        finally:
            local.cleanup()
            assert await asyncio.to_thread(local.done.wait, 3)
    await sources.close()


@pytest.mark.skipif(not shutil.which("ffmpeg"), reason="FFmpeg is not installed")
def test_actual_decoder_reads_synthetic_audio_and_seeks_without_voice(tmp_path: Path) -> None:
    data = asyncio.run(encoded_audio())

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args: object) -> None:
            pass

        def do_GET(self) -> None:
            start = int(self.headers.get("Range", "bytes=0-").removeprefix("bytes=").split("-")[0])
            payload = data[start:]
            self.send_response(HTTPStatus.PARTIAL_CONTENT if self.headers.get("Range") else HTTPStatus.OK)
            self.send_header("Content-Type", "audio/mp4")
            self.send_header("Content-Length", str(len(payload)))
            self.send_header("Content-Range", f"bytes {start}-{len(data) - 1}/{len(data)}")
            self.send_header("Accept-Ranges", "bytes")
            self.end_headers()
            self.wfile.write(payload)

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server_thread = threading.Thread(target=server.serve_forever, daemon=True)
    server_thread.start()
    active_proxy = DownloadProxy(100000, 20)
    active_proxy.__enter__()
    addresses = [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", server.server_port))]
    sources = MusicSources(settings(tmp_path))
    try:
        with patch("app.network.public_addresses", return_value=addresses):
            audio = sources.create_source(
                {"stream": "http://public.test/audio", "container": "m4a"},
                active_proxy,
                youtube(duration=2),
                (0.5, 0.7),
            )
            try:
                frames = []
                while frame := audio.read():
                    frames.append(frame)
                assert 65 <= len(frames) <= 85
                assert all(len(frame) == 3840 for frame in frames)
                assert any(any(frame) for frame in frames)
                assert active_proxy.received > len(data)
                assert not active_proxy.block_reason

                asyncio.run(cached_playback(sources, tmp_path, data))
            finally:
                audio.cleanup()
                assert audio.done.wait(3)
    finally:
        server.shutdown()
        server.server_close()
        server_thread.join(timeout=2)


def test_ambiguous_single_word_title_uses_provided_to_youtube_fallback(tmp_path: Path) -> None:
    async def verify() -> None:
        sources = MusicSources(settings(tmp_path))
        track = sources.spotify_track(spotify_item(name="One", artists=[{"name": "SOTA"}], duration_ms=271542))
        desired = {**youtube("CwMGQ_szMss", 272, "One"), "artist": "SOTA - Topic"}
        with patch.object(sources, "search", new=AsyncMock(side_effect=[[], [], [], [desired]])) as search:
            matched = await sources.match(track)
            assert matched["youtube_id"] == "CwMGQ_szMss"
            assert search.call_args.args == ('"SOTA" "One" "Provided to YouTube"',)
        await sources.close()

    asyncio.run(verify())


def test_generic_topic_channel_requires_verified_original_artist(tmp_path: Path) -> None:
    async def verify() -> None:
        sources = MusicSources(settings(tmp_path))
        track = sources.spotify_track(spotify_item(name="Let You Go", artists=[{"name": "Rova"}], duration_ms=250568))
        candidate = {**youtube("mqoeQPOSwL0", 251, "Let You Go"), "artist": "Release - Topic"}
        full = {**candidate, "artist": "Rova"}
        with (
            patch.object(sources, "search", new=AsyncMock(return_value=[candidate])),
            patch.object(sources, "resolve", new=AsyncMock(return_value={"tracks": [full]})) as resolve,
        ):
            matched = await sources.match(track)
            assert matched["youtube_id"] == "mqoeQPOSwL0"
            assert resolve.await_count == 1
        with (
            patch.object(sources, "search", new=AsyncMock(return_value=[candidate])),
            patch.object(sources, "resolve", new=AsyncMock(return_value={"tracks": [{**full, "artist": "Unrelated"}]})),
            pytest.raises(MusicSourceError, match="Choose a recording manually"),
        ):
            await sources.match(track)
        await sources.close()

    asyncio.run(verify())


def test_topic_verification_is_bounded_even_when_recordings_fail(tmp_path: Path) -> None:
    async def verify() -> None:
        sources = MusicSources(settings(tmp_path))
        track = sources.spotify_track(spotify_item())
        candidates = [{**youtube(letter * 11, 180, "Song"), "artist": "Release - Topic"} for letter in "abcd"]
        with (
            patch.object(sources, "search", new=AsyncMock(return_value=candidates)),
            patch.object(sources, "resolve", new=AsyncMock(side_effect=MusicSourceError("Unavailable"))) as resolve,
            pytest.raises(MusicSourceError),
        ):
            await sources.match(track)
        assert resolve.await_count == 2
        await sources.close()

    asyncio.run(verify())
