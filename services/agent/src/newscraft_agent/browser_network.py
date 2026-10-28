"""Bounded public resources for a network-disabled Chromium sandbox.

This gateway performs one HTTP hop. Chromium retains the page's real origin and
handles redirects, while every hop is separately checked here. It deliberately
does not use a browser profile, an HTTP client's ambient authentication, proxy
environment variables, or host cookies. Only GET and HEAD are permitted.
"""
from __future__ import annotations

import asyncio
from asyncio import selector_events, sslproto
import hashlib
import ipaddress
import math
import re
import socket
import ssl
import sys
import zlib
from dataclasses import dataclass
from typing import Mapping
from urllib.parse import quote, urljoin, urlsplit, urlunsplit

MAX_RESOURCE_BYTES = 2 * 1024 * 1024
MAX_HEADER_BYTES = 64 * 1024
MAX_HEADER_LINE_BYTES = 8192
MAX_HEADER_COUNT = 100
MAX_CHUNKS = 4096
# Reserve this before a request, including failures. The application protocol
# receives at most 64 KiB per callback and aborts above 3 MiB delivered plaintext.
# TLS may also hold encrypted or decrypted records not delivered to that reader;
# this conservative reservation includes its bounded pending data and overshoot.
MAX_RESOURCE_WIRE_BYTES = 4 * 1024 * 1024
MAX_RECEIVED_HTTP_BYTES = 3 * 1024 * 1024
_RECEIVE_CHUNK_BYTES = 64 * 1024
_TLS_BUFFER_BYTES = 256 * 1024
_TOKEN = re.compile(rb"^[!#$%&'*+.^_`|~0-9A-Za-z-]+$")
_STATUS = re.compile(rb"^HTTP/1\.[01] ([1-5][0-9]{2})(?: [\x20-\x7e]*)?\r\n$")
# Standard translation/tunnelling ranges can encode a private IPv4 destination
# despite is_global() being true. Custom NAT64 prefixes require the operator's
# outbound network policy; they cannot be discovered from an address alone.
_TRANSITION_NETWORKS = tuple(ipaddress.ip_network(value) for value in (
    "64:ff9b::/96", "64:ff9b:1::/48", "::ffff:0:0:0/96", "2002::/16", "2001::/32",
))
_REQUEST_HEADERS = {"accept", "accept-language", "user-agent", "origin"}
_RESPONSE_HEADERS = {
    "content-type", "content-language", "cache-control", "expires", "pragma",
    "etag", "last-modified", "vary", "location", "accept-ranges",
    "access-control-allow-origin", "access-control-allow-methods",
    "access-control-allow-headers", "access-control-expose-headers",
    "access-control-max-age", "cross-origin-resource-policy",
    "cross-origin-opener-policy", "cross-origin-embedder-policy",
    "content-security-policy", "content-security-policy-report-only",
    "x-frame-options", "x-content-type-options", "referrer-policy",
    "permissions-policy",
}
# These fields are legal to repeat but must never reach the browser profile.
_DISCARDED_RESPONSE_HEADERS = {
    "set-cookie", "set-cookie2", "www-authenticate", "proxy-authenticate",
    "authentication-info", "proxy-authentication-info",
}
# Join only fields whose HTTP grammar permits a comma-separated list. In
# particular, Allow-Origin and all representation/framing fields stay single.
_LIST_RESPONSE_HEADERS = {
    "cache-control", "vary", "pragma", "content-language", "accept-ranges",
    "access-control-allow-methods", "access-control-allow-headers",
    "access-control-expose-headers", "content-security-policy",
    "content-security-policy-report-only", "referrer-policy",
}


class BrowserNetworkError(RuntimeError):
    """A public resource could not safely be fetched."""


def browser_runtime_supported():
    return sys.implementation.name == "cpython" and sys.version_info[:2] == (3, 11)


def require_browser_runtime():
    # The wire-memory bound below relies on audited CPython stdlib internals.
    # Fail before admitting a browser, including when uvloop is installed.
    if not browser_runtime_supported() or type(asyncio.get_running_loop()) is not asyncio.SelectorEventLoop:
        raise BrowserNetworkError("Browser access requires CPython 3.11 with the stdlib asyncio selector loop.")


@dataclass(frozen=True)
class GatewayResponse:
    url: str
    status: int
    headers: dict[str, str]
    body: bytes
    sha256: str
    # Delivered HTTP response bytes, including unread data. Success requires
    # confirmed clean shutdown; unknown discarded TLS data fails and spends the
    # full reservation. None keeps synthetic five-argument fixtures valid.
    wire_bytes: int | None = None


class _CountingReader(asyncio.StreamReader):
    def __init__(self, *, limit: int):
        super().__init__(limit=limit)
        self.received_bytes = 0
        self.wire_limit_exceeded = False

    def feed_data(self, data: bytes) -> None:
        self.received_bytes += len(data)
        if self.received_bytes > MAX_RECEIVED_HTTP_BYTES:
            self.wire_limit_exceeded = True
            self.set_exception(BrowserNetworkError("Browser received HTTP resource exceeds 3 MiB"))
            if self._transport is not None:
                self._transport.abort()
            return
        super().feed_data(data)


class _GatewayProtocol(asyncio.StreamReaderProtocol, asyncio.BufferedProtocol):
    """Fix receive callback size for both plain TCP and asyncio TLS transports."""

    def __init__(self, reader: _CountingReader):
        super().__init__(reader)
        self.reader = reader
        self.receive_buffer = bytearray(_RECEIVE_CHUNK_BYTES)

    def get_buffer(self, sizehint: int) -> memoryview:
        return memoryview(self.receive_buffer)

    def buffer_updated(self, nbytes: int) -> None:
        if not 0 <= nbytes <= len(self.receive_buffer):
            self.reader.set_exception(BrowserNetworkError("Browser transport buffer is invalid"))
            if self.reader._transport is not None:
                self.reader._transport.abort()
            return
        self.reader.feed_data(bytes(self.receive_buffer[:nbytes]))


async def _open_connection(host: str, port: int, *, limit: int, **options):
    """The stdlib open_connection recipe, with a bounded counting reader."""
    loop = asyncio.get_running_loop()
    reader = _CountingReader(limit=limit)
    protocol = _GatewayProtocol(reader)
    transport, _ = await loop.create_connection(lambda: protocol, host, port, **options)
    if options.get("ssl"):
        try:
            _validate_tls_transport(transport, protocol)
        except BrowserNetworkError:
            transport.abort()
            raise
    return reader, asyncio.StreamWriter(transport, protocol, reader, loop)


def _validate_tls_transport(transport, protocol: _GatewayProtocol) -> None:
    """Fail closed if this interpreter's TLS buffering exceeds audited bounds.

    Delivered plaintext <=3 MiB+64 KiB, incoming ciphertext <=2*256 KiB,
    one final shutdown callback <=256 KiB and an internal TLS record allowance
    <=64 KiB fit below the 4 MiB reservation. Compression must stay disabled.
    Private stdlib fields are checked rather than assumed across Python releases.
    """
    tls = getattr(transport, "_ssl_protocol", None)
    try:
        context = transport.get_extra_info("sslcontext")
        valid = (browser_runtime_supported()
            and type(tls) is sslproto.SSLProtocol
            and type(tls._transport) is selector_events._SelectorSocketTransport
            and 0 < tls.max_size <= _TLS_BUFFER_BYTES
            and 0 < tls._incoming_high_water <= _TLS_BUFFER_BYTES
            and 0 <= tls._incoming_low_water <= tls._incoming_high_water
            and len(tls._ssl_buffer_view) <= _TLS_BUFFER_BYTES
            and tls._app_protocol is protocol and tls._app_protocol_is_buffer
            and len(protocol.receive_buffer) == _RECEIVE_CHUNK_BYTES
            and isinstance(context, ssl.SSLContext)
            and bool(context.options & ssl.OP_NO_COMPRESSION)
            and context.minimum_version >= ssl.TLSVersion.TLSv1_2)
    except (AttributeError, TypeError, ValueError):
        valid = False
    if not valid:
        raise BrowserNetworkError("Browser HTTPS requires the audited Python 3.11 stdlib TLS transport contract")


def _public_ip(value: str) -> str:
    if not isinstance(value, str) or "%" in value:
        raise BrowserNetworkError("Browser destination has an invalid address")
    try:
        address = ipaddress.ip_address(value)
    except ValueError as exc:
        raise BrowserNetworkError("Browser destination has an invalid address") from exc
    mapped = getattr(address, "ipv4_mapped", None)
    if (not address.is_global or address.is_multicast or address.is_unspecified
            or getattr(address, "is_site_local", False)
            or (mapped is not None and not mapped.is_global)
            or (address.version == 6 and any(address in network for network in _TRANSITION_NETWORKS))):
        raise BrowserNetworkError("Browser cannot contact private, local, or metadata services")
    return str(address)


def _public_url(value: str) -> tuple[str, str, int]:
    if (not isinstance(value, str) or not value or len(value) > 8192
            or any(ord(char) <= 32 or ord(char) == 127 for char in value)
            or "\\" in value):
        raise BrowserNetworkError("Browser URL is invalid")
    try:
        parsed = urlsplit(value)
        host = parsed.hostname
        parsed_port = parsed.port
        port = parsed_port if parsed_port is not None else (443 if parsed.scheme == "https" else 80)
        if (parsed.scheme not in {"http", "https"} or not host
                or "@" in parsed.netloc or parsed.netloc.endswith(":")
                or port not in {80, 443} or "%" in host):
            raise ValueError("unsupported destination")
        host = host.encode("idna").decode("ascii").lower()
    except (ValueError, UnicodeError) as exc:
        raise BrowserNetworkError("Browser requires public HTTP(S) URLs on ports 80 or 443") from exc
    if (host in {"localhost", "localhost.localdomain"} or host.endswith(".")
            or host.endswith((".local", ".internal", ".localhost", ".lan", ".home", ".onion"))):
        raise BrowserNetworkError("Browser cannot contact private or local services")
    try:
        ipaddress.ip_address(host)
    except ValueError:
        if not re.fullmatch(r"[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?", host):
            raise BrowserNetworkError("Browser host is invalid")
    else:
        _public_ip(host)
    path = quote(parsed.path or "/", safe="/%:@!$&'()*+,;=-._~")
    query = quote(parsed.query, safe="/?%:@!$&'()*+,;=-._~")
    if re.search(r"%(?![0-9a-fA-F]{2})", path + query):
        raise BrowserNetworkError("Browser URL has invalid percent encoding")
    authority = f"[{host}]" if ":" in host else host
    if port != (443 if parsed.scheme == "https" else 80):
        authority += f":{port}"
    return urlunsplit((parsed.scheme, authority, path, query, "")), host, port


async def _dns_lookup(host: str, port: int) -> list[tuple]:
    return await asyncio.get_running_loop().getaddrinfo(
        host, port, type=socket.SOCK_STREAM, proto=socket.IPPROTO_TCP)


async def _public_addresses(host: str, port: int) -> list[str]:
    try:
        records = await _dns_lookup(host, port)
    except OSError as exc:
        raise BrowserNetworkError("Browser host could not be resolved") from exc
    addresses: list[str] = []
    for record in records:
        try:
            family, kind, protocol, _, endpoint = record
            if (family not in {socket.AF_INET, socket.AF_INET6}
                    or kind != socket.SOCK_STREAM or protocol not in {0, socket.IPPROTO_TCP}
                    or endpoint[1] != port):
                raise ValueError("invalid record")
            address = _public_ip(endpoint[0])
        except (ValueError, TypeError, IndexError) as exc:
            raise BrowserNetworkError("Browser host returned invalid DNS records") from exc
        if address not in addresses:
            addresses.append(address)
    if not addresses:
        raise BrowserNetworkError("Browser host has no public addresses")
    return addresses


async def _request_headers(request_headers: Mapping[str, str] | None) -> dict[str, str]:
    result = {"accept": "*/*", "user-agent": "NewsCraft-Research/1.0"}
    seen: set[str] = set()
    for name, value in (request_headers or {}).items():
        if not isinstance(name, str) or name.lower() not in _REQUEST_HEADERS:
            continue
        name = name.lower()
        if (name in seen or not isinstance(value, str) or len(value) > 4096
                or any(ord(char) < 32 or ord(char) >= 127 for char in value)):
            raise BrowserNetworkError("Browser request headers are invalid")
        seen.add(name)
        if name == "origin":
            if value == "null":
                continue
            origin, host, port = _public_url(value)
            parsed = urlsplit(origin)
            if parsed.path != "/" or parsed.query or urlsplit(value).fragment:
                raise BrowserNetworkError("Browser request origin is invalid")
            await _public_addresses(host, port)
            value = origin.removesuffix("/")
        result[name] = value
    return result


async def _line(reader: asyncio.StreamReader, maximum: int = MAX_HEADER_LINE_BYTES) -> bytes:
    try:
        line = await reader.readline()
    except (ValueError, asyncio.LimitOverrunError) as exc:
        raise BrowserNetworkError("Browser response line is too large") from exc
    if not line or len(line) > maximum or not line.endswith(b"\r\n"):
        raise BrowserNetworkError("Browser response has an invalid HTTP line")
    return line


async def _response_headers(reader: asyncio.StreamReader) -> tuple[int, dict[str, str], int]:
    total = 0
    for _ in range(5):
        line = await _line(reader)
        total += len(line)
        matched = _STATUS.fullmatch(line)
        if not matched:
            raise BrowserNetworkError("Browser response has an invalid HTTP status")
        status = int(matched[1])
        headers: dict[str, str] = {}
        for index in range(MAX_HEADER_COUNT + 1):
            line = await _line(reader)
            total += len(line)
            if total > MAX_HEADER_BYTES:
                raise BrowserNetworkError("Browser response headers are too large")
            if line == b"\r\n":
                break
            if index == MAX_HEADER_COUNT:
                raise BrowserNetworkError("Browser response has too many headers")
            name, colon, value = line[:-2].partition(b":")
            if (not colon or not _TOKEN.fullmatch(name)
                    or any(char < 32 and char != 9 or char == 127 for char in value)):
                raise BrowserNetworkError("Browser response has invalid headers")
            key = name.decode("ascii").lower()
            if key in _DISCARDED_RESPONSE_HEADERS:
                continue
            decoded = value.decode("latin-1").strip(" \t")
            if key in headers:
                if key not in _LIST_RESPONSE_HEADERS:
                    raise BrowserNetworkError("Browser response has duplicate singleton headers")
                headers[key] += ", " + decoded
            else:
                headers[key] = decoded
        if status == 101:
            raise BrowserNetworkError("Browser protocol upgrades are disabled")
        if status >= 200:
            return status, headers, total
    raise BrowserNetworkError("Browser response has too many interim statuses")


def _framing(headers: dict[str, str]) -> tuple[str, int | None]:
    transfer = headers.get("transfer-encoding", "").lower()
    length = headers.get("content-length")
    if "transfer-encoding" in headers and (transfer != "chunked" or length is not None):
        raise BrowserNetworkError("Browser response has ambiguous HTTP framing")
    if "trailer" in headers:
        raise BrowserNetworkError("Browser response trailers are disabled")
    if length is not None:
        if not re.fullmatch(r"[0-9]{1,20}", length):
            raise BrowserNetworkError("Browser response has an invalid content length")
        return "length", int(length)
    return ("chunked", None) if transfer else ("close", None)


async def _exact(reader: asyncio.StreamReader, size: int) -> bytes:
    try:
        return await reader.readexactly(size)
    except asyncio.IncompleteReadError as exc:
        raise BrowserNetworkError("Browser response body is truncated") from exc


async def _read_body(reader: asyncio.StreamReader, headers: dict[str, str], method: str, status: int) -> tuple[bytes, int]:
    framing, length = _framing(headers)
    if method == "HEAD" or status in {204, 205, 304}:
        return b"", 0
    if length is not None:
        if length > MAX_RESOURCE_BYTES:
            raise BrowserNetworkError("Browser resource exceeds 2 MiB")
        return await _exact(reader, length), length
    result = bytearray()
    if framing == "chunked":
        wire_bytes = 0
        for _ in range(MAX_CHUNKS):
            line = await _line(reader, 128)
            wire_bytes += len(line)
            size, _, extensions = line[:-2].partition(b";")
            if (not re.fullmatch(rb"[0-9a-fA-F]{1,16}", size)
                    or any(char < 32 or char > 126 for char in extensions)):
                raise BrowserNetworkError("Browser response has invalid chunks")
            count = int(size, 16)
            if count == 0:
                if await _line(reader) != b"\r\n":
                    raise BrowserNetworkError("Browser response trailers are disabled")
                return bytes(result), wire_bytes + 2
            if len(result) + count > MAX_RESOURCE_BYTES:
                raise BrowserNetworkError("Browser resource exceeds 2 MiB")
            result.extend(await _exact(reader, count))
            if await _exact(reader, 2) != b"\r\n":
                raise BrowserNetworkError("Browser response has invalid chunks")
            wire_bytes += count + 2
        raise BrowserNetworkError("Browser response has too many chunks")
    while chunk := await reader.read(65536):
        if len(result) + len(chunk) > MAX_RESOURCE_BYTES:
            raise BrowserNetworkError("Browser resource exceeds 2 MiB")
        result.extend(chunk)
    return bytes(result), len(result)


def _decode_body(body: bytes, encoding: str) -> bytes:
    encoding = encoding.strip().lower()
    if not body or encoding in {"", "identity"}:
        return body
    if encoding not in {"gzip", "deflate"}:
        raise BrowserNetworkError("Browser resource has an unsupported content encoding")
    try:
        inflater = zlib.decompressobj(16 + zlib.MAX_WBITS if encoding == "gzip" else zlib.MAX_WBITS)
        decoded = inflater.decompress(body, MAX_RESOURCE_BYTES + 1)
        if len(decoded) > MAX_RESOURCE_BYTES or inflater.unconsumed_tail:
            raise BrowserNetworkError("Browser decompressed resource exceeds 2 MiB")
        # decompress(max_length) is a true output cap. flush(length) only sets
        # its initial buffer size, so never use flush to finish untrusted data.
        if not inflater.eof or inflater.unused_data:
            raise BrowserNetworkError("Browser resource has invalid compressed content")
        return decoded
    except zlib.error as exc:
        raise BrowserNetworkError("Browser resource has invalid compressed content") from exc


async def _fetch(url: str, method: str, request_headers: Mapping[str, str] | None) -> GatewayResponse:
    normalized, host, port = _public_url(url)
    addresses = await _public_addresses(host, port)
    permitted = await _request_headers(request_headers)
    parsed = urlsplit(normalized)
    tls = ssl.create_default_context() if parsed.scheme == "https" else None
    writer = None
    completed = False
    try:
        for address in addresses:
            try:
                reader, writer = await _open_connection(
                    address, port, ssl=tls, server_hostname=host if tls else None,
                    family=socket.AF_INET6 if ":" in address else socket.AF_INET,
                    flags=socket.AI_NUMERICHOST, limit=MAX_HEADER_BYTES + 1)
                break
            except OSError:
                continue
        if writer is None:
            raise BrowserNetworkError("Browser public service could not be reached")
        peer = writer.get_extra_info("peername")
        if (not isinstance(peer, tuple) or len(peer) < 2
                or _public_ip(peer[0]) != address or peer[1] != port):
            raise BrowserNetworkError("Browser connection left its validated destination")
        host_header = f"[{host}]" if ":" in host else host
        if port != (443 if tls else 80):
            host_header += f":{port}"
        target = parsed.path + (f"?{parsed.query}" if parsed.query else "")
        head = f"{method} {target} HTTP/1.1\r\nHost: {host_header}\r\n"
        head += "".join(f"{name}: {value}\r\n" for name, value in permitted.items())
        head += "Accept-Encoding: gzip, deflate\r\nConnection: close\r\n\r\n"
        writer.write(head.encode("ascii"))
        await writer.drain()
        status, headers, header_bytes = await _response_headers(reader)
        disposition = headers.get("content-disposition", "").split(";", 1)[0].strip().lower()
        if disposition and disposition != "inline":
            raise BrowserNetworkError("Browser attachments and downloads are disabled")
        body, body_wire_bytes = await _read_body(reader, headers, method, status)
        body = _decode_body(body, headers.get("content-encoding", ""))
        safe = {key: value for key, value in headers.items() if key in _RESPONSE_HEADERS}
        if "location" in safe:
            destination, redirect_host, redirect_port = _public_url(urljoin(normalized, safe["location"]))
            await _public_addresses(redirect_host, redirect_port)
            safe["location"] = destination
        completed = True
    finally:
        if writer is not None:
            writer.close()
            try:
                await asyncio.wait_for(writer.wait_closed(), timeout=1 if completed else 0.25)
            except (OSError, TimeoutError) as exc:
                transport = getattr(writer, "transport", None)
                if transport is not None:
                    transport.abort()
                if completed:
                    raise BrowserNetworkError("Browser connection shutdown could not be confirmed") from exc
            except asyncio.CancelledError:
                transport = getattr(writer, "transport", None)
                if transport is not None:
                    transport.abort()
                raise
    if not isinstance(reader, _CountingReader):
        raise BrowserNetworkError("Browser transport byte accounting is unavailable")
    if reader.wire_limit_exceeded or reader.received_bytes > MAX_RECEIVED_HTTP_BYTES:
        raise BrowserNetworkError("Browser received HTTP resource exceeds 3 MiB")
    return GatewayResponse(normalized, status, safe, body, hashlib.sha256(body).hexdigest(),
                           wire_bytes=max(header_bytes + body_wire_bytes, reader.received_bytes))


async def fetch_public_resource(
    url: str, method: str = "GET", request_headers: Mapping[str, str] | None = None,
    timeout_seconds: float = 15,
) -> GatewayResponse:
    """Fetch one public GET/HEAD resource with an overall timeout and pinned DNS.

    Cancellation propagates and closes the connection. Caller budgets must also
    bound the number and aggregate bytes of requests belonging to a browser
    action; the 2 MiB limit here applies to each raw and decoded resource.
    """
    if not isinstance(method, str) or method.upper() not in {"GET", "HEAD"}:
        raise BrowserNetworkError("Browser permits only public GET and HEAD requests")
    if (isinstance(timeout_seconds, bool) or not isinstance(timeout_seconds, (int, float))
            or not math.isfinite(timeout_seconds) or not 0 < timeout_seconds <= 60):
        raise BrowserNetworkError("Browser resource timeout must be between 0 and 60 seconds")
    try:
        async with asyncio.timeout(timeout_seconds):
            return await _fetch(url, method.upper(), request_headers)
    except TimeoutError as exc:
        raise BrowserNetworkError("Browser resource request timed out") from exc
    except (OSError, ssl.SSLError) as exc:
        raise BrowserNetworkError("Browser public service could not be reached") from exc
