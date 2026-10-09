from __future__ import annotations

import json
import sys
from types import SimpleNamespace
from typing import TYPE_CHECKING
from unittest.mock import Mock

import pytest

from app import transcription_models as models

if TYPE_CHECKING:
    from pathlib import Path


def fake_conversion(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> tuple[Mock, Mock]:
    monkeypatch.setattr(models, "MODEL_CACHE", tmp_path)
    download = Mock(return_value="snapshot")
    converter = Mock()

    def convert(output: str, *, quantization: str) -> None:
        assert quantization == "float16"
        path = tmp_path / output
        path.mkdir(parents=True)
        for name in ("model.bin", "config.json", "preprocessor_config.json"):
            (path / name).write_bytes(b"converted")

    converter.return_value.convert.side_effect = convert
    tokenizer = Mock()
    tokenizer.from_pretrained.return_value.save_pretrained.side_effect = lambda output: (
        output / "tokenizer.json"
    ).write_text("{}", encoding="utf-8")
    monkeypatch.setitem(sys.modules, "ctranslate2.converters", SimpleNamespace(TransformersConverter=converter))
    monkeypatch.setitem(sys.modules, "huggingface_hub", SimpleNamespace(snapshot_download=download))
    monkeypatch.setitem(sys.modules, "transformers", SimpleNamespace(AutoTokenizer=tokenizer))
    return converter, download


def test_conversion_is_pinned_and_cached(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    converter, download = fake_conversion(monkeypatch, tmp_path)
    result = models.convert_dutch_model()
    assert result == models.model_path(models.DUTCH_MODEL)
    assert models.model_path("large-v3") == "large-v3"
    download.assert_called_once_with(
        models.DUTCH_MODEL,
        revision=models.DUTCH_REVISION,
        cache_dir=str(tmp_path / "hub"),
        allow_patterns=["*.json", "*.txt", "*.safetensors"],
    )
    converter.assert_called_once_with("snapshot", copy_files=["preprocessor_config.json"], load_as_float16=True)
    assert models.convert_dutch_model() == result
    converter.assert_called_once()
    assert (
        json.loads((tmp_path / result / "ready.json").read_text(encoding="utf-8"))["revision"] == models.DUTCH_REVISION
    )


def test_failed_conversion_leaves_no_active_partial_model(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    converter, _download = fake_conversion(monkeypatch, tmp_path)
    converter.return_value.convert.side_effect = RuntimeError("Conversion failed")
    with pytest.raises(RuntimeError, match="Conversion failed"):
        models.convert_dutch_model()
    assert not (tmp_path / "converted" / models.model_path(models.DUTCH_MODEL)).exists()
    assert not list((tmp_path / "converted").glob("conversion-*"))
