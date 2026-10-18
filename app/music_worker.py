from __future__ import annotations

import json
import math
import re
import sys

import yt_dlp
from yt_dlp.networking.exceptions import RequestError

from app.download_worker import GuardedDownloader, configure_requests
from app.music_diagnostics import MusicSourceError, classify_failure, source_error
from app.network import validate_url

MAX_ITEMS = 1000
MAX_TEXT = 300


class MusicWorkerError(MusicSourceError):
    pass


class DiagnosticLogger:
    def __init__(self) -> None:
        self.reasons: dict[str, int] = {}

    def debug(self, _message: str) -> None:
        pass

    def warning(self, _message: str) -> None:
        pass

    def error(self, message: str) -> None:
        reason = classify_failure(message)["reason"]
        self.reasons[reason] = min(MAX_ITEMS, self.reasons.get(reason, 0) + 1)


def metadata(info: dict, maximum: float) -> dict | None:
    identity = str(info.get("id") or "")
    duration = info.get("duration")
    if not re.fullmatch(r"[A-Za-z0-9_-]{11}", identity):
        return None
    if (
        isinstance(duration, bool)
        or not isinstance(duration, (float, int))
        or not math.isfinite(duration)
        or not 0 < duration <= maximum
        or info.get("is_live")
        or info.get("live_status") in ("is_live", "is_upcoming", "post_live")
    ):
        return None
    return {
        "provider": "youtube",
        "source_id": identity,
        "title": str(info.get("title") or "Untitled song")[:MAX_TEXT],
        "artist": str(info.get("artist") or info.get("uploader") or info.get("channel") or "")[:MAX_TEXT],
        "duration": float(duration),
        "thumbnail": "https://i.ytimg.com/vi/" + identity + "/hqdefault.jpg",
        "url": "https://www.youtube.com/watch?v=" + identity,
        "youtube_id": identity,
    }


def extract(query: str, mode: str, proxy: str, maximum: float, runtime: str) -> dict:
    logger = DiagnosticLogger()
    options = {
        "proxy": proxy,
        "noplaylist": mode != "collection",
        "extract_flat": "in_playlist" if mode in ("search", "collection") else False,
        "enable_file_urls": False,
        "socket_timeout": 15,
        "retries": 1,
        "extractor_retries": 1,
        "quiet": True,
        "no_warnings": True,
        "logger": logger,
        "ignoreerrors": mode == "collection",
        "playlistend": MAX_ITEMS + 1,
        "skip_download": True,
        "format": "bestaudio[protocol=https][ext=webm]/bestaudio[protocol=https][ext=m4a]",
        "js_runtimes": {runtime: {}},
        "remote_components": set(),
        "cachedir": False,
    }
    with GuardedDownloader(options) as downloader:
        configure_requests(downloader)
        info = downloader.extract_info(query, download=False)
    if not isinstance(info, dict):
        message = "YouTube could not find an available recording."
        raise MusicWorkerError(message)
    if mode == "stream":
        track = metadata(info, maximum)
        url = info.get("url")
        if not track:
            message = "This recording is live, unavailable, or exceeds the configured duration limit."
            raise MusicWorkerError(message, reason="duration_limit")
        try:
            validate_url(url or "")
        except ValueError as exc:
            message = "This recording returned an unsupported audio destination."
            raise MusicWorkerError(message, reason="blocked_destination") from exc
        if info.get("protocol") not in ("http", "https") or info.get("ext") not in ("webm", "m4a"):
            message = "This recording has no supported direct audio stream."
            raise MusicWorkerError(message, reason="unsupported_format")
        return {"track": track, "stream": url, "container": info["ext"]}
    entries = info.get("entries") if mode in ("search", "collection") else [info]
    if not isinstance(entries, list):
        entries = list(entries or [])
    if len(entries) > MAX_ITEMS:
        message = "Collections can contain at most 1,000 songs."
        raise MusicWorkerError(message)
    tracks = []
    unavailable = 0
    for entry in entries:
        track = metadata(entry, maximum) if isinstance(entry, dict) else None
        if track:
            tracks.append(track)
        else:
            unavailable += 1
    return {
        "title": str(info.get("title") or "YouTube")[:MAX_TEXT],
        "tracks": tracks,
        "unavailable": unavailable,
        "unavailable_reasons": logger.reasons,
    }


def main() -> None:
    query, mode, proxy, maximum, runtime = sys.argv[1:]
    try:
        result = extract(query, mode, proxy, float(maximum), runtime)
    except MusicWorkerError as exc:
        result = {"error": str(exc), "diagnostic": exc.details}
    except (yt_dlp.utils.DownloadError, RequestError, OSError, TypeError, RuntimeError, ValueError) as exc:
        details = classify_failure(str(exc))
        error = source_error(details.pop("reason"), **details)
        result = {"error": str(error), "diagnostic": error.details}
    sys.stdout.write(json.dumps(result))
    sys.stdout.flush()


if __name__ == "__main__":
    main()
