from __future__ import annotations

import asyncio
import contextlib
import json
import math
import os
import re
import shlex
import signal
import subprocess
import sys
import threading
import time
from http import HTTPStatus
from typing import TYPE_CHECKING
from urllib.parse import parse_qs

import aiohttp
import discord

from app.music_buffer import FRAME_SECONDS, MusicBuffer
from app.music_diagnostics import MusicSourceError, classify_failure, source_error
from app.music_matching import RecordingMatch, choose_recording, matching_queries, normalized, recording_match
from app.network import DownloadProxy, validate_url

if TYPE_CHECKING:
    from collections.abc import Callable
    from pathlib import Path
    from typing import BinaryIO

    from app.config import Settings
    from app.music_cache import MusicCache

MAX_ITEMS = 1000
MAX_QUERY = 1000
MAX_PAGES = 25
SEARCH_RESULTS = 10
TOPIC_VERIFICATIONS = 2
MAX_RESPONSE = 2_000_000
EXTRACTION_TIMEOUT = 90
EXTRACTION_BYTES = 64_000_000
MAX_ACTIVE_SOURCES = 8
MAX_PENDING = 16
MAX_TOKEN_BYTES = 4096
DOWNLOAD_CHUNK_BYTES = 1_048_576
END_TOLERANCE = 3.0
SPOTIFY_ORIGIN = "https://api.spotify.com/v1/"
SPOTIFY_ID = re.compile(r"[A-Za-z0-9]{22}")
YOUTUBE_ID = re.compile(r"[A-Za-z0-9_-]{11}")


def environment(proxy: str) -> dict[str, str]:
    result = {
        key: value
        for key, value in os.environ.items()
        if not any(
            part in key.upper() for part in ("TOKEN", "SECRET", "PASSWORD", "KEY", "DATABASE_URL", "SPOTIFY_CLIENT_ID")
        )
    }
    for key in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"):
        result[key] = proxy
    result["NO_PROXY"] = result["no_proxy"] = ""
    return result


def youtube_url(identity: str) -> str:
    if not YOUTUBE_ID.fullmatch(identity):
        message = "Use a valid YouTube recording."
        raise MusicSourceError(message)
    return "https://www.youtube.com/watch?v=" + identity


def spotify_target(path: str) -> tuple[str, str]:
    match = re.fullmatch(r"(?:intl-[^/]+/)?(track|album|playlist)/([A-Za-z0-9]{22})", path.strip("/"))
    if match:
        return "spotify", match[1] + "/" + match[2]
    message = "Use a Spotify track, album, or public playlist link."
    raise MusicSourceError(message)


def youtube_target(host: str, path: str, query: str) -> tuple[str, str]:
    values = parse_qs(query)
    playlist = values.get("list", [""])[0]
    if playlist and re.fullmatch(r"[A-Za-z0-9_-]{10,100}", playlist):
        return "collection", "https://www.youtube.com/playlist?list=" + playlist
    identity = values.get("v", [""])[0]
    if host == "youtu.be":
        identity = path.strip("/")
    elif path.startswith(("/shorts/", "/embed/", "/live/")):
        identity = path.split("/")[2]
    return "track", youtube_url(identity)


def source_query(query: str) -> tuple[str, str]:
    query = query.strip()
    if not query or len(query) > MAX_QUERY:
        message = "Enter a song, artist, or YouTube/Spotify link using at most 1,000 characters."
        raise MusicSourceError(message)
    if query.startswith("spotify:"):
        return spotify_target(query.removeprefix("spotify:").replace(":", "/"))
    if not re.match(r"(?i)^https?://", query):
        if re.match(r"^[\w+.-]+:", query) or query.startswith(("/", "\\")):
            message = "Only YouTube and Spotify music links are supported."
            raise MusicSourceError(message)
        return "search", query
    parsed = validate_url(query)
    if parsed.hostname == "open.spotify.com":
        return spotify_target(parsed.path)
    if parsed.hostname in ("youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be"):
        return youtube_target(parsed.hostname, parsed.path, parsed.query)
    message = "Only YouTube and Spotify music links are supported."
    raise MusicSourceError(message)


async def read_json(reader: aiohttp.StreamReader | asyncio.StreamReader) -> dict:
    chunks = []
    received = 0
    while chunk := await reader.read(65536):
        received += len(chunk)
        if received > MAX_RESPONSE:
            message = "The music source returned too much metadata."
            raise MusicSourceError(message)
        chunks.append(chunk)
    result = json.loads(b"".join(chunks))
    if not isinstance(result, dict):
        message = "The music source returned unsupported metadata."
        raise MusicSourceError(message)
    return result


class MusicDecoder(discord.FFmpegPCMAudio):
    def _spawn_process(self, args: list[str], **kwargs: object) -> subprocess.Popen:
        proxy = args[args.index("-http_proxy") + 1] if "-http_proxy" in args else ""
        if self is not None:
            kwargs["stderr"] = subprocess.PIPE
            self.music_error: MusicSourceError | None = None
            self.stderr_done = threading.Event()
            self.diagnostic_details = {"reason": "source_unavailable"}
        process = subprocess.Popen(
            args,
            creationflags=0x08000000 if os.name == "nt" else 0,
            env=environment(proxy),
            **kwargs,
        )
        if self is not None:
            self.diagnostic_worker = threading.Thread(
                target=self.consume_stderr, args=(process,), daemon=True, name="music-decoder-diagnostics"
            )
            self.diagnostic_worker.start()
        return process

    def consume_stderr(self, process: subprocess.Popen) -> None:
        tail = b""
        try:
            if process.stderr:
                while chunk := process.stderr.read(4096):
                    tail = (tail + chunk)[-8192:]
                    details = classify_failure(tail.decode("utf-8", errors="replace"))
                    if details["reason"] != "source_unavailable":
                        self.diagnostic_details = details
        except (OSError, ValueError):
            pass
        finally:
            if process.stderr:
                process.stderr.close()
            self.stderr_done.set()

    def _check_process_returncode(self) -> None:
        process = getattr(self, "_process", None)
        if not process or getattr(self, "_stopped", False):
            return
        code = process.poll()
        if code is None:
            try:
                code = process.wait(timeout=0.2)
            except subprocess.TimeoutExpired:
                return
        self.stderr_done.wait(0.2)
        if code:
            details = self.diagnostic_details
            reason = details["reason"] if details["reason"] != "source_unavailable" else "decoder_exit"
            self.music_error = source_error(
                reason, **{key: value for key, value in details.items() if key != "reason"}, decoder_exit=code
            )
            self._current_error = self.music_error


class GuardedMusicAudio(discord.AudioSource):
    def __init__(self, decoder: discord.AudioSource, proxy: DownloadProxy | None, track: dict, playback: tuple) -> None:
        position, volume = playback
        remaining = max(0.0, track["duration"] - position)
        self.buffer = MusicBuffer(decoder, remaining, proxy, track.get("youtube_id") or track.get("source_id") or "")
        self.decoder = discord.PCMVolumeTransformer(self.buffer, volume=volume)
        self.proxy = proxy
        self.music_track = track
        self.done = threading.Event()
        self.lock = threading.Lock()
        self.cleaning = False
        self.buffer.prepare()

    @property
    def played_seconds(self) -> float:
        return self.buffer.played * FRAME_SECONDS

    @property
    def starved_seconds(self) -> float:
        return self.buffer.silent * FRAME_SECONDS

    def check_prepared(self) -> None:
        with self.buffer.condition:
            if self.buffer.error and not self.buffer.queue:
                raise self.buffer.error

    @property
    def volume(self) -> float:
        return self.decoder.volume

    @volume.setter
    def volume(self, value: float) -> None:
        self.decoder.volume = value

    def read(self) -> bytes:
        if self.proxy and self.proxy.block_reason:
            msg = "blocked_destination"
            raise source_error(msg, youtube_id=self.music_track.get("youtube_id"))
        return self.decoder.read()

    def is_opus(self) -> bool:
        return False

    def cleanup(self) -> None:
        with self.lock:
            if self.cleaning:
                return
            self.cleaning = True
        threading.Thread(target=self.finish, daemon=True, name="music-audio-cleanup").start()

    def finish(self) -> None:
        try:
            self.decoder.cleanup()
        finally:
            try:
                if self.proxy:
                    self.proxy.__exit__()
            finally:
                self.done.set()


class MusicSources:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.workers = asyncio.Semaphore(2)
        self.children: set[asyncio.subprocess.Process] = set()
        self.audio: set[GuardedMusicAudio] = set()
        self.http: aiohttp.ClientSession | None = None
        self.token = ""
        self.expires = 0.0
        self.token_lock = asyncio.Lock()
        self.closed = False
        self.pending = 0
        self.cache: MusicCache | None = None

    async def open_proxy(self, byte_limit: int, lifetime: int) -> DownloadProxy:
        def start() -> DownloadProxy:
            proxy = DownloadProxy(byte_limit, lifetime)
            proxy.__enter__()
            return proxy

        task = asyncio.create_task(asyncio.to_thread(start))
        try:
            return await asyncio.shield(task)
        except asyncio.CancelledError:
            proxy = await task
            await asyncio.to_thread(proxy.__exit__)
            raise

    async def extract(self, query: str, mode: str) -> dict:
        if self.pending >= MAX_PENDING:
            message = "The music resolver is busy. Wait for an import or search to finish and retry."
            raise MusicSourceError(message)
        self.pending += 1
        try:
            return await self.extract_limited(query, mode)
        finally:
            self.pending -= 1

    @staticmethod
    def kill(process: asyncio.subprocess.Process) -> None:
        if process.returncode is None:
            with contextlib.suppress(ProcessLookupError):
                if os.name == "nt":
                    process.kill()
                else:
                    os.killpg(process.pid, signal.SIGKILL)

    async def extract_limited(self, query: str, mode: str) -> dict:
        async with self.workers:
            if self.closed:
                message = "The music resolver is shutting down."
                raise MusicSourceError(message)
            proxy = await self.open_proxy(EXTRACTION_BYTES, EXTRACTION_TIMEOUT)
            process = None
            try:
                process = await asyncio.create_subprocess_exec(
                    sys.executable,
                    "-m",
                    "app.music_worker",
                    query,
                    mode,
                    proxy.url,
                    str(self.settings.max_source_seconds),
                    self.settings.js_runtime,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.DEVNULL,
                    limit=MAX_RESPONSE,
                    env=environment(proxy.url),
                    creationflags=0x08000000 if os.name == "nt" else 0,
                    start_new_session=os.name != "nt",
                )
                self.children.add(process)
                async with asyncio.timeout(EXTRACTION_TIMEOUT):
                    result = await read_json(process.stdout)
                    await process.wait()
                if proxy.block_reason:
                    msg = "blocked_destination"
                    raise source_error(msg)
                if process.returncode:
                    msg = "worker_exit"
                    raise source_error(msg)
                if result.get("error"):
                    details = result.get("diagnostic")
                    details = details if isinstance(details, dict) else {}
                    raise MusicSourceError(str(result["error"])[:500], **details)
            except TimeoutError as exc:
                msg = "extraction_timeout"
                raise source_error(msg) from exc
            except (OSError, json.JSONDecodeError) as exc:
                msg = "network_error"
                raise source_error(msg) from exc
            finally:
                if process:
                    self.kill(process)
                    await process.wait()
                    self.children.discard(process)
                await asyncio.to_thread(proxy.__exit__)
            return result

    async def search(self, query: str) -> list[dict]:
        kind, target = source_query(query)
        if kind != "search":
            return (await self.resolve(query))["tracks"][:SEARCH_RESULTS]
        result = await self.extract(f"ytsearch{SEARCH_RESULTS}:" + target, "search")
        return result.get("tracks", [])[:SEARCH_RESULTS]

    def prioritize(self, tracks: list[dict]) -> None:
        if self.cache:
            self.cache.prioritize(tracks)

    async def resolve(self, query: str, progress: Callable[[int, int], None] | None = None) -> dict:
        kind, target = source_query(query)
        if kind == "spotify":
            result = await self.spotify(target, progress)
        elif kind == "search":
            tracks = await self.search(target)
            result = {"title": target[:300], "tracks": tracks[:1], "warnings": []}
        else:
            result = await self.extract(target, kind)
            unavailable = int(result.pop("unavailable", 0))
            result["warnings"] = (
                [f"{unavailable} unavailable, live, or over-length recordings were skipped."] if unavailable else []
            )
        if not result["tracks"]:
            message = "No playable songs were found. Live recordings and songs without a known duration are excluded."
            raise MusicSourceError(message)
        if progress:
            progress(len(result["tracks"]), len(result["tracks"]))
        return result

    async def client(self) -> aiohttp.ClientSession:
        if self.closed:
            message = "The music resolver is shutting down."
            raise MusicSourceError(message)
        if not self.http or self.http.closed:
            self.http = aiohttp.ClientSession(
                timeout=aiohttp.ClientTimeout(total=20), connector=aiohttp.TCPConnector(limit=2), trust_env=False
            )
        return self.http

    async def request(self, method: str, url: str, **kwargs: object) -> dict:
        parsed = validate_url(url)
        if parsed.scheme != "https" or parsed.hostname not in ("api.spotify.com", "accounts.spotify.com"):
            message = "Spotify returned an unsupported API destination."
            raise MusicSourceError(message)
        client = await self.client()
        try:
            async with client.request(method, url, allow_redirects=False, **kwargs) as response:
                if response.status in (HTTPStatus.UNAUTHORIZED, HTTPStatus.FORBIDDEN):
                    message = (
                        "Spotify refused access to this source. Some public playlists require account access "
                        "that app credentials cannot provide. Use a YouTube playlist link instead."
                        if "/playlists/" in url
                        else "Spotify refused access. Check the server's Spotify credentials and API access."
                    )
                    raise MusicSourceError(message, reason="authentication_required", http_status=response.status)
                if response.status == HTTPStatus.TOO_MANY_REQUESTS:
                    message = "Spotify is rate limiting requests. Wait a moment and retry."
                    raise MusicSourceError(message, reason="rate_limited", http_status=response.status)
                if response.status != HTTPStatus.OK:
                    message = "Spotify could not load this source. It may be unavailable in the configured market."
                    details = classify_failure(f"HTTP status {response.status}")
                    raise MusicSourceError(message, **details)
                return await read_json(response.content)
        except TimeoutError as exc:
            reason = "network_timeout"
            raise source_error(reason) from exc
        except (aiohttp.ClientError, json.JSONDecodeError) as exc:
            message = "Spotify could not be reached. Check the server connection and retry."
            raise MusicSourceError(message, reason="network_error") from exc

    async def access_token(self) -> str:
        async with self.token_lock:
            if self.token and self.expires > time.monotonic():
                return self.token
            identity = self.settings.spotify_client_id.get_secret_value()
            secret = self.settings.spotify_client_secret.get_secret_value()
            if not identity or not secret:
                message = "Spotify links require SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET on the server."
                raise MusicSourceError(message)
            result = await self.request(
                "POST",
                "https://accounts.spotify.com/api/token",
                headers={"Authorization": aiohttp.encode_basic_auth(identity, secret)},
                data={"grant_type": "client_credentials"},
            )
            token = result.get("access_token")
            expiry = result.get("expires_in", 0)
            if (
                not isinstance(token, str)
                or not 0 < len(token) <= MAX_TOKEN_BYTES
                or not isinstance(expiry, (int, float))
                or not math.isfinite(expiry)
                or expiry <= 0
            ):
                message = "Spotify did not provide a valid application access token."
                raise MusicSourceError(message)
            self.token = token
            self.expires = time.monotonic() + min(expiry, 3600) - 30
            return self.token

    async def spotify_get(self, path: str) -> dict:
        token = await self.access_token()
        return await self.request("GET", SPOTIFY_ORIGIN + path, headers={"Authorization": "Bearer " + token})

    def spotify_track(self, value: dict, album: dict | None = None) -> dict | None:
        identity = value.get("id") or ""
        duration = value.get("duration_ms")
        if (
            not SPOTIFY_ID.fullmatch(str(identity))
            or value.get("type") not in (None, "track")
            or value.get("is_local")
            or value.get("is_playable") is False
            or not isinstance(duration, (float, int))
            or not math.isfinite(duration)
            or not 0 < duration <= self.settings.max_source_seconds * 1000
        ):
            return None
        images = (value.get("album") or album or {}).get("images") or []
        thumbnail = images[0].get("url") if images else None
        if thumbnail:
            try:
                validate_url(thumbnail)
            except ValueError:
                thumbnail = None
        return {
            "provider": "spotify",
            "source_id": identity,
            "title": str(value.get("name") or "Untitled song")[:300],
            "artist": ", ".join(str(item.get("name") or "") for item in value.get("artists", []))[:300],
            "album": str((value.get("album") or album or {}).get("name") or "")[:300] or None,
            "duration": duration / 1000,
            "thumbnail": thumbnail,
            "url": "https://open.spotify.com/track/" + identity,
            "youtube_id": None,
        }

    async def spotify(self, target: str, progress: Callable[[int, int], None] | None) -> dict:
        if self.pending >= MAX_PENDING:
            message = "The music resolver is busy. Wait for an import or search to finish and retry."
            raise MusicSourceError(message)
        self.pending += 1
        try:
            async with self.workers:
                if self.closed:
                    message = "The music resolver is shutting down."
                    raise MusicSourceError(message)
                return await self.spotify_metadata(target, progress)
        finally:
            self.pending -= 1

    async def spotify_metadata(self, target: str, progress: Callable[[int, int], None] | None) -> dict:
        kind, identity = target.split("/")
        plural = {"track": "tracks", "album": "albums", "playlist": "playlists"}[kind]
        market = self.settings.spotify_market
        info = await self.spotify_get(f"{plural}/{identity}?market={market}")
        if kind == "track":
            track = self.spotify_track(info)
            return {"title": info.get("name", "Spotify"), "tracks": [track] if track else [], "warnings": []}
        page = info.get("items" if kind == "playlist" else "tracks") or info.get("tracks") or {}
        endpoint = f"{plural}/{identity}/" + ("items" if kind == "playlist" else "tracks")
        if not isinstance(page, dict) or "items" not in page:
            page = await self.spotify_get(f"{endpoint}?market={market}&limit=50")
        tracks, unavailable = await self.spotify_pages(page, endpoint, kind, info, progress)
        return {
            "title": str(info.get("name") or "Spotify playlist")[:300],
            "tracks": tracks,
            "warnings": [f"{unavailable} unavailable or over-length songs were skipped."] if unavailable else [],
        }

    def spotify_entries(self, page: dict, kind: str, album: dict) -> tuple[list[dict], int]:
        tracks = []
        entries = page.get("items", [])
        if not isinstance(entries, list):
            message = "Spotify returned unsupported collection metadata."
            raise MusicSourceError(message)
        for item in entries:
            value = item.get("track", item.get("item")) if kind == "playlist" and isinstance(item, dict) else item
            track = self.spotify_track(value, album) if isinstance(value, dict) else None
            if track:
                tracks.append(track)
        return tracks, len(entries)

    async def spotify_pages(
        self, page: dict, endpoint: str, kind: str, album: dict, progress: Callable[[int, int], None] | None
    ) -> tuple[list[dict], int]:
        tracks = []
        processed = 0
        seen = set()
        while True:
            total = page.get("total", 0)
            accepted, count = self.spotify_entries(page, kind, album)
            processed += count
            if not isinstance(total, int) or not 0 <= total <= MAX_ITEMS or processed > MAX_ITEMS:
                message = "Collections can contain at most 1,000 songs."
                raise MusicSourceError(message)
            tracks.extend(accepted)
            if progress:
                progress(processed, max(processed, total))
            next_page = page.get("next")
            if not next_page:
                break
            parsed = validate_url(next_page)
            allowed = {"/v1/" + endpoint}
            if kind == "playlist":
                allowed.add("/v1/" + endpoint.removesuffix("items") + "tracks")
            if (
                parsed.scheme != "https"
                or parsed.hostname != "api.spotify.com"
                or parsed.path not in allowed
                or next_page in seen
                or len(seen) >= MAX_PAGES
            ):
                message = "Spotify returned an unsupported pagination link."
                raise MusicSourceError(message)
            seen.add(next_page)
            page = await self.spotify_get(parsed.path.removeprefix("/v1/") + "?" + parsed.query)
        return tracks, processed - len(tracks)

    async def match(self, track: dict, *, force: bool = False) -> dict:
        result = dict(track)
        if result.get("youtube_id") and (not force or result.get("match_locked")):
            youtube_url(result["youtube_id"])
            return result
        if result.get("provider") == "youtube":
            youtube_url(result["source_id"])
            result["youtube_id"] = result["source_id"]
            return result
        if result.get("provider") != "spotify":
            message = "This music provider is not supported."
            raise MusicSourceError(message)
        candidates: dict[str, dict] = {}
        chosen = None
        for query in matching_queries(track):
            for candidate in await self.search(query[:MAX_QUERY]):
                candidates.setdefault(candidate["youtube_id"], candidate)
            chosen = choose_recording(track, list(candidates.values()))
            if chosen:
                break
        if not chosen:
            chosen = await self.verify_topic_matches(track, list(candidates.values()))
        if not chosen:
            message = (
                "No sufficiently close YouTube recording matched this Spotify song's "
                "title, artist, version and duration. "
                "Choose a recording manually."
            )
            raise MusicSourceError(message, reason="match_not_found")
        result.update(youtube_id=chosen.track["youtube_id"], youtube_title=chosen.track["title"])
        return result

    async def verify_topic_matches(self, track: dict, candidates: list[dict]) -> RecordingMatch | None:
        verified = []
        attempts = 0
        for candidate in candidates:
            if not normalized(str(candidate.get("artist") or "")).endswith(" topic"):
                continue
            if recording_match(track, {**candidate, "artist": track.get("artist", "")}) is None:
                continue
            attempts += 1
            try:
                result = await self.resolve(youtube_url(candidate["youtube_id"]))
                verified.extend(
                    value for value in result.get("tracks", []) if value.get("youtube_id") == candidate["youtube_id"]
                )
            except MusicSourceError:
                pass
            if attempts >= TOPIC_VERIFICATIONS:
                break
        return choose_recording(track, verified)

    def stream_metadata(self, result: dict, matched: dict, position: float) -> None:
        actual = result["track"]
        duration = actual.get("duration")
        if (
            not isinstance(duration, (int, float))
            or not math.isfinite(duration)
            or not 0 < duration <= self.settings.max_source_seconds
            or position >= duration
            or actual.get("source_id") != matched["youtube_id"]
        ):
            message = "This recording is unavailable, over-length, or shorter than the playback position."
            raise MusicSourceError(message)
        validate_url(result["stream"])
        if result.get("container") not in ("webm", "m4a"):
            message = "This recording has no supported direct audio stream."
            raise MusicSourceError(message)
        matched.update(youtube_id=actual["source_id"], youtube_title=actual["title"], duration=duration)

    async def download(self, track: dict, path: Path, byte_limit: int) -> dict:
        matched = await self.match(track)
        result = await self.recording(matched)
        self.stream_metadata(result, matched, 0)
        overhead = max(65536, math.ceil(byte_limit / DOWNLOAD_CHUNK_BYTES) * 8192)
        proxy = await self.open_proxy(byte_limit + overhead, 600)
        try:
            received = await self.download_stream(result["stream"], path, proxy, byte_limit)
            await self.verify_download(path, matched["duration"])
            return {"track": matched, "container": result["container"], "bytes": received}
        except MusicSourceError as exc:
            raise MusicSourceError(str(exc), **{**exc.details, "youtube_id": matched["youtube_id"]}) from exc
        except TimeoutError as exc:
            msg = "network_timeout"
            raise source_error(msg, youtube_id=matched["youtube_id"]) from exc
        except (aiohttp.ClientError, OSError) as exc:
            reason = "blocked_destination" if proxy.block_reason else "network_error"
            raise source_error(reason, youtube_id=matched["youtube_id"]) from exc
        finally:
            await asyncio.to_thread(proxy.__exit__)

    @staticmethod
    async def download_stream(url: str, path: Path, proxy: DownloadProxy, byte_limit: int) -> int:
        timeout = aiohttp.ClientTimeout(total=600, sock_read=20)
        async with asyncio.timeout(600), aiohttp.ClientSession(timeout=timeout, trust_env=False) as client:
            file = path.open("wb")
            try:
                received, total, validator = 0, None, None
                while total is None or received < total:
                    headers = {"Range": f"bytes={received}-{received + DOWNLOAD_CHUNK_BYTES - 1}"}
                    if validator:
                        headers["If-Range"] = validator[1]
                    async with client.get(url, proxy=proxy.url, headers=headers, auto_decompress=False) as response:
                        expected, total = MusicSources.download_range(response, received, total, byte_limit)
                        validator = MusicSources.download_validator(response, validator)
                        received += await MusicSources.download_response(
                            response, file, byte_limit - received, expected
                        )
                        if response.status == HTTPStatus.OK:
                            break
            finally:
                await asyncio.to_thread(file.close)
            if not received or proxy.block_reason:
                raise source_error("blocked_destination" if proxy.block_reason else "early_eof")
            return received

    @staticmethod
    def download_range(
        response: aiohttp.ClientResponse, offset: int, total: int | None, byte_limit: int
    ) -> tuple[int | None, int | None]:
        if response.status == HTTPStatus.OK and offset == 0:
            length = response.content_length
            if length is None or 0 < length <= byte_limit:
                return length, length
            msg = "storage_limit" if length and length > byte_limit else "invalid_media"
            raise source_error(msg)
        if response.status != HTTPStatus.PARTIAL_CONTENT:
            if response.status == HTTPStatus.OK:
                msg = "invalid_media"
                raise source_error(msg)
            details = classify_failure(f"HTTP status {response.status}")
            raise source_error(details.pop("reason"), **details)
        match = re.fullmatch(r"bytes (\d+)-(\d+)/(\d+)", response.headers.get("Content-Range", ""))
        if not match:
            msg = "invalid_media"
            raise source_error(msg)
        start, end, size = map(int, match.groups())
        if size > byte_limit:
            msg = "storage_limit"
            raise source_error(msg)
        length = end - start + 1
        if (
            start != offset
            or size <= offset
            or end != min(size - 1, offset + DOWNLOAD_CHUNK_BYTES - 1)
            or (total is not None and size != total)
            or response.content_length not in (None, length)
        ):
            msg = "invalid_media"
            raise source_error(msg)
        return length, size

    @staticmethod
    def download_validator(
        response: aiohttp.ClientResponse, previous: tuple[str, str] | None
    ) -> tuple[str, str] | None:
        if previous:
            if response.headers.get(previous[0]) != previous[1]:
                msg = "invalid_media"
                raise source_error(msg)
            return previous
        etag = response.headers.get("ETag", "")
        if re.fullmatch(r'"[^"\r\n]*"', etag):
            return "ETag", etag
        modified = response.headers.get("Last-Modified")
        return ("Last-Modified", modified) if modified else None

    @staticmethod
    async def download_response(
        response: aiohttp.ClientResponse, file: BinaryIO, byte_limit: int, expected: int | None
    ) -> int:
        count = 0
        async for chunk in response.content.iter_chunked(262144):
            count += len(chunk)
            if count > byte_limit:
                msg = "storage_limit"
                raise source_error(msg)
            if expected is not None and count > expected:
                msg = "invalid_media"
                raise source_error(msg)
            task = asyncio.create_task(asyncio.to_thread(file.write, chunk))
            try:
                await asyncio.shield(task)
            except asyncio.CancelledError:
                await task
                raise
        if expected is not None and count != expected:
            msg = "early_eof"
            raise source_error(msg)
        return count

    async def verify_download(self, path: Path, duration: float) -> None:
        process = await asyncio.create_subprocess_exec(
            self.settings.ffprobe_path,
            "-v",
            "error",
            "-protocol_whitelist",
            "file",
            "-show_entries",
            "format=duration:stream=codec_type",
            "-of",
            "json",
            str(path),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
            env=environment(""),
            creationflags=0x08000000 if os.name == "nt" else 0,
            start_new_session=os.name != "nt",
        )
        try:
            async with asyncio.timeout(20):
                info = await read_json(process.stdout)
                await process.wait()
            actual = float(info.get("format", {}).get("duration", 0))
            if (
                process.returncode
                or not math.isfinite(actual)
                or abs(actual - duration) > END_TOLERANCE
                or not any(stream.get("codec_type") == "audio" for stream in info.get("streams", []))
            ):
                message = "The downloaded recording is incomplete or has no usable audio."
                raise MusicSourceError(message, reason="invalid_media")
        except (ValueError, KeyError, TypeError) as exc:
            message = "The downloaded recording could not be verified."
            raise MusicSourceError(message, reason="invalid_media") from exc
        finally:
            self.kill(process)
            await process.wait()

    def create_local_source(self, result: dict, playback: tuple) -> GuardedMusicAudio:
        position, volume = playback
        before = shlex.join(
            [
                "-nostdin",
                "-protocol_whitelist",
                "file",
                "-f",
                "matroska" if result["container"] == "webm" else "mov",
                "-ss",
                str(position),
            ]
        )
        decoder = MusicDecoder(
            result["stream"],
            executable=self.settings.ffmpeg_path,
            before_options=before,
            options="-vn -sn -dn -t " + str(result["track"]["duration"] - position),
        )
        return GuardedMusicAudio(decoder, None, result["track"], (position, max(0.0, min(volume, 2.0))))

    async def local_audio(self, local: dict, position: float, volume: float) -> GuardedMusicAudio:
        if position >= local["track"]["duration"]:
            message = "Choose a playback position before the end of the cached recording."
            raise MusicSourceError(message)
        task = asyncio.create_task(asyncio.to_thread(self.create_local_source, local, (position, volume)))
        try:
            source = await asyncio.shield(task)
        except asyncio.CancelledError:
            source = await task
            source.cleanup()
            self.audio.add(source)
            raise
        except (OSError, discord.DiscordException) as exc:
            reason = "decoder_start"
            raise source_error(reason) from exc
        self.audio.add(source)
        try:
            source.check_prepared()
        except MusicSourceError:
            source.cleanup()
            raise
        if self.closed:
            source.cleanup()
            message = "The music player is shutting down."
            raise MusicSourceError(message)
        return source

    def create_source(self, result: dict, proxy: DownloadProxy, matched: dict, playback: tuple) -> GuardedMusicAudio:
        position, volume = playback
        before = shlex.join(
            [
                "-nostdin",
                "-protocol_whitelist",
                "http,https,tcp,tls,httpproxy",
                "-http_proxy",
                proxy.url,
                "-rw_timeout",
                "15000000",
                "-f",
                "matroska" if result["container"] == "webm" else "mov",
                "-ss",
                str(position),
            ]
        )
        decoder = MusicDecoder(
            result["stream"],
            executable=self.settings.ffmpeg_path,
            before_options=before,
            options="-vn -sn -dn -t " + str(matched["duration"] - position),
        )
        return GuardedMusicAudio(decoder, proxy, matched, (position, max(0.0, min(volume, 2.0))))

    async def source(self, track: dict, position: float, volume: float) -> GuardedMusicAudio:
        if not math.isfinite(position) or position < 0 or not math.isfinite(volume):
            message = "Invalid music playback position or volume."
            raise MusicSourceError(message)
        self.audio = {item for item in self.audio if not item.done.is_set()}
        if self.closed or len(self.audio) >= MAX_ACTIVE_SOURCES:
            message = "The music player is busy or shutting down."
            raise MusicSourceError(message)
        local = await self.cache.ensure(track) if self.cache else None
        if local:
            return await self.local_audio(local, position, volume)
        matched = await self.match(track)
        result = await self.recording(matched)
        self.stream_metadata(result, matched, position)
        duration = matched["duration"]
        proxy = await self.open_proxy(self.settings.max_import_bytes, int(duration - position) + 120)
        task = asyncio.create_task(asyncio.to_thread(self.create_source, result, proxy, matched, (position, volume)))
        try:
            source = await asyncio.shield(task)
        except asyncio.CancelledError:
            try:
                source = await task
            except (OSError, discord.DiscordException):
                await asyncio.to_thread(proxy.__exit__)
            else:
                source.cleanup()
                self.audio.add(source)
            raise
        except (OSError, discord.DiscordException) as exc:
            await asyncio.to_thread(proxy.__exit__)
            reason = "decoder_start"
            raise source_error(reason) from exc
        self.audio.add(source)
        try:
            source.check_prepared()
        except MusicSourceError:
            source.cleanup()
            raise
        if self.closed:
            source.cleanup()
            message = "The music player is shutting down."
            raise MusicSourceError(message)
        return source

    async def recording(self, matched: dict) -> dict:
        try:
            return await self.extract(youtube_url(matched["youtube_id"]), "stream")
        except MusicSourceError as exc:
            raise MusicSourceError(str(exc), **{**exc.details, "youtube_id": matched["youtube_id"]}) from exc

    async def close(self) -> None:
        self.closed = True
        for process in tuple(self.children):
            self.kill(process)
        if self.children:
            await asyncio.gather(*(process.wait() for process in tuple(self.children)))
        for source in self.audio:
            source.cleanup()
        if self.audio:
            await asyncio.gather(*(asyncio.to_thread(source.done.wait, 5) for source in self.audio))
        if self.http:
            await self.http.close()
        self.token = ""
