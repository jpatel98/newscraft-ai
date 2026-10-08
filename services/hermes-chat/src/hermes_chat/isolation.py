"""Server-owned tenant and conversation identities for the research agent.

``hermes_home`` is retained as an internal staging-field name for the existing
artifact publisher. It is never exposed or mounted into the computer sandbox.
"""
from __future__ import annotations

import contextlib
import contextvars
import hashlib
import os
import re
import threading
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any, Callable, Iterator, Mapping

TENANT_HEADER = "x-newscraft-tenant-key"
_TENANT_KEY_RE = re.compile(r"^[A-Za-z0-9_-]{8,128}$")
_PROFILE_ARGUMENT_NAMES = frozenset({
    "profile", "profile_name", "profiles", "hermes_home", "home", "tenant",
    "tenant_key", "browser_profile", "profile_path", "session_name",
    "cross_profile", "task_id", "session_key", "ui_session_id", "thread_id",
    "run_id", "user_id", "conversation_id", "container", "image", "mounts",
    "environment", "env", "network",
})


class TenantIsolationError(ValueError):
    """A request attempted to leave its server-owned account scope."""


@dataclass(frozen=True)
class TenantRuntime:
    key: str
    hermes_home: Path
    workspace: Path
    browser_profile: Path
    profile_name: str
    task_key: str
    container_workspace: str = "/workspace"
    conversation_id: str | None = None


@dataclass(frozen=True)
class TenantRun:
    runtime: TenantRuntime
    thread_id: str
    run_id: str


_CURRENT_TENANT_RUN: contextvars.ContextVar[TenantRun | None] = contextvars.ContextVar(
    "newscraft_tenant_run", default=None
)


def _no_symlink_components(path: Path) -> None:
    for component in (path, *path.parents):
        if component.is_symlink():
            raise TenantIsolationError("State directories must not contain symlinks")


def _private_root(path: Path) -> Path:
    candidate = Path(path).expanduser().absolute()
    _no_symlink_components(candidate)
    resolved = candidate.resolve()
    if resolved in {Path("/"), Path.home().resolve()}:
        raise TenantIsolationError("State roots must be dedicated subdirectories")
    return resolved


def _ensure_private_directory(path: Path) -> Path:
    # Descriptor-relative traversal keeps mkdir/chmod bound to the validated
    # inode even if a terminal background process swaps a workspace child.
    fd = os.open("/", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        for component in path.parts[1:]:
            try:
                os.mkdir(component, mode=0o700, dir_fd=fd)
            except FileExistsError:
                pass
            next_fd = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=fd)
            os.close(fd)
            fd = next_fd
        os.fchmod(fd, 0o700)
    except OSError as exc:
        raise TenantIsolationError("Private directory could not be initialized safely") from exc
    finally:
        os.close(fd)
    return path


def _safe_child(root: Path, *parts: str) -> Path:
    target = root.joinpath(*parts)
    _no_symlink_components(target)
    resolved = target.resolve(strict=False)
    if not resolved.is_relative_to(root.resolve()):
        raise TenantIsolationError("State path escaped its private root")
    return resolved


def conversation_identity(value: str) -> str:
    if not isinstance(value, str) or not value or len(value) > 256 or any(ord(c) < 32 for c in value):
        raise TenantIsolationError("Conversation identity is missing or invalid")
    return hashlib.sha256(value.encode("utf-8")).hexdigest()[:32]


def workspace_path(value: Any) -> str:
    """Accept only virtual workspace paths, never host paths or traversal."""
    if not isinstance(value, str) or not value or "\x00" in value or "\\" in value:
        raise TenantIsolationError("Workspace path is invalid")
    if value == "/workspace":
        return value
    relative = value.removeprefix("/workspace/")
    if relative.startswith("/") or value.startswith("~"):
        raise TenantIsolationError("Paths must be beneath /workspace")
    parts = relative.split("/")
    if any(part in {"", ".", ".."} for part in parts):
        raise TenantIsolationError("Workspace path must not contain traversal")
    return str(PurePosixPath("/workspace", *parts))


class TenantIsolation:
    """Resolve persisted files per conversation and private server staging."""

    def __init__(self, hermes_home_root: Path, workspace_root: Path) -> None:
        self.hermes_home_root = _private_root(hermes_home_root)
        self.workspace_root = _private_root(workspace_root)
        if (self.hermes_home_root == self.workspace_root
                or self.hermes_home_root.is_relative_to(self.workspace_root)
                or self.workspace_root.is_relative_to(self.hermes_home_root)):
            raise TenantIsolationError("State and workspace roots must be separate")
        self._locks_guard = threading.Lock()
        self._locks: dict[str, threading.RLock] = {}

    def resolve(self, tenant_key: str, conversation_id: str | None = None) -> TenantRuntime:
        key = str(tenant_key or "").strip()
        if not _TENANT_KEY_RE.fullmatch(key):
            raise TenantIsolationError("NewsCraft tenant key is missing or invalid")
        identity = conversation_identity(conversation_id) if conversation_id is not None else None
        suffix = ("conversations", identity) if identity else ()
        home = _safe_child(self.hermes_home_root, "tenants", key, *suffix)
        workspace = _safe_child(self.workspace_root, "tenants", key, *suffix)
        scope = hashlib.sha256(f"{key}\x00{conversation_id or ''}".encode()).hexdigest()[:32]
        return TenantRuntime(
            key=key, hermes_home=home, workspace=workspace,
            browser_profile=workspace / ".browser" / "profile",
            profile_name=f"newscraft-{scope}", task_key=f"newscraft-{scope}",
            conversation_id=conversation_id,
        )

    def ensure(self, runtime: TenantRuntime, *, computer_state: bool = True) -> TenantRuntime:
        if runtime != self.resolve(runtime.key, runtime.conversation_id):
            raise TenantIsolationError("Runtime paths are not owned by this service")
        for root, leaf in ((self.hermes_home_root, runtime.hermes_home), (self.workspace_root, runtime.workspace)):
            for directory in reversed((leaf, *leaf.parents)):
                if directory == root or directory.is_relative_to(root):
                    _ensure_private_directory(directory)
        if computer_state:
            for path in (runtime.workspace / ".tmp", runtime.workspace / ".browser", runtime.browser_profile):
                _ensure_private_directory(path)
        return runtime

    @contextlib.contextmanager
    def initialization_lock(self, runtime: TenantRuntime) -> Iterator[None]:
        with self._locks_guard:
            lock = self._locks.setdefault(runtime.task_key, threading.RLock())
        with lock:
            yield

    def tenant_from_headers(self, headers: Mapping[str, Any]) -> str:
        matches = [value for name, value in headers.items() if str(name).lower() == TENANT_HEADER]
        if len(matches) != 1:
            raise TenantIsolationError("Request must contain one NewsCraft tenant key")
        key = str(matches[0] or "").strip()
        if not _TENANT_KEY_RE.fullmatch(key):
            raise TenantIsolationError("Request has no valid NewsCraft tenant key")
        return key

    def guard_tool_arguments(self, function_name: str, arguments: Mapping[str, Any]) -> dict[str, Any]:
        return guard_tool_arguments(function_name, arguments, current_tenant_run())


def current_tenant_run() -> TenantRun | None:
    return _CURRENT_TENANT_RUN.get()


def current_tenant() -> TenantRuntime | None:
    run = current_tenant_run()
    return run.runtime if run else None


def guard_tool_arguments(function_name: str, arguments: Mapping[str, Any] | None, run: TenantRun | None = None) -> dict[str, Any]:
    safe = dict(arguments or {})
    if _PROFILE_ARGUMENT_NAMES.intersection(safe):
        raise TenantIsolationError("Tools cannot select account, container, or profile settings")
    for name in ("path", "file_path", "directory", "root", "cwd", "workdir"):
        if name in safe and safe[name] is not None:
            safe[name] = workspace_path(safe[name])
    return safe


@contextlib.contextmanager
def tenant_run_scope(
    runtime: TenantRuntime, *, thread_id: str, run_id: str,
    home_override: Callable[[Path], Any] | Any | None = None,
    session_scope: Callable[[TenantRun], Any] | Any | None = None,
) -> Iterator[TenantRun]:
    """Bind identity through contextvars without Hermes or global env changes."""
    if runtime.conversation_id is not None and runtime.conversation_id != thread_id:
        raise TenantIsolationError("Run conversation does not match its workspace")
    run = TenantRun(runtime, str(thread_id or ""), str(run_id or ""))
    token = _CURRENT_TENANT_RUN.set(run)
    home_manager = home_override(runtime.hermes_home) if callable(home_override) else home_override
    session_manager = session_scope(run) if callable(session_scope) else session_scope
    try:
        with home_manager or contextlib.nullcontext():
            with session_manager or contextlib.nullcontext():
                yield run
    finally:
        _CURRENT_TENANT_RUN.reset(token)
