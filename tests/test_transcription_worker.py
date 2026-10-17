from __future__ import annotations

import sys
from types import SimpleNamespace
from unittest.mock import Mock

import numpy as np
import pytest
from fastapi.testclient import TestClient

from app import transcription_worker as worker
from app.conversation import Conversation
from app.transcription_vocabulary import VOCABULARY_HEADER, encode_hints


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch) -> TestClient:
    monkeypatch.setattr(worker, "load_model", lambda *_args: object())
    with TestClient(worker.app) as value:
        worker.app.state.model = object()
        yield value


def test_batch_framing_and_order(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    inference = Mock(return_value=[{"text": "first", "language": "nl"}, {"text": "second", "language": "nl"}])
    monkeypatch.setattr(worker, "recognize_many", inference)
    response = client.post("/transcribe/batch?lengths=2&lengths=4&language=nl", content=b"aabbbb")
    assert response.status_code == 200
    assert response.json()["results"][1]["text"] == "second"
    inference.assert_called_once_with([b"aa", b"bbbb"], "nl")


@pytest.mark.parametrize(
    ("query", "body", "status"),
    [
        ("lengths=1", b"a", 422),
        ("lengths=0", b"", 422),
        ("lengths=320002", b"", 422),
        ("lengths=2", b"a", 422),
        ("lengths=2", b"aaaa", 413),
        ("lengths=2&lengths=2&lengths=2&lengths=2&lengths=2", b"a" * 10, 422),
        ("lengths=2&language=fr", b"aa", 422),
    ],
)
def test_batch_validation(client: TestClient, query: str, body: bytes, status: int) -> None:
    assert client.post("/transcribe/batch?" + query, content=body).status_code == status


def test_busy_and_loading(client: TestClient) -> None:
    worker.app.state.model = None
    assert client.post("/transcribe", content=b"aa").status_code == 503
    worker.app.state.model = object()
    worker.app.state.lock = SimpleNamespace(locked=lambda: True)
    assert client.post("/transcribe/batch?lengths=2", content=b"aa").status_code == 503


@pytest.mark.parametrize("language", ["nl", "auto"])
@pytest.mark.parametrize("hints", ["", "Zoë, Sjoerd"])
def test_batch_mapping_uses_separate_features_and_languages(
    monkeypatch: pytest.MonkeyPatch, language: str, hints: str
) -> None:
    calls = []

    class Pipeline:
        def __init__(self, model: object) -> None:
            self.model = model

        def transcribe(self, audio: np.ndarray, **options: object) -> tuple:
            calls.append((audio, options))
            segments = [
                SimpleNamespace(seek=int(clip["start"] * 100), text=f"speaker {index}", no_speech_prob=0, avg_logprob=0)
                for index, clip in enumerate(options["clip_timestamps"])
            ]
            return iter(segments), None

    monkeypatch.setitem(sys.modules, "faster_whisper", SimpleNamespace(BatchedInferencePipeline=Pipeline))
    monkeypatch.setitem(
        sys.modules,
        "faster_whisper.vad",
        SimpleNamespace(
            VadOptions=lambda: None,
            get_speech_timestamps=lambda audio, _options: [{"start": 0, "end": len(audio)}],
            collect_chunks=lambda audio, _timestamps: ([audio], []),
        ),
    )
    monkeypatch.setattr(
        worker.app.state,
        "model",
        SimpleNamespace(frames_per_second=100, detect_language=Mock(side_effect=[("nl", 1, []), ("en", 1, [])])),
        raising=False,
    )
    first = np.full(161, 1000, dtype=np.int16).tobytes()
    second = np.full(320, 2000, dtype=np.int16).tobytes()
    result = worker.recognize_many([first, second], language, hints)
    assert all(options["initial_prompt"] == (hints or None) for _, options in calls)
    if language == "auto":
        assert result == [{"text": "speaker 0", "language": "nl"}, {"text": "speaker 0", "language": "en"}]
        assert len(calls) == 2
        assert all(len(options["clip_timestamps"]) == 1 for _, options in calls)
        assert [options["language"] for _, options in calls] == ["nl", "en"]
    else:
        assert result == [{"text": "speaker 0", "language": "nl"}, {"text": "speaker 1", "language": "nl"}]
        assert len(calls) == 1
        assert len(calls[0][1]["clip_timestamps"]) == 2
        assert calls[0][1]["batch_size"] == 4
        assert np.all(calls[0][0][:161] == np.float32(1000 / 32768))
        assert np.all(calls[0][0][320:] == np.float32(2000 / 32768))


def test_batch_response_count_is_validated() -> None:
    with pytest.raises(ValueError, match="Invalid transcription batch response"):
        Conversation.validate_results([{"text": "one"}], 2)


def test_single_preserves_existing_decoder(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    inference = Mock(return_value={"text": "hello", "language": "nl"})
    monkeypatch.setattr(worker, "recognize", inference)
    assert client.post("/transcribe?language=nl", content=b"aa").json()["text"] == "hello"
    inference.assert_called_once_with(b"aa", "nl")


@pytest.mark.parametrize("name", ["large-v3", "yuriyvnv/whisper-large-v3-high-mixed-nl"])
@pytest.mark.parametrize("failure", [False, True])
def test_model_switch_and_rollback(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, name: str, *, failure: bool
) -> None:
    def load(requested: str) -> object:
        if failure and requested == name:
            message = "Unavailable"
            raise RuntimeError(message)
        return object()

    monkeypatch.setattr(worker, "load_model", load)
    monkeypatch.setattr(worker, "download_model", lambda _name: None)
    assert client.put("/model", json={"model": "unknown"}).status_code == 422
    assert client.put("/model", json={"model": name}).status_code == 202
    client.portal.call(lambda: worker.app.state.switch_task)
    health = client.get("/health").json()
    assert health["ready"]
    assert health["model"] == ("large-v3-turbo" if failure else name)
    assert bool(health["error"]) == failure


def test_model_switch_rejects_when_loading(client: TestClient) -> None:
    worker.app.state.model = None
    assert client.put("/model", json={"model": "large-v3"}).status_code == 409


def test_native_worker_requires_authentication(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("TRANSCRIPTION_API_TOKEN", "test-worker-token")
    for path in ("/health", "/transcribe", "/model"):
        assert client.get(path).status_code == 401
    assert client.get("/health", headers={"Authorization": "Bearer wrong"}).status_code == 401
    response = client.get("/health", headers={"Authorization": "Bearer test-worker-token"})
    assert response.status_code == 200
    assert "test-worker-token" not in response.text


def test_apple_models_and_speaker_isolation(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("TRANSCRIPTION_DEVICE", "mlx")
    assert client.get("/health").json()["models"] == ["large-v3-turbo", "large-v3"]
    assert client.put("/model", json={"model": worker.DUTCH_MODEL}).status_code == 422
    model = SimpleNamespace(
        recognize=Mock(side_effect=[{"text": "one", "language": "nl"}, {"text": "two", "language": "en"}])
    )
    worker.app.state.model = model
    response = client.post("/transcribe/batch?lengths=2&lengths=4&language=auto", content=b"aabbbb")
    assert response.json()["results"] == [{"text": "one", "language": "nl"}, {"text": "two", "language": "en"}]
    assert model.recognize.call_args_list[0].args == (b"aa", "auto")
    assert model.recognize.call_args_list[1].args == (b"bbbb", "auto")


def test_apple_startup_requires_token(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("TRANSCRIPTION_DEVICE", "mlx")
    monkeypatch.delenv("TRANSCRIPTION_API_TOKEN", raising=False)
    with pytest.raises(RuntimeError, match="requires TRANSCRIPTION_API_TOKEN"), TestClient(worker.app):
        pass


@pytest.mark.parametrize("batch", [False, True])
def test_vocabulary_reaches_inference_without_persisting(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, *, batch: bool
) -> None:
    hints = "Zoë, Sjoerd"
    inference = Mock(
        return_value=[{"text": "hello", "language": "nl"}] if batch else {"text": "hello", "language": "nl"}
    )
    monkeypatch.setattr(worker, "recognize_many" if batch else "recognize", inference)
    path = "/transcribe/batch?lengths=2&lengths=2" if batch else "/transcribe"
    body = b"aaaa" if batch else b"aa"
    response = client.post(path, content=body, headers={VOCABULARY_HEADER: encode_hints(hints)})
    assert response.status_code == 200
    assert inference.call_args.args == ([b"aa", b"aa"] if batch else b"aa", "nl", hints)
    assert hints not in client.get("/health").text
    inference.reset_mock()
    assert client.post(path, content=body, headers={VOCABULARY_HEADER: encode_hints("x" * 501)}).status_code == 422
    inference.assert_not_called()


def test_cpu_single_decoder_receives_vocabulary(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("TRANSCRIPTION_DEVICE", "cpu")
    model = SimpleNamespace(
        transcribe=Mock(return_value=(iter([SimpleNamespace(text="hello")]), SimpleNamespace(language="nl")))
    )
    monkeypatch.setattr(worker.app.state, "model", model, raising=False)
    assert worker.recognize(b"aa", "nl", "Zoë, Sjoerd")["text"] == "hello"
    assert model.transcribe.call_args.kwargs["initial_prompt"] == "Zoë, Sjoerd"
    assert not model.transcribe.call_args.kwargs["condition_on_previous_text"]
