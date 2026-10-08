from __future__ import annotations

import asyncio
import json
from typing import TYPE_CHECKING
from unittest.mock import AsyncMock, Mock, patch

import pytest
from fastapi.testclient import TestClient
from pydantic import SecretStr

from app.captions import parse
from app.config import Settings
from app.db import Database
from app.download_worker import download_captions
from app.events import Events
from app.main import create_app
from app.media import Media, MediaError
from tests.helpers import authenticated_fixture

if TYPE_CHECKING:
    from pathlib import Path


def track(language: str = "nl") -> dict:
    return {
        "language": language,
        "kind": "manual",
        "status": "ready",
        "cues": [
            {
                "start": 1,
                "end": 4,
                "text": "Hallo mooie wereld",
                "words": [
                    {"text": "Hallo", "start": 1, "end": 2},
                    {"text": "mooie", "start": 2, "end": 3},
                    {"text": "wereld", "start": 3, "end": 4},
                ],
            }
        ],
    }


def source(media_id: str = "old") -> dict:
    return {"id": "video", "url": "https://example.com/video", "title": "Example", "duration": 10, "media_id": media_id}


@pytest.mark.parametrize("extension", ["vtt", "srt"])
def test_text_formats_markup_clamping_and_repeated_speech(tmp_path: Path, extension: str) -> None:
    path = tmp_path / ("caption." + extension)
    path.write_text(
        "WEBVTT\n\n00:00:01.000 --> 00:00:04.000\n<b>Hallo</b> &amp; wereld\n\n"
        "00:00:03.000 --> 00:00:05.000\nHallo &amp; wereld\n\n"
        "00:00:07,000 --> 00:00:12,000\nHallo &amp; wereld\n",
        encoding="utf8",
    )
    cues = parse(path, 10)
    assert len(cues) == 2
    assert cues[0] == {"text": "Hallo & wereld", "start": 1, "end": 5, "words": []}
    assert cues[1]["end"] == 10


def test_json_and_vtt_word_offsets(tmp_path: Path) -> None:
    path = tmp_path / "caption.json3"
    path.write_text(
        json.dumps(
            {
                "events": [
                    {
                        "tStartMs": 1000,
                        "dDurationMs": 3000,
                        "segs": [{"utf8": "Hallo ", "tOffsetMs": 0}, {"utf8": "wereld", "tOffsetMs": 1200}],
                    }
                ]
            }
        ),
        encoding="utf8",
    )
    cues = parse(path, 10)
    assert cues[0]["words"][1]["start"] == 2.2
    path = tmp_path / "caption.vtt"
    path.write_text("WEBVTT\n\n00:00:01.000 --> 00:00:04.000\nHallo <00:00:02.200>wereld\n", encoding="utf8")
    assert parse(path, 10)[0]["words"] == cues[0]["words"]


def test_malformed_and_bounded_tracks(tmp_path: Path) -> None:
    path = tmp_path / "caption.json3"
    path.write_text("broken", encoding="utf8")
    with pytest.raises(json.JSONDecodeError):
        parse(path, 10)
    path.write_text(
        json.dumps({"events": [{"tStartMs": 0, "dDurationMs": 1000, "segs": [{"utf8": "x"}]}]}), encoding="utf8"
    )
    with patch("app.captions.MAX_CUES", 0), pytest.raises(ValueError, match="too many"):
        parse(path, 10)
    with patch("app.captions.MAX_CAPTION_BYTES", 1), pytest.raises(ValueError, match="8 MB"):
        parse(path, 10)


def test_caption_search_persistence_atomic_replacement_and_deletion(tmp_path: Path) -> None:
    path = tmp_path / "db.sqlite3"
    db = Database(path)
    db.save_source(source(), [track(), track("en")])
    results = db.search_captions("MOOIE wereld", "nl", None, 0, 50)
    assert len(results) == 1
    assert results[0]["start"] == 2
    assert results[0]["precision"] == "word"
    assert db.search_captions('" OR *', "all", None, 0, 50) == []
    assert db.search_captions("wereld", "all", "missing", 0, 50) == []
    assert len(db.search_captions("wereld", "all", None, 1, 1)) == 1
    db.close()
    db = Database(path)
    assert len(db.search_captions("wereld", "all", None, 0, 50)) == 2
    db.save_source(source("new"), [])
    assert db.search_captions("wereld", "all", None, 0, 50) == []
    assert len(db.sources()) == 1
    db.save_source(source(), [track()])
    db.execute("DELETE FROM sources WHERE id=?", ("video",))
    assert db.search_captions("wereld", "all", None, 0, 50) == []
    db.close()


def test_manual_preference_automatic_fallback_and_partial_failure(tmp_path: Path) -> None:
    downloader = Mock()
    response = Mock()
    response.read.return_value = b"WEBVTT"
    downloader.urlopen.return_value.__enter__ = Mock(return_value=response)
    downloader.urlopen.return_value.__exit__ = Mock(return_value=False)
    info = {
        "subtitles": {"nl": [{"ext": "vtt", "url": "https://example.com/nl"}]},
        "automatic_captions": {
            "nl": [{"ext": "vtt", "url": "https://example.com/auto"}],
            "en": [{"ext": "vtt", "url": "https://example.com/en"}],
        },
    }
    tracks = download_captions(downloader, info, tmp_path)
    assert [item["kind"] for item in tracks] == ["manual", "automatic"]
    assert downloader.urlopen.call_args_list[0].args[0] == "https://example.com/nl"
    downloader.urlopen.side_effect = OSError
    assert all(item["status"] == "failed" for item in download_captions(downloader, info, tmp_path))
    assert all(item["status"] == "missing" for item in download_captions(downloader, {}, tmp_path))


def test_search_api_and_refresh_validation(tmp_path: Path) -> None:
    settings = Settings(_env_file=None, discord_token=SecretStr(""), data_dir=tmp_path)
    with TestClient(create_app(settings)) as client:
        authenticated_fixture(client.app)
        client.app.state.db.save_source(source(), [track()])
        response = client.get("/api/captions/search", params={"q": "wereld", "language": "nl"})
        assert response.json()["results"][0]["start"] == 3
        assert client.get("/api/captions/search", params={"q": "hello", "language": "de"}).status_code == 422
        assert client.get("/api/captions/search", params={"q": "hello", "limit": 51}).status_code == 422
        assert client.post("/api/sources/missing/refresh").status_code == 404
        client.app.state.media.busy = True
        assert client.post("/api/sources/video/refresh").status_code == 400


def test_refresh_failure_preserves_media_captions_and_clips(tmp_path: Path) -> None:
    async def verify() -> None:
        db = Database(tmp_path / "db.sqlite3")
        db.save_source(source(), [track()])
        settings = Settings(_env_file=None, discord_token=SecretStr(""), data_dir=tmp_path)
        folder = tmp_path / "media" / "old"
        folder.mkdir(parents=True)
        (folder / "video.mp4").write_bytes(b"original")
        db.execute(
            "INSERT INTO clips(id,source_id,name,emoji,tags,start,end,volume,created_at) VALUES (?,?,?,?,?,?,?,?,?)",
            ("clip", "video", "Saved", "", "[]", 1, 2, 1, 0),
        )
        media = Media(settings, db, Events())
        job = db.add_job(source()["url"])
        with (
            patch("app.media.public_addresses"),
            patch.object(media, "download", new=AsyncMock(side_effect=MediaError("Unavailable"))),
        ):
            await media.import_job(job, source()["url"], "video")
        assert db.jobs()[0]["status"] == "failed"
        assert (folder / "video.mp4").read_bytes() == b"original"
        assert len(db.clips()) == 1
        assert len(db.search_captions("wereld", "all", None, 0, 50)) == 1
        assert len(list(media.root.iterdir())) == 1
        db.close()

    asyncio.run(verify())


def test_refresh_success_switches_revision_and_keeps_saved_clips(tmp_path: Path) -> None:
    async def verify() -> None:
        db = Database(tmp_path / "db.sqlite3")
        db.save_source(source(), [track()])
        settings = Settings(_env_file=None, discord_token=SecretStr(""), data_dir=tmp_path)
        old = tmp_path / "media" / "old"
        old.mkdir(parents=True)
        (old / "video.mp4").write_bytes(b"original")
        saved = old.parent / "clip"
        saved.mkdir()
        (saved / "sound.wav").write_bytes(b"saved audio")
        db.execute(
            "INSERT INTO clips(id,source_id,name,emoji,tags,start,end,volume,created_at) VALUES (?,?,?,?,?,?,?,?,?)",
            ("clip", "video", "Saved", "", "[]", 1, 2, 1, 0),
        )
        media = Media(settings, db, Events())
        job = db.add_job(source()["url"])
        db.execute("UPDATE jobs SET source_id=? WHERE id=?", ("video", job))

        async def convert(_download: Path, folder: Path) -> None:
            (folder / "video.mp4").write_bytes(b"replacement")
            (folder / "audio.m4a").write_bytes(b"audio")

        with (
            patch("app.media.public_addresses"),
            patch.object(
                media,
                "download",
                new=AsyncMock(return_value={"file": "download.mp4", "title": "Refreshed", "captions": []}),
            ),
            patch.object(media, "convert_source", side_effect=convert),
            patch.object(media, "duration", new=AsyncMock(return_value=10)),
            patch.object(media, "make_peaks", new=AsyncMock()),
            patch.object(media, "make_thumbnail", new=AsyncMock()),
        ):
            await media.import_job(job, source()["url"], "video")
        current = db.sources()[0]
        assert current["id"] == "video"
        assert current["media_id"] != "old"
        assert (media.root / current["media_id"] / "video.mp4").read_bytes() == b"replacement"
        assert not old.exists()
        assert (saved / "sound.wav").read_bytes() == b"saved audio"
        assert db.jobs()[0]["source_id"] == "video"
        assert db.jobs()[0]["status"] == "complete"
        assert db.search_captions("wereld", "all", None, 0, 50) == []
        db.close()

    asyncio.run(verify())


def test_failed_database_replacement_rolls_back_caption_index(tmp_path: Path) -> None:
    db = Database(tmp_path / "db.sqlite3")
    db.save_source(source(), [track()])
    invalid = track()
    invalid["cues"][0].pop("text")
    with pytest.raises(KeyError, match="text"):
        db.save_source(source("new"), [invalid])
    assert db.sources()[0]["media_id"] == "old"
    assert len(db.search_captions("wereld", "all", None, 0, 50)) == 1
    db.close()


def test_fuzzy_prefix_search_order_and_word_timing(tmp_path: Path) -> None:
    db = Database(tmp_path / "search.sqlite3")
    db.save_source(source(), [track()])
    for query in ("wer", "werld", "MOOIE wer", "mooi wereld"):
        result = db.search_captions(query, "nl", None, 0, 50)
        assert len(result) == 1
        assert result[0]["precision"] == "word"
        assert result[0]["highlights"]
    assert db.search_captions("w", "all", None, 0, 50)
    assert not db.search_captions("wereld mooie", "all", None, 0, 50)
    assert not db.search_captions("werld", "en", None, 0, 50)
    assert not db.search_captions("!@#$", "all", None, 0, 50)
    db.close()
