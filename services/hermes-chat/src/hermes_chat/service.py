from __future__ import annotations

import asyncio
import ipaddress
import importlib.util
import json
import logging
import math
import os
import secrets
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Awaitable, Callable
from urllib.parse import urlsplit
from uuid import uuid4

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from .durable import (
    DEFAULT_MAX_ACTIVE_RUNS,
    DEFAULT_MAX_ACTIVE_RUNS_PER_TENANT,
    DEFAULT_MAX_QUEUED_RUNS,
    DEFAULT_MAX_QUEUED_RUNS_PER_TENANT,
    DurableRunError,
    DurableRunWorker,
)
from .isolation import TENANT_HEADER, TenantIsolation, TenantIsolationError
from .provider_policy import DEEPSEEK_MODELS
from .retrieval import RetrievalConfig, retrieval_readiness

logger = logging.getLogger(__name__)
_PROCESS_INSTANCE_ID = uuid4().hex
RECOVERY_POLL_INTERVAL_SECONDS = 15


@dataclass(frozen=True)
class Settings:
    host: str
    port: int
    session_token: str = field(repr=False)
    public_host: str | None
    # Compatibility field names identify existing storage roots, never an upstream runtime.
    hermes_home: Path
    workspace: Path
    model_provider: str
    model: str
    model_base_url: str
    model_api_key: str = field(repr=False)
    model_api_mode: str | None
    max_iterations: int
    max_active_runs: int
    max_active_runs_per_tenant: int
    max_queued_runs: int
    max_queued_runs_per_tenant: int
    web_provider: str
    browser_provider: str
    retrieval: RetrievalConfig
    run_api_url: str | None
    run_api_token: str | None = field(repr=False)
    max_seconds: int = 180
    max_input_tokens: int = 120000
    max_output_tokens: int = 4096
    max_cost_usd: float = 2.0
    input_cost_per_million: float = 0.0
    output_cost_per_million: float = 0.0
    search_api_key: str = field(default="", repr=False)
    search_model: str = "gpt-6-astra"
    search_base_url: str = "https://api.openai.com/v1"
    max_search_calls: int = 5
    search_cost_ceiling_usd: float = 0.0
    image_token_ceiling: int = 32768
    executor: Any = None


def _setting(name: str, default: str = "", *aliases: str) -> str:
    for key in (name, *aliases):
        value = os.environ.get(key, "").strip()
        if value:
            return value
    return default


def _required(name: str, *aliases: str) -> str:
    value = _setting(name, "", *aliases)
    if not value:
        raise RuntimeError(f"{name} is required")
    return value


def _private_directory(name: str, *aliases: str) -> Path:
    candidate = Path(_required(name, *aliases)).expanduser()
    if not candidate.is_absolute():
        raise RuntimeError(f"{name} must be an absolute path")
    if candidate.is_symlink():
        raise RuntimeError(f"{name} must not be a symlink")
    resolved = candidate.resolve()
    if resolved in {Path("/"), Path.home().resolve()}:
        raise RuntimeError(f"{name} must be a dedicated subdirectory")
    return resolved


def _http_endpoint(value: str, name: str) -> str:
    parsed = urlsplit(value)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise RuntimeError(f"{name} must be an HTTP URL without credentials, query or fragment")
    try:
        parsed.port
    except ValueError:
        raise RuntimeError(f"{name} has an invalid port") from None
    try:
        is_loopback = ipaddress.ip_address(parsed.hostname).is_loopback
    except ValueError:
        is_loopback = parsed.hostname.lower() == "localhost"
    if parsed.scheme != "https" and not is_loopback:
        raise RuntimeError(f"A remote {name} endpoint must use HTTPS")
    return value.rstrip("/")


def _integer_setting(name: str, default: int, minimum: int, maximum: int, *aliases: str) -> int:
    try:
        value = int(_setting(name, str(default), *aliases))
    except ValueError as exc:
        raise RuntimeError(f"{name} must be an integer") from exc
    if not minimum <= value <= maximum:
        raise RuntimeError(f"{name} must be between {minimum} and {maximum}")
    return value


def _float_setting(name: str, default: float, minimum: float, maximum: float) -> float:
    try:
        value = float(_setting(name, str(default)))
    except ValueError as exc:
        raise RuntimeError(f"{name} must be a number") from exc
    if not math.isfinite(value) or not minimum <= value <= maximum:
        raise RuntimeError(f"{name} must be between {minimum} and {maximum}")
    return value


def _public_host_setting(value: str) -> str | None:
    value = value.strip().lower()
    if not value:
        return None
    if "://" in value or any(character in value for character in "/?#@"):
        raise RuntimeError("NEWSCRAFT_AGENT_PUBLIC_HOST must be one hostname")
    parsed = urlsplit(f"//{value}")
    try:
        port = parsed.port
    except ValueError as exc:
        raise RuntimeError("NEWSCRAFT_AGENT_PUBLIC_HOST must be one hostname") from exc
    if not parsed.hostname or port is not None or parsed.hostname != value or value in {"0.0.0.0", "::", "*"}:
        raise RuntimeError("NEWSCRAFT_AGENT_PUBLIC_HOST must be one exact hostname")
    return value


def _credential_from_file(path: str, key_name: str = "OPENAI_API_KEY") -> str:
    """Select one approved credential in memory; never source or copy its file."""
    if key_name not in {"OPENAI_API_KEY", "DEEPSEEK_API_KEY"}:
        raise RuntimeError("Unsupported credential-file key reference")
    candidate = Path(path).expanduser()
    if not candidate.is_absolute() or candidate.is_symlink() or not candidate.is_file():
        raise RuntimeError("NEWSCRAFT_AGENT_CREDENTIAL_FILE must reference a regular absolute file")
    if candidate.stat().st_size > 256 * 1024:
        raise RuntimeError("NEWSCRAFT_AGENT_CREDENTIAL_FILE exceeds the size limit")
    try:
        lines = candidate.read_text().splitlines()
    except (OSError, UnicodeError):
        raise RuntimeError("NEWSCRAFT_AGENT_CREDENTIAL_FILE is not readable") from None
    matches: list[tuple[str, str]] = []
    for line in lines:
        line = line.strip()
        if line.startswith("export "):
            line = line[7:].lstrip()
        name, separator, value = line.partition("=")
        if name.strip() == key_name:
            matches.append((separator, value.strip()))
    if len(matches) != 1:
        raise RuntimeError(f"NEWSCRAFT_AGENT_CREDENTIAL_FILE must contain exactly one usable {key_name}")
    separator, value = matches[0]
    if len(value) >= 2 and value[0] == value[-1] and value[0] in {chr(34), chr(39)}:
        value = value[1:-1]
    if not separator or not value or any(character.isspace() or character in {chr(34), chr(39)} for character in value):
        raise RuntimeError(f"NEWSCRAFT_AGENT_CREDENTIAL_FILE must contain exactly one usable {key_name}")
    return value


def settings_from_env() -> Settings:
    port = _integer_setting("NEWSCRAFT_AGENT_PORT", 8000, 1, 65535, "HERMES_AGUI_PORT")
    session_token = _required("NEWSCRAFT_AGENT_SESSION_TOKEN", "HERMES_AGUI_SESSION_TOKEN")
    if len(session_token) < 24:
        raise RuntimeError("NEWSCRAFT_AGENT_SESSION_TOKEN must contain at least 24 characters")
    home = _private_directory("NEWSCRAFT_AGENT_STATE_HOME", "NEWSCRAFT_HERMES_HOME")
    workspace = _private_directory("NEWSCRAFT_AGENT_WORKSPACE", "NEWSCRAFT_HERMES_WORKSPACE")
    if home == workspace or home.is_relative_to(workspace) or workspace.is_relative_to(home):
        raise RuntimeError("Agent state and workspace must be separate directories")
    run_api_value = _setting("NEWSCRAFT_AGENT_RUN_API_URL", "", "NEWSCRAFT_HERMES_RUN_API_URL")
    run_api_url = _http_endpoint(run_api_value, "NEWSCRAFT_AGENT_RUN_API_URL") if run_api_value else None
    run_api_token = _setting("NEWSCRAFT_AGENT_RUN_API_TOKEN", "", "NEWSCRAFT_HERMES_RUN_API_TOKEN") or None
    if bool(run_api_url) != bool(run_api_token):
        raise RuntimeError("NEWSCRAFT_AGENT_RUN_API_URL and NEWSCRAFT_AGENT_RUN_API_TOKEN must be set together")
    provider = _setting("NEWSCRAFT_AGENT_MODEL_PROVIDER", "openai")
    if provider not in {"openai", "anthropic", "deepseek"}:
        raise RuntimeError("NEWSCRAFT_AGENT_MODEL_PROVIDER must be openai, anthropic or deepseek")
    key_name, base_url_name, default_base_url, default_model = {
        "openai": ("OPENAI_API_KEY", "OPENAI_BASE_URL", "https://api.openai.com/v1", "gpt-6-astra"),
        "anthropic": ("ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "https://api.anthropic.com/v1", ""),
        "deepseek": ("DEEPSEEK_API_KEY", "DEEPSEEK_BASE_URL", "https://api.deepseek.com/anthropic", "deepseek-flash"),
    }[provider]
    model = _setting("NEWSCRAFT_AGENT_MODEL", default_model)
    if not model:
        raise RuntimeError("NEWSCRAFT_AGENT_MODEL is required for the selected provider")
    # DeepSeek's compatible endpoint silently maps unknown model names. Reject
    # aliases here so the dispatched model matches its explicit price ceiling.
    if provider == "deepseek" and model not in DEEPSEEK_MODELS:
        raise RuntimeError("DeepSeek NEWSCRAFT_AGENT_MODEL must be deepseek-flash or deepseek-v4-pro")
    credential_file = _setting("NEWSCRAFT_AGENT_CREDENTIAL_FILE")
    model_key = _setting(key_name)
    if not model_key and provider in {"openai", "deepseek"} and credential_file:
        model_key = _credential_from_file(credential_file, key_name)
    if not model_key:
        raise RuntimeError(key_name + " is required for the configured model adapter")
    web_provider = _setting("NEWSCRAFT_AGENT_WEB_PROVIDER", "public")
    if web_provider not in {"public", "openai"}:
        raise RuntimeError("NEWSCRAFT_AGENT_WEB_PROVIDER must be public or openai")
    search_key = (model_key if provider == "openai" else _setting("OPENAI_API_KEY")) if web_provider == "openai" else ""
    if web_provider == "openai" and not search_key and credential_file:
        search_key = _credential_from_file(credential_file)
    if web_provider == "openai" and not search_key:
        raise RuntimeError("The optional OpenAI search adapter requires an approved OpenAI credential")
    browser_image = _setting("NEWSCRAFT_BROWSER_IMAGE")
    browser_profile = _setting("NEWSCRAFT_BROWSER_SECCOMP_PROFILE")
    browser_digest = _setting("NEWSCRAFT_BROWSER_SECCOMP_SHA256")
    browser_provider = "rootless-oci" if browser_image else "disabled"
    legacy_browser = _setting("NEWSCRAFT_AGENT_BROWSER_PROVIDER", "disabled")
    if legacy_browser not in {"disabled", browser_provider}:
        raise RuntimeError("Interactive browsing requires the rootless OCI browser image and reviewed seccomp profile")
    executor = None
    executor_image = _setting("NEWSCRAFT_EXECUTOR_IMAGE")
    if executor_image:
        from .oci_executor import OCIConfig
        executor = OCIConfig(image=executor_image,
            socket=Path(_required("NEWSCRAFT_EXECUTOR_SOCKET")), state_root=home / "computer",
            binary=_setting("NEWSCRAFT_EXECUTOR_DOCKER_BIN", "/usr/bin/docker"),
            browser_image=browser_image or None,
            browser_seccomp=Path(browser_profile) if browser_profile else None,
            browser_seccomp_sha256=browser_digest or None)
    elif _setting("NEWSCRAFT_EXECUTOR_SOCKET") or browser_image or browser_profile or browser_digest:
        raise RuntimeError("NEWSCRAFT_EXECUTOR_IMAGE and its socket are required for the isolated computer")
    active = _integer_setting("NEWSCRAFT_AGENT_MAX_ACTIVE_RUNS", DEFAULT_MAX_ACTIVE_RUNS, 1, 128, "NEWSCRAFT_HERMES_MAX_ACTIVE_RUNS")
    tenant_active = _integer_setting("NEWSCRAFT_AGENT_MAX_ACTIVE_RUNS_PER_TENANT", DEFAULT_MAX_ACTIVE_RUNS_PER_TENANT, 1, 128, "NEWSCRAFT_HERMES_MAX_ACTIVE_RUNS_PER_TENANT")
    queued = _integer_setting("NEWSCRAFT_AGENT_MAX_QUEUED_RUNS", DEFAULT_MAX_QUEUED_RUNS, 1, 1024, "NEWSCRAFT_HERMES_MAX_QUEUED_RUNS")
    tenant_queued = _integer_setting("NEWSCRAFT_AGENT_MAX_QUEUED_RUNS_PER_TENANT", DEFAULT_MAX_QUEUED_RUNS_PER_TENANT, 1, 1024, "NEWSCRAFT_HERMES_MAX_QUEUED_RUNS_PER_TENANT")
    if tenant_active > active or tenant_queued > queued:
        raise RuntimeError("Per-tenant run limits cannot exceed global limits")
    return Settings(
        host=_setting("NEWSCRAFT_AGENT_HOST", "127.0.0.1", "HERMES_AGUI_HOST"),
        port=port,
        session_token=session_token,
        public_host=_public_host_setting(_setting("NEWSCRAFT_AGENT_PUBLIC_HOST", "", "NEWSCRAFT_HERMES_PUBLIC_HOST")),
        hermes_home=home,
        workspace=workspace,
        model_provider=provider,
        model=model,
        model_base_url=_http_endpoint(_setting(base_url_name, default_base_url), "MODEL_BASE_URL"),
        model_api_key=model_key,
        model_api_mode="responses" if provider == "openai" else "messages",
        max_iterations=_integer_setting("NEWSCRAFT_AGENT_MAX_STEPS", 12, 1, 90, "NEWSCRAFT_HERMES_MAX_ITERATIONS"),
        max_active_runs=active,
        max_active_runs_per_tenant=tenant_active,
        max_queued_runs=queued,
        max_queued_runs_per_tenant=tenant_queued,
        web_provider=web_provider,
        browser_provider=browser_provider,
        retrieval=RetrievalConfig.from_env(),
        run_api_url=run_api_url,
        run_api_token=run_api_token,
        max_seconds=_integer_setting("NEWSCRAFT_AGENT_MAX_SECONDS", 180, 10, 1800),
        max_input_tokens=_integer_setting("NEWSCRAFT_AGENT_MAX_INPUT_TOKENS", 120000, 1000, 10000000),
        max_output_tokens=_integer_setting("NEWSCRAFT_AGENT_MAX_OUTPUT_TOKENS", 4096, 256, 32000),
        max_cost_usd=_float_setting("NEWSCRAFT_AGENT_MAX_COST_USD", 2.0, 0.001, 100),
        input_cost_per_million=_float_setting("NEWSCRAFT_AGENT_INPUT_PRICE_CEILING", 0, 0, 100000),
        output_cost_per_million=_float_setting("NEWSCRAFT_AGENT_OUTPUT_PRICE_CEILING", 0, 0, 100000),
        search_cost_ceiling_usd=_float_setting("NEWSCRAFT_AGENT_SEARCH_CALL_PRICE_CEILING", 0, 0, 100),
        image_token_ceiling=_integer_setting("NEWSCRAFT_AGENT_IMAGE_TOKEN_CEILING", 32768, 32768, 1000000),
        search_api_key=search_key,
        search_model=_setting("NEWSCRAFT_SEARCH_MODEL", "gpt-6-astra"),
        search_base_url=_http_endpoint(_setting("NEWSCRAFT_SEARCH_BASE_URL", "https://api.openai.com/v1"), "NEWSCRAFT_SEARCH_BASE_URL"),
        max_search_calls=_integer_setting("NEWSCRAFT_AGENT_MAX_SEARCH_CALLS", 5, 1, 20),
        executor=executor,
    )


def prepare_runtime(settings: Settings) -> None:
    for path in (settings.hermes_home, settings.workspace):
        if path.is_symlink():
            raise RuntimeError("Agent state roots must not be symlinks")
        path.mkdir(mode=0o700, parents=True, exist_ok=True)
        path.chmod(0o700)


def _host_accepted(value: str, allowed: set[str]) -> bool:
    if not value or any(character in value for character in "/?#@"):
        return False
    try:
        parsed = urlsplit(f"//{value}")
        parsed.port
        return bool(parsed.hostname and parsed.hostname.lower() in allowed)
    except ValueError:
        return False


def _tenant_binding(request: Request, isolation: TenantIsolation) -> str:
    values = request.headers.getlist(TENANT_HEADER)
    if len(values) != 1:
        raise TenantIsolationError("Request must contain exactly one NewsCraft tenant key")
    return isolation.tenant_from_headers({TENANT_HEADER: values[0]})


def _authorized(request: Request, settings: Settings) -> bool:
    values = request.headers.getlist("authorization")
    if len(values) != 1:
        return False
    authorization = values[0]
    bearer = authorization[7:].strip() if authorization.lower().startswith("bearer ") else ""
    return bool(bearer and secrets.compare_digest(bearer, settings.session_token))


async def _durable_recovery_loop(
    worker: DurableRunWorker,
    *,
    sleep: Callable[[float], Awaitable[Any]] = asyncio.sleep,
) -> None:
    """Find leases that expire after startup without resetting a run's saved bounds."""
    while True:
        try:
            await worker.recover()
        except asyncio.CancelledError:
            raise
        except Exception:
            # Transport errors can contain credential-bearing request details.
            # Keep the periodic scheduler's log fixed and retry on its bounded cadence.
            logger.warning("Durable recovery check failed; retrying on the next interval")
        await sleep(RECOVERY_POLL_INTERVAL_SECONDS)


def create_app(settings: Settings | None = None):
    from .portable import PortableAgentRunner

    # HTTPX INFO includes complete signed upload URLs; httpcore DEBUG includes
    # transport details. Keep credential-bearing request metadata out of logs.
    for transport_logger in ("httpx", "httpcore"):
        logging.getLogger(transport_logger).setLevel(logging.WARNING)
    settings = settings or settings_from_env()
    prepare_runtime(settings)
    isolation = TenantIsolation(settings.hermes_home, settings.workspace)
    runner = PortableAgentRunner(settings, isolation)
    durable_worker = DurableRunWorker(settings, isolation, runner=runner)
    runner.publisher = durable_worker.publish_artifact_from_tool
    runner.checkpoint = durable_worker.runtime_checkpoint
    app = FastAPI(title="NewsCraft cloud research agent")
    app.state.runner = runner
    app.state.durable_worker = durable_worker
    app.state.isolation = isolation
    allowed_hosts = {settings.host.lower()}
    if settings.host in {"0.0.0.0", "::"}:
        allowed_hosts = {"127.0.0.1", "localhost", "::1"}
    if settings.public_host:
        allowed_hosts.add(settings.public_host)

    @app.middleware("http")
    async def host_guard(request: Request, call_next):
        if len(request.headers.getlist("host")) != 1 or not _host_accepted(request.headers.get("host", ""), allowed_hosts):
            return JSONResponse({"detail": "invalid host"}, status_code=400)
        return await call_next(request)

    @app.post("/v1/runs/start")
    async def durable_start(request: Request):
        if not _authorized(request, settings):
            return JSONResponse({"detail": "unauthorized"}, status_code=401)
        try:
            tenant_key = _tenant_binding(request, isolation)
            payload = await request.json()
            if not isinstance(payload, dict):
                return JSONResponse({"detail": "JSON object required"}, status_code=400)
            if payload.get("tenant_key") != tenant_key:
                return JSONResponse({"detail": "tenant binding does not match"}, status_code=409)
            return JSONResponse(await durable_worker.start(payload), status_code=202)
        except TenantIsolationError as exc:
            return JSONResponse({"detail": str(exc)}, status_code=409)
        except (json.JSONDecodeError, UnicodeError):
            return JSONResponse({"detail": "valid JSON required"}, status_code=400)
        except DurableRunError as exc:
            response: dict[str, Any] = {"detail": str(exc)}
            if exc.code:
                response["code"] = exc.code
            if exc.code == "overloaded":
                response["state"] = "rejected"
            return JSONResponse(response, status_code=exc.status_code or 409)
        except Exception:
            logger.error("Durable agent start failed")
            return JSONResponse({"detail": "durable agent start failed"}, status_code=503)

    @app.post("/v1/runs/{run_id}/cancel")
    async def durable_cancel(run_id: str, request: Request):
        if not _authorized(request, settings):
            return JSONResponse({"detail": "unauthorized"}, status_code=401)
        try:
            tenant_key = _tenant_binding(request, isolation)
            payload = await request.json()
            if not isinstance(payload, dict):
                return JSONResponse({"detail": "JSON object required"}, status_code=400)
            account_id = str(payload.get("account_id") or "").strip()
            if not account_id or payload.get("run_id") != run_id or payload.get("tenant_key") != tenant_key:
                return JSONResponse({"detail": "run, account and tenant bindings are required"}, status_code=409)
            return JSONResponse(await durable_worker.cancel(run_id, account_id, tenant_key), status_code=202)
        except TenantIsolationError as exc:
            return JSONResponse({"detail": str(exc)}, status_code=409)
        except (json.JSONDecodeError, UnicodeError):
            return JSONResponse({"detail": "valid JSON required"}, status_code=400)
        except DurableRunError as exc:
            return JSONResponse({"detail": str(exc)}, status_code=exc.status_code or 409)

    @app.post("/")
    async def direct_stream_removed(request: Request):
        if not _authorized(request, settings):
            return JSONResponse({"detail": "unauthorized"}, status_code=401)
        return JSONResponse({"detail": "Use /v1/runs/start for durable research execution"}, status_code=410)

    @app.on_event("startup")
    async def recover_durable_runs() -> None:
        app.state.recovery_task = asyncio.create_task(_durable_recovery_loop(durable_worker), name="newscraft-agent-recovery")

    @app.on_event("shutdown")
    async def stop_durable_runs() -> None:
        recovery = getattr(app.state, "recovery_task", None)
        if recovery is not None and not recovery.done():
            recovery.cancel()
            await asyncio.gather(recovery, return_exceptions=True)
        await durable_worker.close()

    @app.get("/ready")
    async def ready(request: Request):
        runtime_ready = await runner.readiness()
        ready_ok = bool(durable_worker.configured and runtime_ready.get("configured"))
        payload: dict[str, Any] = {"ok": ready_ok, "state": "ready" if ready_ok else "unavailable", "service": "newscraft-agent"}
        if _authorized(request, settings):
            payload.update({
                "processInstanceId": _PROCESS_INSTANCE_ID, "toolset": "newscraft-agent", "tools": runtime_ready.get("tools", []),
                "runtime": {"provider": settings.model_provider, "model": settings.model, "endpointMode": "explicit",
                            "apiMode": settings.model_api_mode, "orchestration": "newscraft", "accessVerified": False,
                            "maxObservedActions": settings.max_iterations, "maxSeconds": settings.max_seconds},
                "toolProviders": {"webSearch": {"requested": settings.web_provider, "active": settings.web_provider, "configured": True, "verified": False},
                                  "webExtract": {"configured": settings.retrieval.enabled}, "leadVerification": {"configured": settings.retrieval.enabled},
                                  "browser": {"configured": bool(runtime_ready.get("browser")), "verified": False}},
                "capabilities": {"standard": True, "terminal": bool(runtime_ready.get("terminal")), "files": True, "browser": bool(runtime_ready.get("browser")),
                    "workspaceFiles": bool(runtime_ready.get("workspaceFiles")),
                    "webResearch": settings.retrieval.enabled,
                    "webExtraction": {"configured": settings.retrieval.enabled, "tool": settings.retrieval.enabled, "leadVerificationTool": settings.retrieval.enabled},
                    "webLeadVerification": {"configured": settings.retrieval.enabled, "tool": settings.retrieval.enabled, "bounded": True},
                    "boundedLoop": {"configured": True, "cancellation": True, "stepBudget": True,
                                    "timeBudget": True, "costBudget": True, "providerHardLimit": False},
                    "durableRuns": {"configured": durable_worker.configured, "callback": durable_worker.configured,
                                    "concurrency": durable_worker.capacity_snapshot()},
                    "accountIsolation": {"tenantHeader": TENANT_HEADER, "stableTaskKey": True,
                        "ownedRunState": True, "conversationWorkspace": True, "sandbox": runtime_ready.get("sandbox", "unconfigured")}},
                "computer": {"configured": bool(runtime_ready.get("terminal")),
                    "reason": runtime_ready.get("sandboxReason"), "accessVerified": False}})
        return JSONResponse(payload, status_code=200 if ready_ok else 503)

    return app


def main() -> None:
    import uvicorn

    settings = settings_from_env()
    logging.basicConfig(level=logging.INFO)
    logger.info("Starting NewsCraft cloud research agent on %s:%d", settings.host, settings.port)
    uvicorn.run(create_app(settings), host=settings.host, port=settings.port, workers=1, loop="asyncio", log_level="warning")


def _artifact_source_schema() -> dict[str, Any]:
    return {
        "type": "object",
        "properties": {
            "id": {"type": "string", "minLength": 1, "maxLength": 160},
            "label": {"type": "string", "minLength": 1, "maxLength": 200},
            "url": {"type": "string", "maxLength": 2000},
            "period": {"type": "string", "maxLength": 120},
            "publicationDate": {"anyOf": [{"type": "string", "maxLength": 80}, {"type": "null"}]},
            "updatedAt": {"anyOf": [{"type": "string", "maxLength": 80}, {"type": "null"}]},
        },
        "required": ["id", "label"],
        "additionalProperties": False,
    }


def _artifact_spec_schema() -> dict[str, Any]:
    source = _artifact_source_schema()
    point = {
        "type": "object",
        "properties": {
            "period": {"type": "string", "minLength": 1, "maxLength": 120},
            "value": {"anyOf": [{"type": "number"}, {"type": "null"}]},
            "status": {"enum": ["observed", "missing", "estimated"]},
            "sourceId": {"type": "string", "maxLength": 160},
        },
        "required": ["period", "value"],
        "additionalProperties": False,
    }
    series = {
        "type": "object",
        "properties": {
            "id": {"type": "string", "minLength": 1, "maxLength": 80},
            "label": {"type": "string", "minLength": 1, "maxLength": 120},
            "unit": {"type": "string", "maxLength": 80},
            "color": {
                "type": "string",
                "pattern": "^(?:#[0-9a-fA-F]{3,8}|[A-Za-z]{1,32})$",
            },
            "points": {"type": "array", "maxItems": 5000, "items": point},
        },
        "required": ["id", "label", "points"],
        "additionalProperties": False,
    }
    chart = {
        "type": "object",
        "title": "Chart artifact",
        "description": "Use chartType plus one or more series of period/value points. This is not Vega-Lite.",
        "properties": {
            "kind": {"enum": ["chart"]},
            "title": {"type": "string", "minLength": 1, "maxLength": 200},
            "subtitle": {"type": "string", "maxLength": 240},
            "chartType": {"enum": ["line", "bar", "area", "scatter"]},
            "unit": {"type": "string", "maxLength": 80},
            "series": {"type": "array", "minItems": 1, "maxItems": 12, "items": series},
            "sources": {"type": "array", "maxItems": 64, "items": source},
        },
        "required": ["kind", "title", "chartType", "series"],
        "additionalProperties": False,
    }
    table = {
        "type": "object",
        "title": "Table artifact",
        "description": "Columns define the allowed row keys; each cell is text, number, or null.",
        "properties": {
            "kind": {"enum": ["table"]},
            "title": {"type": "string", "minLength": 1, "maxLength": 200},
            "columns": {
                "type": "array",
                "minItems": 1,
                "maxItems": 32,
                "items": {
                    "type": "object",
                    "properties": {
                        "id": {"type": "string", "minLength": 1, "maxLength": 80},
                        "label": {"type": "string", "minLength": 1, "maxLength": 120},
                        "type": {"enum": ["text", "number", "date"]},
                    },
                    "required": ["id", "label"],
                    "additionalProperties": False,
                },
            },
            "rows": {
                "type": "array",
                "maxItems": 5000,
                "items": {
                    "type": "object",
                    "description": "Use the column ids as row keys.",
                    "additionalProperties": {
                        "anyOf": [{"type": "string", "maxLength": 2000}, {"type": "number"}, {"type": "null"}]
                    },
                },
            },
            "sources": {"type": "array", "maxItems": 64, "items": source},
        },
        "required": ["kind", "title", "columns", "rows"],
        "additionalProperties": False,
    }
    image = {
        "type": "object",
        "title": "Image artifact",
        "description": "The image bytes are supplied through the outer path, mime_type, size, and checksum_sha256 arguments.",
        "properties": {
            "kind": {"enum": ["image"]},
            "title": {"type": "string", "minLength": 1, "maxLength": 200},
            "alt": {"type": "string", "minLength": 1, "maxLength": 400},
            "caption": {"type": "string", "maxLength": 400},
            "sources": {"type": "array", "maxItems": 64, "items": source},
        },
        "required": ["kind", "title", "alt"],
        "additionalProperties": False,
    }
    markdown = {
        "type": "object",
        "title": "Markdown artifact",
        "description": "Use safe Markdown text; scripts, embeds, and javascript URLs are rejected.",
        "properties": {
            "kind": {"enum": ["markdown"]},
            "title": {"type": "string", "minLength": 1, "maxLength": 200},
            "markdown": {"type": "string", "minLength": 1, "maxLength": 32000},
            "sources": {"type": "array", "maxItems": 64, "items": source},
        },
        "required": ["kind", "title", "markdown"],
        "additionalProperties": False,
    }
    coordinate = {
        "type": "array",
        "description": "[longitude, latitude], with longitude -180..180 and latitude -90..90.",
        "minItems": 2,
        "maxItems": 2,
        "items": {"type": "number"},
    }
    geometry = {
        "oneOf": [
            {"type": "object", "properties": {"type": {"enum": ["Point"]}, "coordinates": coordinate}, "required": ["type", "coordinates"], "additionalProperties": False},
            {"type": "object", "properties": {"type": {"enum": ["LineString"]}, "coordinates": {"type": "array", "minItems": 2, "maxItems": 1000, "items": coordinate}}, "required": ["type", "coordinates"], "additionalProperties": False},
            {"type": "object", "properties": {"type": {"enum": ["Polygon"]}, "coordinates": {"type": "array", "maxItems": 100, "items": {"type": "array", "maxItems": 1000, "items": coordinate}}}, "required": ["type", "coordinates"], "additionalProperties": False},
        ]
    }
    map_spec = {
        "type": "object",
        "title": "Map artifact",
        "description": "Use GeoJSON-like Point, LineString, or Polygon features with bounded coordinates.",
        "properties": {
            "kind": {"enum": ["map"]},
            "title": {"type": "string", "minLength": 1, "maxLength": 200},
            "subtitle": {"type": "string", "maxLength": 240},
            "features": {
                "type": "array",
                "maxItems": 2000,
                "items": {
                    "type": "object",
                    "properties": {
                        "type": {"enum": ["Feature"]},
                        "properties": {
                            "type": "object",
                            "properties": {
                                "id": {"type": "string", "maxLength": 120},
                                "label": {"type": "string", "maxLength": 200},
                                "layer": {"type": "string", "maxLength": 80},
                            },
                            "additionalProperties": False,
                        },
                        "geometry": geometry,
                    },
                    "required": ["type", "geometry"],
                    "additionalProperties": False,
                },
            },
            "layers": {
                "type": "array",
                "maxItems": 32,
                "items": {
                    "type": "object",
                    "properties": {
                        "id": {"type": "string", "minLength": 1, "maxLength": 80},
                        "label": {"type": "string", "minLength": 1, "maxLength": 120},
                        "visible": {"type": "boolean"},
                    },
                    "required": ["id", "label"],
                    "additionalProperties": False,
                },
            },
            "sources": {"type": "array", "maxItems": 64, "items": source},
        },
        "required": ["kind", "title", "features"],
        "additionalProperties": False,
    }
    return {
        "type": "object",
        "description": (
            "Use exactly one supported NewsCraft artifact form. Do not send Vega-Lite or another arbitrary chart schema. "
            "Charts use chartType and series[].points[]; images use the outer workspace file arguments."
        ),
        "oneOf": [chart, table, image, markdown, map_spec],
        "examples": [
            {"kind": "chart", "title": "Alpha and Beta", "chartType": "bar", "series": [{"id": "alpha", "label": "Alpha", "points": [{"period": "2026", "value": 3}]}, {"id": "beta", "label": "Beta", "points": [{"period": "2026", "value": 5}]}]},
            {"kind": "table", "title": "Scores", "columns": [{"id": "name", "label": "Name", "type": "text"}, {"id": "score", "label": "Score", "type": "number"}], "rows": [{"name": "Alpha", "score": 3}]},
            {"kind": "image", "title": "Generated chart", "alt": "A bar chart of Alpha and Beta"},
            {"kind": "markdown", "title": "Key finding", "markdown": "## Finding\n\nAlpha scored **3**."},
            {"kind": "map", "title": "Locations", "features": [{"type": "Feature", "properties": {"label": "Toronto"}, "geometry": {"type": "Point", "coordinates": [-79.38, 43.65]}}]},
        ],
    }




if __name__ == "__main__":
    main()
