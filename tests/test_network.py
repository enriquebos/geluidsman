from __future__ import annotations

import socket
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch

import pytest
import requests

from app.network import DownloadProxy, UnsafeURLError, public_addresses, validate_url


@pytest.mark.parametrize(
    "url",
    [
        "file:///etc/passwd",
        "ftp://example.com/a",
        "https://u:p@example.com/",
        "http://example.com:8000/",
        "javascript:alert(1)",
    ],
)
def test_blocked_schemes_credentials_and_ports(url: str) -> None:
    with pytest.raises(UnsafeURLError):
        validate_url(url)


@pytest.mark.parametrize(
    "address",
    ["127.0.0.1", "10.0.0.1", "192.168.1.2", "169.254.169.254", "::1", "fc00::1", "::ffff:127.0.0.1", "0.0.0.0"],
)
def test_private_dns_blocked(address: str) -> None:
    with (
        patch("socket.getaddrinfo", return_value=[(socket.AF_INET, socket.SOCK_STREAM, 6, "", (address, 80))]),
        pytest.raises(UnsafeURLError),
    ):
        public_addresses("example.com", 80)


def test_mixed_dns_is_rejected() -> None:
    with (
        patch("socket.getaddrinfo", return_value=[(2, 1, 6, "", ("8.8.8.8", 443)), (2, 1, 6, "", ("127.0.0.1", 443))]),
        pytest.raises(UnsafeURLError),
    ):
        public_addresses("example.com", 443)


def test_proxy_blocks_private_http_and_https() -> None:
    with DownloadProxy(100000, 30) as proxy:
        response = requests.get("http://127.0.0.1/private", proxies={"http": proxy.url}, timeout=3)
        assert response.status_code == 502
        with pytest.raises(requests.exceptions.ProxyError):
            requests.get("https://127.0.0.1/private", proxies={"https": proxy.url}, timeout=3)
        assert proxy.block_reason


def test_redirect_is_checked_again_and_budget_is_enforced() -> None:
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args: object) -> None:
            pass

        def do_GET(self) -> None:
            if self.path == "/redirect":
                self.send_response(302)
                self.send_header("Location", "http://127.0.0.1/private")
                self.send_header("Content-Length", "0")
                self.end_headers()
            else:
                self.send_response(200)
                self.send_header("Content-Length", "10000")
                self.end_headers()
                self.wfile.write(b"x" * 10000)

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    checked = []

    def resolve(host: str, _port: int) -> list[tuple[int, int, int, str, tuple[str, int]]]:
        checked.append(host)
        if host != "public.test":
            msg = "Blocked private destination."
            raise UnsafeURLError(msg)

        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", server.server_port))]

    try:
        with patch("app.network.public_addresses", side_effect=resolve), DownloadProxy(100000, 30) as proxy:
            response = requests.get("http://public.test/redirect", proxies={"http": proxy.url}, timeout=3)
            assert response.status_code == 502
            assert checked == ["public.test", "127.0.0.1"]
        with patch("app.network.public_addresses", side_effect=resolve), DownloadProxy(100, 30) as proxy:
            with pytest.raises(requests.RequestException):
                requests.get("http://public.test/large", proxies={"http": proxy.url}, timeout=3)
            assert proxy.block_reason == "Import exceeds the configured download size limit."
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)
