from __future__ import annotations

import asyncio
import logging
import re
import time
from dataclasses import dataclass, field
from http import HTTPStatus
from typing import TYPE_CHECKING

import aiohttp
import numpy as np

from app.conversation_audio import Speech
from app.db import DATABASE_ERRORS, new_id
from app.deepgram_options import DeepgramOptions

if TYPE_CHECKING:
    from app.conversation import Conversation

MAX_STREAMS = 16
MAX_PACKET_BYTES = 19200
FINALIZE_SECONDS = 0.5
INTERIM_INTERVAL = 0.2
MUTE_COOLDOWN = 10
MAX_DETAILS = 256
MAX_SEARCH_HITS = 50
MAX_PACKETS = 128
IDLE_SECONDS = 5
RETRY_SECONDS = 15
MAX_FRAGMENTS = 128
WORD_TIME_EPSILON = 0.001


class StreamError(ValueError):
    pass


def failure_message(error: Exception) -> str:
    if isinstance(error, StreamError):
        return str(error)
    if isinstance(error, aiohttp.WSServerHandshakeError):
        guidance = {
            HTTPStatus.BAD_REQUEST: "Check the Deepgram model, language and API options.",
            HTTPStatus.UNAUTHORIZED: "Check the Deepgram API key.",
            HTTPStatus.PAYMENT_REQUIRED: "Check the Deepgram account credits.",
            HTTPStatus.FORBIDDEN: "Check the Deepgram API key permissions and account access.",
            HTTPStatus.TOO_MANY_REQUESTS: "Check the Deepgram concurrency and rate limits.",
        }.get(error.status, "Check the Deepgram service status and connection.")
        return f"Deepgram connection rejected (HTTP {error.status}). {guidance}"
    if isinstance(error, TimeoutError):
        return "Deepgram connection timed out. Check the network and Deepgram service status."
    if isinstance(error, DATABASE_ERRORS):
        return "Could not save the Deepgram transcript. Check the database connection."
    return f"Deepgram stream failed ({type(error).__name__}). Check the connection and API configuration."


def stream_parameters(language: str, vocabulary: str, options: DeepgramOptions | None = None) -> list[tuple[str, str]]:
    options = options or DeepgramOptions()
    flags = {
        "interim_results": options.interim_results,
        "smart_format": options.smart_format,
        "punctuate": options.punctuate or options.smart_format or (options.dictation and language == "en"),
        "profanity_filter": options.profanity_filter,
        "vad_events": options.vad_events,
        "dictation": options.dictation and language == "en",
        "numerals": options.numerals,
    }
    params = [
        ("model", "nova-3"),
        ("language", "multi" if language == "auto" else language),
        ("encoding", "linear16"),
        ("sample_rate", "16000"),
        ("channels", "1"),
        ("endpointing", str(options.endpointing_ms) if options.endpointing else "false"),
        *[(key, str(value).lower()) for key, value in flags.items()],
    ]
    if options.interim_results and options.utterance_end:
        params.append(("utterance_end_ms", str(options.utterance_end_ms)))
    if options.diarization:
        params.append(("diarize_model", options.diarize_model))
    if options.redaction != "off":
        params.append(("redact", options.redaction))
    if options.find_replace:
        params.extend(("replace", item.find + ":" + item.replacement) for item in options.replacements)
    if options.search:
        params.extend(("search", term) for term in options.search_terms)
    if options.keyterm_prompting:
        terms = list(dict.fromkeys(term.strip() for term in re.split(r"[,\n]", vocabulary) if term.strip()))
        params.extend(("keyterm", term) for term in terms[:100])
    return params


@dataclass
class Utterance:
    id: str = field(default_factory=new_id)
    fragments: dict[tuple[float, float], str] = field(default_factory=dict)
    start: float | None = None
    watermark: float = -1
    end: float = 0
    confirmed_end: float = -1
    committed_end: float = -1

    def final_text(self) -> str:
        return " ".join(self.fragments.values()).strip()[:4000]

    def finish(self) -> tuple[str, bool] | None:
        text = self.final_text()
        return (text, True) if text else None

    def new_words(self, alternative: dict, start: float, end: float) -> tuple[str, float, float] | None:
        text = str(alternative.get("transcript", "")).strip()[:4000]
        words = alternative.get("words", [])
        if not words:
            return (text, start, end) if start >= self.watermark - WORD_TIME_EPSILON else None
        fresh = [
            word
            for word in words
            if float(word["start"]) >= self.confirmed_end - WORD_TIME_EPSILON
            and float(word["end"]) > self.confirmed_end + WORD_TIME_EPSILON
        ]
        if not fresh:
            return None
        if len(fresh) != len(words):
            text = " ".join(str(word.get("punctuated_word", word.get("word", ""))) for word in fresh).strip()[:4000]
        return text, float(fresh[0]["start"]), float(fresh[-1]["end"])

    def finish_replay(self, alternative: dict) -> tuple[str, bool] | None:
        words = alternative.get("words", [])
        if words and float(words[-1]["end"]) >= self.confirmed_end - WORD_TIME_EPSILON:
            return self.finish()
        return None

    def update(self, result: dict) -> tuple[str, bool] | None:
        if result.get("type") == "UtteranceEnd":
            boundary = self.committed_end if self.committed_end >= 0 else self.watermark
            if float(result.get("last_word_end", float("inf"))) <= boundary + WORD_TIME_EPSILON:
                return None
            return self.finish()
        if result.get("type") != "Results":
            return None
        start = float(result.get("start", 0))
        end = start + float(result.get("duration", 0))
        alternatives = result.get("channel", {}).get("alternatives", [])
        alternative = alternatives[0] if alternatives else {}
        complete = bool(result.get("speech_final") or result.get("from_finalize"))
        update = self.new_words(alternative, start, end)
        if update is None:
            return self.finish_replay(alternative) if complete else None
        text, word_start, word_end = update
        if text and self.start is None:
            self.start = word_start
        self.end = max(self.end, end)
        if (result.get("is_final") or complete) and text:
            self.fragments = {span: value for span, value in self.fragments.items() if span[0] != word_start}
            self.fragments[(word_start, word_end)] = text
            if alternative.get("words"):
                self.confirmed_end = word_end
        elif text:
            text = " ".join([*self.fragments.values(), text])[:4000]
        if result.get("is_final") or complete or not text:
            text = self.final_text()
        return text, complete or len(self.fragments) >= MAX_FRAGMENTS

    def reset(self) -> None:
        self.watermark = self.end
        self.committed_end = self.confirmed_end
        self.id = new_id()
        self.fragments.clear()
        self.start = None


@dataclass
class SpeakerStream:
    speaker: tuple[str, str, str | None]
    session_id: str
    origin: float
    queue: asyncio.Queue[bytes] = field(default_factory=lambda: asyncio.Queue(maxsize=MAX_PACKETS))
    task: asyncio.Task | None = None
    utterance: Utterance = field(default_factory=Utterance)
    published: float = 0
    configuration: tuple[str, str] = ("", "")
    language: str = "nl"
    search_hits: dict[str, float] = field(default_factory=dict)


class DeepgramStreams:
    def __init__(self, conversation: Conversation) -> None:
        self.conversation = conversation
        self.streams: dict[str, SpeakerStream] = {}
        self.retry: dict[str, float] = {}
        self.interims: dict[str, dict] = {}
        self.details: dict[str, list[dict]] = {}
        self.muted: set[str] = set()
        self.resume_after: dict[str, float] = {}
        self.http: aiohttp.ClientSession | None = None

    def feed(self, session_id: str, speaker: tuple[str, str, str | None], pcm: bytes, timestamp: float) -> None:
        if not pcm or len(pcm) % 4 or len(pcm) > MAX_PACKET_BYTES:
            return
        manager = self.conversation
        if (
            speaker[0] not in manager.allowed
            or speaker[0] in self.muted
            or self.resume_after.get(speaker[0], 0) > time.monotonic()
            or timestamp < time.time() - 5
        ):
            return
        if self.retry.get(speaker[0], 0) > time.monotonic():
            return
        stream = self.streams.get(speaker[0])
        if stream is None:
            if len(self.streams) >= MAX_STREAMS:
                manager.dropped += 1
                manager.error = "Deepgram speaker connection limit reached. Some audio could not be transcribed."
                self.retry[speaker[0]] = time.monotonic() + RETRY_SECONDS
                return
            stream = SpeakerStream(speaker, session_id, timestamp)
            self.streams[speaker[0]] = stream
            stream.task = asyncio.create_task(self.run(stream))
            stream.task.add_done_callback(lambda _task: self.finished(stream))
        mono = np.frombuffer(pcm, dtype=np.int16).reshape(-1, 2).astype(np.float32).mean(axis=1)
        values = manager.segmenter.resample(speaker[0], mono)
        audio = np.clip(np.rint(values), -32768, 32767).astype(np.int16).tobytes()
        if stream.queue.full():
            manager.dropped += 1
            manager.error = "Deepgram stream could not keep up; some audio was dropped."
            if stream.task:
                stream.task.cancel()
            self.retry[speaker[0]] = time.monotonic() + RETRY_SECONDS
            return
        stream.queue.put_nowait(audio)

    async def run(self, stream: SpeakerStream) -> None:
        manager = self.conversation
        if self.http is None:
            self.http = aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=None, sock_connect=10))
        sender = receiver = None
        try:
            stream.configuration = (manager.language, manager.vocabulary)
            async with asyncio.timeout(10):
                connection = await self.http.ws_connect(
                    "wss://api.deepgram.com/v1/listen",
                    params=stream_parameters(*stream.configuration, manager.deepgram_options),
                    headers={"Authorization": "Token " + manager.settings.deepgram_api_key.get_secret_value()},
                    max_msg_size=65536,
                    heartbeat=5,
                )
            async with connection:
                sender = asyncio.create_task(self.send(connection, stream))
                receiver = asyncio.create_task(self.receive(connection, stream))
                done, _ = await asyncio.wait((sender, receiver), return_when=asyncio.FIRST_COMPLETED)
                if sender in done:
                    sender.result()
                await receiver
                if stream.utterance.fragments:
                    await self.result(stream, {"type": "UtteranceEnd"})
        except (
            aiohttp.ClientError,
            TimeoutError,
            ValueError,
            TypeError,
            KeyError,
            AttributeError,
            *DATABASE_ERRORS,
        ) as error:
            manager.error = failure_message(error)
            logging.getLogger("app.deepgram").warning("%s Retrying in %s seconds.", manager.error, RETRY_SECONDS)
            manager.dropped += 1
            self.retry[stream.speaker[0]] = time.monotonic() + RETRY_SECONDS
            manager.events.publish("conversation")
        finally:
            tasks = [task for task in (sender, receiver) if task]
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            self.finished(stream)

    async def receive(self, connection: aiohttp.ClientWebSocketResponse, stream: SpeakerStream) -> None:
        while True:
            message = await connection.receive(timeout=10)
            if message.type in {aiohttp.WSMsgType.CLOSE, aiohttp.WSMsgType.CLOSED}:
                code = message.data if isinstance(message.data, int) else connection.close_code
                if code not in {None, aiohttp.WSCloseCode.OK, aiohttp.WSCloseCode.GOING_AWAY}:
                    reason = f"Deepgram WebSocket closed unexpectedly (code {code})."
                    raise StreamError(reason)
                return
            if message.type == aiohttp.WSMsgType.ERROR:
                raise aiohttp.ClientConnectionError
            if message.type != aiohttp.WSMsgType.TEXT:
                continue
            result = message.json()
            if result.get("type") == "Error":
                reason = "Deepgram reported a streaming error. Check its service status and API configuration."
                raise StreamError(reason)
            await self.result(stream, result)

    def finished(self, stream: SpeakerStream) -> None:
        if self.streams.get(stream.speaker[0]) is stream:
            self.interims.pop(stream.speaker[0], None)
            self.streams.pop(stream.speaker[0], None)
            self.conversation.events.publish("conversation", {"session_id": stream.session_id})

    async def send(self, connection: aiohttp.ClientWebSocketResponse, stream: SpeakerStream) -> None:
        idle = time.monotonic()
        finalized = False
        while True:
            try:
                audio = await asyncio.wait_for(stream.queue.get(), 0.25)
            except TimeoutError:
                elapsed = time.monotonic() - idle
                if elapsed >= IDLE_SECONDS:
                    await connection.send_json({"type": "CloseStream"})
                    return
                if elapsed >= FINALIZE_SECONDS and not finalized:
                    await connection.send_json({"type": "Finalize"})
                    finalized = True
                await connection.send_bytes(bytes(8000))
                continue
            manager = self.conversation
            configuration = (manager.language, manager.vocabulary)
            if configuration[0] != stream.configuration[0]:
                await connection.send_json({"type": "CloseStream"})
                return
            if configuration[1] != stream.configuration[1]:
                terms = [
                    term
                    for key, term in stream_parameters(*configuration, manager.deepgram_options)
                    if key == "keyterm"
                ]
                await connection.send_json({"type": "Configure", "keyterms": terms})
                stream.configuration = configuration
            idle = time.monotonic()
            finalized = False
            await connection.send_bytes(audio)

    def collect_search(self, stream: SpeakerStream, result: dict) -> None:
        for item in result.get("channel", {}).get("search", [])[:MAX_SEARCH_HITS]:
            query = str(item.get("query", ""))[:100]
            confidence = max(
                (float(hit.get("confidence", 0)) for hit in item.get("hits", [])[:MAX_SEARCH_HITS]), default=0
            )
            if query and confidence > 0:
                stream.search_hits[query] = max(stream.search_hits.get(query, 0), min(confidence, 1))
        stream.search_hits = dict(list(stream.search_hits.items())[:MAX_SEARCH_HITS])

    def save_details(self, stream: SpeakerStream, message_id: str) -> None:
        if stream.search_hits:
            self.details[message_id] = [
                {"query": query, "confidence": confidence} for query, confidence in stream.search_hits.items()
            ]
            if len(self.details) > MAX_DETAILS:
                del self.details[next(iter(self.details))]
        stream.search_hits.clear()

    async def result(self, stream: SpeakerStream, result: dict) -> None:
        update = stream.utterance.update(result)
        if update is None:
            return
        self.collect_search(stream, result)
        text, complete = update
        manager = self.conversation
        speech = Speech(
            *stream.speaker,
            stream.origin + (stream.utterance.start or 0),
            time.time(),
            b"",
            stream.utterance.id,
        )
        if (
            not manager.current(stream.session_id, speech)
            or stream.speaker[0] not in manager.allowed
            or stream.speaker[0] in self.muted
        ):
            return
        alternatives = result.get("channel", {}).get("alternatives", [])
        languages = alternatives[0].get("languages", []) if alternatives else []
        if languages:
            stream.language = languages[0].split("-")[0]
        elif stream.configuration[0] in {"nl", "en"}:
            stream.language = stream.configuration[0]
        language = stream.language if stream.language in {"nl", "en"} else "nl"
        if complete:
            self.save_details(stream, speech.id)
            self.interims.pop(stream.speaker[0], None)
            await manager.save_transcript(stream.session_id, speech, {"text": text, "language": language})
            stream.utterance.reset()
            manager.events.publish("conversation", {"session_id": stream.session_id})
        elif not text:
            if self.interims.pop(stream.speaker[0], None):
                manager.events.publish("conversation", {"session_id": stream.session_id})
        else:
            self.interims[stream.speaker[0]] = {
                "id": speech.id,
                "speaker_id": speech.speaker_id,
                "speaker_name": speech.name,
                "avatar": speech.avatar,
                "started_at": speech.started_at,
                "text": text,
                "language": language,
                "interim": True,
            }
            if time.monotonic() - stream.published >= INTERIM_INTERVAL:
                stream.published = time.monotonic()
                manager.events.publish("conversation", {"session_id": stream.session_id})

    def set_muted(self, speaker_id: str, *, muted: bool) -> None:
        if muted == (speaker_id in self.muted):
            return
        if muted:
            if speaker_id not in self.muted:
                self.resume_after[speaker_id] = max(
                    self.resume_after.get(speaker_id, 0), time.monotonic() + MUTE_COOLDOWN
                )
            self.muted.add(speaker_id)
            stream = self.streams.get(speaker_id)
            if stream and stream.task:
                stream.task.cancel()
            self.interims.pop(speaker_id, None)
            self.conversation.events.publish(
                "conversation", {"session_id": self.conversation.session["id"]} if self.conversation.session else {}
            )
        else:
            self.muted.discard(speaker_id)

    def prune(self, members: set[str]) -> None:
        for speaker_id, stream in self.streams.items():
            if speaker_id not in members and stream.task:
                stream.task.cancel()
        self.muted.intersection_update(members)
        self.resume_after = {
            speaker_id: until for speaker_id, until in self.resume_after.items() if speaker_id in members
        }
        self.retry = {speaker_id: until for speaker_id, until in self.retry.items() if speaker_id in members}

    async def close(self) -> None:
        tasks = [stream.task for stream in self.streams.values() if stream.task]
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        self.streams.clear()
        self.interims.clear()
        self.details.clear()
        self.retry.clear()
        self.muted.clear()
        self.resume_after.clear()
        if self.http:
            await self.http.close()
            self.http = None
