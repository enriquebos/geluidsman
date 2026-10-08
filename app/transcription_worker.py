from __future__ import annotations

import asyncio
import logging
import os
from contextlib import asynccontextmanager
from typing import TYPE_CHECKING, Literal

import numpy as np
from fastapi import FastAPI, HTTPException, Request
from faster_whisper import WhisperModel

if TYPE_CHECKING:
    from collections.abc import AsyncIterator

MAX_AUDIO_BYTES = 320000


def load_model() -> object:
    return WhisperModel("large-v3-turbo", device="cpu", compute_type="int8", cpu_threads=4, download_root="/models")


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    app.state.model = None
    app.state.error = None
    app.state.lock = asyncio.Lock()

    async def warm() -> None:
        while app.state.model is None:
            try:
                app.state.model = await asyncio.to_thread(load_model)
            except (RuntimeError, OSError, ValueError) as error:
                app.state.error = type(error).__name__
            else:
                app.state.error = None
                return
            logging.getLogger("app.transcription").error("Model initialization failed (%s); retrying", app.state.error)
            await asyncio.sleep(30)

    task = asyncio.create_task(warm())
    yield
    task.cancel()
    await asyncio.gather(task, return_exceptions=True)


app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)


@app.get("/health")
def health() -> dict:
    return {"ready": app.state.model is not None, "error": app.state.error}


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


@app.post("/transcribe")
async def transcribe(request: Request, language: Literal["nl", "en", "auto"] = "nl") -> dict:
    pcm = bytearray()
    async for piece in request.stream():
        pcm.extend(piece)
        if len(pcm) > MAX_AUDIO_BYTES:
            raise HTTPException(413, "Audio segment is too large.")
    if not pcm or len(pcm) % 2:
        raise HTTPException(422, "Expected mono 16 kHz signed 16-bit PCM.")
    if app.state.model is None:
        raise HTTPException(503, "Transcription model is unavailable or still loading.")
    if app.state.lock.locked():
        raise HTTPException(503, "Transcription worker is busy.")
    async with app.state.lock:
        return await asyncio.to_thread(recognize, bytes(pcm), language)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host=os.environ.get("HOST", "0.0.0.0"), port=8000, access_log=False)
