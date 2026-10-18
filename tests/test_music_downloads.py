from __future__ import annotations

import asyncio
import socket
import threading
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from types import SimpleNamespace
from typing import TYPE_CHECKING, ClassVar
from unittest.mock import patch

import pytest

from app.music_sources import DOWNLOAD_CHUNK_BYTES, MusicSourceError, MusicSources
from app.network import DownloadProxy

if TYPE_CHECKING:
    from pathlib import Path


class RecordingHandler(BaseHTTPRequestHandler):
    payload = b"recording" * 350_000
    requests: ClassVar[list[tuple[str, str | None]]] = []

    def log_message(self, *args: object) -> None:
        pass

    def do_GET(self) -> None:
        value = self.headers.get("Range", "")
        self.requests.append((value, self.headers.get("If-Range")))
        start, end = map(int, value.removeprefix("bytes=").split("-"))
        end = min(len(self.payload) - 1, end)
        total = len(self.payload)
        if self.path == "/ignored":
            start, end = 0, len(self.payload) - 1
        if self.path == "/changed" and start:
            total += 1
        payload = self.payload[start:end] if self.path == "/truncated" else self.payload[start : end + 1]
        self.send_response(HTTPStatus.OK if self.path == "/ignored" else HTTPStatus.PARTIAL_CONTENT)
        if self.path != "/ignored":
            self.send_header("Content-Range", f"bytes {start}-{end}/{total}")
        if self.path != "/truncated":
            self.send_header("Content-Length", str(len(payload)))
        self.send_header("ETag", '"changed"' if self.path == "/validator" and start else '"recording"')
        self.end_headers()
        self.wfile.write(payload)


@pytest.mark.parametrize("endpoint", ["normal", "ignored", "changed", "truncated", "validator"])
def test_guarded_download_ranges_preserve_order_and_reject_inconsistent_audio(tmp_path: Path, endpoint: str) -> None:
    RecordingHandler.requests = []
    server = ThreadingHTTPServer(("127.0.0.1", 0), RecordingHandler)
    server_thread = threading.Thread(target=server.serve_forever, daemon=True)
    server_thread.start()
    proxy = DownloadProxy(len(RecordingHandler.payload) + 1_000_000, 20)
    proxy.__enter__()
    addresses = [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", server.server_port))]
    path = tmp_path / "download.part"

    async def transfer() -> int:
        return await MusicSources.download_stream(
            "http://public.test/" + endpoint, path, proxy, len(RecordingHandler.payload) + 1024
        )

    try:
        with patch("app.network.public_addresses", return_value=addresses):
            if endpoint in {"changed", "truncated", "validator"}:
                with pytest.raises(MusicSourceError) as failure:
                    asyncio.run(transfer())
                assert failure.value.details["reason"] == ("early_eof" if endpoint == "truncated" else "invalid_media")
            else:
                assert asyncio.run(transfer()) == len(RecordingHandler.payload)
                assert path.read_bytes() == RecordingHandler.payload
            if endpoint == "normal":
                assert RecordingHandler.requests == [
                    ("bytes=0-1048575", None),
                    ("bytes=1048576-2097151", '"recording"'),
                    ("bytes=2097152-3145727", '"recording"'),
                    ("bytes=3145728-4194303", '"recording"'),
                ]
            if endpoint == "ignored":
                assert len(RecordingHandler.requests) == 1
            if endpoint in {"normal", "ignored"}:
                assert not proxy.block_reason
    finally:
        proxy.__exit__()
        server.shutdown()
        server.server_close()
        server_thread.join(timeout=2)


@pytest.mark.parametrize(
    ("offset", "previous", "content_range", "length", "reason"),
    [
        (0, None, "bytes 1-1048575/2097152", 1048575, "invalid_media"),
        (0, None, "bytes 0-1048576/2097152", 1048577, "invalid_media"),
        (0, None, "bytes 0-1048575/*", DOWNLOAD_CHUNK_BYTES, "invalid_media"),
        (0, None, "bytes 0-1048575/2097152", 10, "invalid_media"),
        (0, None, "bytes 0-1048575/9000000", DOWNLOAD_CHUNK_BYTES, "storage_limit"),
        (DOWNLOAD_CHUNK_BYTES, 2097152, "bytes 1048576-2097151/2097153", DOWNLOAD_CHUNK_BYTES, "invalid_media"),
        (2097152, 2097152, "bytes 2097152-2097152/2097152", 1, "invalid_media"),
    ],
)
def test_invalid_download_range_headers_are_rejected_before_writing(
    offset: int, previous: int | None, content_range: str, length: int, reason: str
) -> None:
    response = SimpleNamespace(
        status=HTTPStatus.PARTIAL_CONTENT, content_length=length, headers={"Content-Range": content_range}
    )
    with pytest.raises(MusicSourceError) as failure:
        MusicSources.download_range(response, offset, previous, 3_000_000)
    assert failure.value.details["reason"] == reason


def test_repeated_full_response_cannot_duplicate_already_downloaded_ranges() -> None:
    response = SimpleNamespace(status=HTTPStatus.OK, content_length=100, headers={})
    with pytest.raises(MusicSourceError) as failure:
        MusicSources.download_range(response, DOWNLOAD_CHUNK_BYTES, 2 * DOWNLOAD_CHUNK_BYTES, 3_000_000)
    assert failure.value.details["reason"] == "invalid_media"


@pytest.mark.parametrize("etag", ['W/"weak"', "invalid", ""])
def test_weak_or_invalid_etag_uses_stable_last_modified_for_range_requests(etag: str) -> None:
    response = SimpleNamespace(headers={"ETag": etag, "Last-Modified": "Wed, 21 Oct 2015 07:28:00 GMT"})
    validator = MusicSources.download_validator(response, None)
    assert validator == ("Last-Modified", "Wed, 21 Oct 2015 07:28:00 GMT")
    assert MusicSources.download_validator(response, validator) == validator
    response.headers["Last-Modified"] = "Thu, 22 Oct 2015 07:28:00 GMT"
    with pytest.raises(MusicSourceError) as failure:
        MusicSources.download_validator(response, validator)
    assert failure.value.details["reason"] == "invalid_media"
