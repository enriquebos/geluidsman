from __future__ import annotations

import importlib
import os
from pathlib import Path

import numpy as np

APPLE_MODELS = {
    "large-v3-turbo": ("mlx-community/whisper-large-v3-turbo", "a4aaeec0636e6fef84abdcbe3544cb2bf7e9f6fb"),
    "large-v3": ("mlx-community/whisper-large-v3-mlx", "49e6aa286ad60c14352c404340ded53710378a11"),
}


def download_apple_model(name: str) -> str:
    from huggingface_hub import snapshot_download

    if name not in APPLE_MODELS:
        message = "This model is not supported by the Apple GPU backend."
        raise ValueError(message)
    cache = Path(os.environ.get("TRANSCRIPTION_MODEL_CACHE", "data/models/apple"))
    return snapshot_download(
        APPLE_MODELS[name][0],
        revision=APPLE_MODELS[name][1],
        cache_dir=str(cache),
        allow_patterns=["config.json", "weights.npz", "*.safetensors"],
    )


def has_speech(pcm: bytes) -> bool:
    import webrtcvad

    vad = webrtcvad.Vad(2)
    frame_bytes = 640
    return any(
        vad.is_speech(pcm[offset : offset + frame_bytes], 16000)
        for offset in range(0, len(pcm) - frame_bytes + 1, frame_bytes)
    )


class AppleModel:
    def __init__(self, name: str) -> None:
        import mlx.core as mx

        if not mx.metal.is_available():
            message = "Apple GPU transcription requires native macOS on Apple Silicon."
            raise RuntimeError(message)
        mx.set_default_device(mx.gpu)
        self.path = download_apple_model(name)
        module = importlib.import_module("mlx_whisper.transcribe")
        module.ModelHolder.model = None
        mx.clear_cache()
        model = module.ModelHolder.get_model(self.path, mx.float16)
        mx.eval(model.parameters())
        self.decode(np.zeros(16000, dtype=np.float32), "nl")

    def recognize(self, pcm: bytes, language: str) -> dict:
        if not has_speech(pcm):
            return {"text": "", "language": "nl" if language == "auto" else language}
        audio = np.frombuffer(pcm, dtype=np.int16).astype(np.float32) / 32768
        return self.decode(audio, language)

    def decode(self, audio: np.ndarray, language: str) -> dict:
        import mlx_whisper

        result = mlx_whisper.transcribe(
            audio,
            path_or_hf_repo=self.path,
            language=None if language == "auto" else language,
            task="transcribe",
            temperature=0.0,
            condition_on_previous_text=False,
            verbose=None,
            fp16=True,
            no_speech_threshold=0.6,
        )
        detected = result["language"]
        text = result["text"].strip()[:4000] if detected in {"nl", "en"} else ""
        return {"text": text, "language": detected}
