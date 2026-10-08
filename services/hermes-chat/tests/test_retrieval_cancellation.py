from __future__ import annotations
import asyncio
import io
import socket
import tempfile
import threading
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch
from urllib.request import Request

from hermes_chat.durable import DurableRunWorker
from hermes_chat.isolation import TenantIsolation
from hermes_chat.retrieval import (ResearchTools, RetrievalConfig, NewsCraftWebProvider,
    RetrievalOperation, RetrievalStopped, _OPERATION, _PublicRedirectHandler, _public_socket)
from hermes_chat.retrieval import _PublicHTTPResponse, _PublicHTTPSConnection, default_fetch
from test_retrieval import FakeFetcher, SOURCE_URL, response


class RetrievalCancellationTests(unittest.IsolatedAsyncioTestCase):
    async def test_cancel_and_timeout_keep_worker_slot_until_active_fetch_drains(self):
        for mode in ("cancel", "timeout"):
            for stage in ("live", "cdx", "archive"):
                with self.subTest(mode=mode, stage=stage), tempfile.TemporaryDirectory() as root:
                    loop = asyncio.get_running_loop()
                    entered, timed_out = asyncio.Event(), asyncio.Event()
                    release = threading.Event()
                    requests = []
                    base = FakeFetcher()
                    def fetch(url, timeout):
                        requests.append(url)
                        current = "cdx" if "/cdx/" in url else "archive" if "web.archive.org/web/" in url else "live"
                        if current == stage:
                            loop.call_soon_threadsafe(entered.set)
                            if not release.wait(2):
                                raise AssertionError("fixture fetch was not released")
                        if current == "live" and stage != "live":
                            return response(url, status=403, body=b"blocked")
                        return base(url, timeout)
                    config = RetrievalConfig()
                    research = ResearchTools(config, NewsCraftWebProvider(config, fetcher=fetch))
                    async def run(*args, **kwargs):
                        yield {"type": "STATE_SNAPSHOT", "snapshot": {}}
                        duration = 0.04 if mode == "timeout" else 2
                        try:
                            async with asyncio.timeout(duration):
                                await research.execute("web_extract", {"urls": [SOURCE_URL, "https://second.example.test/article"]},
                                                       deadline=time.monotonic() + duration)
                        finally:
                            timed_out.set()
                        yield {"type": "RUN_FINISHED", "model": "fixture"}
                    settings = SimpleNamespace(run_api_url="https://app.example.test/api/internal/hermes/runs", run_api_token="fixture")
                    isolation = TenantIsolation(Path(root) / "state", Path(root) / "files")
                    runner = SimpleNamespace(run=run, cancel_run=AsyncMock())
                    worker = DurableRunWorker(settings, isolation, runner)
                    worker._callback = AsyncMock()
                    worker._newscraft = AsyncMock(return_value={})
                    try:
                        await worker.start_recovered({"run_id": "run-one", "account_id": "account-one", "tenant_key": "tenant-one",
                            "lease_owner": "worker", "lease_token": "lease", "input": {"threadId": "conversation-one"}})
                        task = worker.jobs["run-one"].task
                        await asyncio.wait_for(entered.wait(), 1)
                        cancelling = asyncio.create_task(worker.cancel("run-one")) if mode == "cancel" else None
                        await asyncio.sleep(0.07)
                        self.assertFalse(task.done())
                        self.assertFalse(timed_out.is_set())
                        self.assertEqual(worker.capacity_snapshot()["active_runs"], 1)
                        calls_at_cancel = list(requests)
                        release.set()
                        await asyncio.wait_for(task, 1)
                        if cancelling:
                            await asyncio.wait_for(cancelling, 1)
                        self.assertEqual(requests, calls_at_cancel)
                        self.assertNotIn("https://second.example.test/article", requests)
                        self.assertEqual(worker.capacity_snapshot()["active_runs"], 0)
                        events = [call.args[1] for call in worker._callback.await_args_list]
                        self.assertIn("run.cancelled" if mode == "cancel" else "run.failed", events)
                    finally:
                        release.set()
                        await worker.close()

    async def test_deadline_without_outer_task_cancel_stops_before_next_fetch(self):
        entered = asyncio.Event(); release = threading.Event(); loop = asyncio.get_running_loop()
        calls = []
        def fetch(url, timeout):
            calls.append(url); loop.call_soon_threadsafe(entered.set)
            release.wait(1)
            return FakeFetcher()(url, timeout)
        config = RetrievalConfig()
        research = ResearchTools(config, NewsCraftWebProvider(config, fetcher=fetch))
        task = asyncio.create_task(research.execute("web_extract", {"urls": [SOURCE_URL, "https://second.example.test"]},
                                                    deadline=time.monotonic() + 0.03))
        await entered.wait(); await asyncio.sleep(0.05); release.set()
        with self.assertRaises(TimeoutError):
            await task
        self.assertEqual(calls, [SOURCE_URL])


class RetrievalDispatchBoundaryTests(unittest.TestCase):
    def test_response_keeps_socket_file_alive_after_connection_owner_closes(self):
        sender, receiver = socket.socketpair()
        try:
            receiver.settimeout(1)
            sender.sendall(b"HTTP/1.1 200 OK\r\nContent-Length: 4\r\nConnection: close\r\n\r\nTest")
            response = _PublicHTTPResponse(receiver)
            try:
                response.begin()
                receiver.close()  # HTTPConnection closes when will_close is true.
                self.assertEqual(response.read(), b"Test")
            finally:
                response.close()
        finally:
            sender.close()
            receiver.close()

    def test_cancelled_tls_handshake_closes_the_wrapped_socket(self):
        operation = RetrievalOperation(threading.Event(), None)
        token = _OPERATION.set(operation)
        raw, wrapped = Mock(), Mock()
        connection = _PublicHTTPSConnection("example.test", timeout=1)
        connection._context = Mock()
        def finish_handshake(*args, **kwargs):
            operation.stopped.set()
            return wrapped
        connection._context.wrap_socket.side_effect = finish_handshake
        try:
            with patch("hermes_chat.retrieval._public_socket", return_value=raw):
                with self.assertRaises(RetrievalStopped):
                    connection.connect()
            raw.close.assert_called_once()
            wrapped.close.assert_called_once()
            self.assertIsNone(connection.sock)
        finally:
            _OPERATION.reset(token)

    def test_slow_headers_and_body_share_an_absolute_socket_read_deadline(self):
        header = b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\n\r\n"
        for slow_headers in (True, False):
            with self.subTest(slow_headers=slow_headers):
                clock = [0.0]
                reads = []
                contents = io.BytesIO(header + b"x" * 100)
                class DripStream(io.RawIOBase):
                    def readable(self):
                        return True
                    def readinto(self, buffer):
                        if not slow_headers and contents.tell() == 0:
                            chunk = contents.read(len(header))
                        else:
                            clock[0] += 1
                            chunk = contents.read(1)
                            reads.append(clock[0])
                        buffer[:len(chunk)] = chunk
                        return len(chunk)
                connection = Mock()
                connection.gettimeout.return_value = 1.0
                connection.makefile.side_effect = lambda *args, **kwargs: DripStream() if kwargs.get("buffering") == 0 else io.BytesIO()
                operation = RetrievalOperation(threading.Event(), 2.5)
                token = _OPERATION.set(operation)
                try:
                    with patch("hermes_chat.retrieval.time.monotonic", side_effect=lambda: clock[0]):
                        response = _PublicHTTPResponse(connection)
                        try:
                            with self.assertRaises(RetrievalStopped):
                                response.begin()
                                response.read(100)
                        finally:
                            response.close()
                    self.assertEqual(reads, [1.0, 2.0, 3.0])
                    self.assertEqual(connection.settimeout.call_args.args, (0.5,))
                finally:
                    _OPERATION.reset(token)

    def test_redirect_closes_body_before_urllib_can_drain_it(self):
        handler = _PublicRedirectHandler()
        handler.parent = Mock()
        request = Request(SOURCE_URL)
        request.timeout = 1
        response = Mock()
        def read_closed():
            response.close.assert_called_once()
            return b""
        response.read.side_effect = read_closed
        handler.http_error_302(request, response, 302, "Found", {"location": "https://next.example.test/article"})
        handler.parent.open.assert_called_once()
        self.assertEqual(handler.parent.open.call_args.args[0].full_url, "https://next.example.test/article")

    def test_fetch_sets_total_deadline_and_restores_outer_operation(self):
        parent = RetrievalOperation(threading.Event(), 50.0)
        token = _OPERATION.set(parent)
        def open_request(*args, **kwargs):
            self.assertEqual(_OPERATION.get().deadline, 12.0)
            self.assertIs(_OPERATION.get().stopped, parent.stopped)
            raise RetrievalStopped("deadline")
        opener = Mock()
        opener.open.side_effect = open_request
        try:
            with patch("hermes_chat.retrieval.time.monotonic", return_value=10.0), \
                 patch("hermes_chat.retrieval.build_opener", return_value=opener):
                self.assertEqual(default_fetch(SOURCE_URL, 2.0).error, "timeout")
            self.assertIs(_OPERATION.get(), parent)
        finally:
            _OPERATION.reset(token)

    def test_redirect_is_not_dispatched_after_stop(self):
        operation = RetrievalOperation(threading.Event(), None)
        token = _OPERATION.set(operation)
        try:
            operation.stopped.set()
            with self.assertRaises(RetrievalStopped):
                _PublicRedirectHandler().redirect_request(Request(SOURCE_URL), None, 302, "Found", {}, "https://next.example.test")
        finally:
            _OPERATION.reset(token)

    def test_next_resolved_address_is_not_connected_after_stop(self):
        operation = RetrievalOperation(threading.Event(), None)
        token = _OPERATION.set(operation)
        connection = Mock()
        def failed_connect(address):
            operation.stopped.set()
            raise OSError("first address unavailable")
        connection.connect.side_effect = failed_connect
        addresses = [(socket.AF_INET, socket.SOCK_STREAM, 0, "", (ip, 443)) for ip in ("8.8.8.8", "1.1.1.1")]
        try:
            with patch("hermes_chat.retrieval.socket.getaddrinfo", return_value=addresses), patch("hermes_chat.retrieval.socket.socket", return_value=connection) as factory:
                with self.assertRaises(RetrievalStopped):
                    _public_socket("public.example.test", 443, 1)
                self.assertEqual(factory.call_count, 1)
                self.assertEqual(connection.connect.call_count, 1)
                connection.close.assert_called_once()
        finally:
            _OPERATION.reset(token)
