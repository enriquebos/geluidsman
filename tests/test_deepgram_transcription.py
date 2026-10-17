from __future__ import annotations

import asyncio
import time
from types import SimpleNamespace
from typing import TYPE_CHECKING
from unittest.mock import AsyncMock, Mock

if TYPE_CHECKING:
    import pytest

import aiohttp

from app.config import Settings
from app.conversation_audio import Segmenter
from app.deepgram_options import DeepgramOptions
from app.deepgram_transcription import (
    MAX_PACKETS,
    MAX_STREAMS,
    DeepgramStreams,
    SpeakerStream,
    Utterance,
    stream_parameters,
)


def message(text: str, start: float = 0, *, final: bool = False, complete: bool = False) -> dict:
    return {
        "type": "Results",
        "start": start,
        "duration": 0.5,
        "is_final": final,
        "speech_final": complete,
        "channel": {"alternatives": [{"transcript": text, "languages": ["nl"]}]},
    }


def manager() -> SimpleNamespace:
    return SimpleNamespace(
        settings=Settings(_env_file=None, transcription_provider="deepgram", deepgram_api_key="test-key"),
        language="nl",
        vocabulary="",
        session={"id": "session"},
        deepgram_options=DeepgramOptions(),
        allowed={"1", "2"},
        segmenter=Segmenter(),
        current=Mock(return_value=True),
        save_transcript=AsyncMock(),
        events=SimpleNamespace(publish=Mock()),
        dropped=0,
        error=None,
    )


def test_explicit_dutch_stream_and_literal_keyterms() -> None:
    params = stream_parameters("nl", "patapim\nbrrr, Naar bed\npatapim")
    assert dict(params)["language"] == "nl"
    assert dict(params)["encoding"] == "linear16"
    assert dict(params)["interim_results"] == "true"
    assert dict(params)["profanity_filter"] == "false"
    assert [value for key, value in params if key == "keyterm"] == ["patapim", "brrr", "Naar bed"]
    assert dict(stream_parameters("auto", ""))["language"] == "multi"


def test_revised_interims_accumulate_finals_without_duplicates() -> None:
    utterance = Utterance()
    assert utterance.update(message("nartpets")) == ("nartpets", False)
    assert utterance.update(message("Naar bed", final=True)) == ("Naar bed", False)
    assert utterance.update(message("Naar bed", final=True)) == ("Naar bed", False)
    assert utterance.update(message("nu", 0.5)) == ("Naar bed nu", False)
    assert utterance.update(message("nu.", 0.5, final=True, complete=True)) == ("Naar bed nu.", True)
    previous = utterance.id
    utterance.reset()
    assert utterance.id != previous
    assert utterance.update(message("nu.", 0.5, final=True, complete=True)) is None
    assert utterance.update({"type": "UtteranceEnd"}) is None


def test_multiple_speakers_only_final_speech_is_saved_and_events_have_no_text() -> None:
    async def check() -> None:
        owner = manager()
        streams = DeepgramStreams(owner)
        first = SpeakerStream(("1", "One", None), "session", time.time(), configuration=("nl", ""))
        second = SpeakerStream(("2", "Two", None), "session", time.time(), configuration=("nl", ""))
        await streams.result(first, message("narebet"))
        await streams.result(second, message("Hallo"))
        assert streams.interims["1"]["text"] == "narebet"
        assert streams.interims["2"]["text"] == "Hallo"
        owner.save_transcript.assert_not_called()
        await streams.result(first, message("Naar bed.", final=True, complete=True))
        assert "1" not in streams.interims
        assert streams.interims["2"]["text"] == "Hallo"
        speech = owner.save_transcript.call_args.args[1]
        assert speech.speaker_id == "1"
        assert owner.save_transcript.call_args.args[2] == {"text": "Naar bed.", "language": "nl"}
        await streams.result(first, message("Naar bed.", final=True, complete=True))
        assert owner.save_transcript.call_count == 1
        assert all(call.args[1] == {"session_id": "session"} for call in owner.events.publish.call_args_list)
        owner.current.return_value = False
        await streams.result(second, message("Hallo.", final=True, complete=True))
        assert owner.save_transcript.call_count == 1

    asyncio.run(check())


def test_utterance_end_commits_confirmed_words_and_discards_unconfirmed_tail() -> None:
    utterance = Utterance()
    utterance.update(message("Naar", final=True))
    utterance.update(message("fiets", 0.5))
    assert utterance.update({"type": "UtteranceEnd"}) == ("Naar", True)


def test_streams_are_bounded_and_shutdown_discards_audio(monkeypatch: pytest.MonkeyPatch) -> None:
    async def check() -> None:
        owner = manager()
        streams = DeepgramStreams(owner)
        blocker = asyncio.Event()

        async def wait(_stream: SpeakerStream) -> None:
            await blocker.wait()

        monkeypatch.setattr(streams, "run", wait)
        for index in range(MAX_STREAMS + 1):
            speaker = str(index)
            owner.allowed.add(speaker)
            streams.feed("session", (speaker, speaker, None), bytes(3840), time.time())
        assert len(streams.streams) == MAX_STREAMS
        assert owner.dropped == 1
        for _ in range(MAX_PACKETS):
            streams.feed("session", ("1", "One", None), bytes(3840), time.time())
        assert streams.streams["1"].queue.qsize() == MAX_PACKETS
        assert owner.dropped == 2
        await streams.close()
        assert not streams.streams
        assert not streams.interims

    asyncio.run(check())


def test_connection_failure_cleans_stream_and_does_not_expose_provider_error() -> None:
    async def check() -> None:
        owner = manager()
        streams = DeepgramStreams(owner)
        streams.http = Mock(ws_connect=Mock(side_effect=aiohttp.ClientConnectionError("test-key")), close=AsyncMock())
        stream = SpeakerStream(("1", "One", None), "session", time.time())
        streams.streams["1"] = stream
        await streams.run(stream)
        assert not streams.streams
        assert streams.retry["1"] > time.monotonic()
        assert "test-key" not in owner.error
        assert owner.dropped == 1
        await streams.close()

    asyncio.run(check())


def test_saved_options_are_encoded_and_dependencies_are_respected() -> None:
    options = DeepgramOptions(
        smart_format=True,
        interim_results=False,
        utterance_end=True,
        endpointing=False,
        keyterm_prompting=False,
        diarization=True,
        diarize_model="v1",
        punctuate=False,
        profanity_filter=True,
        redaction="numbers",
        find_replace=True,
        replacements=[{"find": "NaReBeT", "replacement": "Naar bed"}],
        search=True,
        search_terms=["Naar bed", "brrr"],
        vad_events=True,
        dictation=True,
        numerals=True,
    )
    params = stream_parameters("nl", "patapim", options)
    encoded = dict(params)
    assert encoded["endpointing"] == "false"
    assert encoded["interim_results"] == "false"
    assert "utterance_end_ms" not in encoded
    assert "keyterm" not in encoded
    assert "keywords" not in encoded
    assert encoded["dictation"] == "false"
    assert encoded["punctuate"] == "true"
    assert encoded["diarize_model"] == "v1"
    assert encoded["redact"] == "numbers"
    assert encoded["replace"] == "narebet:Naar bed"
    assert [value for key, value in params if key == "search"] == ["Naar bed", "brrr"]
    assert dict(stream_parameters("en", "", options))["dictation"] == "true"


def test_mute_cancels_only_that_speaker_and_unmute_obeys_cooldown(monkeypatch: pytest.MonkeyPatch) -> None:
    async def check() -> None:
        owner = manager()
        streams = DeepgramStreams(owner)
        blocker = asyncio.Event()

        async def wait(_stream: SpeakerStream) -> None:
            await blocker.wait()

        monkeypatch.setattr(streams, "run", wait)
        streams.feed("session", ("1", "One", None), bytes(3840), time.time())
        streams.feed("session", ("2", "Two", None), bytes(3840), time.time())
        first = streams.streams["1"]
        second = streams.streams["2"]
        await asyncio.sleep(0)
        streams.interims["1"] = {"text": "draft"}
        streams.set_muted("1", muted=True)
        deadline = streams.resume_after["1"]
        assert deadline >= time.monotonic() + 9
        streams.set_muted("1", muted=True)
        assert streams.resume_after["1"] == deadline
        await asyncio.sleep(0)
        await asyncio.sleep(0)
        assert first.task.cancelled()
        assert not second.task.cancelled()
        assert "1" not in streams.interims
        streams.set_muted("1", muted=False)
        streams.feed("session", ("1", "One", None), bytes(3840), time.time())
        assert "1" not in streams.streams
        streams.resume_after["1"] = time.monotonic() - 1
        streams.feed("session", ("1", "One", None), bytes(3840), time.time())
        assert streams.streams["1"] is not first
        streams.set_muted("1", muted=True)
        await streams.result(first, message("old speech", final=True, complete=True))
        owner.save_transcript.assert_not_called()
        await streams.close()

    asyncio.run(check())


def test_search_metadata_is_bounded_and_never_published_in_events() -> None:
    async def check() -> None:
        owner = manager()
        streams = DeepgramStreams(owner)
        stream = SpeakerStream(("1", "One", None), "session", time.time(), configuration=("nl", ""))
        result = message("Naar bed.", final=True, complete=True)
        result["channel"]["search"] = [{"query": "Naar bed", "hits": [{"confidence": 0.98}, {"confidence": 0.2}]}]
        identity = stream.utterance.id
        await streams.result(stream, result)
        assert streams.details[identity] == [{"query": "Naar bed", "confidence": 0.98}]
        assert all(call.args[1] == {"session_id": "session"} for call in owner.events.publish.call_args_list)
        await streams.close()
        assert not streams.details

    asyncio.run(check())


def timed_message(text: str, start: float, end: float, *, complete: bool = False) -> dict:
    result = message(text, final=True, complete=complete)
    result["duration"] = end + 0.2
    result["channel"]["alternatives"][0]["words"] = [
        {"word": text.lower().strip("."), "punctuated_word": text, "start": start, "end": end},
    ]
    return result


def test_finalization_replay_with_larger_audio_window_does_not_insert_twice() -> None:
    async def check() -> None:
        owner = manager()
        streams = DeepgramStreams(owner)
        stream = SpeakerStream(("1", "One", None), "session", time.time(), configuration=("nl", ""))
        initial = timed_message("Oh.", 0.1, 0.3, complete=True)
        await streams.result(stream, initial)
        replay = timed_message("Oh.", 0.1, 0.3, complete=True)
        replay["duration"] = 1.5
        replay["from_finalize"] = True
        interim = {**replay, "is_final": False, "speech_final": False, "from_finalize": False}
        await streams.result(stream, interim)
        assert not streams.interims
        await streams.result(stream, replay)
        assert owner.save_transcript.call_count == 1
        repeated = timed_message("Oh.", 1.6, 1.8, complete=True)
        await streams.result(stream, repeated)
        assert owner.save_transcript.call_count == 2
        assert owner.save_transcript.call_args_list[0].args[1].id != owner.save_transcript.call_args_list[1].args[1].id

    asyncio.run(check())


def test_replayed_final_fragment_is_not_appended_before_utterance_end() -> None:
    utterance = Utterance()
    initial = timed_message("Ah.", 0.1, 0.3)
    utterance.update(initial)
    replay = timed_message("Ah.", 0.1, 0.3, complete=True)
    replay["duration"] = 1.5
    assert utterance.update(replay) == ("Ah.", True)


def test_replayed_prefix_keeps_new_words_without_repeating_old_words() -> None:
    utterance = Utterance()
    utterance.update(timed_message("Oh.", 0.1, 0.3))
    result = timed_message("Oh, ja.", 0.1, 0.3, complete=True)
    result["channel"]["alternatives"][0]["words"] = [
        {"word": "oh", "punctuated_word": "Oh,", "start": 0.1, "end": 0.3},
        {"word": "ja", "punctuated_word": "ja.", "start": 0.4, "end": 0.6},
    ]
    assert utterance.update(result) == ("Oh. ja.", True)


def test_old_utterance_end_and_final_replay_do_not_finish_new_speech() -> None:
    utterance = Utterance()
    utterance.update(timed_message("Oh.", 0.1, 0.3, complete=True))
    utterance.reset()
    utterance.update(timed_message("Ah.", 0.6, 0.8))
    assert utterance.update({"type": "UtteranceEnd", "last_word_end": 0.3}) is None
    replay = timed_message("Oh.", 0.1, 0.3, complete=True)
    replay["duration"] = 1.5
    assert utterance.update(replay) is None
    assert utterance.update({"type": "UtteranceEnd", "last_word_end": 0.8}) == ("Ah.", True)


def test_speech_final_before_final_flag_does_not_create_a_second_message() -> None:
    async def check() -> None:
        owner = manager()
        streams = DeepgramStreams(owner)
        stream = SpeakerStream(("1", "One", None), "session", time.time(), configuration=("nl", ""))
        first = timed_message("Oh.", 0.1, 0.3, complete=True)
        first["is_final"] = False
        await streams.result(stream, first)
        await streams.result(stream, timed_message("Oh.", 0.1, 0.3, complete=True))
        assert owner.save_transcript.call_count == 1
        assert owner.save_transcript.call_args.args[2]["text"] == "Oh."

    asyncio.run(check())
