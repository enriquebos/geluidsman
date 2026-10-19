from __future__ import annotations

import asyncio
import hashlib
import json
import shutil
import wave
from typing import TYPE_CHECKING
from unittest.mock import AsyncMock

import numpy as np
import pytest

from app.audio_processing import measure_loudness, process
from app.music_cache import MusicCache, cache_key
from app.music_normalization import POLICY_VERSION, media_version
from tests.test_music_cache import parts, song, until
from tests.test_music_player import player_parts

if TYPE_CHECKING:
    from pathlib import Path


def pcm(path: Path, samples: np.ndarray) -> None:
    with wave.open(str(path), "wb") as writer:
        writer.setparams((2, 2, 48000, 0, "NONE", "not compressed"))
        writer.writeframes(samples.astype("<i2").tobytes())


@pytest.fixture(scope="module")
def recordings(tmp_path_factory: pytest.TempPathFactory) -> dict[str, Path]:
    root = tmp_path_factory.mktemp("loudness")
    result = {}
    time = np.arange(4 * 48000) / 48000
    for name, amplitude in (
        ("quiet", 0.02),
        ("capped", 0.001),
        ("loud", 0.9),
        ("silent", 0),
        ("dynamic", 0.1),
        ("peak", 0.003),
    ):
        wave_samples = np.sin(time * 2 * np.pi * 440) * amplitude
        if name == "dynamic":
            wave_samples[:48000] *= 0.1
            wave_samples[-48000:] *= 3
        if name == "peak":
            wave_samples[96000] = 0.98
        samples = np.column_stack((wave_samples, wave_samples * 0.7)) * 32767
        original = root / (name + ".wav")
        pcm(original, samples)
        target = root / (name + ".m4a")
        asyncio.run(process([shutil.which("ffmpeg"), "-v", "error", "-i", original, "-c:a", "alac", target]))
        result[name] = target
    return result


async def decoded(sources: object, path: Path, gain: float, *, position: float = 0, volume: float = 1) -> bytes:
    result = {"stream": str(path), "container": "m4a", "track": music_track(), "normalization": {"gain_db": gain}}
    source = await sources.local_audio(result, position, volume)
    try:

        def read() -> bytes:
            chunks = []
            while chunk := source.read():
                chunks.append(chunk)
            return b"".join(chunks)

        return await asyncio.to_thread(read)
    finally:
        source.cleanup()
        await asyncio.to_thread(source.done.wait, 3)


def music_track(*, upload: bool = False) -> dict:
    track = song()
    track["duration"] = 4
    if upload:
        track.update(upload_id="a" * 64, upload_name="test.mp3")
    return track


def install(cache: MusicCache, path: Path, *, track: dict | None = None) -> tuple[str, dict]:
    track = track or music_track()
    key = cache_key(track)
    cache.root.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(path, cache.root / (key + ".part"))
    entry = {
        "original": track,
        "track": track,
        "container": "mp3" if track.get("upload_id") else "m4a",
        "bytes": path.stat().st_size,
    }
    cache.commit(key, entry)
    cache.entries[key] = entry
    return key, entry


@pytest.mark.parametrize("name", ["quiet", "capped", "loud", "dynamic", "silent", "peak"])
def test_constant_music_gain_preserves_pcm_seek_channels_and_master_volume(
    tmp_path: Path, recordings: dict, name: str
) -> None:
    async def verify() -> None:
        db, _store, sources, cache, _user = parts(tmp_path)
        path = recordings[name]
        original = hashlib.sha256(path.read_bytes()).hexdigest()
        measured = await measure_loudness(path, sources.settings.ffmpeg_path, music=True)
        gain = measured["gain_db"]
        assert gain <= 24
        baseline = np.frombuffer(await decoded(sources, path, 0), dtype="<i2").astype(np.int32)
        actual = np.frombuffer(await decoded(sources, path, gain), dtype="<i2").astype(np.int32)
        assert len(actual) == len(baseline) == 4 * 48000 * 2
        assert np.max(np.abs(actual - np.rint(baseline * 10 ** (gain / 20)))) <= 2
        half = np.frombuffer(await decoded(sources, path, gain, volume=0.5), dtype="<i2").astype(np.int32)
        assert np.max(np.abs(half - actual * 0.5)) <= 1
        seek = np.frombuffer(await decoded(sources, path, gain, position=1), dtype="<i2").astype(np.int32)
        assert np.max(np.abs(seek - actual[48000 * 2 :])) <= 1
        output = tmp_path / "measured.wav"
        pcm(output, actual)
        result = await measure_loudness(output, sources.settings.ffmpeg_path, music=True)
        assert result["true_peak_dbfs"] is None or result["true_peak_dbfs"] <= -1.99
        if name == "silent":
            assert gain == 0
            assert not np.any(actual)
        elif name in {"peak", "capped"}:
            assert result["integrated_lufs"] < -16
            if name == "capped":
                assert gain == 24
        else:
            assert abs(result["integrated_lufs"] + 16) < 0.15
        assert hashlib.sha256(path.read_bytes()).hexdigest() == original
        await cache.close()
        await sources.close()
        db.close()

    asyncio.run(verify())


def test_backfill_persists_deduplicates_and_skips_current_policy_on_restart(
    tmp_path: Path, recordings: dict, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def verify() -> None:
        db, store, sources, cache, _user = parts(tmp_path)
        key, entry = install(cache, recordings["quiet"])
        analyze = AsyncMock(wraps=measure_loudness)
        monkeypatch.setattr("app.music_normalization.measure_loudness", analyze)
        cache.normalization.start()
        cache.normalization.enqueue(key)
        cache.normalization.enqueue(key)
        await until(lambda: entry["normalization"]["state"] == "ready")
        assert analyze.await_count == 1
        assert entry["normalization"]["policy"] == POLICY_VERSION
        assert entry["normalization"]["media_version"] == media_version(cache.root / (key + ".audio"))
        await cache.close()
        restored = MusicCache(db, sources, store, cache.events)
        restored.load()
        restored.normalization.start()
        await asyncio.sleep(0.1)
        assert analyze.await_count == 1
        assert restored.entries[key]["normalization"] == entry["normalization"]
        alias = {
            **music_track(),
            "provider": "spotify",
            "source_id": "z" * 22,
            "youtube_id": music_track()["source_id"],
        }
        assert restored.entry_key(alias) == key
        assert (await restored.local(alias))["normalization"]["gain_db"] == entry["normalization"]["gain_db"]
        await restored.close()
        await sources.close()
        db.close()

    asyncio.run(verify())


def test_policy_change_and_same_size_media_replacement_reanalyse(
    tmp_path: Path, recordings: dict, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def verify() -> None:
        db, _store, sources, cache, _user = parts(tmp_path)
        key, entry = install(cache, recordings["quiet"])
        measured = {"integrated_lufs": -30.0, "true_peak_dbfs": -20.0, "gain_db": 14.0}
        analyze = AsyncMock(return_value=measured)
        monkeypatch.setattr("app.music_normalization.measure_loudness", analyze)
        cache.normalization.start()
        await until(lambda: entry["normalization"]["state"] == "ready")
        version = entry["normalization"]["media_version"]
        path = cache.root / (key + ".audio")
        data = path.read_bytes()
        path.write_bytes(data)
        await cache.local(entry["track"])
        await until(lambda: analyze.await_count == 2 and entry["normalization"]["state"] == "ready")
        assert entry["normalization"]["media_version"] != version
        entry["normalization"]["policy"] = 0
        await cache.local(entry["track"])
        await until(lambda: analyze.await_count == 3 and entry["normalization"]["state"] == "ready")
        await cache.close()
        await sources.close()
        db.close()

    asyncio.run(verify())


def test_interrupted_backfill_resumes_and_download_priority_preempts(
    tmp_path: Path, recordings: dict, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def verify() -> None:
        db, store, sources, cache, _user = parts(tmp_path)
        key, entry = install(cache, recordings["quiet"])
        started, cancelled = asyncio.Event(), asyncio.Event()

        async def hold(*_args: object, **_kwargs: object) -> dict:
            started.set()
            try:
                await asyncio.Event().wait()
            finally:
                cancelled.set()

        monkeypatch.setattr("app.music_normalization.measure_loudness", hold)
        cache.normalization.start()
        await started.wait()
        cache.required[key] = entry["track"]
        await asyncio.wait_for(cancelled.wait(), 2)
        await cache.close()
        assert json.loads((cache.root / (key + ".json")).read_text())["normalization"]["state"] == "queued"
        restored = MusicCache(db, sources, store, cache.events)
        restored.load()
        monkeypatch.setattr("app.music_normalization.measure_loudness", measure_loudness)
        restored.normalization.start()
        await until(lambda: restored.entries[key]["normalization"]["state"] == "ready")
        await restored.close()
        await sources.close()
        db.close()

    asyncio.run(verify())


def test_failure_is_persisted_and_explicit_retry_keeps_original_file(
    tmp_path: Path, recordings: dict, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def verify() -> None:
        db, store, sources, cache, _user = parts(tmp_path)
        key, entry = install(cache, recordings["quiet"])
        before = (cache.root / (key + ".audio")).read_bytes()
        monkeypatch.setattr("app.music_normalization.measure_loudness", AsyncMock(side_effect=TimeoutError))
        cache.normalization.start()
        await until(lambda: entry["normalization"]["state"] == "failed")
        await cache.close()
        restored = MusicCache(db, sources, store, cache.events)
        restored.load()
        analyze = AsyncMock(wraps=measure_loudness)
        monkeypatch.setattr("app.music_normalization.measure_loudness", analyze)
        restored.normalization.start()
        await asyncio.sleep(0.1)
        analyze.assert_not_awaited()
        await restored.retry_verified([entry["track"]])
        await until(lambda: restored.entries[key]["normalization"]["state"] == "ready")
        assert (cache.root / (key + ".audio")).read_bytes() == before
        await restored.close()
        await sources.close()
        db.close()

    asyncio.run(verify())


def test_replacement_during_analysis_rejects_obsolete_result(
    tmp_path: Path, recordings: dict, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def verify() -> None:
        db, _store, sources, cache, _user = parts(tmp_path)
        key, old = install(cache, recordings["quiet"])
        release = asyncio.Event()

        async def hold(*_args: object, **_kwargs: object) -> dict:
            await release.wait()
            return {"integrated_lufs": -30.0, "true_peak_dbfs": -20.0, "gain_db": 14.0}

        cache.normalization.start()
        monkeypatch.setattr("app.music_normalization.measure_loudness", hold)
        await until(lambda: cache.normalization.active == key)
        await asyncio.sleep(0.05)
        _, new = install(cache, recordings["loud"])
        monkeypatch.setattr("app.music_normalization.measure_loudness", measure_loudness)
        release.set()
        await until(lambda: new["normalization"]["state"] == "ready")
        assert new["normalization"]["gain_db"] < 0
        assert old is not new
        assert json.loads((cache.root / (key + ".json")).read_text())["normalization"] == new["normalization"]
        await cache.close()
        await sources.close()
        db.close()

    asyncio.run(verify())


def test_playing_source_keeps_gain_through_backfill_master_changes_and_seek(
    tmp_path: Path, recordings: dict, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def verify() -> None:
        db, _store, sources, cache, _user = parts(tmp_path)
        key, entry = install(cache, recordings["quiet"])
        player, _memory, _fake_sources, voice = player_parts()
        player.sources = sources
        release = asyncio.Event()

        async def hold(*args: object, **kwargs: object) -> dict:
            await release.wait()
            return await measure_loudness(*args, **kwargs)

        monkeypatch.setattr("app.music_normalization.measure_loudness", hold)
        cache.normalization.start()
        await player.start()
        await player.enqueue([music_track()], {"id": "100", "name": "Listener"})
        await player.command("play")
        await until(lambda: player.state == "playing")
        original = player.source
        assert original.music_normalization["gain_db"] == 0
        before = await asyncio.to_thread(original.read)
        release.set()
        for _ in range(100):
            assert len(await asyncio.to_thread(original.read)) == len(before) == 3840
            assert player.source is original
            assert original.music_normalization["gain_db"] == 0
            await asyncio.sleep(0.02)
        await until(lambda: entry["normalization"]["state"] == "ready")
        assert player.source is original
        assert original.music_normalization["gain_db"] == 0
        assert not original.done.is_set()
        voice.master_volume = 0.25
        player.update_volume()
        assert original.volume == 0.25
        assert len(await asyncio.to_thread(original.read)) == len(before) == 3840
        await player.command("seek", 1)
        await until(lambda: player.state == "playing")
        assert player.source.music_normalization["gain_db"] == 0
        await player.command("pause")
        await player.command("play")
        await until(lambda: player.state == "playing")
        assert player.source.music_normalization["gain_db"] == 0
        await player.command("stop")
        await player.command("play")
        await until(lambda: player.state == "playing")
        assert player.source.music_normalization["gain_db"] == entry["normalization"]["gain_db"]
        assert player.source.volume == 0.25
        assert cache.entry_key(player.current["track"]) == key
        await player.close()
        await cache.close()
        await sources.close()
        db.close()

    asyncio.run(verify())


@pytest.mark.parametrize("failure", ["corrupt", "missing", "manifest"])
def test_analysis_failure_does_not_remove_recordings_or_leave_partial_manifests(
    tmp_path: Path, recordings: dict, monkeypatch: pytest.MonkeyPatch, failure: str
) -> None:
    async def verify() -> None:
        db, _store, sources, cache, _user = parts(tmp_path)
        key, entry = install(cache, recordings["quiet"])
        path = cache.root / (key + ".audio")
        if failure == "corrupt":
            path.write_bytes(b"invalid audio")
        elif failure == "missing":
            path.unlink()
        else:
            replace = type(path).replace

            def fail_replace(self: Path, target: Path) -> Path:
                if str(self).endswith(".json.part"):
                    message = "Disk full"
                    raise OSError(message)
                return replace(self, target)

            monkeypatch.setattr(type(path), "replace", fail_replace)
        cache.normalization.start()
        await until(lambda: entry["normalization"]["state"] == "failed")
        await cache.close()
        assert path.exists() == (failure != "missing")
        assert not list(cache.root.glob("*.part"))
        assert cache.status(entry["track"])["normalization"]["state"] == "failed"
        await sources.close()
        db.close()

    asyncio.run(verify())


def test_backfill_uses_one_worker_and_yields_to_playback_preparation(
    tmp_path: Path, recordings: dict, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def verify() -> None:
        db, _store, sources, cache, _user = parts(tmp_path)
        for identity in ("abcdefghijk", "lmnopqrstuv", "zyxwvutsrqp"):
            install(cache, recordings["quiet"], track={**music_track(), "source_id": identity})
        active = maximum = calls = 0

        async def measure(*args: object, **kwargs: object) -> dict:
            nonlocal active, maximum, calls
            active += 1
            calls += 1
            maximum = max(maximum, active)
            try:
                await asyncio.sleep(0.3)
                return await measure_loudness(*args, **kwargs)
            finally:
                active -= 1

        monkeypatch.setattr("app.music_normalization.measure_loudness", measure)
        cache.normalization.preparing = 1
        cache.normalization.start()
        await asyncio.sleep(0.05)
        assert calls == 0
        cache.normalization.preparing = 0
        cache.normalization.wake.set()
        await until(lambda: all(entry["normalization"]["state"] == "ready" for entry in cache.entries.values()))
        assert maximum == 1
        assert calls == 3
        await cache.close()
        await sources.close()
        db.close()

    asyncio.run(verify())
