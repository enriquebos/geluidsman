from __future__ import annotations

import math
import re
import unicodedata
from dataclasses import dataclass
from difflib import SequenceMatcher

MIN_TITLE_RECALL = 0.85
MIN_TITLE_PRECISION = 0.65
MIN_TITLE_SIMILARITY = 0.90
MIN_MATCH_SCORE = 0.78
MAX_DURATION_RATIO = 0.08
MIN_DURATION_WINDOW = 3.0
MAX_DURATION_WINDOW = 35.0
MIN_ARTIST_COVERAGE = 0.8
MAX_CANDIDATES = 40
DISPLAY_WORDS = frozenset(
    {"official", "audio", "video", "music", "lyric", "lyrics", "visualizer", "visualiser", "hd", "hq", "4k", "full"}
)
VERSION_WORDS = frozenset(
    {
        "remix",
        "vip",
        "live",
        "acoustic",
        "instrumental",
        "cover",
        "karaoke",
        "nightcore",
        "mashup",
        "bootleg",
        "edit",
        "dub",
        "rework",
        "flip",
        "remake",
        "demo",
    }
)
GENERIC_WORDS = frozenset({"original", "mix", "version", "the", "topic", "records", "recordings"})
ARTIST_CONNECTORS = frozenset({"and", "x", "vs", "with"})
FEATURED = re.compile(r"\b(?:feat(?:uring)?|ft)\b[^)\]]*?(?=\s[-\u2013\u2014]\s|[)\]]|$)", re.IGNORECASE)
REMASTER = re.compile(r"\b(?:\d{4}\s+)?remaster(?:ed)?(?:\s+\d{4})?\b", re.IGNORECASE)
PROMOTIONAL_LABELS = frozenset({"free download", "out now", "premiere", "exclusive premiere"})


def normalized(value: str) -> str:
    folded = unicodedata.normalize("NFKD", value.casefold()).replace("&", " and ")
    folded = "".join(character for character in folded if not unicodedata.combining(character))
    folded = re.sub("['\\u2019`\\u02bc]", "", folded)
    return " ".join(re.findall(r"[^\W_]+", folded))


def artists(value: str) -> list[str]:
    return [item for part in value.split(",") if (item := normalized(part))]


def title_words(value: str, performers: list[str], preserve: frozenset[str] = frozenset()) -> list[str]:
    title = normalized(REMASTER.sub("", FEATURED.sub("", value)))
    previous = title
    for artist in sorted(performers, key=len, reverse=True):
        artist_pattern = r"\s*".join(re.escape(word) for word in artist.split())
        title = re.sub(r"\b" + artist_pattern + r"\b", " ", title)
    ignored = (DISPLAY_WORDS | GENERIC_WORDS) - preserve
    words = [word for word in title.split() if word not in ignored]
    if title != previous:
        connectors = ARTIST_CONNECTORS - preserve
        while words and words[0] in connectors:
            words.pop(0)
        while words and words[-1] in connectors:
            words.pop()
    return words or title.split()


def artist_present(artist: str, text: str) -> bool:
    if re.search(r"\b" + re.escape(artist) + r"\b", text):
        return True
    words = set(artist.split()) - GENERIC_WORDS
    found = set(text.split())
    return bool(words) and (len(words & found) / len(words) >= MIN_ARTIST_COVERAGE or "".join(artist.split()) in found)


def versions(value: str) -> set[str]:
    text = normalized(value)
    found = set(text.split()) & VERSION_WORDS
    for label, patterns in (
        ("sped_up", ("sped up", "speed up", "speedup")),
        ("slowed", ("slowed", "slow reverb")),
        ("extended", ("extended", "12 inch")),
        ("radio_edit", ("radio edit", "radio mix")),
    ):
        if any(re.search(r"\b" + pattern + r"\b", text) for pattern in patterns):
            found.add(label)
    return found


def version_descriptors(value: str) -> dict[str, str]:
    result = {}
    value = re.sub(r"\[([^\[\]]+)\](?=\s*(?:&|and\b|x\b|remix\b))", r"\1", FEATURED.sub("", value))
    segments = re.split(r"\s[-\u2013\u2014]\s|[()[\]]", value)
    for segment in segments[1:]:
        words = normalized(segment).split()
        for version in {"remix", "bootleg", "edit", "rework"} & set(words):
            label = [word for word in words[: words.index(version)] if word not in DISPLAY_WORDS | GENERIC_WORDS]
            if label:
                result[version] = " ".join(label)
    return result


@dataclass(frozen=True)
class RecordingMatch:
    track: dict
    score: float
    title_score: float
    duration_difference: float
    artist_channel: bool


def recording_title(track: dict, candidate: dict, performers: list[str]) -> str:
    title = str(candidate.get("title") or "")
    album = normalized(str(track.get("album") or ""))
    metadata = PROMOTIONAL_LABELS | {album, normalized(str(candidate.get("artist") or ""))}
    parts = title.split("|")
    publisher = normalized(parts[-1])
    channel = normalized(str(candidate.get("artist") or ""))
    publisher_credit = (
        publisher.endswith((" records", " recordings")) and channel and artist_present(channel, publisher)
    )
    if len(parts) > 1 and (all(normalized(part) in metadata for part in parts[1:]) or publisher_credit):
        title = parts[0]
    title = re.sub(
        r"\(([^()]*)\)|\[([^\[\]]*)\]",
        lambda match: "" if normalized(match[1] or match[2]) in metadata else match[0],
        title,
    )
    credit = re.split(r"\s[-\u2013\u2014]\s", title, maxsplit=1)
    if len(credit) > 1 and performers and artist_present(performers[0], normalized(credit[0])):
        title = credit[1]
    return title.strip()


def recording_match(track: dict, candidate: dict) -> RecordingMatch | None:
    performers = artists(str(track.get("artist") or ""))
    title = str(track.get("original_title") or track.get("title") or "")
    expected = title_words(title, performers)
    actual = title_words(recording_title(track, candidate, performers), performers, frozenset(expected))
    if not expected or not actual:
        return None
    overlap = len(set(expected) & set(actual))
    recall = overlap / len(set(expected))
    precision = overlap / len(set(actual))
    similarity = SequenceMatcher(None, " ".join(expected), " ".join(actual), autojunk=False).ratio()
    if (
        ((recall < MIN_TITLE_RECALL or precision < MIN_TITLE_PRECISION) and similarity < MIN_TITLE_SIMILARITY)
        or versions(title) != versions(str(candidate.get("title") or ""))
        or ("x" in actual and "x" not in expected)
        or any(
            version_descriptors(str(candidate.get("title") or "")).get(version) != label
            for version, label in version_descriptors(title).items()
        )
    ):
        return None
    actual_text = normalized(f"{candidate.get('title') or ''} {candidate.get('artist') or ''}")
    if not performers or not artist_present(performers[0], actual_text):
        return None
    requested_duration = float(track.get("duration") or 0)
    actual_duration = float(candidate.get("duration") or 0)
    difference = abs(actual_duration - requested_duration)
    window = min(MAX_DURATION_WINDOW, max(MIN_DURATION_WINDOW, requested_duration * MAX_DURATION_RATIO))
    if (
        not all(math.isfinite(value) and value > 0 for value in (requested_duration, actual_duration))
        or difference > window
    ):
        return None
    title_score = (2 * precision * recall / max(precision + recall, 1)) * 0.6 + similarity * 0.4
    performer_score = sum(artist_present(artist, actual_text) for artist in performers) / len(performers)
    channel = normalized(str(candidate.get("artist") or ""))
    artist_channel = bool(channel) and artist_present(performers[0], channel)
    score = title_score * 0.65 + performer_score * 0.15 + (1 - difference / window) * 0.15
    if artist_channel:
        score += 0.05
    if score < MIN_MATCH_SCORE:
        return None
    return RecordingMatch(candidate, score, title_score, difference, artist_channel)


def choose_recording(track: dict, candidates: list[dict]) -> RecordingMatch | None:
    matches = [matched for candidate in candidates[:MAX_CANDIDATES] if (matched := recording_match(track, candidate))]
    return max(matches, key=lambda match: (match.score, -match.duration_difference), default=None)


def matching_queries(track: dict) -> tuple[str, ...]:
    title = str(track.get("original_title") or track.get("title") or "").replace('"', " ").strip()
    performer = str(track.get("artist") or "").split(",", 1)[0].replace('"', " ").strip()
    core_title = re.sub(r"\(\s*\)|\[\s*\]", "", FEATURED.sub("", title)).strip()
    queries = f'"{performer}" "{title}"', f"{track.get('artist') or ''} {title}", f"{performer} {core_title} audio"
    if len(normalized(core_title).split()) == 1:
        return (*queries, f'"{performer}" "{title}" "Provided to YouTube"')
    return queries
