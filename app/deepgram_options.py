from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

MAX_TERM_LENGTH = 100
MAX_SEARCH_TERMS = 50
MAX_REPLACEMENTS = 20


def clean_term(value: str) -> str:
    if any(not char.isprintable() for char in value):
        message = "Use ordinary text without control characters."
        raise ValueError(message)
    return " ".join(value.split())


class Replacement(BaseModel):
    model_config = ConfigDict(extra="forbid")
    find: str = Field(min_length=1, max_length=100)
    replacement: str = Field(max_length=100)

    @field_validator("find", "replacement")
    @classmethod
    def normalize(cls, value: str) -> str:
        value = clean_term(value)
        if ":" in value:
            message = "Find and replacement terms cannot contain colons."
            raise ValueError(message)
        return value

    @field_validator("find")
    @classmethod
    def lowercase_find(cls, value: str) -> str:
        if not value:
            message = "Enter a word or phrase to find."
            raise ValueError(message)
        return value.lower()


class DeepgramOptions(BaseModel):
    model_config = ConfigDict(extra="forbid")
    smart_format: bool = False
    interim_results: bool = True
    utterance_end: bool = True
    utterance_end_ms: int = Field(1000, ge=1000, le=5000)
    endpointing: bool = True
    endpointing_ms: int = Field(300, ge=0, le=5000)
    keyterm_prompting: bool = True
    diarization: bool = False
    diarize_model: Literal["latest", "v1"] = "latest"
    punctuate: bool = True
    profanity_filter: bool = False
    redaction: Literal["off", "numbers", "aggressive_numbers", "pci", "pii"] = "off"
    find_replace: bool = False
    replacements: list[Replacement] = Field(default_factory=list, max_length=MAX_REPLACEMENTS)
    search: bool = False
    search_terms: list[str] = Field(default_factory=list, max_length=MAX_SEARCH_TERMS)
    vad_events: bool = False
    dictation: bool = False
    numerals: bool = False

    @field_validator("search_terms")
    @classmethod
    def normalize_terms(cls, values: list[str]) -> list[str]:
        terms = list(dict.fromkeys(clean_term(value) for value in values if value.strip()))
        if any(len(value) > MAX_TERM_LENGTH for value in terms):
            message = "Search terms must be at most 100 characters."
            raise ValueError(message)
        return terms
