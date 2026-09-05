"""Bounded, tenant-scoped artifact acquisition for the durable Hermes worker.

The model supplies only a workspace-relative path and a server-issued revision
identity.  This helper resolves the path beneath the active runtime root with
openat/O_NOFOLLOW, hashes a private staging copy, and sends those bytes to the
server-issued direct-upload grant.  The NewsCraft verifier remains the source
of truth for readiness.
"""

from __future__ import annotations

import asyncio
import base64
import fcntl
import hashlib
import os
import secrets
import stat
from pathlib import Path, PurePosixPath
from typing import Any, Mapping

import httpx

from .isolation import TenantRuntime

MAX_ARTIFACT_BYTES = 20 * 1024 * 1024
CHUNK_BYTES = 1024 * 1024
_SAFE_COMPONENT = frozenset("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-")


class ArtifactPublishError(RuntimeError):
    """A publication attempt was rejected before it could become ready."""


def _write_all(fd: int, chunk: bytes) -> None:
    offset = 0
    while offset < len(chunk):
        written = os.write(fd, chunk[offset:])
        if written <= 0:
            raise ArtifactPublishError("artifact staging write failed")
        offset += written


def _components(path: str, runtime: TenantRuntime) -> list[str]:
    raw = str(path or "").strip()
    if not raw or "\x00" in raw:
        raise ArtifactPublishError("artifact path is invalid")
    # The model sees the active container workspace (normally /workspace),
    # while the worker resolves that virtual path against the tenant's host
    # runtime.workspace. Never accept the host path itself: it is an
    # implementation detail and could name a sibling tenant in a shared host.
    virtual_root = str(runtime.container_workspace or "/workspace").rstrip("/") or "/"
    if raw == virtual_root:
        raise ArtifactPublishError("artifact path must name a file")
    prefix = f"{virtual_root}/" if virtual_root != "/" else "/"
    if raw.startswith(prefix):
        relative = raw[len(prefix):]
    elif not raw.startswith("/"):
        # Relative paths are interpreted by the active runtime, not by the
        # host process cwd. This keeps the tool useful when a backend exposes
        # a different virtual workspace root without exposing host paths.
        relative = raw
    else:
        raise ArtifactPublishError(f"artifact path must be beneath {virtual_root}")
    parts = PurePosixPath(relative).parts
    if not parts or any(part in {"", ".", ".."} or not set(part) <= _SAFE_COMPONENT for part in parts):
        raise ArtifactPublishError("artifact path is invalid")
    return list(parts)


def _open_workspace_file(
    path: str,
    runtime: TenantRuntime,
    *,
    workspace_root: Path | None = None,
) -> tuple[int, os.stat_result]:
    parts = _components(path, runtime)
    root = Path(workspace_root) if workspace_root is not None else runtime.workspace
    if not root.is_absolute() or root.is_symlink():
        raise ArtifactPublishError("artifact workspace root is not private")
    try:
        root_fd = os.open(
            root,
            os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC,
        )
    except OSError as exc:
        raise ArtifactPublishError("artifact workspace root is unavailable") from exc
    fd = root_fd
    try:
        for index, part in enumerate(parts):
            # O_NONBLOCK makes a hostile FIFO fail at the fstat check instead
            # of blocking the worker before it can reject the non-regular
            # file. It is harmless for regular files and is preserved on the
            # descriptor used for the bounded copy.
            flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC
            if index < len(parts) - 1:
                flags |= os.O_DIRECTORY
            try:
                next_fd = os.open(part, flags, dir_fd=fd)
            except OSError as exc:
                raise ArtifactPublishError("artifact path could not be opened safely") from exc
            if fd != root_fd:
                os.close(fd)
            fd = next_fd
        descriptor = os.fstat(fd)
        if not stat.S_ISREG(descriptor.st_mode):
            raise ArtifactPublishError("artifact path is not a regular file")
        if fd != root_fd:
            os.close(root_fd)
        return fd, descriptor
    except BaseException:
        if fd != root_fd:
            os.close(fd)
        os.close(root_fd)
        raise


def stage_workspace_file(
    path: str,
    runtime: TenantRuntime,
    max_bytes: int = MAX_ARTIFACT_BYTES,
    *,
    workspace_root: Path | None = None,
) -> tuple[Path, int, str]:
    """Copy a stable file into a private staging path and return size/hash."""
    if not isinstance(max_bytes, int) or max_bytes < 1 or max_bytes > MAX_ARTIFACT_BYTES:
        raise ArtifactPublishError("artifact byte bound is invalid")
    fd, before = _open_workspace_file(path, runtime, workspace_root=workspace_root)
    staged_fd: int | None = None
    staging_dir_fd: int | None = None
    staged_path: Path | None = None
    try:
        try:
            fcntl.flock(fd, fcntl.LOCK_SH | fcntl.LOCK_NB)
        except OSError:
            # A cooperative lock is useful, but a file that does not support
            # flock is still protected by the post-copy fingerprint check.
            pass
        if before.st_size > max_bytes:
            raise ArtifactPublishError("artifact file is too large")
        # Staging must not be visible to the model's workspace. The tenant
        # Hermes home is private to this account and is outside the mounted
        # model workspace, so a model cannot read or replace a staged upload.
        staging_dir = runtime.hermes_home / "artifact-staging"
        if runtime.hermes_home.is_symlink() or (staging_dir.exists() and staging_dir.is_symlink()):
            raise ArtifactPublishError("artifact staging root is not private")
        staging_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
        staging_dir.chmod(0o700)
        staging_dir_fd = os.open(
            staging_dir,
            os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC,
        )
        for _ in range(8):
            name = f"publish-{secrets.token_hex(12)}"
            try:
                staged_fd = os.open(
                    name,
                    os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
                    0o600,
                    dir_fd=staging_dir_fd,
                )
                staged_path = staging_dir / name
                break
            except FileExistsError:
                continue
        if staged_fd is None or staged_path is None:
            raise ArtifactPublishError("could not allocate a private staging file")
        os.fchmod(staged_fd, 0o600)
        digest = hashlib.sha256()
        total = 0
        while True:
            chunk = os.read(fd, CHUNK_BYTES)
            if not chunk:
                break
            total += len(chunk)
            if total > max_bytes:
                raise ArtifactPublishError("artifact file changed beyond its bound")
            digest.update(chunk)
            _write_all(staged_fd, chunk)
        after = os.fstat(fd)
        # The descriptor pins the original inode, while the full fingerprint
        # catches in-place writes (including writes that preserve byte length)
        # and metadata churn during the copy.
        if (
            after.st_dev != before.st_dev
            or after.st_ino != before.st_ino
            or after.st_size != before.st_size
            or after.st_mtime_ns != before.st_mtime_ns
            or after.st_ctime_ns != before.st_ctime_ns
            or total != before.st_size
        ):
            raise ArtifactPublishError("artifact file changed during publication")
        os.fsync(staged_fd)
        return staged_path, total, digest.hexdigest()
    except BaseException:
        if staged_path is not None:
            try:
                staged_path.unlink(missing_ok=True)
            except OSError:
                pass
        raise
    finally:
        if staged_fd is not None:
            os.close(staged_fd)
        if staging_dir_fd is not None:
            os.close(staging_dir_fd)
        os.close(fd)


def _stage_backend_bytes(payload: bytes, runtime: TenantRuntime, max_bytes: int) -> tuple[Path, int, str]:
    """Stage bytes read through a non-host Hermes backend.

    Docker tmpfs, SSH, and other remote backends do not expose a trustworthy
    host path.  The backend's binary file API is therefore the source of
    bytes, while the same private staging directory and immutable upload
    checks used by host-mounted workspaces remain the source of the grant
    payload.
    """
    if not isinstance(max_bytes, int) or isinstance(max_bytes, bool) or max_bytes < 1 or max_bytes > MAX_ARTIFACT_BYTES:
        raise ArtifactPublishError("artifact byte bound is invalid")
    if len(payload) < 1 or len(payload) > max_bytes:
        raise ArtifactPublishError("artifact file is too large")
    staging_dir = runtime.hermes_home / "artifact-staging"
    if runtime.hermes_home.is_symlink() or (staging_dir.exists() and staging_dir.is_symlink()):
        raise ArtifactPublishError("artifact staging root is not private")
    staging_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    staging_dir.chmod(0o700)
    staging_dir_fd = os.open(
        staging_dir,
        os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC,
    )
    staged_fd: int | None = None
    staged_path: Path | None = None
    try:
        for _ in range(8):
            name = f"publish-{secrets.token_hex(12)}"
            try:
                staged_fd = os.open(
                    name,
                    os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
                    0o600,
                    dir_fd=staging_dir_fd,
                )
                staged_path = staging_dir / name
                break
            except FileExistsError:
                continue
        if staged_fd is None or staged_path is None:
            raise ArtifactPublishError("could not allocate a private staging file")
        os.fchmod(staged_fd, 0o600)
        _write_all(staged_fd, payload)
        os.fsync(staged_fd)
        return staged_path, len(payload), hashlib.sha256(payload).hexdigest()
    except BaseException:
        if staged_path is not None:
            try:
                staged_path.unlink(missing_ok=True)
            except OSError:
                pass
        raise
    finally:
        if staged_fd is not None:
            os.close(staged_fd)
        os.close(staging_dir_fd)


def stage_backend_file(
    file_ops: Any,
    path: str,
    runtime: TenantRuntime,
    max_bytes: int = MAX_ARTIFACT_BYTES,
) -> tuple[Path, int, str]:
    """Read a virtual workspace file through Hermes and stage exact bytes."""
    if not hasattr(file_ops, "read_file_bytes"):
        raise ArtifactPublishError("artifact runtime backend cannot read binary files")
    try:
        result = file_ops.read_file_bytes(path, max_bytes=max_bytes)
    except Exception as exc:  # noqa: BLE001 - backend-specific errors are opaque
        raise ArtifactPublishError("artifact runtime file could not be read") from exc
    error = result.get("error") if isinstance(result, Mapping) else getattr(result, "error", None)
    if error:
        raise ArtifactPublishError("artifact runtime file could not be read")
    raw_size = result.get("file_size") if isinstance(result, Mapping) else getattr(result, "file_size", None)
    encoded = result.get("base64_content") if isinstance(result, Mapping) else getattr(result, "base64_content", None)
    if isinstance(raw_size, bool) or not isinstance(raw_size, int) or raw_size < 1 or raw_size > max_bytes:
        raise ArtifactPublishError("artifact runtime file size is invalid")
    if not isinstance(encoded, str) or not encoded:
        raise ArtifactPublishError("artifact runtime file bytes are unavailable")
    try:
        payload = base64.b64decode("".join(encoded.split()), validate=True)
    except (ValueError, base64.binascii.Error) as exc:
        raise ArtifactPublishError("artifact runtime file bytes are invalid") from exc
    if len(payload) != raw_size:
        raise ArtifactPublishError("artifact runtime file changed during publication")
    return _stage_backend_bytes(payload, runtime, max_bytes)


def _active_backend_for_task(task_id: str) -> tuple[Any, Any | None]:
    """Return the active Hermes environment and optional file operations."""
    try:
        from tools.terminal_tool import get_active_env
        from tools.file_tools import _get_file_ops
    except ImportError as exc:
        raise ArtifactPublishError("artifact runtime backend is unavailable") from exc
    try:
        environment = get_active_env(task_id)
        file_ops = None
        if environment is None:
            # A model can publish immediately after a non-terminal tool has
            # selected the task.  Bring up the configured backend through the
            # pinned file-tool path instead of falling back to host cwd.
            file_ops = _get_file_ops(task_id)
            environment = getattr(file_ops, "env", None) or get_active_env(task_id)
        if environment is None:
            raise ArtifactPublishError("artifact runtime backend is unavailable")
        return environment, file_ops
    except ArtifactPublishError:
        raise
    except Exception as exc:  # noqa: BLE001 - backend-specific errors are opaque
        raise ArtifactPublishError("artifact runtime backend is unavailable") from exc


async def upload_staged_file(
    client: httpx.AsyncClient,
    staged_path: Path,
    upload_url: str,
    *,
    mime_type: str,
    size: int,
    checksum_sha256: str,
) -> Mapping[str, Any]:
    """PUT exact bytes to the server-issued grant without exposing local paths."""
    if isinstance(size, bool) or not isinstance(size, int) or size < 1 or size > MAX_ARTIFACT_BYTES:
        raise ArtifactPublishError("staged artifact size is invalid")
    if not isinstance(checksum_sha256, str):
        raise ArtifactPublishError("staged artifact checksum is invalid")
    if len(checksum_sha256) != 64 or any(char not in "0123456789abcdefABCDEF" for char in checksum_sha256):
        raise ArtifactPublishError("staged artifact checksum is invalid")
    try:
        # httpx.AsyncClient requires an async byte stream (or bytes); passing
        # a synchronous file object makes the transport attempt async reads
        # and fails at runtime. The staged file is bounded to 20 MiB, so a
        # thread-offloaded read keeps the event loop responsive while giving
        # httpx an explicit immutable byte payload.
        payload = await asyncio.to_thread(staged_path.read_bytes)
        if len(payload) != size:
            raise ArtifactPublishError("staged artifact length changed before upload")
        if hashlib.sha256(payload).hexdigest().lower() != checksum_sha256.lower():
            raise ArtifactPublishError("staged artifact checksum changed before upload")
        response = await client.put(
            upload_url,
            headers={
                "content-type": mime_type,
                "content-length": str(size),
                "x-content-sha256": checksum_sha256,
            },
            content=payload,
        )
    finally:
        staged_path.unlink(missing_ok=True)
    if response.status_code >= 400:
        raise ArtifactPublishError(f"artifact upload rejected ({response.status_code})")
    value = response.json()
    if not isinstance(value, dict) or not isinstance(value.get("object_version"), str):
        raise ArtifactPublishError("artifact upload response is invalid")
    return value


async def publish_workspace_file(
    *,
    client: httpx.AsyncClient,
    runtime: TenantRuntime,
    path: str,
    grant: Mapping[str, Any],
    mime_type: str,
    size: int,
    checksum_sha256: str,
    task_id: str | None = None,
) -> Mapping[str, Any]:
    """Validate a staged grant response and upload one exact file."""
    upload_url = grant.get("upload_url")
    grant_max = grant.get("max_bytes")
    if not isinstance(upload_url, str) or not upload_url.startswith(("http://", "https://")):
        raise ArtifactPublishError("artifact upload grant is invalid")
    if isinstance(size, bool) or not isinstance(size, int) or size < 1 or size > MAX_ARTIFACT_BYTES:
        raise ArtifactPublishError("artifact size is invalid")
    if not isinstance(checksum_sha256, str) or len(checksum_sha256) != 64 or any(char not in "0123456789abcdefABCDEF" for char in checksum_sha256):
        raise ArtifactPublishError("artifact checksum is invalid")
    if isinstance(grant_max, bool) or not isinstance(grant_max, int) or grant_max < 1 or grant_max > MAX_ARTIFACT_BYTES or size > grant_max:
        raise ArtifactPublishError("artifact exceeds its upload grant")
    if task_id:
        environment, file_ops = _active_backend_for_task(task_id)
        host_workspace = getattr(environment, "_workspace_dir", None)
        environment_name = type(environment).__name__.lower()
        if isinstance(host_workspace, str) and host_workspace:
            # Persistent Docker exposes its /workspace bind mount through this
            # private host path. The virtual path is still validated by
            # _components and every component is opened with O_NOFOLLOW.
            root = Path(host_workspace)
            staged_path, staged_size, staged_hash = await asyncio.to_thread(
                stage_workspace_file,
                path,
                runtime,
                grant_max,
                workspace_root=root,
            )
        elif "local" in environment_name:
            staged_path, staged_size, staged_hash = await asyncio.to_thread(
                stage_workspace_file,
                path,
                runtime,
                grant_max,
            )
        else:
            if file_ops is None:
                try:
                    from tools.file_tools import _get_file_ops
                    file_ops = _get_file_ops(task_id)
                except Exception as exc:  # noqa: BLE001 - backend-specific errors are opaque
                    raise ArtifactPublishError("artifact runtime backend cannot read binary files") from exc
            staged_path, staged_size, staged_hash = await asyncio.to_thread(
                stage_backend_file,
                file_ops,
                path,
                runtime,
                grant_max,
            )
    else:
        # Direct unit callers may supply an already-resolved local runtime;
        # production worker calls always provide task_id and therefore resolve
        # the active Hermes backend above.
        staged_path, staged_size, staged_hash = await asyncio.to_thread(stage_workspace_file, path, runtime, grant_max)
    if staged_size != size or staged_hash != checksum_sha256:
        staged_path.unlink(missing_ok=True)
        raise ArtifactPublishError("artifact fingerprint changed before upload")
    return await upload_staged_file(client, staged_path, upload_url, mime_type=mime_type, size=size, checksum_sha256=checksum_sha256)
