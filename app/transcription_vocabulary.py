from __future__ import annotations

import base64

from pydantic import BaseModel, Field, field_validator

MAX_VOCABULARY_CHARACTERS = 500
VOCABULARY_HEADER = "X-Transcription-Vocabulary"
MAX_VOCABULARY_HEADER_LENGTH = 2700


class VocabularyHints(BaseModel):
    hints: str = Field(max_length=MAX_VOCABULARY_CHARACTERS)

    @field_validator("hints")
    @classmethod
    def normalize(cls, value: str) -> str:
        if any(not char.isprintable() and char not in "\n\r\t" for char in value):
            message = "Vocabulary hints must contain ordinary text and line breaks."
            raise ValueError(message)
        return "\n".join(" ".join(line.split()) for line in value.splitlines() if line.strip())


def encode_hints(value: str) -> str:
    return base64.b64encode(value.encode()).decode("ascii")


def decode_hints(value: str) -> str:
    if len(value) > MAX_VOCABULARY_HEADER_LENGTH:
        message = "Vocabulary header is too large."
        raise ValueError(message)
    return VocabularyHints(hints=base64.b64decode(value, validate=True).decode()).hints
