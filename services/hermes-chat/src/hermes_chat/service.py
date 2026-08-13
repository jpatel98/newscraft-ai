from __future__ import annotations

import ipaddress
import logging
import os
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from . import HERMES_COMMIT
from .contracts import HERMES_TOOLSET

logger = logging.getLogger(__name__)

_MODEL_REF = "${env:NEWSCRAFT_HERMES_MODEL}"
_MODEL_BASE_URL_REF = "${env:NEWSCRAFT_HERMES_MODEL_BASE_URL}"
_MODEL_API_KEY_REF = "${env:NEWSCRAFT_HERMES_MODEL_API_KEY}"


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


def _required(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"{name} is required")
    return value


def _private_directory(name: str) -> Path:
    raw = _required(name)
    candidate = Path(raw).expanduser()
    if not candidate.is_absolute():
        raise RuntimeError(f"{name} must be an absolute path")
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

    agui = dict(config.get("agui") or {})
    agui.update(
        {
            "toolsets": [HERMES_TOOLSET],
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
    return config


def _standard_auxiliary_tasks() -> set[str]:
    from hermes_cli.config_defaults import DEFAULT_CONFIG

    auxiliary = DEFAULT_CONFIG.get("auxiliary") or {}
    return {
        str(name)
        for name, value in auxiliary.items()
        if isinstance(value, dict) and "provider" in value
    }


def _write_runtime_config(settings: Settings, auxiliary_tasks: Iterable[str]) -> None:
    from hermes_cli.config import atomic_config_write, get_config_path, read_raw_config

    config_path = get_config_path()
    config = _runtime_config(read_raw_config(), auxiliary_tasks, settings.model_api_mode)
    atomic_config_write(config_path, config, sort_keys=False)
    config_path.chmod(0o600)


def _tool_names(definitions: Iterable[dict]) -> list[str]:
    names = []
    for definition in definitions:
        function = definition.get("function") if isinstance(definition, dict) else None
        name = function.get("name") if isinstance(function, dict) else None
        if isinstance(name, str) and name:
            names.append(name)
    return sorted(set(names))


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


def create_app(settings: Settings | None = None):
    """Create the pinned Hermes AG-UI runtime with its standard capabilities."""
    settings = settings or settings_from_env()
    prepare_runtime(settings)

    auxiliary_tasks = _standard_auxiliary_tasks()
    _write_runtime_config(settings, auxiliary_tasks)

    from hermes_cli.plugins import get_plugin_auxiliary_tasks

    plugin_tasks = {
        str(entry.get("key") or "").strip()
        for entry in get_plugin_auxiliary_tasks()
        if str(entry.get("key") or "").strip()
    }
    if not plugin_tasks.issubset(auxiliary_tasks):
        auxiliary_tasks.update(plugin_tasks)
        _write_runtime_config(settings, auxiliary_tasks)

    import agui_adapter.server as agui_server
    from agui_adapter.session import AgentConfig
    from model_tools import get_tool_definitions

    config = AgentConfig()
    config.enabled_toolsets = [HERMES_TOOLSET]
    # Hermes names a pinned OpenAI-compatible endpoint "custom". Keep the
    # operator's provider name as metadata, not as a resolver input.
    config.provider = "custom"
    config.model = settings.model
    config.base_url = settings.model_base_url
    config.api_key = settings.model_api_key
    config.api_mode = settings.model_api_mode

    _install_iteration_limit(agui_server, settings.max_iterations)

    tools = _tool_names(
        get_tool_definitions(
            enabled_toolsets=config.enabled_toolsets,
            quiet_mode=True,
            skip_tool_search_assembly=True,
        )
    )

    app = agui_server.create_app(
        config=config,
        session_token=settings.session_token,
        bound_host=settings.host,
    )
    _install_public_host_alias(app, settings.host, settings.public_host)

    @app.get("/ready")
    async def ready() -> dict:
        return {
            "ok": True,
            "service": "newscraft-hermes-chat",
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
            "capabilities": {
                "standard": True,
                "browser": {"browser_navigate", "browser_snapshot"}.issubset(tools),
                "webResearch": "web_search" in tools,
                "terminal": {"terminal", "process"}.issubset(tools),
                "files": {"read_file", "write_file", "patch"}.issubset(tools),
                "codeExecution": "execute_code" in tools,
                "delegation": "delegate_task" in tools,
                "skills": {"skills_list", "skill_view", "skill_manage"}.issubset(tools),
                "memory": "memory" in tools,
            },
        }

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
