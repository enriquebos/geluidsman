from __future__ import annotations

import contextlib
import ipaddress
import select
import socket
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Self, TypeAlias
from urllib.parse import SplitResult, urlsplit

AddressInfo: TypeAlias = tuple[int, int, int, str, tuple[str, int] | tuple[str, int, int, int]]
MAX_REQUEST_BYTES = 2_000_000


class UnsafeURLError(ValueError):
    pass


def validate_url(url: str) -> SplitResult:
    try:
        parsed = urlsplit(url)
        port = parsed.port or (443 if parsed.scheme == "https" else 80)
    except ValueError as exc:
        msg = "Invalid source URL."
        raise UnsafeURLError(msg) from exc
    if parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.username or parsed.password:
        msg = "Use a public HTTP or HTTPS URL without embedded credentials."
        raise UnsafeURLError(msg)
    if port not in (80, 443):
        msg = "Only standard HTTP and HTTPS ports are supported."
        raise UnsafeURLError(msg)
    return parsed


def public_addresses(host: str, port: int) -> list[AddressInfo]:
    try:
        addresses = socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except OSError as exc:
        msg = "Source hostname could not be resolved."
        raise UnsafeURLError(msg) from exc
    if not addresses:
        msg = "Source hostname could not be resolved."
        raise UnsafeURLError(msg)
    for _, _, _, _, address in addresses:
        ip = ipaddress.ip_address(address[0].split("%")[0])
        mapped = getattr(ip, "ipv4_mapped", None)
        if not ip.is_global or ip.is_multicast or (mapped is not None and not mapped.is_global):
            msg = "Local and private network destinations are not allowed."
            raise UnsafeURLError(msg)
    return addresses


class DownloadProxy:
    def __init__(self, byte_limit: int, timeout: int) -> None:
        self.limit = byte_limit
        self.received = 0
        self.deadline = time.monotonic() + timeout
        self.block_reason = None
        self.lock = threading.Lock()

        self.server = ProxyServer(self)
        self.server.daemon_threads = True
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    def __enter__(self) -> Self:
        self.thread.start()
        return self

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.server.server_port}"

    def __exit__(self, *args: object) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)


class ProxyHandler(BaseHTTPRequestHandler):
    @property
    def owner(self) -> DownloadProxy:
        return self.server.owner

    protocol_version = "HTTP/1.1"

    def log_message(self, *args: object) -> None:
        pass

    def connect_public(self, host: str, port: int) -> socket.socket:
        if port not in (80, 443):
            msg = "Only standard HTTP and HTTPS ports are supported."
            raise UnsafeURLError(msg)
        addresses = public_addresses(host, port)
        for family, kind, proto, _, address in addresses:
            upstream = socket.socket(family, kind, proto)
            upstream.settimeout(15)
            try:
                upstream.connect(address)
                return upstream
            except OSError:
                upstream.close()
            else:
                return upstream
        msg = "Unable to connect to source."
        raise OSError(msg)

    def relay(self, upstream: socket.socket) -> None:
        self.connection.settimeout(15)
        while time.monotonic() < self.owner.deadline:
            readable, _, _ = select.select([self.connection, upstream], [], [], 1)
            for sock in readable:
                chunk = sock.recv(65536)
                if not chunk:
                    return
                if sock is upstream:
                    with self.owner.lock:
                        self.owner.received += len(chunk)
                        if self.owner.received > self.owner.limit:
                            self.owner.block_reason = "Import exceeds the configured download size limit."
                            return
                target = upstream if sock is self.connection else self.connection
                target.sendall(chunk)

    def do_CONNECT(self) -> None:
        upstream = None
        try:
            parsed = urlsplit("https://" + self.path)
            if parsed.username or parsed.password or parsed.path:
                msg = "Invalid tunnel destination."
                raise UnsafeURLError(msg)
            upstream = self.connect_public(parsed.hostname, parsed.port or 443)
            self.send_response(200, "Connection Established")
            self.end_headers()
            self.wfile.flush()
            self.relay(upstream)
        except (ValueError, OSError):
            self.owner.block_reason = "Source connection failed or used a blocked network destination."
            with contextlib.suppress(OSError):
                self.send_error(502)
        finally:
            self.close_connection = True
            if upstream:
                upstream.close()

    def forward(self) -> None:
        upstream = None
        try:
            parsed = validate_url(self.path)
            if parsed.scheme != "http":
                msg = "HTTPS must use a validated tunnel."
                raise UnsafeURLError(msg)
            upstream = self.connect_public(parsed.hostname, parsed.port or 80)
            path = parsed.path or "/"
            if parsed.query:
                path += "?" + parsed.query
            lines = [f"{self.command} {path} HTTP/1.1", f"Host: {parsed.netloc}", "Connection: close"]
            for key, value in self.headers.items():
                if key.lower() not in (
                    "host",
                    "connection",
                    "proxy-connection",
                    "proxy-authorization",
                    "transfer-encoding",
                ):
                    lines.append(f"{key}: {value}")
            upstream.sendall(("\r\n".join(lines) + "\r\n\r\n").encode("latin1"))
            length = int(self.headers.get("Content-Length", 0))
            if length < 0 or length > MAX_REQUEST_BYTES or self.headers.get("Transfer-Encoding"):
                msg = "Unsupported source request."
                raise UnsafeURLError(msg)
            if length:
                upstream.sendall(self.rfile.read(length))
            self.relay(upstream)
        except (ValueError, OSError):
            self.owner.block_reason = "Source connection failed or used a blocked network destination."
            with contextlib.suppress(OSError):
                self.send_error(502)
        finally:
            self.close_connection = True
            if upstream:
                upstream.close()

    do_GET = forward
    do_POST = forward
    do_HEAD = forward


class ProxyServer(ThreadingHTTPServer):
    def __init__(self, owner: DownloadProxy) -> None:
        self.owner = owner
        super().__init__(("127.0.0.1", 0), ProxyHandler)
