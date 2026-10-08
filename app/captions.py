from __future__ import annotations

import html
import json
import math
import re
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from pathlib import Path

MAX_CAPTION_BYTES = 8_000_000
MAX_CUES = 100_000
MILLISECONDS = 1000


def clean(text: str) -> str:
    return " ".join(html.unescape(re.sub(r"<[^>]*>", "", text)).split())


def timestamp(text: str) -> float:
    parts = text.replace(",", ".").split(":")
    return sum(float(value) * 60**index for index, value in enumerate(reversed(parts)))


def json_cues(data: dict) -> list[dict]:
    if not isinstance(data, dict) or not isinstance(data.get("events", []), list):
        message = "Invalid caption document."
        raise TypeError(message)
    cues = []
    for event in data.get("events", []):
        segments = event.get("segs", [])
        start = event.get("tStartMs", 0) / MILLISECONDS
        end = start + event.get("dDurationMs", 0) / MILLISECONDS
        text = clean("".join(segment.get("utf8", "") for segment in segments))
        words = []
        timed = any("tOffsetMs" in segment for segment in segments)
        for index, segment in enumerate(segments):
            if timed and clean(segment.get("utf8", "")):
                boundary = start + segment.get("tOffsetMs", 0) / MILLISECONDS
                following = segments[index + 1 :]
                stop = next(
                    (start + item["tOffsetMs"] / MILLISECONDS for item in following if "tOffsetMs" in item), end
                )
                words.append({"text": clean(segment["utf8"]), "start": boundary, "end": stop})
        cues.append({"text": text, "start": start, "end": end, "words": words})
    return cues


def text_cues(text: str) -> list[dict]:
    cues = []
    for block in re.split(r"\n\s*\n", text.replace("\r", "")):
        lines = block.splitlines()
        timing = next((index for index, line in enumerate(lines) if " --> " in line), None)
        if timing is None:
            continue
        boundaries = lines[timing].split(" --> ")
        start, end = timestamp(boundaries[0]), timestamp(boundaries[1].split()[0])
        raw = " ".join(lines[timing + 1 :])
        words = []
        inline = list(re.finditer(r"<(\d{2}:\d{2}:\d{2}\.\d{3})>", raw))
        if inline and clean(raw[: inline[0].start()]):
            words.append({"text": clean(raw[: inline[0].start()]), "start": start, "end": timestamp(inline[0][1])})
        for index, match in enumerate(inline):
            stop = inline[index + 1].start() if index + 1 < len(inline) else len(raw)
            word = clean(raw[match.end() : stop])
            if word:
                words.append(
                    {
                        "text": word,
                        "start": timestamp(match[1]),
                        "end": timestamp(inline[index + 1][1]) if index + 1 < len(inline) else end,
                    }
                )
        cues.append({"text": clean(raw), "start": start, "end": end, "words": words})
    return cues


def parse(path: Path, duration: float) -> list[dict]:
    if path.stat().st_size > MAX_CAPTION_BYTES:
        message = "Caption file exceeds the 8 MB limit."
        raise ValueError(message)
    text = path.read_text(encoding="utf-8-sig")
    cues = json_cues(json.loads(text)) if path.suffix == ".json3" else text_cues(text)
    if len(cues) > MAX_CUES:
        message = "Caption track contains too many cues."
        raise ValueError(message)
    result = []
    for cue in cues:
        if not all(math.isfinite(cue[key]) for key in ("start", "end")):
            continue
        cue["start"], cue["end"] = max(0, cue["start"]), min(duration, cue["end"])
        if not cue["text"] or cue["end"] <= cue["start"]:
            continue
        if result and result[-1]["text"] == cue["text"] and cue["start"] <= result[-1]["end"]:
            result[-1]["end"] = max(result[-1]["end"], cue["end"])
            continue
        cue["words"] = [
            {**word, "start": max(cue["start"], word["start"]), "end": min(cue["end"], word["end"])}
            for word in cue["words"]
            if all(math.isfinite(word[key]) for key in ("start", "end"))
            and min(cue["end"], word["end"]) > max(cue["start"], word["start"])
        ]
        result.append(cue)
    return result
