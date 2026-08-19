"""Controlled durable Hermes service used by the local browser acceptance gate.

This fixture uses the production DurableRunWorker lease, callback, cancellation,
and recovery path. It replaces only the Hermes AG-UI event source with a
deterministic delayed sequence. It does not call a model or another provider.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from hermes_chat.contracts import RUN_TOKEN_HEADER
from hermes_chat.durable import DurableJob, DurableRunError, DurableRunWorker
from hermes_chat.isolation import TenantIsolation

logger = logging.getLogger("newscraft.durable-fixture")


def _required(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"{name} is required")
    return value


@dataclass(frozen=True)
class FixtureSettings:
    run_api_url: str
    run_api_token: str
    session_token: str
    hermes_home: Path
    workspace: Path


def settings_from_env() -> FixtureSettings:
    return FixtureSettings(
        run_api_url=_required("FIXTURE_NEWSCRAFT_RUN_API_URL"),
        run_api_token=_required("FIXTURE_NEWSCRAFT_RUN_API_TOKEN"),
        session_token=_required("FIXTURE_SERVICE_TOKEN"),
        hermes_home=Path(_required("FIXTURE_HERMES_HOME")).resolve(),
        workspace=Path(_required("FIXTURE_HERMES_WORKSPACE")).resolve(),
    )


class FixtureWorker(DurableRunWorker):
    def __init__(self, settings: FixtureSettings, isolation: TenantIsolation, stats_path: Path):
        super().__init__(settings, isolation)
        self.stats_path = stats_path
        self.stats_lock = asyncio.Lock()
        self.delay_scale = max(1.0, float(os.environ.get("FIXTURE_DELAY_SCALE", "1")))

    async def _read_stats(self) -> dict[str, Any]:
        if not self.stats_path.exists():
            return {
                "start_requests": {},
                "logical_starts": {},
                "run_invocations": {},
                "recoveries": {},
                "events": [],
                "callbacks": [],
            }
        try:
            value = json.loads(self.stats_path.read_text())
        except (OSError, json.JSONDecodeError):
            value = {}
        if not isinstance(value, dict):
            value = {}
        value.setdefault("start_requests", {})
        value.setdefault("logical_starts", {})
        value.setdefault("run_invocations", {})
        value.setdefault("recoveries", {})
        value.setdefault("events", [])
        value.setdefault("callbacks", [])
        return value

    async def _write_stats(self, update: Mapping[str, Any] | None = None) -> None:
        async with self.stats_lock:
            stats = await self._read_stats()
            if update:
                for name, value in update.items():
                    stats[name] = value
            self.stats_path.parent.mkdir(parents=True, exist_ok=True)
            temporary = self.stats_path.with_suffix(".tmp")
            temporary.write_text(json.dumps(stats, sort_keys=True))
            temporary.replace(self.stats_path)

    async def _increment(self, field: str, run_id: str) -> None:
        async with self.stats_lock:
            stats = await self._read_stats()
            counters = stats.setdefault(field, {})
            counters[run_id] = int(counters.get(run_id, 0)) + 1
            self.stats_path.parent.mkdir(parents=True, exist_ok=True)
            temporary = self.stats_path.with_suffix(".tmp")
            temporary.write_text(json.dumps(stats, sort_keys=True))
            temporary.replace(self.stats_path)

    async def _record_event(self, run_id: str, event_type: str) -> None:
        async with self.stats_lock:
            stats = await self._read_stats()
            events = stats.setdefault("events", [])
            events.append({"run_id": run_id, "event_type": event_type})
            stats["events"] = events[-200:]
            self.stats_path.parent.mkdir(parents=True, exist_ok=True)
            temporary = self.stats_path.with_suffix(".tmp")
            temporary.write_text(json.dumps(stats, sort_keys=True))
            temporary.replace(self.stats_path)

    async def _record_callback(self, body: Mapping[str, Any]) -> None:
        async with self.stats_lock:
            stats = await self._read_stats()
            callbacks = stats.setdefault("callbacks", [])
            data = body.get("data") if isinstance(body.get("data"), dict) else {}
            delta = data.get("delta") if isinstance(data.get("delta"), str) else ""
            callbacks.append({
                "run_id": body.get("run_id"),
                "event_type": body.get("event_type"),
                "worker_cursor": body.get("worker_cursor"),
                "text_chars": len(delta),
            })
            stats["callbacks"] = callbacks[-500:]
            self.stats_path.parent.mkdir(parents=True, exist_ok=True)
            temporary = self.stats_path.with_suffix(".tmp")
            temporary.write_text(json.dumps(stats, sort_keys=True))
            temporary.replace(self.stats_path)

    async def _newscraft(self, method: str, path: str, body: dict[str, Any] | None = None) -> dict[str, Any]:
        result = await super()._newscraft(method, path, body)
        if method == "POST" and path.endswith("/callback") and isinstance(body, dict):
            await self._record_callback(body)
        return result

    async def start(self, payload: Mapping[str, Any]) -> dict[str, Any]:
        await self._increment("start_requests", str(payload.get("run_id") or "unknown"))
        result = await super().start(payload)
        if not result.get("duplicate"):
            await self._increment("logical_starts", str(result["run_id"]))
        return result

    async def start_recovered(self, payload: Mapping[str, Any]) -> dict[str, Any]:
        result = await super().start_recovered(payload)
        if not result.get("duplicate"):
            await self._increment("recoveries", str(result["run_id"]))
        return result

    async def _emit(self, job: DurableJob, event_type: str, data: dict[str, Any]) -> None:
        await self._record_event(job.run_id, event_type)
        await self._callback(job, event_type, data)

    async def _run(self, job: DurableJob) -> None:
        await self._increment("run_invocations", job.run_id)
        renew_task = asyncio.create_task(self._renew(job), name=f"fixture-renew-{job.run_id}")
        async def pause(seconds: float) -> None:
            await asyncio.sleep(seconds * self.delay_scale)
        try:
            await self._emit(job, "run.started", {"status": "researching"})
            await self._emit(job, "agent.tool.progress", {
                "id": "fixture-tool",
                "name": "Controlled research",
                "status": "running",
                "done": False,
            })
            await pause(1.0)
            await self._emit(
                job,
                "agent.source.read",
                {
                    "source": {
                        "id": "fixture-source-1",
                        "url": "https://fixture.invalid/source-1",
                        "title": "Controlled fixture source",
                        "domain": "fixture.invalid",
                        "citationNumber": 1,
                        "publicationDate": "2026-08-18",
                        "sourceType": "fixture",
                        "supportingExcerpt": "Deterministic source evidence.",
                    }
                },
            )
            await pause(1.5)
            await self._emit(job, "agent.citations", {"citations": [{
                "citationNumber": 1,
                "title": "Controlled fixture source",
                "url": "https://fixture.invalid/source-1",
                "domain": "fixture.invalid",
                "publicationDate": "2026-08-18",
                "sourceType": "fixture",
                "supportingExcerpt": "Deterministic source evidence.",
            }]})
            answer_fragments = [
                "The durable answer begins. ",
                "The same run continues after reconnect. ",
                *[
                    f"Checkpoint {index:02d} confirms persisted incremental text. "
                    for index in range(1, 61)
                ],
                "The final answer is persisted.",
            ]
            for fragment in answer_fragments:
                await self._emit(job, "response.output_text.delta", {"delta": fragment})
                await pause(0.08)
            await self._emit(job, "agent.tool.progress", {
                "id": "fixture-tool",
                "name": "Controlled research",
                "status": "ok",
                "done": True,
            })
            await self._emit(job, "response.completed", {"model": "hermes-fixture"})
        except asyncio.CancelledError:
            if job.stop_reason == "cancelled":
                try:
                    await self._emit(job, "run.cancelled", {"status": "cancelled"})
                except Exception:
                    pass
            raise
        except Exception as exc:
            if not job.stale_lease:
                try:
                    await self._emit(job, "run.failed", {"error": {"message": str(exc)[:500]}})
                except Exception:
                    pass
        finally:
            renew_task.cancel()
            await asyncio.gather(renew_task, return_exceptions=True)


def _authorized(request: Request, token: str) -> bool:
    authorization = request.headers.get("authorization", "")
    bearer = authorization[7:].strip() if authorization.lower().startswith("bearer ") else ""
    return bearer == token or request.headers.get("x-hermes-session-token", "") == token


def create_app() -> FastAPI:
    settings = settings_from_env()
    stats_path = Path(_required("FIXTURE_STATS_PATH")).resolve()
    isolation = TenantIsolation(settings.hermes_home, settings.workspace)
    worker = FixtureWorker(settings, isolation, stats_path)
    app = FastAPI()

    @app.post("/v1/runs/start")
    async def start(request: Request):
        if not _authorized(request, settings.session_token):
            return JSONResponse({"detail": "unauthorized"}, status_code=401)
        try:
            payload = await request.json()
            if payload.get("tenant_key") != request.headers.get("x-newscraft-tenant-key", ""):
                logger.warning("fixture start tenant mismatch run_id=%s", payload.get("run_id"))
                return JSONResponse({"detail": "tenant binding does not match"}, status_code=409)
            result = await worker.start(payload)
            return JSONResponse(result, status_code=202)
        except DurableRunError as exc:
            logger.warning("fixture start rejected run_id=%s status=%s", payload.get("run_id"), exc.status_code)
            return JSONResponse({"detail": str(exc)}, status_code=409)

    @app.post("/v1/runs/{run_id}/cancel")
    async def cancel(run_id: str, request: Request):
        if not _authorized(request, settings.session_token):
            return JSONResponse({"detail": "unauthorized"}, status_code=401)
        try:
            payload = await request.json()
        except Exception:
            payload = {}
        try:
            result = await worker.cancel(
                run_id,
                str(payload.get("account_id") or "").strip() or None,
                request.headers.get("x-newscraft-tenant-key", "").strip() or None,
            )
            return JSONResponse(result, status_code=202)
        except DurableRunError as exc:
            return JSONResponse({"detail": str(exc)}, status_code=409)

    @app.get("/fixture/stats")
    async def stats():
        return await worker._read_stats()

    @app.get("/ready")
    async def ready():
        # Match the NewsCraft gateway health contract so the local app can
        # exercise its normal readiness path without a model backend.
        tools = [
            "browser_navigate",
            "browser_snapshot",
            "web_search",
            "web_extract",
            "terminal",
            "process",
            "read_file",
            "write_file",
            "patch",
            "execute_code",
            "delegate_task",
            "skills_list",
            "skill_view",
            "skill_manage",
            "memory",
            "cronjob",
        ]
        return {
            "ok": True,
            "service": "newscraft-hermes-chat",
            "toolset": "hermes-acp",
            "tools": tools,
            "runtime": {
                "provider": "fixture",
                "model": "hermes-fixture",
                "endpointMode": "explicit",
            },
            "capabilities": {
                "standard": True,
                "browser": True,
                "webResearch": True,
                "terminal": True,
                "files": True,
                "codeExecution": True,
                "delegation": True,
                "skills": True,
                "memory": True,
                "documents": True,
                "webExtraction": {
                    "configured": True,
                    "backend": "newscraft-local",
                    "archiveProvider": "wayback",
                    "tool": True,
                    "leadVerificationTool": True,
                },
                "webLeadVerification": {
                    "configured": True,
                    "tool": True,
                    "bounded": True,
                },
                "accountIsolation": {
                    "tenantHeader": "x-newscraft-tenant-key",
                    "contextLocalHome": True,
                    "stableTaskKey": True,
                    "persistentDockerWorkspace": True,
                    "isolatedBrowserProfiles": True,
                },
            },
        }

    @app.on_event("startup")
    async def recover():
        asyncio.create_task(worker.recover(), name="fixture-recovery")

    @app.on_event("shutdown")
    async def shutdown():
        await worker.close()

    return app


app = create_app()


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=int(_required("FIXTURE_PORT")), log_level="info")
