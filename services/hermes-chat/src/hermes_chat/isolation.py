"""Account isolation for the shared NewsCraft Hermes service.

The authenticated NewsCraft server sends an opaque tenant key. This module
turns that key into private state roots and binds the full Hermes run to those
roots without changing process-global environment variables per request.
"""

from __future__ import annotations

import contextlib
import contextvars
import posixpath
import re
import threading
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any, Callable, Iterator, Mapping

TENANT_HEADER = "x-newscraft-tenant-key"
_TENANT_KEY_RE = re.compile(r"^[A-Za-z0-9_-]{8,128}$")
_FILE_TOOL_NAMES = frozenset({"read_file", "write_file", "patch", "search_files"})
_WORKDIR_TOOL_NAMES = frozenset({"terminal", "cronjob"})
_PATH_ARGUMENT_NAMES = frozenset({"path", "file_path", "directory", "root", "cwd"})
_PROFILE_ARGUMENT_NAMES = frozenset(
    {
        "profile",
        "profile_name",
        "profiles",
        "hermes_home",
        "home",
        "tenant",
        "tenant_key",
        "browser_profile",
        "profile_path",
        "session_name",
        "cross_profile",
        # These are Hermes infrastructure selectors. They are supplied by
        # the service wrapper and must never be chosen by the model.
        "task_id",
        "session_key",
        "ui_session_id",
        "thread_id",
        "run_id",
        "user_id",
    }
)


class TenantIsolationError(ValueError):
    """Raised when a request cannot be bound to one account scope."""


@dataclass(frozen=True)
class TenantRuntime:
    """All state names used by one NewsCraft account."""

    key: str
    hermes_home: Path
    workspace: Path
    browser_profile: Path
    profile_name: str
    task_key: str
    container_workspace: str = "/workspace"


@dataclass(frozen=True)
class TenantRun:
    runtime: TenantRuntime
    thread_id: str
    run_id: str


_CURRENT_TENANT_RUN: contextvars.ContextVar[TenantRun | None] = contextvars.ContextVar(
    "newscraft_tenant_run", default=None
)


def _private_root(path: Path) -> Path:
    candidate = Path(path).expanduser()
    if candidate.is_symlink():
        raise TenantIsolationError("Tenant state roots must not be symlinks")
    resolved = candidate.resolve()
    if resolved in {Path("/"), Path.home().resolve()}:
        raise TenantIsolationError("Tenant state roots must be dedicated subdirectories")
    return resolved


def _ensure_private_directory(path: Path) -> Path:
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    if path.is_symlink():
        raise TenantIsolationError(f"Tenant state path must not be a symlink: {path}")
    path.chmod(0o700)
    return path


def _safe_tenant_child(root: Path, key: str) -> Path:
    target = root / key
    if target.is_symlink():
        raise TenantIsolationError("Tenant state path must not be a symlink")
    try:
        resolved = target.resolve(strict=False)
        if not resolved.is_relative_to(root.resolve()):
            raise TenantIsolationError("Tenant state path escaped its private root")
    except OSError as exc:
        raise TenantIsolationError("Tenant state path could not be resolved") from exc
    return resolved


class TenantIsolation:
    """Resolve and prepare account-local Hermes state directories."""

    def __init__(self, hermes_home_root: Path, workspace_root: Path) -> None:
        self.hermes_home_root = _private_root(hermes_home_root)
        self.workspace_root = _private_root(workspace_root)
        if (
            self.hermes_home_root == self.workspace_root
            or self.hermes_home_root.is_relative_to(self.workspace_root)
            or self.workspace_root.is_relative_to(self.hermes_home_root)
        ):
            raise TenantIsolationError("Tenant home and workspace roots must be separate")
        self._locks_guard = threading.Lock()
        self._locks: dict[str, threading.RLock] = {}

    def resolve(self, tenant_key: str) -> TenantRuntime:
        key = str(tenant_key or "").strip()
        if not _TENANT_KEY_RE.fullmatch(key):
            raise TenantIsolationError("Hermes tenant key is missing or invalid")

        home_root = self.hermes_home_root / "tenants"
        workspace_root = self.workspace_root / "tenants"
        home = _safe_tenant_child(home_root, key)
        workspace = _safe_tenant_child(workspace_root, key)
        return TenantRuntime(
            key=key,
            hermes_home=home,
            workspace=workspace,
            browser_profile=home / "browser-profile",
            profile_name=f"newscraft-{key}",
            task_key=f"newscraft-{key}",
        )

    def ensure(self, runtime: TenantRuntime) -> TenantRuntime:
        """Create only private account directories and their normal state areas."""
        if runtime.key != runtime.profile_name.removeprefix("newscraft-"):
            raise TenantIsolationError("Tenant runtime identity is inconsistent")
        expected = self.resolve(runtime.key)
        if runtime != expected:
            raise TenantIsolationError("Tenant runtime paths are not owned by this service")

        for root in (self.hermes_home_root, self.workspace_root):
            _ensure_private_directory(root)
            _ensure_private_directory(root / "tenants")
        _ensure_private_directory(runtime.hermes_home)
        _ensure_private_directory(runtime.workspace)
        _ensure_private_directory(runtime.browser_profile)
        _ensure_private_directory(runtime.browser_profile / "config")
        _ensure_private_directory(runtime.workspace / ".tmp")
        for name in ("skills", "plugins", "cron", "memories", "cache"):
            _ensure_private_directory(runtime.hermes_home / name)
        return runtime

    @contextlib.contextmanager
    def initialization_lock(self, runtime: TenantRuntime) -> Iterator[None]:
        with self._locks_guard:
            lock = self._locks.setdefault(runtime.key, threading.RLock())
        with lock:
            yield

    def tenant_from_headers(self, headers: Mapping[str, Any]) -> str:
        matches = [value for name, value in headers.items() if str(name).lower() == TENANT_HEADER]
        if len(matches) != 1:
            raise TenantIsolationError("Hermes request must contain one NewsCraft tenant key")
        key = str(matches[0] or "").strip()
        if not _TENANT_KEY_RE.fullmatch(key):
            raise TenantIsolationError("Hermes request has no valid NewsCraft tenant key")
        return key

    def guard_tool_arguments(self, function_name: str, arguments: Mapping[str, Any]) -> dict[str, Any]:
        return guard_tool_arguments(function_name, arguments, current_tenant_run())


def current_tenant_run() -> TenantRun | None:
    return _CURRENT_TENANT_RUN.get()


def current_tenant() -> TenantRuntime | None:
    run = current_tenant_run()
    return run.runtime if run else None


def _validate_scoped_path(value: str, runtime: TenantRuntime) -> None:
    raw = value.strip()
    container_raw = "/root" + raw[1:] if raw == "~" or raw.startswith("~/") else raw

    # Tenant roots can live under /tmp in local and staging harnesses. Check
    # host paths before accepting the Docker namespace's /tmp path, or a model
    # could name a sibling tenant's host workspace and bypass this guard.
    candidate = Path(raw).expanduser()
    if candidate.is_absolute():
        try:
            resolved = candidate.resolve(strict=False)
            if resolved.is_relative_to(runtime.hermes_home) or resolved.is_relative_to(runtime.workspace):
                return
            tenant_roots = (runtime.hermes_home.parent, runtime.workspace.parent)
            if any(
                resolved == root or resolved.is_relative_to(root)
                for root in tenant_roots
            ):
                raise TenantIsolationError(
                    "Hermes file tools may access only the active account scope"
                )
        except OSError as exc:
            raise TenantIsolationError("Hermes path could not be resolved") from exc

    container_candidate = PurePosixPath(posixpath.normpath(container_raw))
    container_roots = (
        PurePosixPath(runtime.container_workspace),
        PurePosixPath("/root"),
        PurePosixPath("/tmp"),
    )
    if any(
        container_candidate == root or root in container_candidate.parents
        for root in container_roots
    ):
        return

    if not candidate.is_absolute():
        return
    try:
        resolved = candidate.resolve(strict=False)
        allowed = resolved.is_relative_to(runtime.hermes_home) or resolved.is_relative_to(runtime.workspace)
    except OSError:
        allowed = False
    if not allowed:
        raise TenantIsolationError("Hermes file tools may access only the active account scope")


def guard_tool_arguments(
    function_name: str,
    arguments: Mapping[str, Any] | None,
    run: TenantRun | None = None,
) -> dict[str, Any]:
    """Reject model-selected profile/path selectors that could cross accounts."""
    safe_arguments = dict(arguments or {})
    selected = sorted(_PROFILE_ARGUMENT_NAMES.intersection(safe_arguments))
    if selected:
        raise TenantIsolationError("Hermes tools cannot select another account profile")
    if function_name == "session_search":
        session_id = safe_arguments.get("session_id")
        if isinstance(session_id, str) and ("/" in session_id or "@session:" in session_id):
            raise TenantIsolationError("session_search cannot select a profile in session_id")

    if run is not None and function_name in _FILE_TOOL_NAMES:
        for name in _PATH_ARGUMENT_NAMES:
            value = safe_arguments.get(name)
            if isinstance(value, str) and value.strip():
                _validate_scoped_path(value, run.runtime)
    if run is not None and function_name in _WORKDIR_TOOL_NAMES:
        workdir = safe_arguments.get("workdir")
        if isinstance(workdir, str) and workdir.strip():
            if function_name == "cronjob" and not workdir.strip().startswith("/"):
                raise TenantIsolationError("Cron workdir must be an absolute scoped path")
            _validate_scoped_path(workdir, run.runtime)
    return safe_arguments


@contextlib.contextmanager
def _hermes_home_scope(path: Path) -> Iterator[None]:
    try:
        from hermes_constants import reset_hermes_home_override, set_hermes_home_override
    except ImportError as exc:
        raise TenantIsolationError("Pinned Hermes does not provide context-local HERMES_HOME") from exc

    token = set_hermes_home_override(str(path))
    try:
        yield
    finally:
        reset_hermes_home_override(token)


@contextlib.contextmanager
def _session_scope(run: TenantRun) -> Iterator[None]:
    try:
        from gateway import session_context
    except ImportError as exc:
        raise TenantIsolationError("Pinned Hermes does not provide session context") from exc

    session_tokens = session_context.set_session_vars(
        platform="agui",
        source="newscraft",
        user_id=run.runtime.key,
        thread_id=run.thread_id,
        session_key=run.runtime.task_key,
        session_id=run.thread_id or run.runtime.task_key,
        profile=run.runtime.profile_name,
        cwd=run.runtime.container_workspace,
        ui_session_id=run.run_id,
        async_delivery=False,
    )
    try:
        yield
    finally:
        clear_session_vars = getattr(session_context, "clear_session_vars", None)
        if clear_session_vars is not None:
            clear_session_vars(session_tokens)


@contextlib.contextmanager
def tenant_run_scope(
    runtime: TenantRuntime,
    *,
    thread_id: str,
    run_id: str,
    home_override: Callable[[Path], Any] | Any | None = None,
    session_scope: Callable[[TenantRun], Any] | Any | None = None,
) -> Iterator[TenantRun]:
    """Bind a complete AG-UI run to one tenant in the current execution context."""
    run = TenantRun(runtime=runtime, thread_id=str(thread_id or ""), run_id=str(run_id or ""))
    token = _CURRENT_TENANT_RUN.set(run)
    home_manager = home_override(runtime.hermes_home) if callable(home_override) else home_override
    session_manager = session_scope(run) if callable(session_scope) else session_scope
    try:
        with (home_manager or _hermes_home_scope(runtime.hermes_home)):
            with (session_manager or _session_scope(run)):
                yield run
    finally:
        _CURRENT_TENANT_RUN.reset(token)
