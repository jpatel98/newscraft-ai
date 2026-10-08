from __future__ import annotations

import asyncio
from asyncio import selector_events, sslproto
import gzip
import hashlib
import os
import socket
import ssl
import unittest
import zlib
from unittest.mock import AsyncMock, Mock, patch

from hermes_chat.browser_network import (
    BrowserNetworkError, GatewayResponse, MAX_RESOURCE_BYTES, MAX_RECEIVED_HTTP_BYTES,
    MAX_RESOURCE_WIRE_BYTES, _CountingReader, _GatewayProtocol, _public_addresses, _public_url,
    _open_connection, _validate_tls_transport, fetch_public_resource,
)

PUBLIC_IP = "93.184.216.34"


def records(*addresses, port=443):
    return [(socket.AF_INET6 if ":" in address else socket.AF_INET,
             socket.SOCK_STREAM, socket.IPPROTO_TCP, "", (address, port))
            for address in addresses]


def response(body=b"hello", headers=None, status="200 OK", framing=True):
    values = dict(headers or {})
    if framing and "Transfer-Encoding" not in values and "Content-Length" not in values:
        values["Content-Length"] = str(len(body))
    return (f"HTTP/1.1 {status}\r\n".encode()
            + b"".join(f"{key}: {value}\r\n".encode("latin-1") for key, value in values.items())
            + b"\r\n" + body)


class Writer:
    def __init__(self, peer=(PUBLIC_IP, 443), *, close_hangs=False):
        self.peer = peer
        self.data = bytearray()
        self.closed = False
        self.close_hangs = close_hangs
    def get_extra_info(self, key):
        return self.peer if key == "peername" else None
    def write(self, data):
        self.data.extend(data)
    async def drain(self):
        pass
    def close(self):
        self.closed = True
    async def wait_closed(self):
        if self.close_hangs:
            await asyncio.Event().wait()


class BrowserNetworkTests(unittest.IsolatedAsyncioTestCase):
    def connection(self, data, *, peer=(PUBLIC_IP, 443), eof=True):
        reader = _CountingReader(limit=65537)
        for offset in range(0, len(data), 65536):
            reader.feed_data(data[offset:offset + 65536])
        if eof:
            reader.feed_eof()
        writer = Writer(peer)
        return reader, writer

    async def fetch(self, data, *, url="https://public.example/", headers=None, method="GET", peer=(PUBLIC_IP, 443)):
        reader, writer = self.connection(data, peer=peer)
        with patch("hermes_chat.browser_network._dns_lookup", return_value=records(PUBLIC_IP)) as lookup, \
             patch("hermes_chat.browser_network._open_connection", return_value=(reader, writer)) as connect:
            result = await fetch_public_resource(url, method, headers)
        return result, writer, lookup, connect

    async def test_numeric_connection_retains_tls_hostname_and_response_mime(self):
        result, writer, lookup, connect = await self.fetch(response(
            b"const page = true;", {"Content-Type": "application/javascript", "Cache-Control": "max-age=30"}),
            url="https://Public.Example/assets/app.js?x=1#local")
        lookup.assert_awaited_once_with("public.example", 443)
        self.assertEqual(connect.await_args.args, (PUBLIC_IP, 443))
        options = connect.await_args.kwargs
        self.assertEqual(options["server_hostname"], "public.example")
        self.assertEqual(options["flags"], socket.AI_NUMERICHOST)
        self.assertEqual(options["family"], socket.AF_INET)
        self.assertTrue(options["ssl"].check_hostname)
        self.assertEqual(options["ssl"].verify_mode, ssl.CERT_REQUIRED)
        self.assertIn(b"GET /assets/app.js?x=1 HTTP/1.1\r\nHost: public.example\r\n", writer.data)
        self.assertEqual(result.url, "https://public.example/assets/app.js?x=1")
        self.assertEqual(result.headers["content-type"], "application/javascript")
        self.assertEqual(result.headers["cache-control"], "max-age=30")
        self.assertEqual(result.sha256, hashlib.sha256(result.body).hexdigest())
        self.assertTrue(writer.closed)

    async def test_no_cookies_credentials_proxy_headers_or_environment_are_forwarded(self):
        fixture = "private-secret-fixture"
        with patch.dict(os.environ, {"OPENAI_API_KEY": fixture, "HTTPS_PROXY": f"http://{fixture}@127.0.0.1"}):
            result, writer, _, connect = await self.fetch(response(b"{}", {
                "Set-Cookie": f"session={fixture}", "WWW-Authenticate": fixture,
                "Proxy-Authenticate": fixture, "Content-Type": "application/json",
                "Access-Control-Allow-Origin": "https://public.example",
            }), headers={"Cookie": fixture, "Authorization": fixture, "Proxy-Authorization": fixture,
                         "Referer": f"https://public.example/?token={fixture}",
                         "X-API-Key": fixture, "Accept": "application/json", "Accept-Language": "en"})
        self.assertNotIn(fixture.encode(), writer.data)
        self.assertNotIn(fixture, str(result.headers))
        self.assertIn(b"accept: application/json\r\n", writer.data)
        self.assertIn(b"accept-language: en\r\n", writer.data)
        self.assertEqual(result.headers["access-control-allow-origin"], "https://public.example")
        self.assertEqual(connect.await_count, 1)

    async def test_every_dns_address_must_be_public_before_connection(self):
        for address in ("127.0.0.1", "10.0.0.7", "169.254.169.254", "100.64.0.1", "::1", "fc00::1", "fec0::1", "ff02::1", "::ffff:127.0.0.1"):
            with self.subTest(address=address), \
                 patch("hermes_chat.browser_network._dns_lookup", return_value=records(PUBLIC_IP, address)), \
                 patch("hermes_chat.browser_network._open_connection", new_callable=AsyncMock) as connect:
                with self.assertRaises(BrowserNetworkError):
                    await fetch_public_resource("https://public.example/")
                connect.assert_not_awaited()

    async def test_ipv6_translation_and_tunnelling_cannot_encode_private_destinations(self):
        addresses = ("64:ff9b::7f00:1", "64:ff9b::a9fe:a9fe", "64:ff9b:1::a00:1",
                     "::ffff:0:7f00:1", "2002:7f00:1::", "2002:a9fe:a9fe::", "2001::1")
        for address in addresses:
            with self.subTest(address=address), \
                 patch("hermes_chat.browser_network._dns_lookup", return_value=records(address)), \
                 patch("hermes_chat.browser_network._open_connection", new_callable=AsyncMock) as connect:
                with self.assertRaises(BrowserNetworkError):
                    await fetch_public_resource("https://public.example/")
                connect.assert_not_awaited()

    async def test_private_literal_credentials_local_schemes_and_header_injection_rejected(self):
        values = ("http://127.0.0.1/", "http://169.254.169.254/", "https://[::1]/", "https://[fec0::1]/",
                  "https://[64:ff9b::7f00:1]/", "https://[2002:7f00:1::]/", "https://user:password@public.example/",
                  "https://@public.example/", "file:///etc/passwd", "http://localhost/", "http://x.local/",
                  "https://public.example:8443/", "https://public.example/\r\nx", "https://public.example\\@127.0.0.1/",
                  "https://public.example:/", "https://public.example:0/", "https://public.example/%bad%", "https://public.example./")
        with patch("hermes_chat.browser_network._dns_lookup", new_callable=AsyncMock) as lookup:
            for url in values:
                with self.subTest(url=url), self.assertRaises(BrowserNetworkError):
                    await fetch_public_resource(url)
            lookup.assert_not_awaited()

    async def test_dns_rebinding_cannot_replace_pinned_connection_peer(self):
        for peer in (("127.0.0.1", 443), ("1.1.1.1", 443), (PUBLIC_IP, 80), None, (), (None, 443)):
            reader, writer = self.connection(response(), peer=peer)
            with self.subTest(peer=peer), \
                 patch("hermes_chat.browser_network._dns_lookup", return_value=records(PUBLIC_IP)), \
                 patch("hermes_chat.browser_network._open_connection", return_value=(reader, writer)):
                with self.assertRaises(BrowserNetworkError):
                    await fetch_public_resource("https://public.example/")
                self.assertEqual(writer.data, b"")
                self.assertTrue(writer.closed)

    async def test_public_ipv6_connection_is_pinned(self):
        address = "2606:4700:4700::1111"
        reader, writer = self.connection(response(), peer=(address, 443, 0, 0))
        with patch("hermes_chat.browser_network._dns_lookup", return_value=records(address)), \
             patch("hermes_chat.browser_network._open_connection", return_value=(reader, writer)) as connect:
            result = await fetch_public_resource(f"https://[{address}]/")
        self.assertEqual(connect.await_args.kwargs["family"], socket.AF_INET6)
        self.assertIn(f"Host: [{address}]\r\n".encode(), writer.data)
        self.assertEqual(result.status, 200)

    async def test_non_get_head_methods_fail_before_any_network(self):
        for method in ("POST", "PUT", "PATCH", "DELETE", "CONNECT", "OPTIONS", "GET\r\nPOST", None):
            with self.subTest(method=method), \
                 patch("hermes_chat.browser_network._dns_lookup", new_callable=AsyncMock) as lookup:
                with self.assertRaisesRegex(BrowserNetworkError, "GET and HEAD"):
                    await fetch_public_resource("https://public.example/", method)
                lookup.assert_not_awaited()

    async def test_head_does_not_read_body_or_forward_original_framing(self):
        result, writer, _, _ = await self.fetch(response(b"", {
            "Content-Length": str(MAX_RESOURCE_BYTES * 20), "Content-Encoding": "gzip"}), method="HEAD")
        self.assertEqual(result.body, b"")
        self.assertNotIn("content-length", result.headers)
        self.assertNotIn("content-encoding", result.headers)
        self.assertTrue(writer.data.startswith(b"HEAD / HTTP/1.1"))

    async def test_redirect_is_single_hop_with_validated_absolute_location(self):
        reader, writer = self.connection(response(b"redirect", {"Location": "../final?x=1#part"}, status="302 Found"))
        with patch("hermes_chat.browser_network._dns_lookup", return_value=records(PUBLIC_IP)) as lookup, \
             patch("hermes_chat.browser_network._open_connection", return_value=(reader, writer)) as connect:
            result = await fetch_public_resource("https://public.example/start/page")
        self.assertEqual(result.url, "https://public.example/start/page")
        self.assertEqual(result.status, 302)
        self.assertEqual(result.headers["location"], "https://public.example/final?x=1")
        self.assertEqual(result.body, b"redirect")
        self.assertEqual(lookup.await_count, 2)
        self.assertEqual(connect.await_count, 1)

    async def test_redirect_target_private_or_rebound_dns_rejected(self):
        for location in ("http://169.254.169.254/latest", "https://internal.example/", "file:///etc/passwd"):
            reader, writer = self.connection(response(b"", {"Location": location}, status="307 Temporary Redirect"))
            with self.subTest(location=location), \
                 patch("hermes_chat.browser_network._dns_lookup", side_effect=[records(PUBLIC_IP), records("10.0.0.1")]), \
                 patch("hermes_chat.browser_network._open_connection", return_value=(reader, writer)) as connect:
                with self.assertRaises(BrowserNetworkError):
                    await fetch_public_resource("https://public.example/")
                self.assertEqual(connect.await_count, 1)
                self.assertTrue(writer.closed)

    async def test_origin_is_public_validated_and_null_origin_omitted(self):
        result, writer, lookup, _ = await self.fetch(response(), headers={"Origin": "https://other.example"})
        self.assertEqual(lookup.await_count, 2)
        self.assertIn(b"origin: https://other.example\r\n", writer.data)
        _, writer, lookup, _ = await self.fetch(response(), headers={"Origin": "null"})
        self.assertEqual(lookup.await_count, 1)
        self.assertNotIn(b"origin:", writer.data)
        for value in ("https://other.example/path", "http://127.0.0.1", "https://other.example/#fragment"):
            with self.subTest(value=value), self.assertRaises(BrowserNetworkError):
                await self.fetch(response(), headers={"Origin": value})

    async def test_request_header_injection_and_duplicates_rejected(self):
        for headers in ({"Accept": "*/*\r\nAuthorization: fixture"}, {"User-Agent": "x\x00"},
                        {"Accept": "a", "accept": "b"}, {"Accept": "x" * 4097}):
            with self.subTest(headers=headers), self.assertRaises(BrowserNetworkError):
                await self.fetch(response(), headers=headers)

    async def test_all_public_resource_mimes_and_binary_bytes_are_supported(self):
        for mime in ("text/html", "text/css", "application/javascript", "application/json", "image/png", "image/svg+xml", "font/woff2"):
            with self.subTest(mime=mime):
                result, _, _, _ = await self.fetch(response(b"\x00\xffbinary", {"Content-Type": mime}))
                self.assertEqual(result.body, b"\x00\xffbinary")
                self.assertEqual(result.headers["content-type"], mime)

    async def test_attachments_unknown_disposition_and_downloads_rejected(self):
        for disposition in ('attachment; filename="report.pdf"', 'ATTACHMENT', 'form-data; name="file"'):
            with self.subTest(disposition=disposition), self.assertRaisesRegex(BrowserNetworkError, "downloads"):
                await self.fetch(response(headers={"Content-Disposition": disposition}))
        result, _, _, _ = await self.fetch(response(headers={"Content-Disposition": "inline; filename=page.html"}))
        self.assertNotIn("content-disposition", result.headers)

    async def test_chunked_body_is_decoded_and_framing_headers_removed(self):
        result, _, _, _ = await self.fetch(response(b"3\r\nabc\r\n2;extension=value\r\nde\r\n0\r\n\r\n",
                                                   {"Transfer-Encoding": "chunked"}))
        self.assertEqual(result.body, b"abcde")
        self.assertNotIn("transfer-encoding", result.headers)

    async def test_repeated_cookie_and_auth_challenges_are_discarded_without_rejecting_page(self):
        hidden = ("Set-Cookie", "Set-Cookie2", "WWW-Authenticate", "Proxy-Authenticate",
                  "Authentication-Info", "Proxy-Authentication-Info")
        data = (b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\n"
                + b"".join(f"{name}: private-secret-fixture-a\r\n{name.lower()}: private-secret-fixture-b\r\n".encode()
                           for name in hidden)
                + b"Content-Type: text/html\r\n\r\nhello")
        result, _, _, _ = await self.fetch(data)
        self.assertEqual(result.body, b"hello")
        self.assertEqual(result.headers, {"content-type": "text/html"})
        self.assertNotIn("private-secret-fixture", str(result))

    async def test_repeated_list_headers_preserve_cache_cors_and_security_policy(self):
        values = {
            "Cache-Control": ("public", "max-age=30"), "Vary": ("Accept", "Origin"),
            "Access-Control-Allow-Methods": ("GET", "HEAD"),
            "Access-Control-Allow-Headers": ("Accept", "X-Public-Header"),
            "Access-Control-Expose-Headers": ("ETag", "Last-Modified"),
            "Content-Security-Policy": ("default-src 'self'", "script-src 'self'"),
            "Referrer-Policy": ("origin", "no-referrer"),
        }
        data = (b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n"
                + b"".join(f"{name}: {first}\r\n{name.lower()}: {second}\r\n".encode()
                           for name, (first, second) in values.items()) + b"\r\n")
        result, _, _, _ = await self.fetch(data)
        for name, (first, second) in values.items():
            with self.subTest(name=name):
                self.assertEqual(result.headers[name.lower()], f"{first}, {second}")

    async def test_ignored_or_combined_repeated_headers_still_count_towards_limits(self):
        for name in ("Set-Cookie", "WWW-Authenticate", "Vary"):
            data = b"HTTP/1.1 200 OK\r\n" + f"{name}: a\r\n".encode() * 101 + b"\r\n"
            with self.subTest(name=name), self.assertRaisesRegex(BrowserNetworkError, "too many headers"):
                await self.fetch(data)
        data = b"HTTP/1.1 200 OK\r\n" + (b"Set-Cookie: " + b"a" * 800 + b"\r\n") * 90 + b"\r\n"
        with self.assertRaisesRegex(BrowserNetworkError, "headers are too large"):
            await self.fetch(data)

    async def test_duplicate_ambiguous_smuggling_headers_and_obsolete_folding_rejected(self):
        responses = (
            b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\ncontent-length: 9\r\n\r\n",
            b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\ncontent-length: 0\r\n\r\n",
            b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\ntransfer-encoding: chunked\r\n\r\n",
            b"HTTP/1.1 200 OK\r\nContent-Encoding: gzip\r\ncontent-encoding: gzip\r\nContent-Length: 0\r\n\r\n",
            b"HTTP/1.1 200 OK\r\nContent-Type: text/html\r\ncontent-type: text/html\r\nContent-Length: 0\r\n\r\n",
            b"HTTP/1.1 302 Found\r\nLocation: /a\r\nlocation: /b\r\nContent-Length: 0\r\n\r\n",
            b"HTTP/1.1 200 OK\r\nAccess-Control-Allow-Origin: *\r\naccess-control-allow-origin: https://public.example\r\nContent-Length: 0\r\n\r\n",
            b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\nTransfer-Encoding: chunked\r\n\r\n",
            b"HTTP/1.1 200 OK\r\nTransfer-Encoding: gzip, chunked\r\n\r\n",
            b"HTTP/1.1 200 OK\r\nTransfer-Encoding: \r\n\r\n",
            b"HTTP/1.1 200 OK\r\nContent-Length: +1\r\n\r\nx",
            b"HTTP/1.1 200 OK\r\nContent-Length: 1, 1\r\n\r\nx",
            b"HTTP/1.1 200 OK\r\nX-Test: okay\r\n folded\r\n\r\n",
            b"HTTP/1.1 200 OK\nContent-Length: 0\n\n",
            b"HTTP/1.1 200 OK\r\nBad Name: value\r\n\r\n",
            b"HTTP/1.1 200 OK\r\nX-Test: \x00\r\n\r\n",
            b"HTTP/1.1 200 OK\r\nTrailer: X-Hash\r\nContent-Length: 0\r\n\r\n",
        )
        for data in responses:
            with self.subTest(data=data), self.assertRaises(BrowserNetworkError):
                await self.fetch(data)

    async def test_invalid_chunk_framing_trailers_and_truncated_body_rejected(self):
        for body in (b"-1\r\n", b"g\r\n", b"1\r\nxXX", b"1\r\n", b"0\r\nX-Final: value\r\n\r\n"):
            with self.subTest(body=body), self.assertRaises(BrowserNetworkError):
                await self.fetch(response(body, {"Transfer-Encoding": "chunked"}))
        with self.assertRaisesRegex(BrowserNetworkError, "truncated"):
            await self.fetch(response(b"short", {"Content-Length": "10"}))

    async def test_raw_bound_applies_to_length_close_and_chunked_bodies(self):
        large = b"x" * (MAX_RESOURCE_BYTES + 1)
        bodies = (response(b"", {"Content-Length": str(len(large))}),
                  response(large, framing=False),
                  response(f"{len(large):x}\r\n".encode(), {"Transfer-Encoding": "chunked"}))
        for data in bodies:
            with self.subTest(framing=data[:100]), self.assertRaisesRegex(BrowserNetworkError, "2 MiB"):
                await self.fetch(data)
        result, _, _, _ = await self.fetch(response(b"x" * MAX_RESOURCE_BYTES))
        self.assertEqual(len(result.body), MAX_RESOURCE_BYTES)

    async def test_gzip_and_deflate_return_decompressed_body_and_sha(self):
        plain = b"const value = 5;" * 100
        for encoding, compressed in (("gzip", gzip.compress(plain)), ("deflate", zlib.compress(plain))):
            with self.subTest(encoding=encoding):
                result, _, _, _ = await self.fetch(response(compressed, {"Content-Encoding": encoding}))
                self.assertEqual(result.body, plain)
                self.assertEqual(result.sha256, hashlib.sha256(plain).hexdigest())
                self.assertNotIn("content-encoding", result.headers)

    async def test_large_compressed_wire_resource_reports_actual_charge_despite_small_decoded_body(self):
        plain = b"tiny"
        compressed = bytearray(gzip.compress(plain))
        compressed[3] |= 0x10  # gzip FCOMMENT may be large without adding output.
        compressed = bytes(compressed[:10]) + b"comment" * 32768 + b"\x00" + bytes(compressed[10:])
        data = response(compressed, {"Content-Encoding": "gzip"})
        result, _, _, _ = await self.fetch(data)
        self.assertEqual(result.body, plain)
        self.assertEqual(result.wire_bytes, len(data))
        self.assertGreater(result.wire_bytes, 200 * 1024)
        self.assertEqual(max(len(result.body), result.wire_bytes), len(data))

    async def test_wire_byte_accounting_includes_interim_discarded_headers_and_chunk_framing(self):
        interim = b"HTTP/1.1 103 Early Hints\r\nLink: </app.js>; rel=preload\r\n\r\n"
        data = interim + response(b"3;extension=value\r\nabc\r\n0\r\n\r\n", {
            "Transfer-Encoding": "chunked", "Set-Cookie": "not-forwarded",
        })
        result, _, _, _ = await self.fetch(data)
        self.assertEqual(result.body, b"abc")
        self.assertEqual(result.wire_bytes, len(data))
        self.assertNotIn("set-cookie", result.headers)

    async def test_successful_zero_length_response_charges_unread_received_junk(self):
        head = response(b"", {"Content-Length": "0"})
        junk = b"unexpected-unframed-data" * 10000
        result, _, _, _ = await self.fetch(head + junk)
        self.assertEqual(result.body, b"")
        self.assertEqual(result.wire_bytes, len(head) + len(junk))

    async def test_bytes_arriving_during_connection_close_are_charged_before_return(self):
        data = response(b"", {"Content-Length": "0"})
        reader, writer = self.connection(data, eof=False)
        async def close_with_more_data():
            reader.feed_data(b"late-unread-junk")
            reader.feed_eof()
        writer.wait_closed = close_with_more_data
        with patch("hermes_chat.browser_network._dns_lookup", return_value=records(PUBLIC_IP)), \
             patch("hermes_chat.browser_network._open_connection", return_value=(reader, writer)):
            result = await fetch_public_resource("https://public.example/")
        self.assertEqual(result.wire_bytes, len(data) + len(b"late-unread-junk"))

    async def test_excess_received_junk_rejects_even_after_zero_length_body_parsed(self):
        reader, writer = self.connection(response(b"", {"Content-Length": "0"}), eof=False)
        async def close_with_excess_data():
            for _ in range(MAX_RECEIVED_HTTP_BYTES // 65536 + 1):
                reader.feed_data(b"x" * 65536)
                if reader.wire_limit_exceeded:
                    break
            reader.feed_eof()
        writer.wait_closed = close_with_excess_data
        with patch("hermes_chat.browser_network._dns_lookup", return_value=records(PUBLIC_IP)), \
             patch("hermes_chat.browser_network._open_connection", return_value=(reader, writer)):
            with self.assertRaisesRegex(BrowserNetworkError, "received HTTP"):
                await fetch_public_resource("https://public.example/")
        self.assertLessEqual(reader.received_bytes, MAX_RESOURCE_WIRE_BYTES)

    async def test_bounded_receive_protocol_limits_overflow_inside_exported_reservation(self):
        reader = _CountingReader(limit=65537)
        protocol = _GatewayProtocol(reader)
        transport = Mock()
        protocol.connection_made(transport)
        buffer = protocol.get_buffer(100 * 1024 * 1024)
        self.assertEqual(len(buffer), 65536)
        self.assertIsInstance(protocol, asyncio.BufferedProtocol)
        buffer[:] = b"x" * len(buffer)
        for _ in range(MAX_RECEIVED_HTTP_BYTES // len(buffer) + 1):
            protocol.buffer_updated(len(buffer))
        self.assertTrue(reader.wire_limit_exceeded)
        transport.abort.assert_called_once()
        self.assertEqual(reader.received_bytes, MAX_RECEIVED_HTTP_BYTES + len(buffer))
        self.assertLess(reader.received_bytes, MAX_RESOURCE_WIRE_BYTES)

    async def test_counted_connection_recipe_keeps_numeric_tls_options_without_network(self):
        loop = asyncio.get_running_loop()
        transport = object()
        writer = object()
        with patch.object(loop, "create_connection", new_callable=AsyncMock, return_value=(transport, None)) as create, \
             patch("hermes_chat.browser_network.asyncio.StreamWriter", return_value=writer) as construct, \
             patch("hermes_chat.browser_network._validate_tls_transport") as validate:
            reader, result_writer = await _open_connection(PUBLIC_IP, 443, limit=65537,
                ssl="tls-fixture", server_hostname="public.example", flags=socket.AI_NUMERICHOST,
                family=socket.AF_INET)
        self.assertIsInstance(reader, _CountingReader)
        self.assertIs(result_writer, writer)
        self.assertEqual(create.await_args.args[1:], (PUBLIC_IP, 443))
        self.assertEqual(create.await_args.kwargs["flags"], socket.AI_NUMERICHOST)
        self.assertEqual(create.await_args.kwargs["server_hostname"], "public.example")
        self.assertIsInstance(create.await_args.args[0](), _GatewayProtocol)
        self.assertIs(construct.call_args.args[2], reader)
        validate.assert_called_once_with(transport, create.await_args.args[0]())

    async def test_real_stdlib_tls_protocol_discarding_pending_junk_fails_fetch(self):
        loop = asyncio.get_running_loop()
        reader = _CountingReader(limit=65537)
        app = _GatewayProtocol(reader)
        tls = sslproto.SSLProtocol(loop, app, ssl.create_default_context(), None,
            server_side=False, server_hostname="public.example")
        raw = Mock()
        raw.get_extra_info.side_effect = lambda name, default=None: (PUBLIC_IP, 443) if name == "peername" else default
        raw._force_close.side_effect = lambda error: loop.call_soon(tls.connection_lost, error)
        tls._transport = raw
        tls._state = sslproto.SSLProtocolState.WRAPPED
        tls._app_state = sslproto.AppProtocolState.STATE_CON_MADE
        discarded = []

        class BufferedTLSFixture:
            def read(self, wanted, buffer):
                if not tls._incoming.pending:
                    raise ssl.SSLWantReadError(ssl.SSL_ERROR_WANT_READ, "fixture needs input")
                data = tls._incoming.read(wanted)
                buffer[:len(data)] = data
                return len(data)
            def write(self, data):
                return len(data)
            def unwrap(self):
                if tls._incoming.pending:
                    discarded.append(tls._incoming.pending)
                    raise ssl.SSLError("APPLICATION_DATA_AFTER_CLOSE_NOTIFY")

        tls._sslobj = BufferedTLSFixture()
        transport = tls._app_transport
        app.connection_made(transport)
        writer = asyncio.StreamWriter(transport, app, reader, loop)
        payload = response(b"", {"Content-Length": "0"}) + b"x" * 500000
        # Exercise real SSLProtocol receive callbacks, each at most its maximum.
        for offset in range(0, len(payload), tls.max_size):
            chunk = payload[offset:offset + tls.max_size]
            receive = tls.get_buffer(len(chunk))
            receive[:len(chunk)] = chunk
            tls.buffer_updated(len(chunk))
        for _ in range(8):
            await asyncio.sleep(0)
        self.assertTrue(tls._app_reading_paused)
        self.assertGreater(tls._incoming.pending, 0)
        self.assertLess(reader.received_bytes, len(payload))
        with patch("hermes_chat.browser_network._dns_lookup", return_value=records(PUBLIC_IP)), \
             patch("hermes_chat.browser_network._open_connection", return_value=(reader, writer)):
            with self.assertRaisesRegex(BrowserNetworkError, "shutdown could not be confirmed"):
                await fetch_public_resource("https://public.example/")
        self.assertTrue(discarded)
        self.assertLess(len(payload), MAX_RESOURCE_WIRE_BYTES)
        self.assertTrue(transport.is_closing())

    async def test_shutdown_timeout_is_failure_and_transport_is_aborted(self):
        reader, writer = self.connection(response())
        writer.transport = Mock()
        async def close_timeout():
            raise TimeoutError()
        writer.wait_closed = close_timeout
        with patch("hermes_chat.browser_network._dns_lookup", return_value=records(PUBLIC_IP)), \
             patch("hermes_chat.browser_network._open_connection", return_value=(reader, writer)):
            with self.assertRaisesRegex(BrowserNetworkError, "shutdown could not be confirmed"):
                await fetch_public_resource("https://public.example/")
        writer.transport.abort.assert_called_once()

    async def test_tls_transport_admission_rejects_changed_interpreter_types_and_buffer_bounds(self):
        loop = asyncio.get_running_loop()
        reader = _CountingReader(limit=65537)
        app = _GatewayProtocol(reader)
        context = ssl.create_default_context()
        tls = sslproto.SSLProtocol(loop, app, context, None,
            server_side=False, server_hostname="public.example")
        # Exact transport type without opening a socket; the admission checker
        # inspects the runtime's contract, while production create_connection
        # constructs and owns the actual transport.
        raw = object.__new__(selector_events._SelectorSocketTransport)
        raw._sock = None
        raw._closing = True
        tls._transport = raw
        transport = tls._app_transport
        _validate_tls_transport(transport, app)
        for attribute, value in (("max_size", 262145), ("_incoming_high_water", 262145),
                                 ("_incoming_low_water", 262145), ("_transport", Mock())):
            original = getattr(tls, attribute)
            setattr(tls, attribute, value)
            with self.subTest(attribute=attribute), self.assertRaises(BrowserNetworkError):
                _validate_tls_transport(transport, app)
            setattr(tls, attribute, original)
        with patch("hermes_chat.browser_network.sys.version_info", (3, 12)), self.assertRaises(BrowserNetworkError):
            _validate_tls_transport(transport, app)
        original = context.options
        context.options &= ~ssl.OP_NO_COMPRESSION
        with self.assertRaises(BrowserNetworkError):
            _validate_tls_transport(transport, app)
        context.options = original
        transport._closed = True

    def test_five_positional_gateway_response_fixture_remains_compatible(self):
        body = b"fixture"
        result = GatewayResponse("https://public.example/", 200, {}, body, hashlib.sha256(body).hexdigest())
        self.assertIsNone(result.wire_bytes)
        self.assertEqual(result.body, body)

    async def test_compression_bombs_invalid_streams_and_encoding_chains_rejected(self):
        invalid = (("gzip", gzip.compress(b"x" * (MAX_RESOURCE_BYTES + 1))),
                   ("deflate", zlib.compress(b"x" * (MAX_RESOURCE_BYTES + 1))),
                   ("gzip", gzip.compress(b"small")[:-2]), ("gzip", b"not gzip"),
                   ("gzip", gzip.compress(b"one") + gzip.compress(b"two")),
                   ("br", b"opaque"), ("gzip, deflate", gzip.compress(b"small")))
        for encoding, body in invalid:
            with self.subTest(encoding=encoding, size=len(body)), self.assertRaises(BrowserNetworkError):
                await self.fetch(response(body, {"Content-Encoding": encoding}))

    async def test_timeout_and_cancellation_close_connection(self):
        reader, writer = self.connection(b"", eof=False)
        with patch("hermes_chat.browser_network._dns_lookup", return_value=records(PUBLIC_IP)), \
             patch("hermes_chat.browser_network._open_connection", return_value=(reader, writer)):
            with self.assertRaisesRegex(BrowserNetworkError, "timed out"):
                await fetch_public_resource("https://public.example/", timeout_seconds=0.01)
        self.assertTrue(writer.closed)
        reader, writer = self.connection(b"", eof=False)
        with patch("hermes_chat.browser_network._dns_lookup", return_value=records(PUBLIC_IP)), \
             patch("hermes_chat.browser_network._open_connection", return_value=(reader, writer)):
            task = asyncio.create_task(fetch_public_resource("https://public.example/"))
            await asyncio.sleep(0)
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task
        self.assertTrue(writer.closed)

    async def test_invalid_timeout_fails_before_dns(self):
        for timeout in (0, -1, 61, float("inf"), float("nan"), True, "15"):
            with self.subTest(timeout=timeout), \
                 patch("hermes_chat.browser_network._dns_lookup", new_callable=AsyncMock) as lookup:
                with self.assertRaises(BrowserNetworkError):
                    await fetch_public_resource("https://public.example/", timeout_seconds=timeout)
                lookup.assert_not_awaited()

    async def test_bad_dns_records_and_failures_rejected_without_details(self):
        for data in ([], records("not-an-ip"), records(PUBLIC_IP, port=80), [(socket.AF_UNIX, 1, 0, "", (PUBLIC_IP, 443))]):
            with self.subTest(data=data), patch("hermes_chat.browser_network._dns_lookup", return_value=data):
                with self.assertRaises(BrowserNetworkError):
                    await _public_addresses("public.example", 443)
        with patch("hermes_chat.browser_network._dns_lookup", side_effect=OSError("private-secret-fixture")):
            with self.assertRaises(BrowserNetworkError) as raised:
                await fetch_public_resource("https://public.example/")
        self.assertNotIn("private-secret-fixture", str(raised.exception))

    async def test_public_address_fallback_is_numeric_and_does_not_redo_dns(self):
        reader, writer = self.connection(response(), peer=("1.1.1.1", 443))
        with patch("hermes_chat.browser_network._dns_lookup", return_value=records(PUBLIC_IP, "1.1.1.1")) as lookup, \
             patch("hermes_chat.browser_network._open_connection", side_effect=[OSError("unavailable"), (reader, writer)]) as connect:
            result = await fetch_public_resource("https://public.example/")
        self.assertEqual(result.status, 200)
        self.assertEqual(lookup.await_count, 1)
        self.assertEqual(connect.await_args_list[1].args, ("1.1.1.1", 443))

    async def test_interim_statuses_supported_and_protocol_upgrades_rejected(self):
        result, _, _, _ = await self.fetch(b"HTTP/1.1 103 Early Hints\r\nLink: </app.js>; rel=preload\r\n\r\n" + response())
        self.assertEqual(result.body, b"hello")
        for data in (b"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n\r\n",
                     b"HTTP/1.1 100 Continue\r\n\r\n" * 6, b"bad status\r\n\r\n"):
            with self.subTest(data=data[:60]), self.assertRaises(BrowserNetworkError):
                await self.fetch(data)

    async def test_header_line_count_total_size_and_chunk_count_are_bounded(self):
        data = b"HTTP/1.1 200 OK\r\nX-Large: " + b"x" * 8192 + b"\r\n\r\n"
        with self.assertRaises(BrowserNetworkError):
            await self.fetch(data)
        for count, size in ((101, 1), (90, 800)):
            data = b"HTTP/1.1 200 OK\r\n" + b"".join(f"X-{index}: ".encode() + b"x" * size + b"\r\n" for index in range(count)) + b"\r\n"
            with self.subTest(count=count, size=size), self.assertRaises(BrowserNetworkError):
                await self.fetch(data)
        with self.assertRaisesRegex(BrowserNetworkError, "too many chunks"):
            await self.fetch(response(b"1\r\nx\r\n" * 4096 + b"0\r\n\r\n", {"Transfer-Encoding": "chunked"}))

    def test_unicode_url_is_ascii_encoded_and_fragment_removed(self):
        normalized, host, port = _public_url("https://bücher.example/été?q=café#part")
        self.assertEqual(host, "xn--bcher-kva.example")
        self.assertEqual(port, 443)
        self.assertEqual(normalized, "https://xn--bcher-kva.example/%C3%A9t%C3%A9?q=caf%C3%A9")


if __name__ == "__main__":
    unittest.main()
