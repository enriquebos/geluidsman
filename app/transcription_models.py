from __future__ import annotations

import json
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Literal

from pydantic import BaseModel

DUTCH_MODEL = "yuriyvnv/whisper-large-v3-high-mixed-nl"
DUTCH_REVISION = "8975a419ff1300e407ef6ae00b70d756fc9a65d2"
ModelName = Literal["large-v3-turbo", "large-v3", "yuriyvnv/whisper-large-v3-high-mixed-nl"]


class ModelSelection(BaseModel):
    model: ModelName


MODEL_CACHE = Path("/models")


def model_path(name: str) -> str:
    if name != DUTCH_MODEL:
        return name
    return str(MODEL_CACHE / "converted" / f"whisper-large-v3-high-mixed-nl-{DUTCH_REVISION}")


def convert_dutch_model() -> str:
    target = Path(model_path(DUTCH_MODEL))
    required = ("model.bin", "config.json", "tokenizer.json", "preprocessor_config.json", "ready.json")
    if all((target / name).is_file() for name in required):
        return str(target)
    from ctranslate2.converters import TransformersConverter
    from huggingface_hub import snapshot_download
    from transformers import AutoTokenizer

    source = snapshot_download(
        DUTCH_MODEL,
        revision=DUTCH_REVISION,
        cache_dir=str(MODEL_CACHE / "hub"),
        allow_patterns=["*.json", "*.txt", "*.safetensors"],
    )
    target.parent.mkdir(parents=True, exist_ok=True)
    with TemporaryDirectory(prefix="conversion-", dir=target.parent) as temporary:
        output = Path(temporary) / "model"
        converter = TransformersConverter(source, copy_files=["preprocessor_config.json"], load_as_float16=True)
        converter.convert(str(output), quantization="float16")
        AutoTokenizer.from_pretrained(source, local_files_only=True).save_pretrained(output)
        required = ("model.bin", "config.json", "tokenizer.json", "preprocessor_config.json")
        if not all((output / name).is_file() for name in required):
            message = "Converted transcription model is incomplete."
            raise ValueError(message)
        (output / "ready.json").write_text(
            json.dumps({"source": DUTCH_MODEL, "revision": DUTCH_REVISION}), encoding="utf-8"
        )
        output.replace(target)
    return str(target)
