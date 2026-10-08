from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from typing import TYPE_CHECKING

import yt_dlp
from yt_dlp.networking import Request, Response
from yt_dlp.networking.exceptions import RequestError

from app.captions import MAX_CAPTION_BYTES
from app.import_errors import download_error
from app.network import validate_url

if TYPE_CHECKING:
    from app.types import JsonObject

WORKER_ARGUMENTS = 7


def emit(data: JsonObject) -> None:
    sys.stdout.write(json.dumps(data) + "\n")
    sys.stdout.flush()


class QuietLogger:
    def debug(self, *args: object) -> None:
        pass

    warning = debug
    error = debug


class GuardedDownloader(yt_dlp.YoutubeDL):
    def urlopen(self, request: Request | str) -> Response:
        if isinstance(request, str):
            request = Request(request)
        if not isinstance(request, Request):
            msg = "This extractor uses an unsupported network request."
            raise TypeError(msg)
        validate_url(request.url)

        request.proxies = {"http": self.params["proxy"], "https": self.params["proxy"], "all": self.params["proxy"]}
        request.headers.pop("Ytdl-Request-Proxy", None)
        return super().urlopen(request)


def caption_bytes(downloader: GuardedDownloader, url: str) -> bytes:
    with downloader.urlopen(url) as response:
        data = response.read(MAX_CAPTION_BYTES + 1)
    if len(data) > MAX_CAPTION_BYTES:
        message = "Caption file exceeds the 8 MB limit."
        raise ValueError(message)
    return data


def configure_requests(downloader: GuardedDownloader) -> None:
    director = downloader._request_director
    if "Requests" not in director.handlers:
        message = "Install the requests dependency for safe source downloads."
        raise ValueError(message)
    for key in list(director.handlers):
        if key != "Requests":
            director.handlers.pop(key).close()


def validate_info(info: dict | None, maximum: float) -> None:
    if not info or info.get("_type") in ("playlist", "multi_video") or "entries" in info:
        message = "Import a single video; playlists are not supported."
        raise ValueError(message)
    if info.get("is_live") or info.get("live_status") in ("is_live", "is_upcoming", "post_live"):
        message = "Live sources are not supported."
        raise ValueError(message)
    if not info.get("duration") or not 0 < info["duration"] <= maximum:
        message = (
            f"Source duration is {info.get('duration') or 'unknown'} seconds; "
            f"the configured maximum is {maximum:g} seconds."
        )
        raise ValueError(message)
    allowed = {"http", "https", "m3u8_native", "http_dash_segments"}
    if any(item.get("protocol") not in allowed for item in (info.get("requested_formats") or [info])):
        message = "This source requires an unsupported download protocol."
        raise ValueError(message)


def download_captions(downloader: GuardedDownloader, info: dict, folder: Path) -> list[dict]:
    tracks = []
    for language in ("nl", "en"):
        track = {"language": language, "kind": "manual", "status": "missing", "cues": []}
        for category, kind in (("subtitles", "manual"), ("automatic_captions", "automatic")):
            available = info.get(category) or {}
            key = next(
                (
                    key
                    for key in (language, language + "-orig", *sorted(available))
                    if key in available and (key == language or key.startswith(language + "-"))
                ),
                None,
            )
            if key:
                choices = available[key]
                chosen = next(
                    (item for extension in ("json3", "vtt", "srt") for item in choices if item.get("ext") == extension),
                    None,
                )
                if chosen:
                    track["kind"] = kind
                    try:
                        data = caption_bytes(downloader, chosen["url"])
                        path = folder / ("caption-" + language + "." + chosen["ext"])
                        path.write_bytes(data)
                        track.update(status="downloaded", file=path.name)
                    except (yt_dlp.utils.DownloadError, RequestError, OSError, ValueError):
                        track.update(status="failed", error="Caption download failed. Redownload to retry.")
                    break
        tracks.append(track)
    return tracks


def run() -> None:
    url, destination, proxy, max_duration, max_bytes, runtime = sys.argv[1:7]
    folder = Path(destination)
    max_duration, max_bytes = float(max_duration), int(max_bytes)

    def progress(data: JsonObject) -> None:
        total = data.get("total_bytes") or data.get("total_bytes_estimate") or 0
        size = data.get("downloaded_bytes", 0)
        if size > max_bytes or (total and total > max_bytes):
            msg = "Download exceeds size limit."
            raise ValueError(msg)
        emit({"progress": min(0.9, size / total * 0.9) if total else 0.05})

    options = {
        "proxy": proxy,
        "noplaylist": True,
        "extract_flat": False,
        "enable_file_urls": False,
        "socket_timeout": 20,
        "retries": 2,
        "fragment_retries": 2,
        "concurrent_fragment_downloads": 1,
        "quiet": True,
        "no_warnings": True,
        "logger": QuietLogger(),
        "progress_hooks": [progress],
        "match_filter": None,
        "outtmpl": str(folder / "download.%(ext)s"),
        "format": (
            "bestvideo[height<=720][protocol=https]+bestaudio[protocol=https]/"
            "best[height<=720][protocol=https]/best[protocol=https]/best[protocol=http]/"
            "best[protocol=m3u8_native]/best[protocol=http_dash_segments]"
        ),
        "merge_output_format": "mp4",
        "max_filesize": max_bytes,
        "js_runtimes": {runtime: {}},
        "remote_components": set(),
        "hls_prefer_native": True,
    }
    if len(sys.argv) > WORKER_ARGUMENTS:
        discover_channel(url, options, int(sys.argv[7]))
        return
    with GuardedDownloader(options) as downloader:
        configure_requests(downloader)
        info = downloader.extract_info(url, download=False)
        if info:
            emit({"title": str(info.get("title") or "Untitled video")[:300]})
        validate_info(info, max_duration)

        downloader.process_info(info)
        tracks = download_captions(downloader, info, folder)
        paths = [
            p
            for p in folder.glob("download.*")
            if p.suffix in (".mp4", ".webm", ".mkv", ".mov", ".m4a", ".mp3", ".ogg") and ".f" not in p.stem
        ]
        if not paths:
            msg = "No media was downloaded; source may exceed the size limit."
            raise ValueError(msg)
        media = max(paths, key=lambda p: p.stat().st_size)
        emit(
            {
                "complete": True,
                "title": str(info.get("title") or "Untitled video")[:300],
                "duration": info["duration"],
                "file": media.name,
                "captions": tracks,
            }
        )


def discover_channel(url: str, options: dict, maximum: int) -> None:
    options.update(
        extract_flat="in_playlist", noplaylist=False, playlistend=maximum + 1, progress_hooks=[], match_filter=None
    )
    with GuardedDownloader(options) as downloader:
        configure_requests(downloader)
        info = downloader.extract_info(url, download=False)
        entries = info.get("entries", []) if info else []
        videos = {}
        for entry in entries:
            if not isinstance(entry, dict):
                continue
            video_id = entry.get("id") or ""
            if re.fullmatch(r"[A-Za-z0-9_-]{11}", video_id):
                videos[video_id] = {
                    "url": "https://www.youtube.com/watch?v=" + video_id,
                    "title": str(entry.get("title") or "Untitled video")[:300],
                }
        if len(videos) > maximum:
            message = "Channel exceeds MAX_CHANNEL_VIDEOS. Increase that setting and retry."
            raise ValueError(message)
        if not videos:
            message = "No public videos found on this channel."
            raise ValueError(message)
        emit(
            {
                "complete": True,
                "title": str(info.get("title") or "YouTube channel")[:300],
                "videos": list(videos.values()),
            }
        )


if __name__ == "__main__":
    try:
        run()
    except (yt_dlp.utils.DownloadError, RequestError, ValueError, TypeError, OSError, RuntimeError) as exc:
        safe = str(exc) if isinstance(exc, ValueError) else download_error(str(exc))
        emit({"diagnostic": str(exc)[:8000]})
        emit({"error": safe})
        sys.exit(1)
