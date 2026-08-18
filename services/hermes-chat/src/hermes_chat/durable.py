"""Durable NewsCraft run ownership for the long-lived Hermes service."""

from __future__ import annotations

import asyncio
import json
import logging
import secrets
import socket
from dataclasses import dataclass
from typing import Any, AsyncIterator, Mapping
from urllib.parse import quote

import httpx

from .contracts import (
    NEWSCRAFT_RUN_CALLBACK_PATH,
    NEWSCRAFT_RUN_CLAIM_PATH,
    NEWSCRAFT_RUN_RECOVER_PATH,
    NEWSCRAFT_RUN_RENEW_PATH,
    RUN_LEASE_RENEW_INTERVAL_SECONDS,
    RUN_TOKEN_HEADER,
)
from .isolation import TenantIsolation

logger = logging.getLogger(__name__)


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
        return [_event_payload("response.failed", {"error": {"message": str(message)}})]
    if kind == "RUN_FINISHED":
        events: list[dict[str, Any]] = []
        answer = "".join(text_parts)
        if answer:
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
        if kind == "TOOL_CALL_ARGS":
            delta = _value(payload, "delta", "arguments") or ""
            tool_arguments[call_id] = f"{tool_arguments.get(call_id, '')}{delta}"[-24_000:]
            return [_event_payload("agent.tool.progress", {"id": call_id, "name": name, "arguments": tool_arguments[call_id], "status": "running"})]
        if kind == "TOOL_CALL_RESULT":
            result = _value(payload, "result", "output", "content")
            return [_event_payload("agent.tool.progress", {"id": call_id, "name": name, "result": _compact(result), "status": "ok"})]
        return [_event_payload("agent.tool.progress", {"id": call_id, "name": name, "status": "ok" if kind == "TOOL_CALL_END" else "running", "done": kind == "TOOL_CALL_END"})]

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
    task: asyncio.Task[None] | None = None
    stop_reason: str | None = None
    stale_lease: bool = False


class DurableRunWorker:
    """Owns Hermes tasks after the start endpoint returns."""

    def __init__(self, settings: Any, isolation: TenantIsolation):
        self.settings = settings
        self.isolation = isolation
        self.instance_id = f"{socket.gethostname()}-{secrets.token_hex(6)}"
        self.jobs: dict[str, DurableJob] = {}
        self._lock = asyncio.Lock()

    @property
    def configured(self) -> bool:
        return bool(self.settings.run_api_url and self.settings.run_api_token)

    def _headers(self) -> dict[str, str]:
        return {RUN_TOKEN_HEADER: self.settings.run_api_token or "", "content-type": "application/json"}

    def _newscraft_url(self, path: str) -> str:
        if not self.settings.run_api_url:
            raise DurableRunError("NewsCraft durable run API is not configured")
        return f"{self.settings.run_api_url.rstrip('/')}{path}"

    async def _newscraft(self, method: str, path: str, body: dict[str, Any] | None = None) -> dict[str, Any]:
        async with httpx.AsyncClient(timeout=20) as client:
            response = await client.request(method, self._newscraft_url(path), headers=self._headers(), json=body)
        if response.status_code >= 400:
            code: str | None = None
            try:
                error_body = response.json()
                if isinstance(error_body, dict) and isinstance(error_body.get("code"), str):
                    code = error_body["code"]
            except ValueError:
                pass
            raise DurableRunError(
                f"NewsCraft durable run request failed ({response.status_code})",
                response.status_code,
                code,
            )
        value = response.json()
        return value if isinstance(value, dict) else {}

    async def start(self, payload: Mapping[str, Any]) -> dict[str, Any]:
        run_id = _string(payload.get("run_id"), "run_id")
        account_id = _string(payload.get("account_id"), "account_id")
        tenant_key = _string(payload.get("tenant_key"), "tenant_key")
        run_input = _json_object(payload.get("input"), "input")
        self.isolation.resolve(tenant_key)
        if str(run_input.get("runId") or run_input.get("run_id") or "").strip() not in {"", run_id}:
            raise DurableRunError("input run id does not match run id")
        async with self._lock:
            current = self.jobs.get(run_id)
            if current:
                if current.account_id != account_id:
                    raise DurableRunError("run account binding does not match")
                if current.tenant_key != tenant_key:
                    raise DurableRunError("run tenant binding does not match")
                return {"accepted": True, "duplicate": True, "run_id": run_id, "state": "running" if current.task and not current.task.done() else "finished"}
            owner = f"hermes:{self.instance_id}:{run_id}"
            try:
                claim = await self._newscraft("POST", NEWSCRAFT_RUN_CLAIM_PATH, {
                    "run_id": run_id,
                    "account_id": account_id,
                    "tenant_key": tenant_key,
                    "lease_owner": owner,
                })
            except DurableRunError as exc:
                # Another start request may have claimed this run between the
                # idempotent NewsCraft insert and this service call. The lease
                # owner is the durable execution lock, so report the same job
                # instead of turning a harmless duplicate into a browser error.
                if exc.status_code == 409:
                    return {"accepted": True, "duplicate": True, "run_id": run_id, "state": "running"}
                raise
            if claim.get("terminal"):
                return {"accepted": True, "duplicate": True, "run_id": run_id, "state": claim.get("state", "complete")}
            job = DurableJob(
                run_id=run_id,
                account_id=account_id,
                tenant_key=tenant_key,
                input=run_input,
                seeded_citations=[item for item in payload.get("seeded_citations", []) if isinstance(item, dict)][:100],
                lease_owner=_string(claim.get("lease_owner"), "lease_owner"),
                lease_token=_string(claim.get("lease_token"), "lease_token"),
                worker_cursor=int(claim.get("worker_cursor") or 0),
            )
            job.task = asyncio.create_task(self._run(job), name=f"newscraft-hermes-{run_id}")
            self.jobs[run_id] = job
            return {"accepted": True, "duplicate": False, "run_id": run_id, "state": "queued"}

    async def start_recovered(self, payload: Mapping[str, Any]) -> dict[str, Any]:
        run_id = _string(payload.get("run_id"), "run_id")
        account_id = _string(payload.get("account_id"), "account_id")
        tenant_key = _string(payload.get("tenant_key"), "tenant_key")
        self.isolation.resolve(tenant_key)
        run_input = _json_object(payload.get("input"), "input")
        if str(run_input.get("runId") or run_input.get("run_id") or "").strip() not in {"", run_id}:
            raise DurableRunError("saved input run id does not match run id")
        async with self._lock:
            current = self.jobs.get(run_id)
            if current and current.task and not current.task.done():
                if current.account_id != account_id:
                    raise DurableRunError("run account binding does not match")
                if current.tenant_key != tenant_key:
                    raise DurableRunError("run tenant binding does not match")
                return {"accepted": True, "duplicate": True, "run_id": run_id, "state": "running"}
            job = DurableJob(
                run_id=run_id,
                account_id=account_id,
                tenant_key=tenant_key,
                input=run_input,
                seeded_citations=[item for item in payload.get("seeded_citations", []) if isinstance(item, dict)][:100],
                lease_owner=_string(payload.get("lease_owner"), "lease_owner"),
                lease_token=_string(payload.get("lease_token"), "lease_token"),
                worker_cursor=int(payload.get("worker_cursor") or 0),
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
            job.task = asyncio.create_task(self._run(job), name=f"newscraft-hermes-recovered-{run_id}")
            self.jobs[run_id] = job
            return {"accepted": True, "duplicate": False, "run_id": run_id, "state": "recovered"}

    async def cancel(self, run_id: str, account_id: str | None = None, tenant_key: str | None = None) -> dict[str, Any]:
        async with self._lock:
            job = self.jobs.get(run_id)
        if not job or not job.task or job.task.done():
            return {"accepted": True, "run_id": run_id, "state": "not_running"}
        if account_id and job.account_id != account_id:
            raise DurableRunError("run account binding does not match")
        if tenant_key and job.tenant_key != tenant_key:
            raise DurableRunError("run tenant binding does not match")
        job.stop_reason = "cancelled"
        job.task.cancel()
        try:
            await job.task
        except asyncio.CancelledError:
            pass
        return {"accepted": True, "run_id": run_id, "state": "cancel_requested"}

    async def recover(self) -> None:
        if not self.configured:
            return
        try:
            owner = f"hermes-recovery:{self.instance_id}"
            result = await self._newscraft("GET", f"{NEWSCRAFT_RUN_RECOVER_PATH}?lease_owner={quote(owner)}&limit=100")
            for payload in result.get("runs", []):
                if isinstance(payload, dict):
                    await self.start_recovered(payload)
        except Exception:
            logger.exception("NewsCraft durable run recovery failed")

    async def close(self) -> None:
        tasks = []
        for job in self.jobs.values():
            if job.task and not job.task.done():
                job.stop_reason = "shutdown"
                tasks.append(job.task)
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)

    async def _callback(self, job: DurableJob, event_type: str, data: dict[str, Any]) -> None:
        job.worker_cursor += 1
        try:
            await self._newscraft("POST", NEWSCRAFT_RUN_CALLBACK_PATH, {
                "run_id": job.run_id,
                "account_id": job.account_id,
                "tenant_key": job.tenant_key,
                "lease_owner": job.lease_owner,
                "lease_token": job.lease_token,
                "worker_cursor": job.worker_cursor,
                "event_type": event_type,
                "data": _bounded_data(data),
            })
        except DurableRunError as exc:
            if exc.status_code == 409:
                if exc.code == "stale_callback":
                    # NewsCraft can record cancel_requested between two Hermes
                    # events. The attempted event is not accepted, but the
                    # same worker must still publish the terminal cancellation
                    # event with the next valid worker cursor.
                    job.worker_cursor = max(job.worker_cursor - 1, 0)
                    job.stop_reason = "cancelled"
                    raise asyncio.CancelledError
                job.stale_lease = True
                job.stop_reason = "stale_lease"
            raise

    async def _renew(self, job: DurableJob) -> None:
        while True:
            await asyncio.sleep(RUN_LEASE_RENEW_INTERVAL_SECONDS)
            try:
                await self._newscraft("POST", NEWSCRAFT_RUN_RENEW_PATH, {
                    "run_id": job.run_id,
                    "account_id": job.account_id,
                    "tenant_key": job.tenant_key,
                    "lease_owner": job.lease_owner,
                    "lease_token": job.lease_token,
                })
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
            async with httpx.AsyncClient(timeout=None) as client:
                async with client.stream("POST", self.settings.internal_agui_url, headers=headers, json=job.input) as response:
                    if response.status_code >= 400:
                        raise DurableRunError(f"Hermes AG-UI request failed ({response.status_code})")
                    async for event, payload in iter_sse(response.aiter_lines()):
                        if job.stop_reason:
                            raise asyncio.CancelledError
                        for normalized in normalized_events(event, payload, tool_arguments, tool_names, text_parts):
                            await self._callback(job, normalized["event_type"], normalized["data"])
                        if _event_type(payload, event) == "RUN_FINISHED":
                            finished = True
            if not finished or not text_parts:
                raise DurableRunError("Hermes ended before a completed response")
        except asyncio.CancelledError:
            if job.stop_reason == "cancelled":
                try:
                    await self._callback(job, "run.cancelled", {"status": "cancelled"})
                except Exception:
                    logger.exception("NewsCraft cancellation callback failed")
            elif job.stop_reason not in {"stale_lease", "shutdown"}:
                logger.exception("Durable Hermes task was cancelled")
        except Exception as exc:
            if not job.stale_lease:
                try:
                    await self._callback(job, "run.failed", {"error": {"message": str(exc)[:2_000]}})
                except Exception:
                    logger.exception("NewsCraft failure callback failed")
        finally:
            renew_task.cancel()
            await asyncio.gather(renew_task, return_exceptions=True)
