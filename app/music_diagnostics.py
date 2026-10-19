from __future__ import annotations

import logging
import re
from errno import EACCES, ENOSPC, EROFS

MAX_DIAGNOSTIC = 8192
MIN_HTTP_ERROR = 400
MAX_HTTP_ERROR = 599
MAX_PROCESS_EXIT = 255
HTTP_STATUS = re.compile(r"(?:http(?:\s+error)?|server returned|status(?:\s+code)?)\D{0,16}([45]\d\d)", re.IGNORECASE)
REASONS = {
    "match_not_found": "No sufficiently close YouTube recording matched this Spotify song's title",
    "age_restricted": "YouTube requires age verification",
    "authentication_required": "YouTube requires sign-in for this recording. Choose another recording.",
    "country_restricted": "This recording is unavailable in the server's country. Choose another recording.",
    "private_recording": "This YouTube recording is private. Choose another recording.",
    "copyright_restricted": "This recording is blocked because of a copyright restriction. Choose another recording.",
    "bot_check": "YouTube requires a sign-in check for the server connection. Retry later or choose another recording.",
    "recording_removed": "This YouTube recording was removed. Choose another recording.",
    "rate_limited": "The music source is rate limiting requests. Wait a moment and retry.",
    "http_forbidden": "The music source refused access to this recording. Retry or choose another recording.",
    "http_not_found": "The music recording could not be found. Choose another recording.",
    "http_error": "The music source returned an HTTP error. Retry or choose another recording.",
    "network_timeout": "The music source timed out. Check the connection and retry.",
    "network_error": "The music source could not be reached. Check the connection and retry.",
    "unsupported_format": "This recording has no supported audio format. Choose another recording.",
    "invalid_media": "The recording contains invalid or incomplete audio. Retry or choose another recording.",
    "source_unavailable": "YouTube could not load this recording. It may be unavailable or require sign-in.",
    "duration_limit": "This recording is live, unavailable, or exceeds the configured duration limit.",
    "blocked_destination": "The music source used a blocked destination or exceeded its download budget.",
    "extraction_timeout": "The music source could not be loaded in time. Retry or choose another recording.",
    "worker_exit": "The music source resolver stopped unexpectedly. Retry or choose another recording.",
    "decoder_exit": "The audio decoder stopped unexpectedly. Retry or choose another recording.",
    "early_eof": "The music stream ended before the recording finished. Retry to obtain a fresh recording link.",
    "buffer_timeout": "The music stream stalled. Retry playback to obtain a fresh recording link.",
    "decoder_start": "The music decoder could not start. Check FFmpeg and retry.",
    "storage_limit": "The recording exceeds the remaining music cache storage.",
}


class MusicSourceError(ValueError):
    def __init__(self, message: str, **details: object) -> None:
        super().__init__(message)
        self.details = safe_details(details)


def safe_details(details: dict) -> dict:
    reason = details.get("reason")
    result = {"reason": reason if isinstance(reason, str) and reason in REASONS else "source_unavailable"}
    status = details.get("http_status")
    if isinstance(status, int) and MIN_HTTP_ERROR <= status <= MAX_HTTP_ERROR:
        result["http_status"] = status
    identity = details.get("youtube_id")
    if isinstance(identity, str) and re.fullmatch(r"[A-Za-z0-9_-]{11}", identity):
        result["youtube_id"] = identity
    code = details.get("decoder_exit")
    if isinstance(code, int) and -MAX_PROCESS_EXIT <= code <= MAX_PROCESS_EXIT:
        result["decoder_exit"] = code
    return result


def classify_failure(detail: str) -> dict:
    value = detail[:MAX_DIAGNOSTIC].casefold()
    found = HTTP_STATUS.search(value)
    status = int(found[1]) if found else None
    patterns = (
        ("age_restricted", ("age-restricted", "age restricted", "confirm your age", "age verification")),
        (
            "country_restricted",
            ("not available in your country", "not made this video available in your country", "geo restricted"),
        ),
        ("private_recording", ("private video", "video is private", "private recording")),
        ("copyright_restricted", ("copyright claim", "copyright grounds", "copyright restriction")),
        (
            "recording_removed",
            ("video has been removed", "video was removed", "removed by the uploader", "account has been terminated"),
        ),
        ("rate_limited", ("too many requests", "rate limit", "http error 429")),
        ("bot_check", ("not a bot", "automated requests")),
        (
            "authentication_required",
            ("sign in", "sign-in", "login required", "members-only", "not a bot", "authentication"),
        ),
        ("network_timeout", ("timed out", "timeout", "connection time out")),
        ("unsupported_format", ("requested format is not available", "no supported", "unsupported codec")),
        ("invalid_media", ("invalid data found", "moov atom not found", "error while decoding", "invalid packet")),
        (
            "network_error",
            (
                "connection reset",
                "network is unreachable",
                "connection refused",
                "name resolution",
                "temporary failure",
            ),
        ),
    )
    reason = next((reason for reason, terms in patterns if any(term in value for term in terms)), None)
    if reason is None:
        reason = {
            401: "authentication_required",
            403: "http_forbidden",
            404: "http_not_found",
            410: "recording_removed",
            429: "rate_limited",
        }.get(status, "http_error" if status else "source_unavailable")
    return safe_details({"reason": reason, "http_status": status})


def source_error(reason: str, **details: object) -> MusicSourceError:
    safe = safe_details({"reason": reason, **details})
    return MusicSourceError(REASONS[safe["reason"]], **safe)


def log_music_failure(track: dict, error: BaseException | None, stage: str) -> None:
    details = safe_details(error.details if isinstance(error, MusicSourceError) else {})
    if isinstance(error, OSError):
        details["reason"] = "storage_limit" if error.errno in {ENOSPC, EACCES, EROFS} else "network_error"
    identity = track.get("youtube_id") or (track.get("source_id") if track.get("provider") == "youtube" else None)
    if isinstance(identity, str) and re.fullmatch(r"[A-Za-z0-9_-]{11}", identity):
        details.setdefault("youtube_id", identity)
    provider = track.get("provider") if track.get("provider") in {"youtube", "spotify"} else "unknown"
    source_id = track.get("source_id")
    pattern = r"[A-Za-z0-9_-]{11}" if provider == "youtube" else r"[A-Za-z0-9]{22}"
    if isinstance(source_id, str) and re.fullmatch(pattern, source_id):
        details["source_id"] = source_id
    stage = stage if stage in {"resolve", "playback", "cache", "search", "import"} else "resolve"
    fields = " ".join(f"{key}={value}" for key, value in details.items())
    logging.getLogger("app.music").warning("Music %s failed: provider=%s %s", stage, provider, fields)
