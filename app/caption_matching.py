from __future__ import annotations

import re
import unicodedata
from difflib import SequenceMatcher

MIN_FUZZY_LENGTH = 4
LONG_WORD_LENGTH = 8
MIN_SIMILARITY = 0.72


def normalize(text: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFD", text.casefold()) if not unicodedata.combining(c))


def search_tokens(text: str) -> list[str]:
    return [normalize(match.group()) for match in re.finditer(r"\w+", text)]


def token_score(query: str, word: str, *, last: bool) -> float | None:
    if query == word:
        return 0
    if last and word.startswith(query):
        return 0.1
    if len(query) < MIN_FUZZY_LENGTH or abs(len(query) - len(word)) > (2 if len(query) >= LONG_WORD_LENGTH else 1):
        return None
    ratio = SequenceMatcher(None, query, word, autojunk=False).ratio()
    return 1 - ratio if ratio >= MIN_SIMILARITY else None


def caption_match(text: str, query: list[str]) -> tuple[float, int, int] | None:
    words = list(re.finditer(r"\w+", text))
    best = None
    for index in range(len(words) - len(query) + 1):
        selected = words[index : index + len(query)]
        scores = [
            token_score(token, normalize(word.group()), last=i == len(query) - 1)
            for i, (token, word) in enumerate(zip(query, selected, strict=True))
        ]
        if any(score is None for score in scores):
            continue
        match = (sum(scores), selected[0].start(), selected[-1].end())
        if best is None or match[0] < best[0]:
            best = match
    return best
