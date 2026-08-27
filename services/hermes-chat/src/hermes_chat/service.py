from __future__ import annotations

import asyncio
import base64
import hashlib
import importlib
import ipaddress
import logging
import os
import secrets
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping
from urllib.parse import urlsplit
from uuid import uuid4

from fastapi import Request

from . import HERMES_COMMIT
from .contracts import CRON_TOOLSET, HERMES_TOOLSET
from .durable import DurableRunError, DurableRunWorker
from .isolation import (
    TENANT_HEADER,
    TenantIsolation,
    TenantIsolationError,
    current_tenant_run,
    guard_tool_arguments,
    tenant_run_scope,
)
from .product_prompt import (
    NEWSCRAFT_RUNTIME_IDENTITY_POINTER,
    append_product_identity,
    tenant_preferences_only,
)
from .retrieval import PROVIDER_NAME, VERIFY_LEAD_TOOL_NAME, RetrievalConfig, retrieval_readiness

logger = logging.getLogger(__name__)

_MODEL_REF = "${env:NEWSCRAFT_HERMES_MODEL}"
_MODEL_BASE_URL_REF = "${env:NEWSCRAFT_HERMES_MODEL_BASE_URL}"
_MODEL_API_KEY_REF = "${env:NEWSCRAFT_HERMES_MODEL_API_KEY}"
_LOCAL_WEB_PROVIDER = "newscraft-local"
_EXA_WEB_PROVIDER = "exa"
_LOCAL_BROWSER_PROVIDER = "local"
_BROWSER_USE_PROVIDER = "browser-use"
_PROCESS_INSTANCE_ID = uuid4().hex


@dataclass(frozen=True)
class Settings:
    host: str
    port: int
    session_token: str
    public_host: str | None
    hermes_home: Path
    workspace: Path
    model_provider: str
    model: str
    model_base_url: str
    model_api_key: str
    model_api_mode: str | None
    max_iterations: int
    web_provider: str
    browser_provider: str
    retrieval: RetrievalConfig
    run_api_url: str | None
    run_api_token: str | None
    internal_agui_url: str


def _required(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"{name} is required")
    return value


def _provider_setting(name: str, default: str, allowed: set[str]) -> str:
    value = os.environ.get(name, default).strip().lower() or default
    if value not in allowed:
        choices = ", ".join(sorted(allowed))
        raise RuntimeError(f"{name} must be one of: {choices}")
    return value


def _private_directory(name: str) -> Path:
    raw = _required(name)
    candidate = Path(raw).expanduser()
    if not candidate.is_absolute():
        raise RuntimeError(f"{name} must be an absolute path")
    if candidate.is_symlink():
        raise RuntimeError(f"{name} must not be a symlink")
    resolved = candidate.resolve()
    if resolved in {Path("/"), Path.home().resolve()}:
        raise RuntimeError(f"{name} must be a dedicated subdirectory")
    return resolved


def _model_endpoint(value: str) -> str:
    parsed = urlsplit(value)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise RuntimeError("NEWSCRAFT_HERMES_MODEL_BASE_URL must be an HTTP URL")
    is_loopback = False
    try:
        is_loopback = ipaddress.ip_address(parsed.hostname).is_loopback
    except ValueError:
        is_loopback = parsed.hostname.lower() == "localhost"
    if parsed.scheme != "https" and not is_loopback:
        raise RuntimeError("A remote Hermes model endpoint must use HTTPS")
    return value.rstrip("/")


def _integer_setting(name: str, default: int, minimum: int, maximum: int) -> int:
    raw = os.environ.get(name, str(default)).strip()
    try:
        value = int(raw)
    except ValueError as exc:
        raise RuntimeError(f"{name} must be an integer") from exc
    if not minimum <= value <= maximum:
        raise RuntimeError(f"{name} must be between {minimum} and {maximum}")
    return value


def _public_host_setting(value: str) -> str | None:
    value = value.strip().lower()
    if not value:
        return None
    if "://" in value or any(character in value for character in "/?#@"):
        raise RuntimeError("NEWSCRAFT_HERMES_PUBLIC_HOST must be one hostname")
    parsed = urlsplit(f"//{value}")
    try:
        port = parsed.port
    except ValueError as exc:
        raise RuntimeError("NEWSCRAFT_HERMES_PUBLIC_HOST must be one hostname") from exc
    if not parsed.hostname or port is not None or parsed.hostname != value:
        raise RuntimeError("NEWSCRAFT_HERMES_PUBLIC_HOST must be one hostname")
    if value in {"0.0.0.0", "::", "*"}:
        raise RuntimeError("NEWSCRAFT_HERMES_PUBLIC_HOST must be an exact hostname")
    return value


def _run_api_setting(value: str) -> str | None:
    value = value.strip().rstrip("/")
    if not value:
        return None
    parsed = urlsplit(value)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise RuntimeError("NEWSCRAFT_HERMES_RUN_API_URL must be an HTTP URL")
    if parsed.scheme != "https":
        try:
            if not ipaddress.ip_address(parsed.hostname).is_loopback and parsed.hostname != "localhost":
                raise RuntimeError("A remote NewsCraft run API must use HTTPS")
        except ValueError:
            raise RuntimeError("A remote NewsCraft run API must use HTTPS") from None
    return value


def settings_from_env() -> Settings:
    try:
        port = int(os.environ.get("HERMES_AGUI_PORT", "8000"))
    except ValueError as exc:
        raise RuntimeError("HERMES_AGUI_PORT must be an integer") from exc
    if not 1 <= port <= 65535:
        raise RuntimeError("HERMES_AGUI_PORT is outside the valid port range")
    session_token = _required("HERMES_AGUI_SESSION_TOKEN")
    if len(session_token) < 24:
        raise RuntimeError("HERMES_AGUI_SESSION_TOKEN must contain at least 24 characters")
    hermes_home = _private_directory("NEWSCRAFT_HERMES_HOME")
    workspace = _private_directory("NEWSCRAFT_HERMES_WORKSPACE")
    if hermes_home == workspace or hermes_home.is_relative_to(workspace) or workspace.is_relative_to(hermes_home):
        raise RuntimeError("Hermes home and workspace must be separate directories")
    run_api_url = _run_api_setting(os.environ.get("NEWSCRAFT_HERMES_RUN_API_URL", ""))
    run_api_token = os.environ.get("NEWSCRAFT_HERMES_RUN_API_TOKEN", "").strip() or None
    if bool(run_api_url) != bool(run_api_token):
        raise RuntimeError("NEWSCRAFT_HERMES_RUN_API_URL and NEWSCRAFT_HERMES_RUN_API_TOKEN must be set together")
    web_provider = _provider_setting(
        "NEWSCRAFT_HERMES_WEB_PROVIDER",
        _LOCAL_WEB_PROVIDER,
        {_LOCAL_WEB_PROVIDER, _EXA_WEB_PROVIDER},
    )
    browser_provider = _provider_setting(
        "NEWSCRAFT_HERMES_BROWSER_PROVIDER",
        _LOCAL_BROWSER_PROVIDER,
        {_LOCAL_BROWSER_PROVIDER, _BROWSER_USE_PROVIDER},
    )
    if web_provider == _EXA_WEB_PROVIDER:
        _required("EXA_API_KEY")
    if browser_provider == _BROWSER_USE_PROVIDER:
        _required("BROWSER_USE_API_KEY")
    return Settings(
        host=os.environ.get("HERMES_AGUI_HOST", "127.0.0.1").strip() or "127.0.0.1",
        port=port,
        session_token=session_token,
        public_host=_public_host_setting(os.environ.get("NEWSCRAFT_HERMES_PUBLIC_HOST", "")),
        hermes_home=hermes_home,
        workspace=workspace,
        model_provider=_required("NEWSCRAFT_HERMES_MODEL_PROVIDER"),
        model=_required("NEWSCRAFT_HERMES_MODEL"),
        model_base_url=_model_endpoint(_required("NEWSCRAFT_HERMES_MODEL_BASE_URL")),
        model_api_key=_required("NEWSCRAFT_HERMES_MODEL_API_KEY"),
        model_api_mode=os.environ.get("NEWSCRAFT_HERMES_MODEL_API_MODE", "").strip() or None,
        max_iterations=_integer_setting("NEWSCRAFT_HERMES_MAX_ITERATIONS", 25, 4, 90),
        web_provider=web_provider,
        browser_provider=browser_provider,
        retrieval=RetrievalConfig.from_env(),
        run_api_url=run_api_url,
        run_api_token=run_api_token,
        internal_agui_url=f"http://127.0.0.1:{port}/",
    )


def _prepare_private_directory(path: Path) -> Path:
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    path.chmod(0o700)
    return path


def _find_browser_executable(*browser_homes: Path) -> Path | None:
    patterns = (
        "browsers/chrome-*/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
        "browsers/chrome-*/chrome-linux*/chrome",
        "browsers/chrome-*/chrome",
        "browsers/chrome-*/chrome.exe",
    )
    candidates = [
        candidate
        for browser_home in browser_homes
        for pattern in patterns
        for candidate in browser_home.glob(pattern)
    ]
    candidates.append(Path("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"))
    executable = [
        candidate for candidate in candidates if candidate.is_file() and os.access(candidate, os.X_OK)
    ]
    return sorted(executable)[-1] if executable else None


def prepare_runtime(settings: Settings) -> None:
    home = _prepare_private_directory(settings.hermes_home)
    service_home = _prepare_private_directory(home / "home")
    workspace = _prepare_private_directory(settings.workspace)
    temp_path = _prepare_private_directory(workspace / ".tmp")
    os.environ["HERMES_HOME"] = str(home)
    os.environ["HOME"] = str(service_home)
    os.environ["NEWSCRAFT_HERMES_WORKSPACE"] = str(workspace)
    os.environ["TMPDIR"] = str(temp_path)
    # The pinned Hermes terminal bridge also reads these values from the
    # process environment. Keep the Docker task boundary explicit even when
    # an inherited operator environment contains broader terminal settings.
    os.environ["TERMINAL_ENV"] = "docker"
    os.environ["TERMINAL_CWD"] = "/workspace"
    os.environ["TERMINAL_DOCKER_FORWARD_ENV"] = "[]"
    os.environ["TERMINAL_DOCKER_VOLUMES"] = "[]"
    os.environ["TERMINAL_DOCKER_ENV"] = "{}"
    os.environ["TERMINAL_DOCKER_EXTRA_ARGS"] = "[]"
    os.environ["TERMINAL_DOCKER_MOUNT_CWD_TO_WORKSPACE"] = "false"
    # The Docker backend bind-mounts private tenant state for persistence.
    # Run as the service UID so the tenant's normal file tools can write it.
    os.environ["TERMINAL_DOCKER_RUN_AS_HOST_USER"] = "true"
    # Hermes derives persistent Docker storage from the active HERMES_HOME.
    # An inherited override would point every tenant at one host directory.
    os.environ.pop("TERMINAL_SANDBOX_DIR", None)
    # Do not attach this service to a browser controlled by another process.
    # Each tenant gets a local browser profile in its own private tenant scope.
    os.environ.pop("BROWSER_CDP_URL", None)
    os.environ.setdefault("AGENT_BROWSER_ENGINE", "chrome")
    os.environ.setdefault("AGENT_BROWSER_HEADED", "false")
    os.environ.setdefault("AGENT_BROWSER_DEFAULT_TIMEOUT", "120000")
    browser_executable = _find_browser_executable(
        service_home / ".agent-browser",
        home / ".agent-browser",
    )
    if browser_executable is not None and not os.environ.get("AGENT_BROWSER_EXECUTABLE_PATH"):
        os.environ.setdefault("AGENT_BROWSER_EXECUTABLE_PATH", str(browser_executable))
    managed_node_bin = home / "node" / "bin"
    os.environ["PATH"] = os.pathsep.join(
        [str(managed_node_bin), *os.environ.get("PATH", "").split(os.pathsep)]
    )
    os.chdir(workspace)


def _runtime_config(
    existing: dict[str, Any],
    auxiliary_tasks: Iterable[str],
    api_mode: str | None,
    retrieval_enabled: bool = True,
    web_provider: str = _LOCAL_WEB_PROVIDER,
    browser_provider: str = _LOCAL_BROWSER_PROVIDER,
) -> dict[str, Any]:
    """Build standard Hermes configuration for one explicit model endpoint."""
    config = dict(existing)
    model_endpoint: dict[str, Any] = {
        "provider": "custom",
        "default": _MODEL_REF,
        "base_url": _MODEL_BASE_URL_REF,
        "api_key": _MODEL_API_KEY_REF,
    }
    auxiliary_endpoint: dict[str, Any] = {
        "provider": "custom",
        "model": _MODEL_REF,
        "base_url": _MODEL_BASE_URL_REF,
        "api_key": _MODEL_API_KEY_REF,
    }
    if api_mode:
        model_endpoint["api_mode"] = api_mode
        auxiliary_endpoint["api_mode"] = api_mode

    config["model"] = model_endpoint
    config["fallback_providers"] = []
    config.pop("fallback_model", None)

    # Hermes can load an operator-selected external provider from this block.
    # The shared service has no tenant-aware provider contract, so retaining
    # that selector would make account state depend on a shared backend.
    # Built-in MEMORY.md/USER.md state remains enabled and is isolated by the
    # tenant Hermes home below.
    memory = config.get("memory")
    memory = dict(memory) if isinstance(memory, dict) else {}
    memory.pop("provider", None)
    config["memory"] = memory

    # External skill directories are arbitrary host paths in Hermes config.
    # They would bypass the tenant home and could expose a personal profile's
    # skills to every account.
    skills = config.get("skills")
    skills = dict(skills) if isinstance(skills, dict) else {}
    skills["external_dirs"] = []
    config["skills"] = skills

    web = dict(config.get("web") or {})
    if web_provider == _EXA_WEB_PROVIDER:
        web.update(
            {
                "backend": _EXA_WEB_PROVIDER,
                "search_backend": _EXA_WEB_PROVIDER,
                "extract_backend": _EXA_WEB_PROVIDER,
            }
        )
    else:
        web["backend"] = "ddgs"
        web["search_backend"] = "ddgs"
        if retrieval_enabled:
            web["extract_backend"] = PROVIDER_NAME
        else:
            web.pop("extract_backend", None)
    config["web"] = web

    plugins = dict(config.get("plugins") or {})
    # Do not inherit operator plugins from a personal Hermes installation.
    # Only reviewed NewsCraft-selected plugins are part of this service
    # contract. Do not inherit an operator's personal plugin list.
    enabled_plugins = ["newscraft-web"] if retrieval_enabled else []
    if web_provider == _EXA_WEB_PROVIDER:
        enabled_plugins.append("web-exa")
    if browser_provider == _BROWSER_USE_PROVIDER:
        enabled_plugins.append("browser-browser-use")
    plugins["enabled"] = enabled_plugins
    config["plugins"] = plugins

    browser = dict(config.get("browser") or {})
    # The provider is fixed by NewsCraft, never inherited from an operator
    # profile. A raw Browser Use session still receives Hermes's tenant task
    # key; caller-selected CDP endpoints remain forbidden.
    browser["cloud_provider"] = browser_provider
    browser.pop("cdp_url", None)
    config["browser"] = browser

    agui = dict(config.get("agui") or {})
    agui.update(
        {
            "toolsets": [HERMES_TOOLSET, CRON_TOOLSET],
            "provider": "custom",
            "model": _MODEL_REF,
            "base_url": _MODEL_BASE_URL_REF,
        }
    )
    if api_mode:
        agui["api_mode"] = api_mode
    else:
        agui.pop("api_mode", None)
    config["agui"] = agui

    auxiliary = dict(config.get("auxiliary") or {})
    task_names = {str(name).strip() for name in auxiliary_tasks if str(name).strip()}
    task_names.update(name for name, value in auxiliary.items() if isinstance(value, dict))
    for task_name in sorted(task_names):
        task_config = dict(auxiliary.get(task_name) or {})
        task_config.update(auxiliary_endpoint)
        task_config["fallback_chain"] = []
        auxiliary[task_name] = task_config
    config["auxiliary"] = auxiliary

    terminal = dict(config.get("terminal") or {})
    # The pinned Docker backend uses this optional host path before it applies
    # its context-local HERMES_HOME. Remove an operator-selected shared path;
    # the backend must derive one sandbox root inside the active tenant home.
    terminal.pop("sandbox_dir", None)
    terminal.update(
        {
            "backend": "docker",
            "cwd": "/workspace",
            "container_persistent": True,
            "docker_persist_across_processes": True,
            "docker_mount_cwd_to_workspace": False,
            "docker_network": True,
            "docker_volumes": [],
            "docker_forward_env": [],
            "docker_env": {},
            "credential_files": [],
            "docker_extra_args": [],
            # Hermes persists the tenant container through private bind mounts
            # under the service user's tenant home. Match that user so the
            # normal file tools can write /workspace without making the
            # container root or exposing any caller-selected host path.
            "docker_run_as_host_user": True,
        }
    )
    config["terminal"] = terminal
    return config


def _standard_auxiliary_tasks() -> set[str]:
    from hermes_cli.config_defaults import DEFAULT_CONFIG

    auxiliary = DEFAULT_CONFIG.get("auxiliary") or {}
    return {
        str(name)
        for name, value in auxiliary.items()
        if isinstance(value, dict) and "provider" in value
    }


def _write_runtime_config(
    settings: Settings,
    auxiliary_tasks: Iterable[str],
    existing: dict[str, Any] | None = None,
) -> dict[str, Any]:
    from hermes_cli.config import atomic_config_write, get_config_path, read_raw_config

    config_path = get_config_path()
    config = _runtime_config(
        existing if existing is not None else read_raw_config(),
        auxiliary_tasks,
        settings.model_api_mode,
        settings.retrieval.enabled,
        settings.web_provider,
        settings.browser_provider,
    )
    atomic_config_write(config_path, config, sort_keys=False)
    config_path.chmod(0o600)
    return config


def _tool_names(definitions: Iterable[dict]) -> list[str]:
    names = []
    for definition in definitions:
        function = definition.get("function") if isinstance(definition, dict) else None
        name = function.get("name") if isinstance(function, dict) else None
        if isinstance(name, str) and name:
            names.append(name)
    return sorted(set(names))


_STARTUP_REQUIRED_TOOL_NAMES = frozenset(
    {"terminal", "read_file", "write_file", "patch"}
)

# Provider-backed capabilities are reported separately from this core
# readiness set. A missing browser, search, or extraction provider must not
# turn a live Hermes process into a false unavailable signal.
_READINESS_REQUIRED_TOOL_NAMES = frozenset(
    {
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
    }
)


def _startup_tool_names(get_tool_definitions: Any, config: Any) -> list[str]:
    """Assemble required terminal/file tools after a transient probe failure.

    Hermes caches availability checks while it builds tool definitions. Docker
    can be briefly unavailable during service startup even when it is healthy
    by the time the app is ready. A cached false result would permanently
    remove the terminal and file tools from this process. Recheck the backend
    directly and rebuild the definitions once. If the backend is still down,
    keep the tools absent so readiness remains fail-closed.
    """
    definitions = get_tool_definitions(
        enabled_toolsets=config.enabled_toolsets,
        quiet_mode=True,
        skip_tool_search_assembly=True,
    )
    names = _tool_names(definitions)
    if _STARTUP_REQUIRED_TOOL_NAMES.issubset(names):
        return names

    try:
        from model_tools import _clear_tool_defs_cache
        from tools.registry import invalidate_check_fn_cache
        from tools.terminal_tool import check_terminal_requirements

        if not check_terminal_requirements():
            return names
        logger.warning(
            "Hermes terminal/file availability probe failed during initial "
            "tool discovery; rebuilding after a successful backend recheck"
        )
        invalidate_check_fn_cache()
        _clear_tool_defs_cache()
        definitions = get_tool_definitions(
            enabled_toolsets=config.enabled_toolsets,
            quiet_mode=True,
            skip_tool_search_assembly=True,
        )
        return _tool_names(definitions)
    except Exception:
        logger.exception("Hermes terminal/file tool availability retry failed")
        return names


def _browser_capability_ready(tools: set[str]) -> bool:
    """Return whether Hermes can execute its local browser tool now."""
    if not {"browser_navigate", "browser_snapshot"}.issubset(tools):
        return False
    try:
        from tools.browser_tool import check_browser_requirements
    except ImportError:
        return False
    try:
        return bool(check_browser_requirements())
    except Exception:
        logger.exception("Hermes browser readiness check failed")
        return False


def _tool_provider_readiness(settings: Settings) -> dict[str, dict[str, object]]:
    """Resolve the exact active web and browser backends without network I/O."""
    expected_web_search = (
        _EXA_WEB_PROVIDER
        if settings.web_provider == _EXA_WEB_PROVIDER
        else "ddgs"
    )
    expected_web_extract = (
        _EXA_WEB_PROVIDER
        if settings.web_provider == _EXA_WEB_PROVIDER
        else PROVIDER_NAME
    )
    web_search_active: str | None = None
    web_extract_active: str | None = None
    browser_active: str | None = None
    try:
        from tools.web_tools import _get_extract_backend, _get_search_backend

        web_search_active = str(_get_search_backend() or "").strip() or None
        web_extract_active = str(_get_extract_backend() or "").strip() or None
    except Exception:
        logger.exception("Hermes web provider readiness probe failed")

    try:
        from tools.browser_tool import _get_cloud_provider

        provider = _get_cloud_provider()
        if provider is None:
            browser_active = _LOCAL_BROWSER_PROVIDER
        else:
            browser_active = str(getattr(provider, "name", "") or "").strip() or None
    except Exception:
        logger.exception("Hermes browser provider readiness probe failed")

    return {
        "webSearch": {
            "requested": expected_web_search,
            "active": web_search_active,
            "configured": web_search_active == expected_web_search,
        },
        "webExtract": {
            "requested": expected_web_extract,
            "active": web_extract_active,
            "configured": web_extract_active == expected_web_extract,
        },
        "leadVerification": {
            "requested": PROVIDER_NAME,
            "active": PROVIDER_NAME,
            "configured": True,
        },
        "browser": {
            "requested": settings.browser_provider,
            "active": browser_active,
            "configured": browser_active == settings.browser_provider,
        },
    }
def _set_iteration_limit(
    agent: Any,
    max_iterations: int,
) -> Any:
    """Set Hermes's native per-run limit before the conversation starts."""
    agent.max_iterations = max_iterations
    return agent


def _install_iteration_limit(agui_server: Any, max_iterations: int) -> None:
    """Wrap the pinned adapter without changing the reviewed Hermes checkout."""
    current = agui_server.build_run_agent
    original = getattr(current, "_newscraft_unbounded_builder", current)

    def build_bounded_agent(*args: Any, **kwargs: Any) -> Any:
        return _set_iteration_limit(original(*args, **kwargs), max_iterations)

    build_bounded_agent._newscraft_unbounded_builder = original  # type: ignore[attr-defined]
    agui_server.build_run_agent = build_bounded_agent


def _install_public_host_alias(app: Any, bound_host: str, public_host: str | None) -> None:
    """Accept one reverse-proxy hostname without weakening Hermes's host guard."""
    if not public_host:
        return

    from agui_adapter.auth import host_accepted

    @app.middleware("http")
    async def accept_public_proxy_host(request: Any, call_next: Any):
        if host_accepted(request.headers.get("host", ""), public_host):
            request.scope["headers"] = [
                (name, bound_host.encode("ascii")) if name.lower() == b"host" else (name, value)
                for name, value in request.scope["headers"]
            ]
        return await call_next(request)


def _header_mapping(headers: Any) -> dict[str, Any]:
    if headers is None:
        return {}
    try:
        pairs = headers.items() if isinstance(headers, Mapping) else headers
        result: dict[str, Any] = {}
        seen: set[str] = set()
        for name, value in pairs:
            normalized = str(name).lower()
            if normalized == TENANT_HEADER and normalized in seen:
                raise TenantIsolationError("Hermes request must contain one NewsCraft tenant key")
            seen.add(normalized)
            result[str(name)] = value
        return result
    except (AttributeError, TypeError, ValueError) as exc:
        raise TenantIsolationError("Hermes forwarded headers are invalid") from exc


def _header_items(headers: Any) -> list[tuple[str, Any]]:
    """Read forwarded headers without losing duplicate raw values."""
    raw = getattr(headers, "raw", None)
    if raw is not None:
        try:
            return [
                (
                    name.decode("latin-1") if isinstance(name, bytes) else str(name),
                    value.decode("latin-1") if isinstance(value, bytes) else value,
                )
                for name, value in raw
            ]
        except (TypeError, ValueError) as exc:
            raise TenantIsolationError("Hermes forwarded headers are invalid") from exc
    try:
        pairs = headers.items() if isinstance(headers, Mapping) else headers
        return [(str(name), value) for name, value in pairs]
    except (AttributeError, TypeError, ValueError) as exc:
        raise TenantIsolationError("Hermes forwarded headers are invalid") from exc


def _install_forward_header_scope(agui_server: Any) -> None:
    """Keep duplicate tenant headers visible until the tenant guard runs."""
    current = getattr(agui_server, "_collect_forward_headers", None)
    if current is None:
        raise TenantIsolationError("Pinned Hermes forwarded-header collector is unavailable")
    original = getattr(current, "_newscraft_unscoped_header_collector", current)

    def collect_scoped(headers: Any) -> Any:
        collected = original(headers)
        collected_items = _header_items(collected)
        tenant_items = [
            (name, value)
            for name, value in _header_items(headers)
            if name.lower() == TENANT_HEADER
        ]
        filtered = [
            (name, value)
            for name, value in collected_items
            if name.lower() != TENANT_HEADER
        ]
        if tenant_items:
            # A list preserves every raw tenant header. _run_turn rejects
            # zero or multiple values before forwarding the rest downstream.
            return [*filtered, *tenant_items]
        return dict(filtered)

    collect_scoped._newscraft_unscoped_header_collector = original  # type: ignore[attr-defined]
    agui_server._collect_forward_headers = collect_scoped


def _run_input_value(run_input: Any, name: str) -> str:
    if isinstance(run_input, Mapping):
        value = run_input.get(name)
        if value is None and name == "thread_id":
            value = run_input.get("threadId")
        if value is None and name == "run_id":
            value = run_input.get("runId")
    else:
        value = getattr(run_input, name, None)
    return str(value or "")


def _install_session_context_scope(agui_server: Any) -> None:
    """Force Hermes session selectors to the active NewsCraft tenant."""
    from gateway import session_context

    def scoped_setter(original: Any) -> Any:
        original = getattr(original, "_newscraft_unscoped_session_setter", original)

        def set_scoped_session_vars(*args: Any, **kwargs: Any) -> Any:
            run = current_tenant_run()
            if run is None:
                return original(*args, **kwargs)
            values = dict(kwargs)
            values.update(
                {
                    "source": "newscraft",
                    "thread_id": run.thread_id,
                    "user_id": run.runtime.key,
                    "session_key": run.runtime.task_key,
                    "session_id": run.thread_id or run.runtime.task_key,
                    "profile": run.runtime.profile_name,
                    "cwd": run.runtime.container_workspace,
                    "ui_session_id": run.run_id,
                    "async_delivery": False,
                }
            )
            return original(*args, **values)

        set_scoped_session_vars._newscraft_unscoped_session_setter = original  # type: ignore[attr-defined]
        return set_scoped_session_vars

    session_context.set_session_vars = scoped_setter(session_context.set_session_vars)
    if hasattr(agui_server, "set_session_vars"):
        agui_server.set_session_vars = scoped_setter(agui_server.set_session_vars)


def _install_browser_profile_scope(
    browser_provider: str = _LOCAL_BROWSER_PROVIDER,
) -> None:
    """Give each tenant's browser subprocess a persistent private profile."""
    try:
        import tools.browser_tool as browser_tool
    except ImportError as exc:
        raise TenantIsolationError("Pinned Hermes browser tool is unavailable") from exc

    current = getattr(browser_tool, "_build_browser_env", None)
    if current is None:
        raise TenantIsolationError("Pinned Hermes browser environment builder is unavailable")
    original = getattr(current, "_newscraft_unscoped_browser_env", current)

    create_local = getattr(browser_tool, "_create_local_session", None)
    if create_local is None:
        raise TenantIsolationError("Pinned Hermes local browser session builder is unavailable")
    original_create_local = getattr(
        create_local,
        "_newscraft_unscoped_local_browser_session",
        create_local,
    )
    socket_tmpdir = getattr(browser_tool, "_socket_safe_tmpdir", None)
    if socket_tmpdir is None:
        raise TenantIsolationError("Pinned Hermes browser socket directory resolver is unavailable")
    original_socket_tmpdir = getattr(
        socket_tmpdir,
        "_newscraft_unscoped_socket_tmpdir",
        socket_tmpdir,
    )

    def build_scoped_browser_env(*args: Any, **kwargs: Any) -> dict[str, str]:
        environment = dict(original(*args, **kwargs))
        run = current_tenant_run()
        if run is None:
            return environment
        for name in (
            "BROWSERBASE_API_KEY",
            "BROWSERBASE_PROJECT_ID",
            "BROWSER_USE_API_KEY",
            "FIRECRAWL_API_KEY",
            "FIRECRAWL_API_URL",
            "FIRECRAWL_BROWSER_TTL",
            "BROWSER_CDP_URL",
        ):
            environment.pop(name, None)
        environment.update(
            {
                "AGENT_BROWSER_PROFILE": str(run.runtime.browser_profile),
                "AGENT_BROWSER_SESSION_NAME": run.runtime.task_key,
                "AGENT_BROWSER_NAMESPACE": run.runtime.task_key,
                "HOME": str(run.runtime.browser_profile),
                "XDG_CONFIG_HOME": str(run.runtime.browser_profile / "config"),
                # Chrome puts its SingletonSocket below TMPDIR. Keep this
                # transient path short; the tenant-specific browser profile
                # above remains the durable cookie and storage boundary.
                "TMPDIR": "/tmp",
            }
        )
        return environment

    def create_scoped_local_session(task_id: Any, *args: Any, **kwargs: Any) -> dict[str, Any]:
        run = current_tenant_run()
        if run is None:
            return original_create_local(task_id, *args, **kwargs)
        if browser_provider == _BROWSER_USE_PROVIDER:
            raise RuntimeError(
                "NewsCraft requires Browser Use for this run; local browser fallback is disabled"
            )
        # Hermes normally creates a random local session name. A deterministic
        # name keeps the tenant's browser cookies across a service restart,
        # while the tenant home still keeps the profile out of every other
        # account's browser state.
        # Keep the stable opaque label short enough for agent-browser's
        # per-session Unix socket path, even when TMPDIR is a long staging or
        # service path. Six digest bytes provide a 48-bit label. The full
        # tenant task key remains the ownership key.
        session_label = base64.urlsafe_b64encode(
            hashlib.sha256(run.runtime.task_key.encode("utf-8")).digest()[:6]
        ).decode("ascii").rstrip("=")
        session_name = "n" + session_label
        return {
            "session_name": session_name,
            "bb_session_id": None,
            "cdp_url": None,
            "features": {"local": True},
        }

    def socket_tmpdir_scoped(*args: Any, **kwargs: Any) -> str:
        if current_tenant_run() is not None:
            # The service keeps its private TMPDIR under a long workspace
            # path. Browser sockets have a short Unix-domain path limit, so
            # use the sticky system temp root for the already tenant-unique
            # session directory. The browser tool creates that directory
            # with mode 0700 and the session name is derived from the tenant
            # task key above.
            return "/tmp"
        return original_socket_tmpdir(*args, **kwargs)

    build_scoped_browser_env._newscraft_unscoped_browser_env = original  # type: ignore[attr-defined]
    create_scoped_local_session._newscraft_unscoped_local_browser_session = original_create_local  # type: ignore[attr-defined]
    socket_tmpdir_scoped._newscraft_unscoped_socket_tmpdir = original_socket_tmpdir  # type: ignore[attr-defined]
    browser_tool._build_browser_env = build_scoped_browser_env
    browser_tool._create_local_session = create_scoped_local_session
    browser_tool._socket_safe_tmpdir = socket_tmpdir_scoped


def _install_session_search_scope() -> None:
    """Prevent Hermes's bare-ID fallback from scanning other tenant profiles."""
    try:
        import tools.session_search_tool as session_search_tool
    except ImportError as exc:
        raise TenantIsolationError("Pinned Hermes session search tool is unavailable") from exc

    current = getattr(session_search_tool, "_locate_session_db", None)
    if current is None:
        raise TenantIsolationError("Pinned Hermes session search locator is unavailable")
    original = getattr(current, "_newscraft_unscoped_session_locator", current)

    def locate_scoped(session_id: Any, *args: Any, **kwargs: Any) -> Any:
        if current_tenant_run() is not None:
            # The pinned fallback scans every Hermes profile. A NewsCraft run
            # may read only its context-local profile, never a bare ID from a
            # different account.
            return None, None
        return original(session_id, *args, **kwargs)

    locate_scoped._newscraft_unscoped_session_locator = original  # type: ignore[attr-defined]
    session_search_tool._locate_session_db = locate_scoped


def _install_prompt_backend_scope() -> None:
    """Disable Hermes's process-global backend probe for tenant runs.

    The pinned prompt builder creates an environment with the literal task
    key ``prompt-backend-probe``. That key is shared across Hermes processes,
    so its Docker container can point at another profile's state. NewsCraft
    already fixes the backend to Docker and Hermes has a safe static fallback
    prompt when the probe does not respond. Do not create that shared
    container inside an authenticated account run.
    """
    try:
        import agent.prompt_builder as prompt_builder
    except ImportError as exc:
        raise TenantIsolationError("Pinned Hermes prompt builder is unavailable") from exc

    current = getattr(prompt_builder, "_probe_remote_backend", None)
    if current is None:
        raise TenantIsolationError("Pinned Hermes backend probe is unavailable")
    original = getattr(current, "_newscraft_unscoped_backend_probe", current)

    def probe_scoped(env_type: str) -> Any:
        if current_tenant_run() is not None:
            return None
        return original(env_type)

    probe_scoped._newscraft_unscoped_backend_probe = original  # type: ignore[attr-defined]
    prompt_builder._probe_remote_backend = probe_scoped


def _disable_shared_delegation_recovery() -> None:
    """Do not restore a process-global async-delegation database at startup.

    Hermes constructs ``ProcessRegistry`` while the shared AG-UI service
    starts. Its constructor restores pending async delegations from the
    process-level ``HERMES_HOME/state.db`` before a tenant run exists. That
    would make one shared recovery queue a cross-account state surface. A
    tenant-scoped run may still use the normal durable delegation functions;
    startup recovery stays disabled because there is no authenticated tenant
    to select at process start.
    """
    try:
        import tools.async_delegation as async_delegation
    except ImportError as exc:
        raise TenantIsolationError("Pinned Hermes async delegation is unavailable") from exc

    current = getattr(async_delegation, "restore_undelivered_completions", None)
    if current is None:
        raise TenantIsolationError("Pinned Hermes async delegation recovery is unavailable")
    original = getattr(
        current,
        "_newscraft_unscoped_delegation_recovery",
        current,
    )

    def restore_scoped(target_queue: Any, *args: Any, **kwargs: Any) -> int:
        if current_tenant_run() is None:
            return 0
        return original(target_queue, *args, **kwargs)

    restore_scoped._newscraft_unscoped_delegation_recovery = original  # type: ignore[attr-defined]
    async_delegation.restore_undelivered_completions = restore_scoped


def _enable_tenant_cron_tool() -> None:
    """Expose cronjob management on the tenant-bound AG-UI surface.

    Hermes's ``cronjob`` check is limited to CLI and gateway environment
    flags. AG-UI has neither flag because the service must not enter the
    gateway approval path. The tool itself resolves storage from the active
    context-local Hermes home, so remove only this availability gate in the
    dedicated NewsCraft process. The gateway scheduler remains disabled.
    """
    try:
        from tools.registry import registry
    except ImportError as exc:
        raise TenantIsolationError("Pinned Hermes tool registry is unavailable") from exc

    entry = registry.get_entry("cronjob")
    if entry is None:
        raise TenantIsolationError("Pinned Hermes cronjob tool is unavailable")
    with registry._lock:
        if entry.check_fn is None:
            return
        entry.check_fn = None
        registry._generation += 1


def _install_process_scope() -> None:
    """Bind process handles to the stable tenant task key."""
    _disable_shared_delegation_recovery()
    try:
        from tools.process_registry import process_registry
    except ImportError as exc:
        raise TenantIsolationError("Pinned Hermes process registry is unavailable") from exc

    current = getattr(process_registry, "get", None)
    if current is None:
        raise TenantIsolationError("Pinned Hermes process lookup is unavailable")
    original = getattr(current, "_newscraft_unscoped_process_get", current)

    def get_scoped(session_id: Any, *args: Any, **kwargs: Any) -> Any:
        session = original(session_id, *args, **kwargs)
        run = current_tenant_run()
        if run is None or session is None:
            return session
        if getattr(session, "task_id", None) != run.runtime.task_key:
            return None
        return session

    get_scoped._newscraft_unscoped_process_get = original  # type: ignore[attr-defined]
    # This is an instance attribute. It intentionally closes over Hermes's
    # original bound method so all registry operations that call self.get()
    # receive the same tenant ownership check.
    process_registry.get = get_scoped

    # Hermes's normal list operation also accepts a session key. That is
    # useful for a shared interactive gateway, but its documented behavior is
    # to include processes from another task when the session key matches.
    # NewsCraft has no shared session scope: list only this tenant's task.
    list_sessions = getattr(process_registry, "list_sessions", None)
    if list_sessions is None:
        raise TenantIsolationError("Pinned Hermes process listing is unavailable")
    original_list_sessions = getattr(
        list_sessions,
        "_newscraft_unscoped_process_list",
        list_sessions,
    )

    def list_scoped(*args: Any, **kwargs: Any) -> Any:
        run = current_tenant_run()
        if run is None:
            return original_list_sessions(*args, **kwargs)
        # Do not pass the current session key. Hermes would union it with the
        # task filter and return another task's session-scoped process.
        return original_list_sessions(
            task_id=run.runtime.task_key,
            session_key=None,
        )

    list_scoped._newscraft_unscoped_process_list = original_list_sessions  # type: ignore[attr-defined]
    process_registry.list_sessions = list_scoped

    # Hermes's crash checkpoint is a module-level path. It is not tenant-aware,
    # and Docker-backed PIDs cannot be recovered after this host service exits.
    # Do not write or read one shared process metadata file for all accounts.
    checkpoint_writer = getattr(process_registry, "_write_checkpoint", None)
    if checkpoint_writer is not None and not getattr(
        checkpoint_writer, "_newscraft_tenant_checkpoint_disabled", False
    ):
        def disable_shared_checkpoint(*_args: Any, **_kwargs: Any) -> None:
            return None

        disable_shared_checkpoint._newscraft_tenant_checkpoint_disabled = True  # type: ignore[attr-defined]
        process_registry._write_checkpoint = disable_shared_checkpoint

    checkpoint_recovery = getattr(process_registry, "recover_from_checkpoint", None)
    if checkpoint_recovery is not None and not getattr(
        checkpoint_recovery, "_newscraft_tenant_checkpoint_disabled", False
    ):
        def disable_shared_checkpoint_recovery(*_args: Any, **_kwargs: Any) -> int:
            return 0

        disable_shared_checkpoint_recovery._newscraft_tenant_checkpoint_disabled = True  # type: ignore[attr-defined]
        process_registry.recover_from_checkpoint = disable_shared_checkpoint_recovery


def _bind_tenant_terminal_scope(runtime: Any) -> None:
    """Make Hermes keep one hardened Docker environment per tenant.

    Hermes intentionally collapses ordinary task IDs to ``default`` so
    delegate tasks share one container. NewsCraft must use the same low-cost
    lazy container model while preventing account A and B from sharing that
    container. The pinned terminal API exposes an infrastructure-only task
    override for this purpose. The service supplies it from the authenticated
    runtime; the model cannot select or change it.
    """
    try:
        from tools.terminal_tool import register_task_env_overrides
    except ImportError as exc:
        raise TenantIsolationError("Pinned Hermes terminal task scope is unavailable") from exc

    register_task_env_overrides(
        runtime.task_key,
        {
            "env_type": "docker",
            "cwd": runtime.container_workspace,
        },
    )


def _install_registry_scope() -> None:
    """Bind every model-dispatched tool call to the tenant task key."""
    try:
        from tools.registry import registry
    except ImportError as exc:
        raise TenantIsolationError("Pinned Hermes tool registry is unavailable") from exc

    current = getattr(registry, "dispatch", None)
    if current is None:
        raise TenantIsolationError("Pinned Hermes tool dispatch is unavailable")
    original = getattr(current, "_newscraft_unscoped_dispatch", current)

    def dispatch_scoped(function_name: str, function_args: Any, *args: Any, **kwargs: Any) -> Any:
        run = current_tenant_run()
        if run is None:
            return original(function_name, function_args, *args, **kwargs)
        safe_arguments = guard_tool_arguments(function_name, function_args, run)
        values = dict(kwargs)
        values["task_id"] = run.runtime.task_key
        return original(function_name, safe_arguments, *args, **values)

    dispatch_scoped._newscraft_unscoped_dispatch = original  # type: ignore[attr-defined]
    registry.dispatch = dispatch_scoped


def _install_agent_scope() -> None:
    """Force conversation and agent-loop tools to use one stable tenant task."""
    try:
        from run_agent import AIAgent
    except ImportError as exc:
        raise TenantIsolationError("Pinned Hermes agent runtime is unavailable") from exc

    invoke = getattr(AIAgent, "_invoke_tool", None)
    converse = getattr(AIAgent, "run_conversation", None)
    if invoke is None or converse is None:
        raise TenantIsolationError("Pinned Hermes agent task hooks are unavailable")

    original_invoke = getattr(invoke, "_newscraft_unscoped_invoke_tool", invoke)
    original_converse = getattr(converse, "_newscraft_unscoped_run_conversation", converse)

    def invoke_scoped(
        agent: Any,
        function_name: str,
        function_args: Any,
        effective_task_id: str | None = None,
        *args: Any,
        **kwargs: Any,
    ) -> Any:
        run = current_tenant_run()
        if run is None:
            return original_invoke(
                agent,
                function_name,
                function_args,
                effective_task_id,
                *args,
                **kwargs,
            )
        safe_arguments = guard_tool_arguments(function_name, function_args, run)
        return original_invoke(
            agent,
            function_name,
            safe_arguments,
            run.runtime.task_key,
            *args,
            **kwargs,
        )

    def converse_scoped(agent: Any, *args: Any, **kwargs: Any) -> Any:
        run = current_tenant_run()
        if run is None:
            return original_converse(agent, *args, **kwargs)
        task_id = run.runtime.task_key
        positional = list(args)
        if len(positional) >= 4:
            positional[3] = task_id
            return original_converse(agent, *positional, **kwargs)
        values = dict(kwargs)
        values["task_id"] = task_id
        return original_converse(agent, *positional, **values)

    invoke_scoped._newscraft_unscoped_invoke_tool = original_invoke  # type: ignore[attr-defined]
    converse_scoped._newscraft_unscoped_run_conversation = original_converse  # type: ignore[attr-defined]
    AIAgent._invoke_tool = invoke_scoped
    AIAgent.run_conversation = converse_scoped


def _install_product_identity_scope() -> None:
    """Keep the standard Hermes prompt scaffold under one NewsCraft identity."""
    try:
        import run_agent
    except ImportError as exc:
        raise TenantIsolationError("Pinned Hermes prompt runtime is unavailable") from exc

    load_soul = getattr(run_agent, "load_soul_md", None)
    if load_soul is None:
        raise TenantIsolationError("Pinned Hermes SOUL loader is unavailable")
    original_load_soul = getattr(load_soul, "_newscraft_unscoped_load_soul_md", load_soul)

    prompt_modules = [
        importlib.import_module("agent.prompt_builder"),
        importlib.import_module("agent.system_prompt"),
    ]
    original_identities = [
        str(
            getattr(
                run_agent,
                "_newscraft_unscoped_default_identity",
                getattr(run_agent, "DEFAULT_AGENT_IDENTITY", ""),
            )
            or ""
        ).strip(),
        *[
            str(
                getattr(
                    module,
                    "_newscraft_unscoped_default_identity",
                    getattr(module, "DEFAULT_AGENT_IDENTITY", ""),
                )
                or ""
            ).strip()
            for module in prompt_modules
        ],
    ]
    upstream_identity = next((identity for identity in original_identities if identity), "")

    def load_soul_scoped(*args: Any, **kwargs: Any) -> str | None:
        if current_tenant_run() is None:
            return original_load_soul(*args, **kwargs)
        return tenant_preferences_only(
            original_load_soul(*args, **kwargs),
            upstream_identity,
        )

    load_soul_scoped._newscraft_unscoped_load_soul_md = original_load_soul  # type: ignore[attr-defined]
    run_agent.load_soul_md = load_soul_scoped

    identity_modules = [run_agent, *prompt_modules]
    for module in identity_modules:
        current_identity = getattr(module, "DEFAULT_AGENT_IDENTITY", None)
        if current_identity is None:
            continue
        original_identity = getattr(
            module,
            "_newscraft_unscoped_default_identity",
            current_identity,
        )
        module._newscraft_unscoped_default_identity = original_identity
        module.DEFAULT_AGENT_IDENTITY = NEWSCRAFT_RUNTIME_IDENTITY_POINTER


def _install_tenant_builder(agui_server: Any) -> None:
    current = getattr(agui_server, "build_run_agent", None)
    if current is None:
        raise TenantIsolationError("Pinned Hermes AG-UI agent builder is unavailable")
    original = getattr(current, "_newscraft_unscoped_tenant_builder", current)

    def build_tenant_agent(*args: Any, **kwargs: Any) -> Any:
        run = current_tenant_run()
        if run is None:
            return original(*args, **kwargs)
        values = dict(kwargs)
        values["cwd"] = run.runtime.container_workspace
        agent = original(*args, **values)
        if agent is None or not hasattr(agent, "__dict__"):
            return agent
        # The upstream conversation loop appends this prompt after the cached
        # standard scaffold, context files, memory, and thread text.
        agent.load_soul_identity = True
        agent.ephemeral_system_prompt = append_product_identity(
            getattr(agent, "ephemeral_system_prompt", None)
        )
        return agent

    build_tenant_agent._newscraft_unscoped_tenant_builder = original  # type: ignore[attr-defined]
    agui_server.build_run_agent = build_tenant_agent


def _install_tenant_run_scope(
    agui_server: Any,
    settings: Settings,
    auxiliary_tasks: Iterable[str],
    runtime_template: dict[str, Any],
    isolation: TenantIsolation,
) -> None:
    current = getattr(agui_server, "_run_turn", None)
    if current is None:
        raise TenantIsolationError("Pinned Hermes AG-UI run hook is unavailable")
    original = getattr(current, "_newscraft_unscoped_tenant_run", current)

    def run_scoped(
        run_input: Any,
        config: Any,
        bridge: Any,
        fwd_headers: Any,
        approval_cb: Any = None,
        on_agent: Any = None,
    ) -> Any:
        headers = _header_mapping(fwd_headers)
        tenant_key = isolation.tenant_from_headers(headers)
        runtime = isolation.resolve(tenant_key)
        thread_id = _run_input_value(run_input, "thread_id")
        run_id = _run_input_value(run_input, "run_id")
        filtered_headers = {
            name: value
            for name, value in headers.items()
            if str(name).lower() != TENANT_HEADER
        }

        with tenant_run_scope(runtime, thread_id=thread_id, run_id=run_id):
            with isolation.initialization_lock(runtime):
                isolation.ensure(runtime)
                _bind_tenant_terminal_scope(runtime)
                _write_runtime_config(settings, auxiliary_tasks, existing=runtime_template)
            return original(
                run_input,
                config,
                bridge,
                filtered_headers,
                approval_cb=approval_cb,
                on_agent=on_agent,
            )

    run_scoped._newscraft_unscoped_tenant_run = original  # type: ignore[attr-defined]
    agui_server._run_turn = run_scoped


def _install_tenant_runtime(
    agui_server: Any,
    settings: Settings,
    auxiliary_tasks: Iterable[str],
    runtime_template: dict[str, Any],
    isolation: TenantIsolation,
) -> None:
    forward_headers = tuple(getattr(agui_server, "_FORWARD_HEADERS", ()))
    if not any(str(name).lower() == TENANT_HEADER for name in forward_headers):
        agui_server._FORWARD_HEADERS = (*forward_headers, TENANT_HEADER)
    _install_forward_header_scope(agui_server)
    _install_session_context_scope(agui_server)
    _install_browser_profile_scope(settings.browser_provider)
    _install_session_search_scope()
    _install_prompt_backend_scope()
    _install_process_scope()
    _install_registry_scope()
    _install_agent_scope()
    _install_product_identity_scope()
    _install_tenant_builder(agui_server)
    _install_tenant_run_scope(agui_server, settings, auxiliary_tasks, runtime_template, isolation)


def create_app(settings: Settings | None = None):
    """Create the pinned Hermes AG-UI runtime with its standard capabilities."""
    settings = settings or settings_from_env()
    prepare_runtime(settings)
    isolation = TenantIsolation(settings.hermes_home, settings.workspace)
    # Install this before plugin and tool discovery can import Hermes's global
    # ProcessRegistry. No authenticated tenant exists during service startup.
    _disable_shared_delegation_recovery()

    auxiliary_tasks = _standard_auxiliary_tasks()
    runtime_template = _write_runtime_config(settings, auxiliary_tasks)

    from hermes_cli.plugins import discover_plugins, get_plugin_auxiliary_tasks

    try:
        discover_plugins()
    except Exception:
        logger.exception("Hermes plugin discovery failed")

    plugin_tasks = {
        str(entry.get("key") or "").strip()
        for entry in get_plugin_auxiliary_tasks()
        if str(entry.get("key") or "").strip()
    }
    if not plugin_tasks.issubset(auxiliary_tasks):
        auxiliary_tasks.update(plugin_tasks)
        runtime_template = _write_runtime_config(
            settings,
            auxiliary_tasks,
            existing=runtime_template,
        )

    import agui_adapter.server as agui_server
    from agui_adapter.session import AgentConfig
    from model_tools import get_tool_definitions

    _enable_tenant_cron_tool()
    config = AgentConfig()
    # Hermes's curated ACP set intentionally omits cronjob. NewsCraft keeps
    # the scheduled-job tool because the tenant-scoped cron store is safe, but
    # the separate gateway ticker remains disabled for this adapter.
    config.enabled_toolsets = [HERMES_TOOLSET, CRON_TOOLSET]
    # Hermes names a pinned OpenAI-compatible endpoint "custom". Keep the
    # operator's provider name as metadata, not as a resolver input.
    config.provider = "custom"
    config.model = settings.model
    config.base_url = settings.model_base_url
    config.api_key = settings.model_api_key
    config.api_mode = settings.model_api_mode

    _install_tenant_runtime(
        agui_server,
        settings,
        auxiliary_tasks,
        runtime_template,
        isolation,
    )
    _install_iteration_limit(agui_server, settings.max_iterations)

    tools = _startup_tool_names(get_tool_definitions, config)
    retrieval = retrieval_readiness(settings.retrieval)
    tool_providers = _tool_provider_readiness(settings)
    if not retrieval["configured"]:
        logger.error("NewsCraft web extraction is not ready: %s", retrieval["reason"])
    lead_verification_tool = VERIFY_LEAD_TOOL_NAME in tools
    browser_ready = _browser_capability_ready(set(tools))
    if not browser_ready:
        logger.error("Hermes local browser is not ready")

    app = agui_server.create_app(
        config=config,
        session_token=settings.session_token,
        bound_host=settings.host,
    )
    _install_public_host_alias(app, settings.host, settings.public_host)
    durable_worker = DurableRunWorker(settings, isolation)

    def durable_authorized(request: Any) -> bool:
        authorization = request.headers.get("authorization", "")
        bearer = authorization[7:].strip() if authorization.lower().startswith("bearer ") else ""
        presented = request.headers.get("x-hermes-session-token", "")
        return bool(
            secrets.compare_digest(bearer, settings.session_token)
            or secrets.compare_digest(presented, settings.session_token)
        )

    @app.post("/v1/runs/start")
    async def durable_start(request: Request):
        from fastapi.responses import JSONResponse

        if not durable_authorized(request):
            return JSONResponse({"detail": "unauthorized"}, status_code=401)
        try:
            payload = await request.json()
            if payload.get("tenant_key") != request.headers.get(TENANT_HEADER, ""):
                return JSONResponse({"detail": "tenant binding does not match"}, status_code=409)
            result = await durable_worker.start(payload)
            return JSONResponse(result, status_code=202)
        except DurableRunError as exc:
            return JSONResponse({"detail": str(exc)}, status_code=409)
        except Exception:
            logger.exception("Durable Hermes start failed")
            return JSONResponse({"detail": "durable Hermes start failed"}, status_code=503)

    @app.post("/v1/runs/{run_id}/cancel")
    async def durable_cancel(run_id: str, request: Request):
        from fastapi.responses import JSONResponse

        if not durable_authorized(request):
            return JSONResponse({"detail": "unauthorized"}, status_code=401)
        try:
            payload = await request.json()
        except Exception:
            payload = {}
        try:
            account_id = str(payload.get("account_id") or "").strip()
            payload_run_id = str(payload.get("run_id") or "").strip()
            payload_tenant_key = str(payload.get("tenant_key") or "").strip()
            header_tenant_key = request.headers.get(TENANT_HEADER, "").strip()
            if not account_id or payload_run_id != run_id or not payload_tenant_key or payload_tenant_key != header_tenant_key:
                return JSONResponse({"detail": "run, account and tenant bindings are required"}, status_code=409)
            result = await durable_worker.cancel(
                run_id,
                account_id,
                header_tenant_key,
            )
            return JSONResponse(result, status_code=202)
        except DurableRunError as exc:
            return JSONResponse({"detail": str(exc)}, status_code=409)

    @app.on_event("startup")
    async def recover_durable_runs() -> None:
        asyncio.create_task(durable_worker.recover(), name="newscraft-hermes-recovery")

    @app.on_event("shutdown")
    async def stop_durable_runs() -> None:
        await durable_worker.close()

    @app.get("/ready")
    async def ready(request: Request):
        from fastapi.responses import JSONResponse

        ready_ok = bool(_READINESS_REQUIRED_TOOL_NAMES.issubset(tools) and durable_worker.configured)
        optional_ready = bool(
            retrieval["configured"]
            and "web_extract" in tools
            and lead_verification_tool
            and browser_ready
            and all(bool(provider["configured"]) for provider in tool_providers.values())
        )
        state = "ready" if ready_ok and optional_ready else "degraded" if ready_ok else "unavailable"
        details = {
            "ok": ready_ok,
            "state": state,
            "service": "newscraft-hermes-chat",
            "processInstanceId": _PROCESS_INSTANCE_ID,
            "hermesCommit": HERMES_COMMIT,
            "toolset": HERMES_TOOLSET,
            "tools": tools,
            "runtime": {
                "provider": "custom",
                "requestedProvider": settings.model_provider,
                "model": settings.model,
                "endpointMode": "explicit",
                "maxIterations": settings.max_iterations,
            },
            "toolProviders": tool_providers,
            "capabilities": {
                "standard": True,
                "browser": browser_ready,
                "webResearch": "web_search" in tools,
                "webExtraction": {
                    **retrieval,
                    "tool": "web_extract" in tools,
                    "leadVerificationTool": lead_verification_tool,
                },
                "webLeadVerification": {
                    "configured": bool(retrieval["configured"] and lead_verification_tool),
                    "tool": lead_verification_tool,
                    "bounded": True,
                },
                "terminal": {"terminal", "process"}.issubset(tools),
                "files": {"read_file", "write_file", "patch"}.issubset(tools),
                "codeExecution": "execute_code" in tools,
                "delegation": "delegate_task" in tools,
                "skills": {"skills_list", "skill_view", "skill_manage"}.issubset(tools),
                "memory": "memory" in tools,
                "scheduledJobs": "cronjob" in tools,
                "durableRuns": {
                    "configured": durable_worker.configured,
                    "callback": durable_worker.configured,
                },
                "accountIsolation": {
                    "tenantHeader": TENANT_HEADER,
                    "contextLocalHome": True,
                    "stableTaskKey": True,
                    "persistentDockerWorkspace": True,
                    "isolatedBrowserProfiles": True,
                },
            },
        }
        # The unauthenticated readiness response is intentionally small. The
        # provider, runtime, tool, and isolation details require the same
        # server token as the durable control plane.
        payload = details if durable_authorized(request) else {
            "ok": ready_ok,
            "state": state,
            "service": "newscraft-hermes-chat",
        }
        return JSONResponse(payload, status_code=200 if ready_ok else 503)

    return app


def main() -> None:
    settings = settings_from_env()
    import uvicorn

    logging.basicConfig(level=logging.INFO)
    logger.info("Starting NewsCraft Hermes chat on %s:%d", settings.host, settings.port)
    uvicorn.run(
        create_app(settings),
        host=settings.host,
        port=settings.port,
        workers=1,
        log_level="warning",
    )
