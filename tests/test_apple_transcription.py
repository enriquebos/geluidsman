from __future__ import annotations

import sys
from types import SimpleNamespace
from unittest.mock import Mock

import numpy as np
import pytest

from app import apple_transcription
from app.apple_transcription import AppleModel, download_apple_model


def test_apple_download_rejects_unsupported_model(monkeypatch: pytest.MonkeyPatch) -> None:
    download = Mock()
    monkeypatch.setitem(sys.modules, "huggingface_hub", SimpleNamespace(snapshot_download=download))
    with pytest.raises(ValueError, match="not supported"):
        download_apple_model("untrusted/arbitrary-model")
    download.assert_not_called()


@pytest.mark.parametrize("language", ["nl", "auto"])
def test_apple_pcm_precision_and_quiet_decoding(monkeypatch: pytest.MonkeyPatch, language: str) -> None:
    monkeypatch.setattr(apple_transcription, "has_speech", lambda _pcm: True)
    inference = Mock(return_value={"text": " hello ", "language": "nl"})
    monkeypatch.setitem(sys.modules, "mlx_whisper", SimpleNamespace(transcribe=inference))
    model = object.__new__(AppleModel)
    model.path = "cached-model"
    pcm = np.array([-32768, 0, 32767], dtype=np.int16).tobytes()
    assert model.recognize(pcm, language) == {"text": "hello", "language": "nl"}
    audio = inference.call_args.args[0]
    np.testing.assert_array_equal(audio, np.array([-1, 0, 32767 / 32768], dtype=np.float32))
    options = inference.call_args.kwargs
    assert options["language"] == (None if language == "auto" else "nl")
    assert options["verbose"] is None
    assert options["fp16"]
    assert not options["condition_on_previous_text"]
    assert options["temperature"] == 0
    inference.return_value = {"text": "foreign speech", "language": "fr"}
    assert model.recognize(pcm, "auto")["text"] == ""


def test_apple_download_uses_pinned_revision_and_cache(monkeypatch: pytest.MonkeyPatch) -> None:
    download = Mock(return_value="cached-model")
    monkeypatch.setitem(sys.modules, "huggingface_hub", SimpleNamespace(snapshot_download=download))
    monkeypatch.setenv("TRANSCRIPTION_MODEL_CACHE", "private-cache")
    assert download_apple_model("large-v3-turbo") == "cached-model"
    assert download.call_args.args == ("mlx-community/whisper-large-v3-turbo",)
    assert download.call_args.kwargs["cache_dir"] == "private-cache"
    assert download.call_args.kwargs["revision"] == "a4aaeec0636e6fef84abdcbe3544cb2bf7e9f6fb"


def test_silence_and_short_audio_skip_gpu_inference() -> None:
    model = object.__new__(AppleModel)
    model.decode = Mock()
    for pcm in (bytes(32000), bytes(2)):
        assert model.recognize(pcm, "auto") == {"text": "", "language": "nl"}
    model.decode.assert_not_called()
