from __future__ import annotations

from unittest.mock import patch

import pytest
from yt_dlp.networking import Request

from app.download_worker import GuardedDownloader
from app.network import UnsafeURLError


def test_extractor_cannot_bypass_proxy() -> None:
    with GuardedDownloader({"proxy": "http://127.0.0.1:54321", "quiet": True}) as downloader:
        request = Request(
            "https://example.com/media", proxies={"https": None}, headers={"Ytdl-Request-Proxy": "__noproxy__"}
        )
        with patch.object(GuardedDownloader.__bases__[0], "urlopen", return_value="response") as base:
            assert downloader.urlopen(request) == "response"
            assert request.proxies["https"] == "http://127.0.0.1:54321"
            assert "Ytdl-Request-Proxy" not in request.headers
            base.assert_called_once()
        with pytest.raises(UnsafeURLError):
            downloader.urlopen("ftp://example.com/secret")
