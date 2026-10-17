from __future__ import annotations

import base64

import pytest
from pydantic import ValidationError

from app.transcription_vocabulary import VocabularyHints, decode_hints, encode_hints


@pytest.mark.parametrize("value", ["", "Enrique\nSjoerd", "Zoë, René, café", "鄭先生"])
def test_vocabulary_transport_preserves_unicode(value: str) -> None:
    assert decode_hints(encode_hints(value)) == value


def test_vocabulary_normalizes_lines_without_changing_spelling() -> None:
    assert VocabularyHints(hints="  Zoë  \r\n\n Brr   Brr Patapim\t ").hints == "Zoë\nBrr Brr Patapim"


@pytest.mark.parametrize("value", ["x" * 501, "Name\x00", "Name\x1b"])
def test_vocabulary_rejects_unbounded_and_control_text(value: str) -> None:
    with pytest.raises(ValidationError):
        VocabularyHints(hints=value)


@pytest.mark.parametrize("value", ["!bad", "a" * 2701, base64.b64encode(b"\xff").decode(), encode_hints("x" * 501)])
def test_vocabulary_rejects_invalid_transport(value: str) -> None:
    with pytest.raises(ValueError, match=r".+"):
        decode_hints(value)
