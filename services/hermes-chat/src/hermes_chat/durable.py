"""Durable NewsCraft run ownership for the long-lived Hermes service."""

from __future__ import annotations

import asyncio
import contextlib
import contextvars
import json
import logging
import re
import secrets
import socket
from collections import deque
from dataclasses import dataclass, field
from typing import Any, AsyncIterator, Mapping
from urllib.parse import quote

import httpx

from .contracts import (
    NEWSCRAFT_RUN_CALLBACK_PATH,
    NEWSCRAFT_RUN_CLAIM_PATH,
    NEWSCRAFT_RUN_FAIL_PATH,
    NEWSCRAFT_RUN_RECOVER_PATH,
    NEWSCRAFT_RUN_RELEASE_PATH,
    NEWSCRAFT_RUN_RENEW_PATH,
    RUN_LEASE_RENEW_INTERVAL_SECONDS,
    RUN_TOKEN_HEADER,
)
from .isolation import TenantIsolation

logger = logging.getLogger(__name__)


# Text is the only high-volume event class. Keep the unpersisted tail small
# while avoiding one NewsCraft transaction per Hermes token.
TEXT_BATCH_MAX_CHARS = 4_096
TEXT_BATCH_FLUSH_INTERVAL_SECONDS = 0.05
TEXT_EVENT_TYPE = "response.output_text.delta"
TRACE_ID_RE = r"^[A-Za-z0-9._-]{8,128}$"

_CURRENT_NEWSCRAFT_CLIENT: contextvars.ContextVar[httpx.AsyncClient | None] = contextvars.ContextVar(
    "newscraft_control_client",
    default=None,
)

DEFAULT_MAX_ACTIVE_RUNS = 4
DEFAULT_MAX_ACTIVE_RUNS_PER_TENANT = 2
DEFAULT_MAX_QUEUED_RUNS = 16
DEFAULT_MAX_QUEUED_RUNS_PER_TENANT = 4
OVERLOAD_ERROR_CODE = "overloaded"
OVERLOAD_ERROR_MESSAGE = "Hermes run capacity is temporarily full. Try again shortly."


@dataclass(frozen=True)
class DurableConcurrencyLimits:
    """Validated single-process admission limits for durable NewsCraft runs."""

    max_active_runs: int = DEFAULT_MAX_ACTIVE_RUNS
    max_active_runs_per_tenant: int = DEFAULT_MAX_ACTIVE_RUNS_PER_TENANT
    max_queued_runs: int = DEFAULT_MAX_QUEUED_RUNS
    max_queued_runs_per_tenant: int = DEFAULT_MAX_QUEUED_RUNS_PER_TENANT

    @classmethod
    def from_settings(cls, settings: Any) -> "DurableConcurrencyLimits":
        values = {
            "max_active_runs": getattr(settings, "max_active_runs", DEFAULT_MAX_ACTIVE_RUNS),
            "max_active_runs_per_tenant": getattr(
                settings,
                "max_active_runs_per_tenant",
                DEFAULT_MAX_ACTIVE_RUNS_PER_TENANT,
            ),
            "max_queued_runs": getattr(settings, "max_queued_runs", DEFAULT_MAX_QUEUED_RUNS),
            "max_queued_runs_per_tenant": getattr(
                settings,
                "max_queued_runs_per_tenant",
                DEFAULT_MAX_QUEUED_RUNS_PER_TENANT,
            ),
        }
        ranges = {
            "max_active_runs": (1, 128),
            "max_active_runs_per_tenant": (1, 128),
            "max_queued_runs": (1, 1024),
            "max_queued_runs_per_tenant": (1, 1024),
        }
        for name, value in values.items():
            minimum, maximum = ranges[name]
            if isinstance(value, bool) or not isinstance(value, int) or not minimum <= value <= maximum:
                raise RuntimeError(f"{name} is outside the validated concurrency range")
        if values["max_active_runs_per_tenant"] > values["max_active_runs"]:
            raise RuntimeError("max_active_runs_per_tenant cannot exceed max_active_runs")
        if values["max_queued_runs_per_tenant"] > values["max_queued_runs"]:
            raise RuntimeError("max_queued_runs_per_tenant cannot exceed max_queued_runs")
        return cls(**values)


class DurableRunError(RuntimeError):
    def __init__(self, message: str, status_code: int | None = None, code: str | None = None):
        super().__init__(message)
        self.status_code = status_code
        self.code = code


def _string(value: Any, label: str) -> str:
    result = str(value or "").strip()
    if not result or len(result) > 256:
        raise DurableRunError(f"{label} is invalid")
    return result


def _json_object(value: Any, label: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise DurableRunError(f"{label} must be an object")
    return value


def _trace_id(value: Any) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str):
        raise DurableRunError("trace_id is invalid")
    result = value.strip()
    if not result or not re.fullmatch(TRACE_ID_RE, result):
        raise DurableRunError("trace_id is invalid")
    return result


def _resolve_trace_id(run_input: Mapping[str, Any], payload_value: Any) -> str | None:
    input_trace = _trace_id(run_input.get("trace_id"))
    payload_trace = _trace_id(payload_value)
    if input_trace and payload_trace and input_trace != payload_trace:
        raise DurableRunError("trace binding does not match")
    return payload_trace or input_trace


def _failure_class(error: BaseException) -> str:
    if isinstance(error, asyncio.CancelledError):
        return "cancelled"
    if isinstance(error, DurableRunError):
        if error.code == OVERLOAD_ERROR_CODE:
            return "overload"
        if error.code in {"stale_lease", "stale_callback"}:
            return "lease"
        if error.code == "protocol":
            return "protocol"
        if error.code == "callback":
            return "callback"
        if error.status_code in {408, 504}:
            return "timeout"
        if error.status_code is not None:
            return "upstream"
    if isinstance(error, httpx.TimeoutException):
        return "timeout"
    if isinstance(error, httpx.RequestError):
        return "network"
    return "unknown"


def _event_payload(event_type: str, data: Mapping[str, Any]) -> dict[str, Any]:
    return {"event_type": event_type, "data": dict(data)}


def _event_type(payload: Mapping[str, Any], event: str) -> str:
    raw = payload.get("type") or event
    return str(raw).replace("-", "_").replace(" ", "_").upper()


def _value(payload: Mapping[str, Any], *names: str) -> Any:
    for name in names:
        if name in payload:
            return payload[name]
    return None


def _compact(value: Any, limit: int = 24_000) -> Any:
    if isinstance(value, str):
        return value if len(value) <= limit else f"{value[:limit]}\n[truncated]"
    if isinstance(value, dict):
        return {str(key): _compact(item, limit) for key, item in value.items()}
    if isinstance(value, list):
        return [_compact(item, limit) for item in value[:100]]
    return value


def _bounded_data(value: Mapping[str, Any]) -> dict[str, Any]:
    encoded = json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    if len(encoded.encode("utf-8")) <= 120 * 1024:
        return dict(value)
    return {"truncated": True, "preview": encoded[:100_000]}


def normalized_events(
    event: str,
    payload: Mapping[str, Any],
    tool_arguments: dict[str, str],
    tool_names: dict[str, str],
    text_parts: list[str],
) -> list[dict[str, Any]]:
    """Convert one Hermes AG-UI frame into bounded NewsCraft events."""
    kind = _event_type(payload, event)
    if kind == "RUN_STARTED":
        return [_event_payload("run.started", {"status": "researching"})]
    if kind == "TEXT_MESSAGE_CONTENT":
        delta = _value(payload, "delta", "content")
        if not isinstance(delta, str) or not delta:
            return []
        text_parts.append(delta)
        return [_event_payload("response.output_text.delta", {"delta": delta})]
    if kind == "TEXT_MESSAGE_END":
        return []
    if kind == "RUN_ERROR":
        nested = payload.get("error")
        message = (
            nested.get("message")
            if isinstance(nested, dict)
            else nested
        ) or payload.get("message") or "Hermes returned an agent error."
        return [_event_payload("response.failed", {
            "failure_class": "upstream",
            "error": {"message": str(message)},
        })]
    if kind == "RUN_FINISHED":
        events: list[dict[str, Any]] = []
        answer = "".join(text_parts)
        if not answer.strip():
            return [_event_payload("response.failed", {
                "failure_class": "protocol",
                "error": {"message": "Hermes ended before a completed response."},
            })]
        events.append(_event_payload("agent.answer.replace", {"content": answer}))
        events.append(_event_payload("response.completed", {"model": "hermes-chat"}))
        return events

    if kind in {"TOOL_CALL_START", "TOOL_CALL_ARGS", "TOOL_CALL_RESULT", "TOOL_CALL_END"}:
        call_id = _value(payload, "toolCallId", "tool_call_id", "callId", "call_id", "id")
        if not call_id:
            return []
        call_id = str(call_id)
        name = str(_value(payload, "toolCallName", "tool_call_name", "name") or tool_names.get(call_id) or "Hermes tool")
        tool_names[call_id] = name
        reset_events: list[dict[str, Any]] = []
        if kind == "TOOL_CALL_START" and text_parts:
            # Text before a later tool call is process narration, not the
            # answer. Remove it from the durable answer surface before the
            # tool progress event is saved.
            text_parts.clear()
            reset_events.append(_event_payload("agent.answer.replace", {"content": ""}))
        if kind == "TOOL_CALL_ARGS":
            delta = _value(payload, "delta", "arguments") or ""
            tool_arguments[call_id] = f"{tool_arguments.get(call_id, '')}{delta}"[-24_000:]
            return reset_events + [_event_payload("agent.tool.progress", {"id": call_id, "name": name, "arguments": tool_arguments[call_id], "status": "running"})]
        if kind == "TOOL_CALL_RESULT":
            result = _value(payload, "result", "output", "content")
            return reset_events + [_event_payload("agent.tool.progress", {"id": call_id, "name": name, "result": _compact(result), "status": "ok"})]
        return reset_events + [_event_payload("agent.tool.progress", {"id": call_id, "name": name, "status": "ok" if kind == "TOOL_CALL_END" else "running", "done": kind == "TOOL_CALL_END"})]

    if kind == "STATE_SNAPSHOT":
        snapshot = payload.get("snapshot")
        if not isinstance(snapshot, dict):
            return []
        events: list[dict[str, Any]] = []
        sources = snapshot.get("newscraftSources")
        if not isinstance(sources, list):
            return events
        citations: list[dict[str, Any]] = []
        for source in sources[:100]:
            if not isinstance(source, dict):
                continue
            events.append(_event_payload("agent.source.read", {"source": _compact(source, 8_000)}))
            citation_number = source.get("citationNumber") or source.get("citation_number")
            if citation_number and source.get("url"):
                citations.append({
                    "citationNumber": citation_number,
                    "title": source.get("title") or source.get("url"),
                    "url": source.get("url"),
                    "domain": source.get("domain") or "Unknown source",
                    "publicationDate": source.get("publicationDate"),
                    "sourceType": source.get("sourceType") or "unknown",
                    "supportingExcerpt": source.get("supportingExcerpt") or "",
                })
        if citations:
            events.append(_event_payload("agent.citations", {"citations": citations}))
        return events
    return []


async def iter_sse(lines: AsyncIterator[str]) -> AsyncIterator[tuple[str, dict[str, Any]]]:
    event = "message"
    data_lines: list[str] = []
    async for line in lines:
        if line:
            if line.startswith("event:"):
                event = line[6:].strip() or "message"
            elif line.startswith("data:"):
                data_lines.append(line[5:].lstrip())
            continue
        if data_lines:
            raw = "\n".join(data_lines)
            if raw != "[DONE]":
                try:
                    parsed = json.loads(raw)
                except json.JSONDecodeError:
                    parsed = {}
                if isinstance(parsed, dict):
                    yield event, parsed
            event = "message"
            data_lines = []
    if data_lines:
        try:
            parsed = json.loads("\n".join(data_lines))
        except json.JSONDecodeError:
            parsed = {}
        if isinstance(parsed, dict):
            yield event, parsed


@dataclass
class DurableJob:
    run_id: str
    account_id: str
    tenant_key: str
    input: dict[str, Any]
    seeded_citations: list[dict[str, Any]]
    lease_owner: str
    lease_token: str
    worker_cursor: int = 0
    trace_id: str | None = None
    task: asyncio.Task[None] | None = None
    stop_reason: str | None = None
    stale_lease: bool = False
    callback_lock: asyncio.Lock = field(default_factory=asyncio.Lock, repr=False)
    text_buffer: list[str] = field(default_factory=list, repr=False)
    text_buffer_chars: int = field(default=0, repr=False)
    text_flush_task: asyncio.Task[None] | None = field(default=None, repr=False)
    text_flush_error: BaseException | None = field(default=None, repr=False)
    slot_reserved: bool = field(default=False, repr=False)
    lease_acquired: bool = field(default=False, repr=False)
    claim_ready: asyncio.Event = field(default_factory=asyncio.Event, repr=False)
    start_observed: asyncio.Event = field(default_factory=asyncio.Event, repr=False)
    claim_settlement_lock: asyncio.Lock = field(default_factory=asyncio.Lock, repr=False)
    claim_settled: bool = field(default=False, repr=False)
    claim_result: dict[str, Any] | None = field(default=None, repr=False)
    claim_error: BaseException | None = field(default=None, repr=False)
    cancel_publish_lock: asyncio.Lock = field(default_factory=asyncio.Lock, repr=False)
    cancel_published: bool = field(default=False, repr=False)
    control_client: httpx.AsyncClient | None = field(default=None, repr=False)


class DurableRunWorker:
    """Owns Hermes tasks after the start endpoint returns.

    New runs wait in a bounded, in-memory round-robin queue before asking
    NewsCraft for a lease. A waiting run therefore cannot hold a lease that
    expires while it is waiting. Recovery payloads are different: the
    recovery route has already claimed their lease, so they are admitted
    immediately or released back to the recovery pool.
    """

    def __init__(self, settings: Any, isolation: TenantIsolation):
        self.settings = settings
        self.isolation = isolation
        self.instance_id = f"{socket.gethostname()}-{secrets.token_hex(6)}"
        self.limits = DurableConcurrencyLimits.from_settings(settings)
        self.jobs: dict[str, DurableJob] = {}
        self._lock = asyncio.Lock()
        self._dispatch_lock = asyncio.Lock()
        self._tenant_queues: dict[str, deque[str]] = {}
        self._tenant_order: deque[str] = deque()
        self._active_runs = 0
        self._active_by_tenant: dict[str, int] = {}
        self._rejected_runs = 0
        self._recovery_lock = asyncio.Lock()
        self._recovery_task: asyncio.Task[None] | None = None
        self._recovery_pending = False
        self._recovery_backlog_known = False
        # One admitted job owns one client. Unscoped recovery/release calls
        # own one-shot clients, and recovery serializes those calls.
        self._control_clients: set[httpx.AsyncClient] = set()
        self._closed = False

    @property
    def configured(self) -> bool:
        return bool(self.settings.run_api_url and self.settings.run_api_token)

    def capacity_snapshot(self) -> dict[str, Any]:
        """Return aggregate capacity state without exposing tenant details."""
        return {
            "active_runs": self._active_runs,
            "queued_runs": sum(len(queue) for queue in self._tenant_queues.values()),
            "rejected_runs": self._rejected_runs,
            "limits": {
                "max_active_runs": self.limits.max_active_runs,
                "max_active_runs_per_tenant": self.limits.max_active_runs_per_tenant,
                "max_queued_runs": self.limits.max_queued_runs,
                "max_queued_runs_per_tenant": self.limits.max_queued_runs_per_tenant,
            },
        }

    def _headers(self, trace_id: str | None = None) -> dict[str, str]:
        headers = {RUN_TOKEN_HEADER: self.settings.run_api_token or "", "content-type": "application/json"}
        if trace_id:
            headers.update({"x-request-id": trace_id, "x-trace-id": trace_id})
        return headers

    def _newscraft_url(self, path: str) -> str:
        if not self.settings.run_api_url:
            raise DurableRunError("NewsCraft durable run API is not configured")
        return f"{self.settings.run_api_url.rstrip('/')}{path}"

    def _new_http_client(self) -> httpx.AsyncClient:
        # A client is owned by one durable run or one unscoped control request.
        # Do not put auth, tenant, trace, or cookie state in client defaults.
        client = httpx.AsyncClient(timeout=20)
        self._control_clients.add(client)
        return client

    async def _close_http_client(self, client: httpx.AsyncClient) -> None:
        try:
            await client.aclose()
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.warning("NewsCraft control client close failed")
        finally:
            self._control_clients.discard(client)

    @contextlib.asynccontextmanager
    async def _control_client_scope(
        self,
        job: DurableJob | None = None,
    ) -> AsyncIterator[httpx.AsyncClient]:
        client = self._new_http_client()
        if job is not None:
            job.control_client = client
        token = _CURRENT_NEWSCRAFT_CLIENT.set(client)
        try:
            yield client
        finally:
            _CURRENT_NEWSCRAFT_CLIENT.reset(token)
            if job is not None and job.control_client is client:
                job.control_client = None
            await self._close_http_client(client)

    async def _newscraft(self, method: str, path: str, body: dict[str, Any] | None = None) -> dict[str, Any]:
        trace_id = _trace_id(body.get("trace_id")) if isinstance(body, dict) else None
        client = _CURRENT_NEWSCRAFT_CLIENT.get()
        owns_client = client is None
        if owns_client:
            client = self._new_http_client()
        assert client is not None
        try:
            response = await client.request(
                method,
                self._newscraft_url(path),
                headers=self._headers(trace_id),
                json=body,
            )
        finally:
            if owns_client:
                await self._close_http_client(client)
        if response.status_code >= 400:
            code: str | None = None
            try:
                error_body = response.json()
                if isinstance(error_body, dict) and isinstance(error_body.get("code"), str):
                    code = error_body["code"]
            except ValueError:
                pass
            if code is None:
                code = "callback" if path.endswith(NEWSCRAFT_RUN_CALLBACK_PATH) else "network"
            raise DurableRunError(
                f"NewsCraft durable run request failed ({response.status_code})",
                response.status_code,
                code,
            )
        value = response.json()
        return value if isinstance(value, dict) else {}

    def _queued_for_tenant_locked(self, tenant_key: str) -> int:
        return len(self._tenant_queues.get(tenant_key, ()))

    def _has_active_slot_locked(self, tenant_key: str) -> bool:
        return (
            self._active_runs < self.limits.max_active_runs
            and self._active_by_tenant.get(tenant_key, 0) < self.limits.max_active_runs_per_tenant
        )

    def _enqueue_locked(self, job: DurableJob) -> None:
        queue = self._tenant_queues.setdefault(job.tenant_key, deque())
        if not queue:
            self._tenant_order.append(job.tenant_key)
        queue.append(job.run_id)

    def _remove_queued_locked(self, job: DurableJob) -> bool:
        queue = self._tenant_queues.get(job.tenant_key)
        if not queue:
            return False
        try:
            queue.remove(job.run_id)
        except ValueError:
            return False
        if not queue:
            self._tenant_queues.pop(job.tenant_key, None)
            self._tenant_order = deque(
                tenant for tenant in self._tenant_order if tenant != job.tenant_key
            )
        return True

    def _next_queued_job_locked(self) -> DurableJob | None:
        # One pass is enough: blocked tenants rotate to the back while an
        # eligible tenant can make progress. This is weighted only by the
        # explicit active-per-tenant limit, never by tenant identity.
        for _ in range(len(self._tenant_order)):
            tenant_key = self._tenant_order.popleft()
            queue = self._tenant_queues.get(tenant_key)
            if not queue:
                self._tenant_queues.pop(tenant_key, None)
                continue
            if not self._has_active_slot_locked(tenant_key):
                self._tenant_order.append(tenant_key)
                continue
            run_id = queue.popleft()
            if queue:
                self._tenant_order.append(tenant_key)
            else:
                self._tenant_queues.pop(tenant_key, None)
            job = self.jobs.get(run_id)
            if job is None or job.stop_reason:
                continue
            return job
        return None

    def _reserve_slot_locked(self, job: DurableJob) -> None:
        if job.slot_reserved:
            raise RuntimeError("durable run slot is already reserved")
        job.slot_reserved = True
        self._active_runs += 1
        self._active_by_tenant[job.tenant_key] = self._active_by_tenant.get(job.tenant_key, 0) + 1

    async def _release_slot(self, job: DurableJob) -> None:
        async with self._lock:
            if job.slot_reserved:
                job.slot_reserved = False
                self._active_runs = max(0, self._active_runs - 1)
                count = self._active_by_tenant.get(job.tenant_key, 0) - 1
                if count > 0:
                    self._active_by_tenant[job.tenant_key] = count
                else:
                    self._active_by_tenant.pop(job.tenant_key, None)
        if not self._closed:
            await self._dispatch()
            self._schedule_recovery()

    async def _dispatch(self) -> None:
        async with self._dispatch_lock:
            while not self._closed:
                async with self._lock:
                    job = self._next_queued_job_locked()
                    if job is None:
                        return
                    self._reserve_slot_locked(job)
                    job.task = asyncio.create_task(
                        self._admit_and_run(job),
                        name=f"newscraft-hermes-admit-{job.run_id}",
                    )

    async def start(self, payload: Mapping[str, Any]) -> dict[str, Any]:
        run_id = _string(payload.get("run_id"), "run_id")
        account_id = _string(payload.get("account_id"), "account_id")
        tenant_key = _string(payload.get("tenant_key"), "tenant_key")
        run_input = _json_object(payload.get("input"), "input")
        trace_id = _resolve_trace_id(run_input, payload.get("trace_id"))
        self.isolation.resolve(tenant_key)
        if str(run_input.get("runId") or run_input.get("run_id") or "").strip() not in {"", run_id}:
            raise DurableRunError("input run id does not match run id")
        job: DurableJob | None = None
        try:
            async with self._lock:
                if self._closed:
                    raise DurableRunError("Hermes durable worker is shutting down", 503, "unavailable")
                current = self.jobs.get(run_id)
                if current:
                    if current.account_id != account_id:
                        raise DurableRunError("run account binding does not match")
                    if current.tenant_key != tenant_key:
                        raise DurableRunError("run tenant binding does not match")
                    if trace_id and current.trace_id and current.trace_id != trace_id:
                        raise DurableRunError("run trace binding does not match")
                    if current.stop_reason == "cancelled":
                        state = "cancelled"
                    elif current.claim_error is not None:
                        state = "failed"
                    elif current.claim_result and (
                        current.claim_result.get("terminal") or current.claim_result.get("duplicate")
                    ):
                        state = current.claim_result.get("state", "finished")
                    elif current.lease_acquired and current.task and not current.task.done():
                        state = "running"
                    elif not current.lease_acquired and current.stop_reason is None:
                        state = "queued"
                    else:
                        state = "finished"
                    return {"accepted": True, "duplicate": True, "run_id": run_id, "state": state}
                if (
                    self._queued_for_tenant_locked(tenant_key) >= self.limits.max_queued_runs_per_tenant
                    or sum(len(queue) for queue in self._tenant_queues.values()) >= self.limits.max_queued_runs
                ):
                    self._rejected_runs += 1
                    raise DurableRunError(OVERLOAD_ERROR_MESSAGE, 429, OVERLOAD_ERROR_CODE)
                job = DurableJob(
                    run_id=run_id,
                    account_id=account_id,
                    tenant_key=tenant_key,
                    input=run_input,
                    seeded_citations=[item for item in payload.get("seeded_citations", []) if isinstance(item, dict)][:100],
                    lease_owner="",
                    lease_token="",
                    trace_id=trace_id,
                )
                self.jobs[run_id] = job
                self._enqueue_locked(job)

            await self._dispatch()
            was_admitted = job.task is not None
            if was_admitted:
                await job.claim_ready.wait()
                if job.claim_error is not None:
                    await self._settle_claim_outcome(job, persist_failure=False)
                    raise job.claim_error
                if job.claim_result and (
                    job.claim_result.get("terminal") or job.claim_result.get("duplicate")
                ):
                    await self._settle_claim_outcome(job, persist_failure=False)
                    return {
                        "accepted": True,
                        "duplicate": True,
                        "run_id": run_id,
                        "state": job.claim_result.get("state", "complete"),
                    }
            return {"accepted": True, "duplicate": False, "run_id": run_id, "state": "queued"}
        finally:
            if job is not None:
                job.start_observed.set()

    async def _fail_queued_after_admission_error(self, job: DurableJob) -> None:
        """Persist a safe terminal state when admission rejects a saved run."""
        body = {
            "run_id": job.run_id,
            "account_id": job.account_id,
            "tenant_key": job.tenant_key,
            "reason": "admission",
        }
        if job.trace_id:
            body["trace_id"] = job.trace_id
        try:
            await self._newscraft("POST", NEWSCRAFT_RUN_FAIL_PATH, body)
        except Exception:
            # A transient control-plane outage leaves the saved unleased run
            # available to the normal recovery poller. Never report the raw
            # exception or tenant data through the service log.
            logger.warning("NewsCraft could not persist a durable admission failure")

    async def _settle_claim_outcome(self, job: DurableJob, *, persist_failure: bool) -> None:
        """Settle one claim outcome and remove any unleased local ownership."""
        async with job.claim_settlement_lock:
            if job.claim_settled:
                return
            try:
                if persist_failure and job.claim_error is not None:
                    await self._fail_queued_after_admission_error(job)
            finally:
                async with self._lock:
                    if self.jobs.get(job.run_id) is job and not job.lease_acquired:
                        self.jobs.pop(job.run_id, None)
                job.claim_settled = True

    async def _remove_unleased_job(self, job: DurableJob) -> None:
        async with self._lock:
            if self.jobs.get(job.run_id) is job and not job.lease_acquired:
                self.jobs.pop(job.run_id, None)

    async def _admit_and_run(self, job: DurableJob) -> None:
        try:
            async with self._control_client_scope(job):
                try:
                    await self._admit_and_run_in_scope(job)
                except asyncio.CancelledError:
                    if job.lease_acquired and job.stop_reason == "cancelled":
                        try:
                            await self._publish_cancelled(job)
                        except BaseException:
                            logger.exception("NewsCraft cancellation callback failed")
                    raise
        except asyncio.CancelledError:
            raise
        except BaseException as exc:
            if job.lease_acquired:
                logger.error("Durable Hermes admitted task failed")
            elif job.claim_error is None:
                job.claim_error = exc
                job.claim_ready.set()
                await job.start_observed.wait()
                await self._settle_claim_outcome(job, persist_failure=True)
        finally:
            if not job.claim_ready.is_set():
                job.claim_ready.set()
            if not job.lease_acquired and (job.claim_settled or job.stop_reason in {"cancelled", "shutdown"}):
                await self._remove_unleased_job(job)
            await self._release_slot(job)

    async def _admit_and_run_in_scope(self, job: DurableJob) -> None:
        try:
            owner = f"hermes:{self.instance_id}:{job.run_id}"
            claim_body = {
                "run_id": job.run_id,
                "account_id": job.account_id,
                "tenant_key": job.tenant_key,
                "lease_owner": owner,
            }
            if job.trace_id:
                claim_body["trace_id"] = job.trace_id
            try:
                claim = await self._newscraft("POST", NEWSCRAFT_RUN_CLAIM_PATH, claim_body)
            except DurableRunError as exc:
                if exc.status_code == 409 and exc.code == "lease_conflict":
                    job.claim_result = {
                        "accepted": True,
                        "duplicate": True,
                        "run_id": job.run_id,
                        "state": "running",
                    }
                else:
                    job.claim_error = exc
                job.claim_ready.set()
                await job.start_observed.wait()
                if job.claim_error is not None:
                    await self._settle_claim_outcome(job, persist_failure=True)
                else:
                    await self._settle_claim_outcome(job, persist_failure=False)
                return
            if claim.get("terminal"):
                job.claim_result = claim
                job.claim_ready.set()
                await job.start_observed.wait()
                await self._settle_claim_outcome(job, persist_failure=False)
                return
            job.lease_owner = _string(claim.get("lease_owner"), "lease_owner")
            job.lease_token = _string(claim.get("lease_token"), "lease_token")
            job.worker_cursor = int(claim.get("worker_cursor") or 0)
            job.lease_acquired = True
            job.claim_result = claim
            job.claim_ready.set()
            await self._run_claimed(job)
        except asyncio.CancelledError:
            raise
        except BaseException as exc:
            if job.lease_acquired:
                # The run already owns a lease. Its normal run path reports
                # provider/callback failures; never turn a post-claim error
                # into a queued admission failure.
                logger.error("Durable Hermes admitted task failed")
            elif job.claim_error is None:
                job.claim_error = exc
                job.claim_ready.set()
                await job.start_observed.wait()
                await self._settle_claim_outcome(job, persist_failure=True)

    async def _run_claimed(self, job: DurableJob) -> None:
        if job.stop_reason == "cancelled":
            await self._publish_cancelled(job)
            return
        await self._run(job)

    async def _run_recovered(self, job: DurableJob) -> None:
        try:
            async with self._control_client_scope(job):
                await self._run_claimed(job)
        finally:
            await self._release_slot(job)

    async def start_recovered(self, payload: Mapping[str, Any]) -> dict[str, Any]:
        run_id = _string(payload.get("run_id"), "run_id")
        account_id = _string(payload.get("account_id"), "account_id")
        tenant_key = _string(payload.get("tenant_key"), "tenant_key")
        lease_owner = _string(payload.get("lease_owner"), "lease_owner")
        lease_token = _string(payload.get("lease_token"), "lease_token")
        self.isolation.resolve(tenant_key)
        run_input = _json_object(payload.get("input"), "input")
        trace_id = _resolve_trace_id(run_input, payload.get("trace_id"))
        if str(run_input.get("runId") or run_input.get("run_id") or "").strip() not in {"", run_id}:
            raise DurableRunError("saved input run id does not match run id")
        existing_state: str | None = None
        async with self._lock:
            if self._closed:
                raise DurableRunError("Hermes durable worker is shutting down", 503, "unavailable")
            current = self.jobs.get(run_id)
            if current:
                if current.account_id != account_id:
                    raise DurableRunError("run account binding does not match")
                if current.tenant_key != tenant_key:
                    raise DurableRunError("run tenant binding does not match")
                if trace_id and current.trace_id and current.trace_id != trace_id:
                    raise DurableRunError("run trace binding does not match")
                if current.stop_reason == "cancelled":
                    current_state = "cancelled"
                elif current.lease_acquired and current.task and not current.task.done():
                    current_state = "running"
                elif not current.lease_acquired and current.stop_reason is None:
                    current_state = "queued"
                else:
                    current_state = "finished"
                # The recovery endpoint has already claimed this lease. Do
                # not replace a local waiting job or start a second task;
                # return the recovery lease below before acknowledging the
                # local duplicate.
                existing_state = current_state
            if existing_state is None:
                if not self._has_active_slot_locked(tenant_key):
                    raise DurableRunError("recovered run capacity is unavailable", 503, "capacity")
                job = DurableJob(
                    run_id=run_id,
                    account_id=account_id,
                    tenant_key=tenant_key,
                    input=run_input,
                    seeded_citations=[item for item in payload.get("seeded_citations", []) if isinstance(item, dict)][:100],
                    lease_owner=lease_owner,
                    lease_token=lease_token,
                    worker_cursor=int(payload.get("worker_cursor") or 0),
                    trace_id=trace_id,
                    lease_acquired=True,
                )
                resume_snapshot = payload.get("resume_snapshot")
                if isinstance(resume_snapshot, dict):
                    state = job.input.get("state")
                    if not isinstance(state, dict):
                        state = {}
                    sources = resume_snapshot.get("sources")
                    if isinstance(sources, list):
                        state["newscraftSources"] = sources[:100]
                    job.input["state"] = state
                    context = job.input.get("context")
                    if not isinstance(context, list):
                        context = []
                    context.append({
                        "description": "Previously gathered NewsCraft evidence from this durable run",
                        "value": json.dumps({
                            "answer_text": str(resume_snapshot.get("answer_text") or "")[:64 * 1024],
                            "sources": sources[:100] if isinstance(sources, list) else [],
                            "citations": resume_snapshot.get("citations") if isinstance(resume_snapshot.get("citations"), list) else [],
                        }),
                    })
                    job.input["context"] = context[-32:]
                self._reserve_slot_locked(job)
                job.task = asyncio.create_task(
                    self._run_recovered(job),
                    name=f"newscraft-hermes-recovered-{run_id}",
                )
                self.jobs[run_id] = job
                return {"accepted": True, "duplicate": False, "run_id": run_id, "state": "recovered"}
        await self._release_recovered_lease(payload, trace_id)
        return {"accepted": True, "duplicate": True, "run_id": run_id, "state": existing_state}

    async def _release_recovered_lease(
        self,
        payload: Mapping[str, Any],
        trace_id: str | None = None,
    ) -> None:
        body = {
            "run_id": _string(payload.get("run_id"), "run_id"),
            "account_id": _string(payload.get("account_id"), "account_id"),
            "tenant_key": _string(payload.get("tenant_key"), "tenant_key"),
            "lease_owner": _string(payload.get("lease_owner"), "lease_owner"),
            "lease_token": _string(payload.get("lease_token"), "lease_token"),
        }
        if trace_id is None:
            trace_id = _trace_id(payload.get("trace_id"))
        if trace_id is None and isinstance(payload.get("input"), Mapping):
            trace_id = _trace_id(payload["input"].get("trace_id"))
        if trace_id:
            body["trace_id"] = trace_id
        try:
            await self._newscraft("POST", NEWSCRAFT_RUN_RELEASE_PATH, body)
        except Exception:
            # The lease remains recoverable after expiry if this best-effort
            # return path is interrupted.
            logger.warning("NewsCraft could not return an unadmitted recovery lease")

    async def cancel(self, run_id: str, account_id: str | None = None, tenant_key: str | None = None) -> dict[str, Any]:
        async with self._lock:
            job = self.jobs.get(run_id)
            if not job:
                return {"accepted": True, "run_id": run_id, "state": "not_running"}
            if account_id and job.account_id != account_id:
                raise DurableRunError("run account binding does not match")
            if tenant_key and job.tenant_key != tenant_key:
                raise DurableRunError("run tenant binding does not match")
            if not job.slot_reserved or not job.task:
                if self._remove_queued_locked(job):
                    job.stop_reason = "cancelled"
                    return {"accepted": True, "run_id": run_id, "state": "not_running"}
                if job.task is None or job.task.done():
                    return {"accepted": True, "run_id": run_id, "state": "not_running"}
            task = job.task
            job.stop_reason = "cancelled"
        if task is None or task.done():
            return {"accepted": True, "run_id": run_id, "state": "not_running"}
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)
        return {
            "accepted": True,
            "run_id": run_id,
            "state": "cancel_requested" if job.lease_acquired else "not_running",
        }

    def _schedule_recovery(self) -> None:
        """Schedule one bounded recovery continuation after capacity returns."""
        if self._closed or not self.configured or not self._recovery_backlog_known:
            return
        current = asyncio.current_task()
        if self._recovery_task is not None and not self._recovery_task.done():
            if self._recovery_task is not current:
                self._recovery_pending = True
            return
        self._recovery_task = asyncio.create_task(
            self.recover(),
            name="newscraft-hermes-recovery-continuation",
        )

    async def _recover_batch(self) -> None:
        async with self._lock:
            if self._closed:
                return
            available = self.limits.max_active_runs - self._active_runs
        if available <= 0:
            # A recovery pass was requested while local work occupied every
            # slot. Remember that a recoverable backlog may still exist so
            # the next release can make one bounded attempt.
            self._recovery_backlog_known = True
            return
        owner = f"hermes-recovery:{self.instance_id}"
        request_limit = min(available, 100)
        result = await self._newscraft(
            "GET",
            f"{NEWSCRAFT_RUN_RECOVER_PATH}?lease_owner={quote(owner)}&limit={request_limit}",
        )
        runs = [payload for payload in result.get("runs", []) if isinstance(payload, dict)]
        self._recovery_backlog_known = len(runs) >= request_limit
        for index, payload in enumerate(runs):
            try:
                await self.start_recovered(payload)
            except DurableRunError as exc:
                await self._release_recovered_lease(payload)
                if exc.code == "capacity":
                    # A tenant may be full while another tenant in the same
                    # batch is eligible. Continue through the batch instead
                    # of stranding the quiet tenant behind the noisy one.
                    self._recovery_backlog_known = True
                    continue
                self._recovery_backlog_known = True
                for remainder in runs[index + 1:]:
                    await self._release_recovered_lease(remainder)
                break
            except Exception:
                await self._release_recovered_lease(payload)
                self._recovery_backlog_known = True
                # Every remaining response already holds a lease. Return all
                # of them before leaving this bounded recovery cycle.
                for remainder in runs[index + 1:]:
                    await self._release_recovered_lease(remainder)
                break

    async def recover(self) -> None:
        if not self.configured:
            return
        current = asyncio.current_task()
        if current is None:
            return
        if self._recovery_task is not None and self._recovery_task is not current and not self._recovery_task.done():
            self._recovery_pending = True
            return
        if self._recovery_task is None:
            self._recovery_task = current
        try:
            async with self._recovery_lock:
                if not self._closed:
                    await self._recover_batch()
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("NewsCraft durable run recovery failed")
        finally:
            if self._recovery_task is current:
                self._recovery_task = None
                pending = self._recovery_pending
                self._recovery_pending = False
                if pending:
                    self._schedule_recovery()

    async def close(self) -> None:
        async with self._lock:
            if self._closed:
                return
            self._closed = True
            tasks: list[asyncio.Task[None]] = []
            jobs = list(self.jobs.values())
            recovery_task = self._recovery_task
            self._recovery_pending = False
            for job in jobs:
                if job.slot_reserved and job.task and not job.task.done():
                    job.stop_reason = "shutdown"
                    tasks.append(job.task)
                elif not job.slot_reserved:
                    self._remove_queued_locked(job)
                    if job.stop_reason is None:
                        job.stop_reason = "shutdown"
        for job in jobs:
            if job.task and job.task in tasks:
                try:
                    client = job.control_client
                    if client is None:
                        await self._flush_text(job)
                    else:
                        token = _CURRENT_NEWSCRAFT_CLIENT.set(client)
                        try:
                            await self._flush_text(job)
                        finally:
                            _CURRENT_NEWSCRAFT_CLIENT.reset(token)
                except asyncio.CancelledError:
                    logger.info("NewsCraft text flush was cancelled during shutdown")
                except Exception:
                    logger.exception("NewsCraft text flush failed during shutdown")
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        if recovery_task and recovery_task is not asyncio.current_task() and not recovery_task.done():
            recovery_task.cancel()
            await asyncio.gather(recovery_task, return_exceptions=True)

    async def _stop_text_flush(self, job: DurableJob) -> None:
        task = job.text_flush_task
        if task and task is not asyncio.current_task() and not task.done():
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
        if job.text_flush_task is task:
            job.text_flush_task = None

    def _discard_text_buffer(self, job: DurableJob) -> None:
        job.text_buffer.clear()
        job.text_buffer_chars = 0

    def _raise_text_flush_error(self, job: DurableJob) -> None:
        if job.text_flush_error is None:
            return
        error = job.text_flush_error
        job.text_flush_error = None
        raise error

    async def _send_callback_locked(self, job: DurableJob, event_type: str, data: dict[str, Any]) -> None:
        worker_cursor = job.worker_cursor + 1
        callback_body = {
            "run_id": job.run_id,
            "account_id": job.account_id,
            "tenant_key": job.tenant_key,
            "lease_owner": job.lease_owner,
            "lease_token": job.lease_token,
            "worker_cursor": worker_cursor,
            "event_type": event_type,
            "data": _bounded_data(data),
        }
        if job.trace_id:
            callback_body["trace_id"] = job.trace_id
        try:
            await self._newscraft("POST", NEWSCRAFT_RUN_CALLBACK_PATH, callback_body)
        except DurableRunError as exc:
            if exc.status_code == 409:
                if exc.code == "stale_callback":
                    # NewsCraft can record cancel_requested between two Hermes
                    # events. The attempted event is not accepted, but the
                    # same worker must still publish the terminal cancellation
                    # event with the next valid worker cursor.
                    job.stop_reason = "cancelled"
                    raise asyncio.CancelledError
                job.stale_lease = True
                job.stop_reason = "stale_lease"
            raise
        job.worker_cursor = worker_cursor

    async def _flush_text_locked(self, job: DurableJob) -> None:
        if not job.text_buffer:
            return
        delta = "".join(job.text_buffer)
        # Detach the bounded tail before the network await. If the service
        # stops after the request begins, the same suffix is never sent twice.
        self._discard_text_buffer(job)
        await self._send_callback_locked(job, TEXT_EVENT_TYPE, {"delta": delta})

    async def _flush_text(self, job: DurableJob) -> None:
        async with job.callback_lock:
            self._raise_text_flush_error(job)
            await self._flush_text_locked(job)

    async def _timed_text_flush(self, job: DurableJob) -> None:
        current = asyncio.current_task()
        try:
            await asyncio.sleep(TEXT_BATCH_FLUSH_INTERVAL_SECONDS)
            await self._flush_text(job)
        except asyncio.CancelledError:
            if (
                job.stop_reason == "cancelled"
                and job.task
                and job.task is not current
                and not job.task.done()
            ):
                job.task.cancel()
            raise
        except BaseException as exc:
            job.text_flush_error = exc
            if job.stop_reason is None:
                job.stop_reason = "callback_failed"
            if job.task and job.task is not current and not job.task.done():
                job.task.cancel()
        finally:
            if job.text_flush_task is current:
                job.text_flush_task = None

    async def _buffer_text(self, job: DurableJob, delta: str) -> None:
        async with job.callback_lock:
            self._raise_text_flush_error(job)
            offset = 0
            while offset < len(delta):
                available = TEXT_BATCH_MAX_CHARS - job.text_buffer_chars
                if available <= 0:
                    await self._flush_text_locked(job)
                    available = TEXT_BATCH_MAX_CHARS
                chunk = delta[offset:offset + available]
                job.text_buffer.append(chunk)
                job.text_buffer_chars += len(chunk)
                offset += len(chunk)
                if job.text_buffer_chars >= TEXT_BATCH_MAX_CHARS:
                    await self._flush_text_locked(job)
            if job.text_buffer and (job.text_flush_task is None or job.text_flush_task.done()):
                job.text_flush_task = asyncio.create_task(
                    self._timed_text_flush(job),
                    name=f"newscraft-hermes-text-flush-{job.run_id}",
                )

    async def _callback(self, job: DurableJob, event_type: str, data: dict[str, Any]) -> None:
        if event_type == TEXT_EVENT_TYPE and isinstance(data.get("delta"), str) and data["delta"]:
            await self._buffer_text(job, data["delta"])
            return
        async with job.callback_lock:
            self._raise_text_flush_error(job)
            await self._flush_text_locked(job)
            await self._send_callback_locked(job, event_type, data)

    async def _publish_cancelled(self, job: DurableJob) -> None:
        # NewsCraft rejects text callbacks after cancel_requested. Drop only
        # the unaccepted tail so it cannot block the terminal callback.
        async with job.cancel_publish_lock:
            if job.cancel_published:
                return
            await self._stop_text_flush(job)
            self._discard_text_buffer(job)
            job.text_flush_error = None
            await self._callback(job, "run.cancelled", {"failure_class": "cancelled", "status": "cancelled"})
            job.cancel_published = True

    async def _renew(self, job: DurableJob) -> None:
        while True:
            await asyncio.sleep(RUN_LEASE_RENEW_INTERVAL_SECONDS)
            try:
                body = {
                    "run_id": job.run_id,
                    "account_id": job.account_id,
                    "tenant_key": job.tenant_key,
                    "lease_owner": job.lease_owner,
                    "lease_token": job.lease_token,
                }
                if job.trace_id:
                    body["trace_id"] = job.trace_id
                await self._newscraft("POST", NEWSCRAFT_RUN_RENEW_PATH, body)
            except Exception:
                job.stale_lease = True
                job.stop_reason = "stale_lease"
                if job.task and not job.task.done():
                    job.task.cancel()
                return

    async def _run(self, job: DurableJob) -> None:
        renew_task = asyncio.create_task(self._renew(job), name=f"newscraft-hermes-renew-{job.run_id}")
        tool_arguments: dict[str, str] = {}
        tool_names: dict[str, str] = {}
        text_parts: list[str] = []
        finished = False
        try:
            await self._callback(job, "run.started", {"status": "researching"})
            if job.seeded_citations:
                await self._callback(job, "agent.citations", {"citations": job.seeded_citations})
            headers = {
                "authorization": f"Bearer {self.settings.session_token}",
                "x-hermes-session-token": self.settings.session_token,
                "x-newscraft-tenant-key": job.tenant_key,
                "content-type": "application/json",
                "accept": "text/event-stream",
            }
            if job.trace_id:
                headers.update({"x-request-id": job.trace_id, "x-trace-id": job.trace_id})
            async with httpx.AsyncClient(timeout=None) as client:
                async with client.stream("POST", self.settings.internal_agui_url, headers=headers, json=job.input) as response:
                    if response.status_code >= 400:
                        raise DurableRunError(
                            f"Hermes AG-UI request failed ({response.status_code})",
                            response.status_code,
                            "upstream",
                        )
                    async for event, payload in iter_sse(response.aiter_lines()):
                        if job.stop_reason:
                            raise asyncio.CancelledError
                        for normalized in normalized_events(event, payload, tool_arguments, tool_names, text_parts):
                            await self._callback(job, normalized["event_type"], normalized["data"])
                        if _event_type(payload, event) == "RUN_FINISHED":
                            finished = True
            if not finished:
                raise DurableRunError("Hermes ended before a completed response", code="protocol")
            if not text_parts:
                return
        except asyncio.CancelledError:
            if job.stop_reason == "cancelled":
                try:
                    await self._publish_cancelled(job)
                except BaseException:
                    logger.exception("NewsCraft cancellation callback failed")
            elif job.stop_reason == "callback_failed":
                error = job.text_flush_error
                job.text_flush_error = None
                self._discard_text_buffer(job)
                try:
                    await self._callback(job, "run.failed", {
                        "failure_class": "callback",
                        "error": {"message": str(error or "NewsCraft callback failed")[:2_000]}
                    })
                except Exception:
                    logger.exception("NewsCraft callback failure event failed")
            elif job.stop_reason == "stale_lease":
                try:
                    await self._flush_text(job)
                except Exception:
                    logger.exception("NewsCraft text flush failed after lease loss")
            elif job.stop_reason not in {"stale_lease", "shutdown"}:
                logger.exception("Durable Hermes task was cancelled")
        except Exception as exc:
            if not job.stale_lease:
                try:
                    await self._callback(job, "run.failed", {
                        "failure_class": _failure_class(exc),
                        "error": {"message": str(exc)[:2_000]},
                    })
                except Exception:
                    logger.exception("NewsCraft failure callback failed")
        finally:
            await self._stop_text_flush(job)
            self._discard_text_buffer(job)
            job.text_flush_error = None
            renew_task.cancel()
            await asyncio.gather(renew_task, return_exceptions=True)
