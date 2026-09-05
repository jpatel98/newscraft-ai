from __future__ import annotations

import asyncio
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Callable
from unittest.mock import AsyncMock, patch

import httpx

import hermes_chat.durable as durable_module
from hermes_chat.contracts import RUN_TOKEN_HEADER
from hermes_chat.artifact_publish import ArtifactPublishError
from hermes_chat.durable import DurableJob, DurableRunError, DurableRunWorker
from hermes_chat.isolation import TenantIsolation


class FakeResponse:
    def __init__(self, status_code: int = 200, payload: Any = None):
        self.status_code = status_code
        self.payload = {} if payload is None else payload

    def json(self) -> Any:
        if isinstance(self.payload, BaseException):
            raise self.payload
        return self.payload


class RecordingClient:
    def __init__(
        self,
        name: str,
        responder: Callable[["RecordingClient", str, str, dict[str, str], Any], Any],
    ):
        self.name = name
        self.responder = responder
        self.requests: list[dict[str, Any]] = []
        self.closed = False
        self.cookie: str | None = None

    async def request(
        self,
        method: str,
        url: str,
        *,
        headers: dict[str, str],
        json: Any,
    ) -> FakeResponse:
        request_headers = dict(headers)
        if self.cookie:
            request_headers["cookie"] = self.cookie
        self.requests.append({"method": method, "url": url, "headers": request_headers, "json": json})
        result = self.responder(self, method, url, request_headers, json)
        if asyncio.iscoroutine(result):
            result = await result
        if self.cookie is None:
            self.cookie = f"scope={self.name}"
        return result

    async def aclose(self) -> None:
        self.closed = True


class KeepAliveServer:
    def __init__(self) -> None:
        self.server: asyncio.AbstractServer | None = None
        self.connections = 0
        self.requests: list[dict[str, Any]] = []
        self._writers: set[asyncio.StreamWriter] = set()

    async def start(self) -> int:
        self.server = await asyncio.start_server(self._handle, "127.0.0.1", 0)
        socket = self.server.sockets[0]
        return int(socket.getsockname()[1])

    async def _handle(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        self.connections += 1
        self._writers.add(writer)
        try:
            while True:
                request_line = await reader.readline()
                if not request_line:
                    return
                if not request_line.endswith(b"\r\n"):
                    return
                headers: dict[str, str] = {}
                while True:
                    line = await reader.readline()
                    if line in {b"", b"\r\n"}:
                        break
                    name, _, value = line.decode("latin-1").rstrip("\r\n").partition(":")
                    headers[name.lower()] = value.strip()
                content_length = int(headers.get("content-length", "0"))
                if content_length:
                    await reader.readexactly(content_length)
                parts = request_line.decode("latin-1").split()
                self.requests.append({"method": parts[0], "path": parts[1], "headers": headers})
                body = b"{}"
                writer.write(
                    b"HTTP/1.1 200 OK\r\n"
                    b"Content-Type: application/json\r\n"
                    b"Content-Length: 2\r\n"
                    b"Connection: keep-alive\r\n"
                    b"\r\n"
                    + body
                )
                await writer.drain()
        except (asyncio.IncompleteReadError, ConnectionError, OSError):
            return
        finally:
            self._writers.discard(writer)
            writer.close()
            try:
                await writer.wait_closed()
            except (ConnectionError, OSError):
                pass

    async def close(self) -> None:
        if self.server is not None:
            self.server.close()
            await self.server.wait_closed()
        writers = list(self._writers)
        for writer in writers:
            writer.close()
        if writers:
            await asyncio.gather(*(writer.wait_closed() for writer in writers), return_exceptions=True)


class DurableTransportTests(unittest.IsolatedAsyncioTestCase):
    def _worker(self, root: str) -> DurableRunWorker:
        settings = SimpleNamespace(
            run_api_url="http://newscraft.test/api/internal/hermes/runs",
            run_api_token="run-token",
            session_token="session-token",
            internal_agui_url="http://127.0.0.1:8768/",
        )
        isolation = TenantIsolation(Path(root) / "home", Path(root) / "workspace")
        return DurableRunWorker(settings, isolation)

    def _job(self, run_id: str, tenant_key: str, trace_id: str) -> DurableJob:
        return DurableJob(
            run_id=run_id,
            account_id=f"account-{tenant_key}",
            tenant_key=tenant_key,
            input={},
            seeded_citations=[],
            lease_owner=f"owner-{run_id}",
            lease_token=f"lease-{run_id}",
            trace_id=trace_id,
        )

    async def test_artifact_tool_rejects_unscoped_call_even_with_one_leased_job(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            worker = self._worker(root)
            job = self._job("run-a", "tenant_a", "trace_a12345678")
            job.thread_id = "thread-a"
            job.lease_acquired = True
            worker.jobs[job.run_id] = job

            with self.assertRaisesRegex(ArtifactPublishError, "trusted runtime binding"):
                await worker.resolve_active_job()

    async def test_artifact_tool_rejects_wrong_tenant_and_task_bindings(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            worker = self._worker(root)
            job = self._job("run-a", "tenant_a", "trace_a12345678")
            job.thread_id = "thread-a"
            job.lease_acquired = True
            worker.jobs[job.run_id] = job

            with self.assertRaisesRegex(ArtifactPublishError, "tenant binding"):
                await worker.resolve_active_job(run_id="run-a", tenant_key="tenant_b")
            with self.assertRaisesRegex(ArtifactPublishError, "task binding"):
                await worker.resolve_active_job(run_id="run-a", task_id="thread-b")

    async def test_artifact_tool_task_binding_selects_the_intended_job_concurrently(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            worker = self._worker(root)
            first = self._job("run-a", "tenant_a", "trace_a12345678")
            first.thread_id = "thread-a"
            first.lease_acquired = True
            second = self._job("run-b", "tenant_b", "trace_b12345678")
            second.thread_id = "thread-b"
            second.lease_acquired = True
            worker.jobs[first.run_id] = first
            worker.jobs[second.run_id] = second

            publish = AsyncMock(return_value={"artifact": {"id": "artifact-a"}})
            with patch.object(worker, "publish_artifact_spec", publish):
                result = await worker.publish_artifact_from_tool(
                    {"spec": {"kind": "chart", "title": "A", "series": []}},
                    task_id="thread-a",
                )

            self.assertEqual(result, {"artifact": {"id": "artifact-a"}})
            publish.assert_awaited_once()
            self.assertIs(publish.await_args.args[0], first)

    def _payload(self, run_id: str = "run-1", tenant_key: str = "tenant_key_1") -> dict[str, Any]:
        return {
            "run_id": run_id,
            "account_id": f"account-{tenant_key}",
            "tenant_key": tenant_key,
            "trace_id": f"trace_{run_id}1234",
            "input": {
                "runId": run_id,
                "threadId": f"thread-{run_id}",
                "trace_id": f"trace_{run_id}1234",
                "messages": [],
            },
            "seeded_citations": [],
        }

    async def _wait_until(self, predicate: Callable[[], bool]) -> None:
        for _ in range(200):
            if predicate():
                return
            await asyncio.sleep(0.001)
        self.fail("condition did not become true")

    async def test_run_scopes_reuse_clients_without_cross_tenant_cookie_or_trace_state(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            worker = self._worker(root)
            clients: list[RecordingClient] = []

            def responder(_client: RecordingClient, _method: str, url: str, _headers: dict[str, str], _body: Any):
                if url.endswith("/claim"):
                    return FakeResponse(200, {
                        "terminal": False,
                        "lease_owner": "owner-1",
                        "lease_token": "lease-1",
                        "worker_cursor": 0,
                    })
                return FakeResponse(200, {})

            def factory(**_kwargs: Any) -> RecordingClient:
                client = RecordingClient(f"client-{len(clients) + 1}", responder)
                clients.append(client)
                return client

            job_a = self._job("run-a", "tenant_a", "trace_a12345678")
            job_b = self._job("run-b", "tenant_b", "trace_b12345678")
            with patch.object(durable_module.httpx, "AsyncClient", side_effect=factory):
                async with worker._control_client_scope(job_a):
                    await worker._newscraft(
                        "POST",
                        "/claim",
                        {"tenant_key": job_a.tenant_key, "trace_id": job_a.trace_id},
                    )
                    await worker._newscraft(
                        "POST",
                        "/callback",
                        {"tenant_key": job_a.tenant_key, "trace_id": job_a.trace_id},
                    )
                async with worker._control_client_scope(job_b):
                    await worker._newscraft(
                        "POST",
                        "/claim",
                        {"tenant_key": job_b.tenant_key, "trace_id": job_b.trace_id},
                    )

            self.assertEqual(len(clients), 2)
            self.assertTrue(all(client.closed for client in clients))
            self.assertEqual(worker._control_clients, set())
            self.assertEqual(len(clients[0].requests), 2)
            self.assertEqual(len(clients[1].requests), 1)
            self.assertEqual(clients[0].requests[0]["json"]["tenant_key"], "tenant_a")
            self.assertEqual(clients[1].requests[0]["json"]["tenant_key"], "tenant_b")
            self.assertEqual(clients[0].requests[0]["headers"]["x-trace-id"], "trace_a12345678")
            self.assertEqual(clients[1].requests[0]["headers"]["x-trace-id"], "trace_b12345678")
            self.assertEqual(clients[0].requests[0]["headers"][RUN_TOKEN_HEADER], "run-token")
            self.assertEqual(clients[0].requests[1]["headers"]["cookie"], "scope=client-1")
            self.assertNotIn("cookie", clients[1].requests[0]["headers"])

    async def test_unscoped_errors_close_client_without_retry_and_preserve_error_mapping(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            worker = self._worker(root)
            clients: list[RecordingClient] = []
            client_options: list[dict[str, Any]] = []

            def responder(_client: RecordingClient, _method: str, _url: str, _headers: dict[str, str], _body: Any):
                return FakeResponse(503, {"code": "stale_lease"})

            def factory(**kwargs: Any) -> RecordingClient:
                client_options.append(kwargs)
                client = RecordingClient("error", responder)
                clients.append(client)
                return client

            with patch.object(durable_module.httpx, "AsyncClient", side_effect=factory):
                with self.assertRaises(DurableRunError) as context:
                    await worker._newscraft(
                        "POST",
                        "/callback",
                        {"trace_id": "trace_error1234"},
                    )

            self.assertEqual(context.exception.status_code, 503)
            self.assertEqual(context.exception.code, "stale_lease")
            self.assertEqual(len(clients), 1)
            self.assertEqual(client_options, [{"timeout": 20}])
            self.assertEqual(len(clients[0].requests), 1)
            self.assertTrue(clients[0].closed)
            self.assertEqual(worker._control_clients, set())

    async def test_timeout_closes_unscoped_client(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            worker = self._worker(root)
            clients: list[RecordingClient] = []

            def responder(_client: RecordingClient, _method: str, _url: str, _headers: dict[str, str], _body: Any):
                raise httpx.ReadTimeout("synthetic timeout")

            def factory(**_kwargs: Any) -> RecordingClient:
                client = RecordingClient("timeout", responder)
                clients.append(client)
                return client

            with patch.object(durable_module.httpx, "AsyncClient", side_effect=factory):
                with self.assertRaises(httpx.TimeoutException):
                    await worker._newscraft("GET", "/recover")

            self.assertEqual(len(clients), 1)
            self.assertTrue(clients[0].closed)
            self.assertEqual(worker._control_clients, set())

    async def test_completion_closes_run_client_after_claim_and_callbacks(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            worker = self._worker(root)
            clients: list[RecordingClient] = []

            def responder(_client: RecordingClient, _method: str, url: str, _headers: dict[str, str], _body: Any):
                if url.endswith("/claim"):
                    return FakeResponse(200, {
                        "terminal": False,
                        "lease_owner": "owner-1",
                        "lease_token": "lease-1",
                        "worker_cursor": 0,
                    })
                return FakeResponse(200, {})

            def factory(**_kwargs: Any) -> RecordingClient:
                client = RecordingClient(f"run-{len(clients) + 1}", responder)
                clients.append(client)
                return client

            async def finish(job: DurableJob) -> None:
                await worker._callback(job, "run.started", {"status": "researching"})
                await worker._callback(job, "response.completed", {"model": "fixture"})

            worker._run = finish  # type: ignore[method-assign]
            with patch.object(durable_module.httpx, "AsyncClient", side_effect=factory):
                await worker.start(self._payload())
                await self._wait_until(lambda: bool(clients) and clients[0].closed)

            self.assertEqual(
                [request["url"].rsplit("/", 1)[-1] for request in clients[0].requests],
                ["claim", "callback", "callback"],
            )
            self.assertEqual(worker._control_clients, set())

    async def test_admission_failure_reuses_client_for_fail_callback_then_closes(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            worker = self._worker(root)
            clients: list[RecordingClient] = []

            def responder(_client: RecordingClient, _method: str, url: str, _headers: dict[str, str], _body: Any):
                if url.endswith("/claim"):
                    return FakeResponse(503, {"code": "network"})
                return FakeResponse(200, {"state": "failed"})

            def factory(**_kwargs: Any) -> RecordingClient:
                client = RecordingClient("admission", responder)
                clients.append(client)
                return client

            job = DurableJob(
                run_id="run-admission",
                account_id="account-tenant_key_1",
                tenant_key="tenant_key_1",
                input={},
                seeded_citations=[],
                lease_owner="",
                lease_token="",
                trace_id="trace_run-admission1234",
            )
            with patch.object(durable_module.httpx, "AsyncClient", side_effect=factory):
                async with worker._lock:
                    worker.jobs[job.run_id] = job
                    worker._reserve_slot_locked(job)
                job.start_observed.set()
                job.task = asyncio.create_task(worker._admit_and_run(job))
                await job.task
                await self._wait_until(lambda: bool(clients) and clients[0].closed)

            self.assertEqual(
                [request["url"].rsplit("/", 1)[-1] for request in clients[0].requests],
                ["claim", "fail"],
            )
            self.assertEqual(worker._control_clients, set())

    async def test_cancellation_closes_run_client_after_terminal_cancel_callback(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            worker = self._worker(root)
            clients: list[RecordingClient] = []
            gate = asyncio.Event()

            def responder(_client: RecordingClient, _method: str, url: str, _headers: dict[str, str], _body: Any):
                if url.endswith("/claim"):
                    return FakeResponse(200, {
                        "terminal": False,
                        "lease_owner": "owner-1",
                        "lease_token": "lease-1",
                        "worker_cursor": 0,
                    })
                return FakeResponse(200, {})

            def factory(**_kwargs: Any) -> RecordingClient:
                client = RecordingClient("cancel", responder)
                clients.append(client)
                return client

            async def wait_for_cancel(job: DurableJob) -> None:
                try:
                    await gate.wait()
                except asyncio.CancelledError:
                    await worker._publish_cancelled(job)
                    raise

            worker._run = wait_for_cancel  # type: ignore[method-assign]
            with patch.object(durable_module.httpx, "AsyncClient", side_effect=factory):
                await worker.start(self._payload())
                result = await worker.cancel("run-1")
                self.assertEqual(result["state"], "cancel_requested")
                await self._wait_until(lambda: bool(clients) and clients[0].closed)

            self.assertEqual(
                [request["url"].rsplit("/", 1)[-1] for request in clients[0].requests],
                ["claim", "callback"],
            )
            self.assertEqual(worker._control_clients, set())

    async def test_shutdown_closes_active_run_client(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            worker = self._worker(root)
            clients: list[RecordingClient] = []
            gate = asyncio.Event()

            def responder(_client: RecordingClient, _method: str, url: str, _headers: dict[str, str], _body: Any):
                if url.endswith("/claim"):
                    return FakeResponse(200, {
                        "terminal": False,
                        "lease_owner": "owner-1",
                        "lease_token": "lease-1",
                        "worker_cursor": 0,
                    })
                return FakeResponse(200, {})

            def factory(**_kwargs: Any) -> RecordingClient:
                client = RecordingClient("shutdown", responder)
                clients.append(client)
                return client

            async def wait_for_shutdown(_job: DurableJob) -> None:
                await gate.wait()

            worker._run = wait_for_shutdown  # type: ignore[method-assign]
            with patch.object(durable_module.httpx, "AsyncClient", side_effect=factory):
                await worker.start(self._payload())
                await worker.close()
                await self._wait_until(lambda: bool(clients) and clients[0].closed)

            self.assertEqual(worker._control_clients, set())

    async def test_recovery_failure_closes_unscoped_client(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            worker = self._worker(root)
            clients: list[RecordingClient] = []

            def responder(_client: RecordingClient, _method: str, _url: str, _headers: dict[str, str], _body: Any):
                raise httpx.ReadTimeout("synthetic recovery timeout")

            def factory(**_kwargs: Any) -> RecordingClient:
                client = RecordingClient("recovery", responder)
                clients.append(client)
                return client

            with patch.object(durable_module.httpx, "AsyncClient", side_effect=factory):
                with self.assertLogs("hermes_chat.durable", level="ERROR"):
                    await worker.recover()

            self.assertEqual(len(clients), 1)
            self.assertTrue(clients[0].closed)
            self.assertEqual(worker._control_clients, set())

    async def test_real_http_transport_reuses_one_keep_alive_connection_within_run_scope(self) -> None:
        server = KeepAliveServer()
        port = await server.start()
        try:
            with tempfile.TemporaryDirectory() as root:
                worker = self._worker(root)
                worker.settings.run_api_url = f"http://127.0.0.1:{port}/api/internal/hermes/runs"
                job = self._job("run-real", "tenant_real", "trace_real12345678")
                async with worker._control_client_scope(job):
                    await worker._newscraft(
                        "POST",
                        "/claim",
                        {"run_id": job.run_id, "tenant_key": job.tenant_key, "trace_id": job.trace_id},
                    )
                    await worker._newscraft(
                        "POST",
                        "/callback",
                        {"run_id": job.run_id, "tenant_key": job.tenant_key, "trace_id": job.trace_id},
                    )
                self.assertEqual(worker._control_clients, set())
                self.assertEqual(server.connections, 1)
                self.assertEqual(len(server.requests), 2)
                self.assertEqual(
                    [request["path"] for request in server.requests],
                    [
                        "/api/internal/hermes/runs/claim",
                        "/api/internal/hermes/runs/callback",
                    ],
                )
                self.assertTrue(all(request["headers"].get("x-trace-id") == job.trace_id for request in server.requests))
                self.assertTrue(all(request["headers"].get(RUN_TOKEN_HEADER) == "run-token" for request in server.requests))
        finally:
            await server.close()

    async def test_next_admission_task_does_not_inherit_previous_closed_client(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            worker = self._worker(root)
            clients: list[RecordingClient] = []

            def responder(_client: RecordingClient, _method: str, url: str, _headers: dict[str, str], _body: Any):
                if url.endswith("/claim"):
                    return FakeResponse(200, {
                        "terminal": False,
                        "lease_owner": "owner-1",
                        "lease_token": "lease-1",
                        "worker_cursor": 0,
                    })
                return FakeResponse(200, {})

            def factory(**_kwargs: Any) -> RecordingClient:
                client = RecordingClient(f"queued-{len(clients) + 1}", responder)
                clients.append(client)
                return client

            async def finish(job: DurableJob) -> None:
                await worker._callback(job, "response.completed", {"model": "fixture"})

            worker._run = finish  # type: ignore[method-assign]
            with patch.object(durable_module.httpx, "AsyncClient", side_effect=factory):
                await worker.start(self._payload("run-first"))
                await self._wait_until(lambda: len(clients) == 1 and clients[0].closed)
                await worker.start(self._payload("run-second"))
                await self._wait_until(lambda: len(clients) == 2 and clients[1].closed)

            self.assertIsNot(clients[0], clients[1])
            self.assertEqual([len(client.requests) for client in clients], [2, 2])
            self.assertIsNone(durable_module._CURRENT_NEWSCRAFT_CLIENT.get())
            self.assertEqual(worker._control_clients, set())

    async def test_recovery_continuation_created_after_scope_has_no_run_client(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            worker = self._worker(root)
            observed: list[Any] = []
            finished = asyncio.Event()

            async def recovery_probe() -> None:
                observed.append(durable_module._CURRENT_NEWSCRAFT_CLIENT.get())
                finished.set()

            worker.recover = recovery_probe  # type: ignore[method-assign]
            worker._recovery_backlog_known = True
            job = self._job("run-recovery-context", "tenant_context", "trace_context1234")
            async with worker._control_client_scope(job):
                self.assertIsNotNone(durable_module._CURRENT_NEWSCRAFT_CLIENT.get())
            self.assertIsNone(durable_module._CURRENT_NEWSCRAFT_CLIENT.get())
            async with worker._lock:
                worker._reserve_slot_locked(job)
            await worker._release_slot(job)
            await asyncio.wait_for(finished.wait(), timeout=1)
            self.assertEqual(observed, [None])

    async def test_recovered_run_completion_closes_run_client(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            worker = self._worker(root)
            clients: list[RecordingClient] = []

            def responder(_client: RecordingClient, _method: str, _url: str, _headers: dict[str, str], _body: Any):
                return FakeResponse(200, {})

            def factory(**_kwargs: Any) -> RecordingClient:
                client = RecordingClient("recovered", responder)
                clients.append(client)
                return client

            async def finish(job: DurableJob) -> None:
                await worker._callback(job, "run.started", {"status": "researching"})
                await worker._callback(job, "response.completed", {"model": "fixture"})

            worker._run = finish  # type: ignore[method-assign]
            payload = self._payload("run-recovered")
            payload.update({"lease_owner": "owner-recovered", "lease_token": "lease-recovered"})
            with patch.object(durable_module.httpx, "AsyncClient", side_effect=factory):
                await worker.start_recovered(payload)
                await self._wait_until(lambda: bool(clients) and clients[0].closed)

            self.assertEqual(len(clients), 1)
            self.assertEqual([request["url"].rsplit("/", 1)[-1] for request in clients[0].requests], ["callback", "callback"])
            self.assertEqual(worker._control_clients, set())

    async def test_recovered_cancellation_closes_run_client_after_terminal_callback(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            worker = self._worker(root)
            clients: list[RecordingClient] = []
            gate = asyncio.Event()

            def responder(_client: RecordingClient, _method: str, _url: str, _headers: dict[str, str], _body: Any):
                return FakeResponse(200, {})

            def factory(**_kwargs: Any) -> RecordingClient:
                client = RecordingClient("recovered-cancel", responder)
                clients.append(client)
                return client

            async def wait_for_cancel(_job: DurableJob) -> None:
                await gate.wait()

            worker._run = wait_for_cancel  # type: ignore[method-assign]
            payload = self._payload("run-recovered-cancel")
            payload.update({"lease_owner": "owner-recovered", "lease_token": "lease-recovered"})
            with patch.object(durable_module.httpx, "AsyncClient", side_effect=factory):
                await worker.start_recovered(payload)
                await self._wait_until(lambda: bool(clients))
                result = await worker.cancel("run-recovered-cancel")
                self.assertEqual(result["state"], "cancel_requested")
                await self._wait_until(lambda: bool(clients) and clients[0].closed)

            self.assertEqual([request["url"].rsplit("/", 1)[-1] for request in clients[0].requests], ["callback"])
            self.assertEqual(worker._control_clients, set())

    async def test_shutdown_flushes_late_text_once_before_closing_run_client(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            worker = self._worker(root)
            clients: list[RecordingClient] = []
            gate = asyncio.Event()

            def responder(_client: RecordingClient, _method: str, url: str, _headers: dict[str, str], body: Any):
                if url.endswith("/claim"):
                    return FakeResponse(200, {
                        "terminal": False,
                        "lease_owner": "owner-1",
                        "lease_token": "lease-1",
                        "worker_cursor": 0,
                    })
                return FakeResponse(200, {})

            def factory(**_kwargs: Any) -> RecordingClient:
                client = RecordingClient("late-flush", responder)
                clients.append(client)
                return client

            async def wait_for_shutdown(job: DurableJob) -> None:
                await worker._callback(job, durable_module.TEXT_EVENT_TYPE, {"delta": "late text"})
                await self._wait_until(lambda: job.text_flush_task is not None)
                await gate.wait()

            worker._run = wait_for_shutdown  # type: ignore[method-assign]
            with patch.object(durable_module.httpx, "AsyncClient", side_effect=factory):
                await worker.start(self._payload("run-late-flush"))
                job = worker.jobs["run-late-flush"]
                await self._wait_until(lambda: job.text_flush_task is not None)
                await worker.close()
                await self._wait_until(lambda: bool(clients) and clients[0].closed)

            callback_requests = [
                request
                for request in clients[0].requests
                if request["url"].endswith("/callback")
            ]
            self.assertEqual(len(callback_requests), 1)
            self.assertEqual(callback_requests[0]["json"]["data"], {"delta": "late text"})
            self.assertEqual(worker._control_clients, set())


if __name__ == "__main__":
    unittest.main()
