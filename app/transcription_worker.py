from __future__ import annotations

import asyncio
import gc
import logging
import os
from contextlib import asynccontextmanager
from typing import TYPE_CHECKING, Annotated, Literal

import numpy as np
from fastapi import FastAPI, HTTPException, Query, Request
from requests import RequestException

from app.transcription_models import DUTCH_MODEL, ModelSelection, convert_dutch_model, model_path

if TYPE_CHECKING:
    from collections.abc import AsyncIterator

MAX_AUDIO_BYTES = 320000
MAX_BATCH = 4
SAMPLE_RATE = 16000
NO_SPEECH_THRESHOLD = 0.6


def load_model(name: str = "large-v3-turbo") -> object:
    from faster_whisper import WhisperModel

    device = os.environ.get("TRANSCRIPTION_DEVICE", "cuda")
    return WhisperModel(
        model_path(name),
        device=device,
        compute_type=os.environ.get("TRANSCRIPTION_COMPUTE_TYPE", "float16" if device == "cuda" else "int8"),
        cpu_threads=4,
        download_root="/models",
    )


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    app.state.model = None
    app.state.error = None
    app.state.lock = asyncio.Lock()
    app.state.model_name = "large-v3-turbo"
    app.state.phase = "loading"
    app.state.target = None
    app.state.switch_task = None

    async def warm() -> None:
        while True:
            if app.state.model is not None or app.state.target is not None:
                await asyncio.sleep(1)
                continue
            try:
                app.state.phase = "loading"
                app.state.model = await asyncio.to_thread(load_model, app.state.model_name)
            except (RuntimeError, OSError, ValueError, RequestException, TimeoutError) as error:
                app.state.error = type(error).__name__
            else:
                app.state.error = None
                app.state.phase = "ready"
                continue
            logging.getLogger("app.transcription").error("Model initialization failed (%s); retrying", app.state.error)
            await asyncio.sleep(30)

    task = asyncio.create_task(warm())
    yield
    if app.state.switch_task:
        await asyncio.gather(app.state.switch_task, return_exceptions=True)
    task.cancel()
    await asyncio.gather(task, return_exceptions=True)


app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)


@app.get("/health")
def health() -> dict:
    return {
        "ready": app.state.model is not None and app.state.target is None,
        "model": app.state.model_name,
        "phase": app.state.phase,
        "target": app.state.target,
        "error": app.state.error,
        "device": os.environ.get("TRANSCRIPTION_DEVICE", "cuda"),
        "max_batch": MAX_BATCH,
    }


class ModelInput(ModelSelection):
    pass


def download_model(name: str) -> None:
    from faster_whisper.utils import download_model as download

    if name == DUTCH_MODEL:
        convert_dutch_model()
    else:
        download(name, cache_dir="/models")


async def replace_model(name: str) -> None:
    previous = app.state.model_name
    try:
        app.state.phase = "downloading"
        await asyncio.to_thread(download_model, name)
        async with app.state.lock:
            app.state.phase = "loading"
            app.state.model = None
            await asyncio.to_thread(gc.collect)
            try:
                app.state.model = await asyncio.to_thread(load_model, name)
            except (RuntimeError, OSError, ValueError):
                app.state.phase = "restoring"
                app.state.model = await asyncio.to_thread(load_model, previous)
                raise
            app.state.model_name = name
        app.state.error = None
    except (RuntimeError, OSError, ValueError, RequestException, TimeoutError) as error:
        app.state.error = "Model switch failed: " + type(error).__name__
    finally:
        app.state.target = None
        app.state.phase = "ready" if app.state.model is not None else "failed"


@app.put("/model", status_code=202)
async def select_model(body: ModelInput) -> dict:
    if app.state.target is not None or app.state.model is None:
        raise HTTPException(409, "The transcription model is still loading or switching.")
    if body.model != app.state.model_name:
        app.state.target = body.model
        app.state.phase = "downloading"
        app.state.switch_task = asyncio.create_task(replace_model(body.model))
    return health()


def recognize_many(items: list[bytes], language: str = "nl") -> list[dict]:
    from faster_whisper import BatchedInferencePipeline
    from faster_whisper.vad import VadOptions, collect_chunks, get_speech_timestamps

    results = [{"text": "", "language": language} for _ in items]
    groups: dict[str, list[tuple[int, np.ndarray]]] = {}
    for index, pcm in enumerate(items):
        audio = np.frombuffer(pcm, dtype=np.int16).astype(np.float32) / 32768
        timestamps = get_speech_timestamps(audio, VadOptions())
        if not timestamps:
            continue
        chunks, _ = collect_chunks(audio, timestamps)
        audio = np.concatenate(chunks)
        detected = app.state.model.detect_language(audio=audio)[0] if language == "auto" else language
        results[index]["language"] = detected
        if detected in {"nl", "en"}:
            groups.setdefault(detected, []).append((index, audio))
    for detected, group in groups.items():
        pieces, clips, owners = [], [], {}
        offset = 0
        for index, audio in group:
            clips.append({"start": offset / SAMPLE_RATE, "end": (offset + len(audio)) / SAMPLE_RATE})
            owners[int(offset / SAMPLE_RATE * app.state.model.frames_per_second)] = index
            padded = np.pad(audio, (0, (-len(audio)) % 160))
            pieces.append(padded)
            offset += len(padded)
        pipeline = BatchedInferencePipeline(app.state.model)
        segments, _ = pipeline.transcribe(
            np.concatenate(pieces),
            language=detected,
            task="transcribe",
            beam_size=5,
            vad_filter=False,
            condition_on_previous_text=False,
            clip_timestamps=clips,
            batch_size=MAX_BATCH,
        )
        for segment in segments:
            if segment.no_speech_prob > NO_SPEECH_THRESHOLD and segment.avg_logprob < -1:
                continue
            index = owners[segment.seek]
            results[index]["text"] = (results[index]["text"] + " " + segment.text.strip()).strip()[:4000]
    return results


def recognize(pcm: bytes, language: str = "nl") -> dict:
    audio = np.frombuffer(pcm, dtype=np.int16).astype(np.float32) / 32768
    segments, info = app.state.model.transcribe(
        audio,
        language=None if language == "auto" else language,
        task="transcribe",
        beam_size=5,
        vad_filter=True,
        condition_on_previous_text=False,
    )
    text = " ".join(segment.text.strip() for segment in segments).strip()[:4000]
    return {"text": text, "language": info.language}


async def read_audio(request: Request, maximum: int) -> bytes:
    pcm = bytearray()
    async for piece in request.stream():
        if len(pcm) + len(piece) > maximum:
            raise HTTPException(413, "Audio segment is too large.")
        pcm.extend(piece)
    return bytes(pcm)


async def infer(items: list[bytes], language: str) -> list[dict]:
    if app.state.model is None or app.state.target is not None:
        raise HTTPException(503, "Transcription model is unavailable or still loading.")
    if app.state.lock.locked():
        raise HTTPException(503, "Transcription worker is busy.")
    async with app.state.lock:
        if len(items) == 1:
            return [await asyncio.to_thread(recognize, items[0], language)]
        return await asyncio.to_thread(recognize_many, items, language)


@app.post("/transcribe")
async def transcribe(request: Request, language: Literal["nl", "en", "auto"] = "nl") -> dict:
    pcm = await read_audio(request, MAX_AUDIO_BYTES)
    if not pcm or len(pcm) % 2:
        raise HTTPException(422, "Expected mono 16 kHz signed 16-bit PCM.")
    return (await infer([pcm], language))[0]


@app.post("/transcribe/batch")
async def transcribe_batch(
    request: Request,
    lengths: Annotated[list[int], Query(min_length=1, max_length=MAX_BATCH)],
    language: Literal["nl", "en", "auto"] = "nl",
) -> dict:
    if any(length <= 0 or length > MAX_AUDIO_BYTES or length % 2 for length in lengths):
        raise HTTPException(422, "Each audio segment must be bounded mono 16 kHz signed 16-bit PCM.")
    pcm = await read_audio(request, sum(lengths))
    if len(pcm) != sum(lengths):
        raise HTTPException(422, "Audio lengths do not match the request body.")
    items = []
    offset = 0
    for length in lengths:
        items.append(pcm[offset : offset + length])
        offset += length
    return {"results": await infer(items, language)}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host=os.environ.get("HOST", "0.0.0.0"), port=8000, access_log=False)
