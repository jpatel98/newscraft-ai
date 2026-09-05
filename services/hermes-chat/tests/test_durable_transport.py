from __future__ import annotations

import asyncio
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Callable
from unittest.mock import patch

import httpx

import hermes_chat.durable as durable_module
from hermes_chat.contracts import RUN_TOKEN_HEADER
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

            def responder(_client: RecordingClient, _method: str, _url: str, _headers: dict[str, str], _body: Any):
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

            async def wait_for_cancel(_job: DurableJob) -> None:
                await gate.wait()

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


if __name__ == "__main__":
    unittest.main()
