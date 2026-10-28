"""Pin computer access to an existing rootful Docker daemon on this host.

The host proves workspace quotas before a bind mount. A remote daemon, Docker
Desktop VM, rootless daemon or transport proxy would invalidate that proof.
Admission is read-only: no Docker API request, daemon startup or permission
change occurs here. Unsupported or unreadable host metadata fails closed.
"""
from __future__ import annotations

import asyncio
import os
import platform
import socket
import stat
import struct
import tempfile
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator


CONNECT_TIMEOUT_SECONDS = 0.5
DEFAULT_DOCKER_SOCKET = "/run/docker.sock"
DEFAULT_DAEMON_EXECUTABLE = "/usr/bin/dockerd"
_ACTIVE_CONFIGS: dict[str, tuple[int, int, int, int, int, int]] = {}


class DockerBoundaryError(RuntimeError):
    """The existing Docker daemon cannot prove the host filesystem boundary."""


def _canonical_path(raw: str, name: str, *, socket_path: bool = False) -> Path:
    if (not raw or "\x00" in raw or not raw.startswith("/") or raw == "/"
            or os.path.normpath(raw) != raw or raw.startswith("//")
            or (socket_path and len(os.fsencode(raw)) > 107)):
        raise DockerBoundaryError(f"{name} must be an absolute canonical local path")
    return Path(raw)


def _trusted_directory(info: os.stat_result) -> None:
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
        raise DockerBoundaryError("Docker boundary paths require root-owned directories without group or other write access")


def _open_trusted_parent(path: Path) -> int:
    """Hold a directory fd and reject links in every pathname component."""
    descriptor = os.open("/", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        _trusted_directory(os.fstat(descriptor))
        for component in path.parts[1:-1]:
            child = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC,
                            dir_fd=descriptor)
            os.close(descriptor)
            descriptor = child
            _trusted_directory(os.fstat(descriptor))
        return descriptor
    except BaseException:
        os.close(descriptor)
        raise


def _identity(info: os.stat_result) -> tuple[int, int, int, int, int, int]:
    return (info.st_dev, info.st_ino, info.st_mode, info.st_uid, info.st_gid, info.st_ctime_ns)


def _socket_info(parent: int, path: Path) -> os.stat_result:
    info = os.stat(path.name, dir_fd=parent, follow_symlinks=False)
    # The existing Docker group may communicate with the socket. It cannot
    # replace the pathname because every parent rejects non-root writers.
    if not stat.S_ISSOCK(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o002:
        raise DockerBoundaryError("Docker requires an existing root-owned Unix socket without public write access")
    return info


def _daemon_info(info: os.stat_result) -> None:
    if (not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022
            or not info.st_mode & 0o111):
        raise DockerBoundaryError("Docker requires the exact configured root-owned, non-writable daemon executable")


def verify_local_docker_socket() -> str:
    """Return a verified Unix socket path; never choose a Docker CLI context.

    Linux SO_PEERCRED identifies the listening process. The configured daemon
    executable, mount namespace and filesystem root must match that process exactly. Procfs
    metadata may require an operator-approved read-only deployment setting;
    inability to inspect it does not weaken this check.
    """
    if platform.system() != "Linux":
        raise DockerBoundaryError("Computer access requires an existing local rootful Linux Docker daemon in the service mount namespace")
    if not hasattr(socket, "AF_UNIX") or not hasattr(socket, "SO_PEERCRED"):
        raise DockerBoundaryError("Docker peer credentials are unavailable on this host")
    socket_path = _canonical_path(os.environ.get("NEWSCRAFT_DOCKER_SOCKET", DEFAULT_DOCKER_SOCKET),
                                  "NEWSCRAFT_DOCKER_SOCKET", socket_path=True)
    executable = _canonical_path(os.environ.get("NEWSCRAFT_DOCKER_DAEMON_EXECUTABLE", DEFAULT_DAEMON_EXECUTABLE),
                                 "NEWSCRAFT_DOCKER_DAEMON_EXECUTABLE")
    socket_parent = executable_parent = executable_fd = None
    client = None
    try:
        socket_parent = _open_trusted_parent(socket_path)
        before = _socket_info(socket_parent, socket_path)
        executable_parent = _open_trusted_parent(executable)
        configured = os.stat(executable.name, dir_fd=executable_parent, follow_symlinks=False)
        _daemon_info(configured)
        executable_fd = os.open(executable.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC,
                                dir_fd=executable_parent)
        opened = os.fstat(executable_fd)
        _daemon_info(opened)
        if _identity(configured) != _identity(opened):
            raise DockerBoundaryError("Configured Docker daemon executable changed during inspection")

        client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        client.settimeout(CONNECT_TIMEOUT_SECONDS)
        client.connect(str(socket_path))
        credentials = client.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize("3i"))
        if len(credentials) != struct.calcsize("3i"):
            raise DockerBoundaryError("Docker socket returned invalid peer credentials")
        pid, uid, _gid = struct.unpack("3i", credentials)
        if pid <= 0 or uid != 0:
            raise DockerBoundaryError("Docker socket peer must be the existing rootful daemon")
        peer_executable = f"/proc/{pid}/exe"
        # Following these procfs links is intentional: the kernel identifies
        # the peer's executable and namespace, rather than trusting a basename.
        if os.readlink(peer_executable) != str(executable):
            raise DockerBoundaryError("Docker socket peer is not the configured daemon executable")
        running = os.stat(peer_executable)
        _daemon_info(running)
        if (running.st_dev, running.st_ino) != (opened.st_dev, opened.st_ino):
            raise DockerBoundaryError("Docker socket peer executable identity does not match the configured daemon")
        ours = os.stat("/proc/self/ns/mnt")
        theirs = os.stat(f"/proc/{pid}/ns/mnt")
        if (ours.st_dev, ours.st_ino) != (theirs.st_dev, theirs.st_ino):
            raise DockerBoundaryError("Docker daemon must share the service mount namespace to preserve the workspace quota proof")
        our_root = os.stat("/proc/self/root")
        peer_root = os.stat(f"/proc/{pid}/root")
        if (our_root.st_dev, our_root.st_ino) != (peer_root.st_dev, peer_root.st_ino):
            raise DockerBoundaryError("Docker daemon must share the service filesystem root to preserve the workspace quota proof")
        if (_identity(before) != _identity(_socket_info(socket_parent, socket_path))
                or _identity(opened) != _identity(os.stat(executable.name, dir_fd=executable_parent, follow_symlinks=False))):
            raise DockerBoundaryError("Docker socket or executable changed during inspection")
        return str(socket_path)
    except DockerBoundaryError:
        raise
    except (OSError, ValueError, struct.error):
        raise DockerBoundaryError("The local Docker boundary could not be verified; the existing socket, daemon executable and read-only procfs metadata must be accessible") from None
    finally:
        if client is not None:
            client.close()
        for descriptor in (executable_fd, executable_parent, socket_parent):
            if descriptor is not None:
                os.close(descriptor)


@contextmanager
def empty_docker_config() -> Iterator[Path]:
    """Keep a private, empty CLI configuration alive for a subprocess lifetime.

    An explicit config directory prevents Docker from reading a user's ambient
    credentials, contexts, plugins or proxy settings. Use the host's fixed
    temporary directory rather than an environment-selected TMPDIR that could
    point inside a model-visible workspace.
    """
    try:
        base = Path("/tmp").resolve(strict=True)
        parent = base.stat()
    except OSError:
        raise DockerBoundaryError("Docker CLI configuration requires an accessible host temporary directory") from None
    if (not stat.S_ISDIR(parent.st_mode) or parent.st_uid != 0
            or (parent.st_mode & 0o022 and not parent.st_mode & stat.S_ISVTX)):
        raise DockerBoundaryError("Docker CLI configuration requires a trusted host temporary directory")
    with tempfile.TemporaryDirectory(prefix="newscraft-docker-cli-", dir=base) as directory:
        path = Path(directory)
        current = path.lstat()
        if (not stat.S_ISDIR(current.st_mode) or current.st_uid != os.getuid()
                or stat.S_IMODE(current.st_mode) != 0o700):
            raise DockerBoundaryError("Docker CLI configuration requires a private host temporary directory")
        _ACTIVE_CONFIGS[str(path)] = _identity(current)
        try:
            yield path
        finally:
            _ACTIVE_CONFIGS.pop(str(path), None)


def _verify_empty_config(config_dir: Path) -> None:
    expected = _ACTIVE_CONFIGS.get(str(config_dir))
    if expected is None:
        raise DockerBoundaryError("Docker CLI configuration must be an active private empty configuration")
    descriptor = None
    try:
        descriptor = os.open(config_dir, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
        current = os.fstat(descriptor)
        if (_identity(current) != expected or current.st_uid != os.getuid()
                or stat.S_IMODE(current.st_mode) != 0o700 or os.listdir(descriptor)):
            raise DockerBoundaryError("Docker CLI configuration changed or is not empty and private")
    except OSError:
        raise DockerBoundaryError("Docker CLI configuration cannot be inspected safely") from None
    finally:
        if descriptor is not None:
            os.close(descriptor)


async def verified_docker_argv(argv: list[str], *, config_dir: Path) -> list[str]:
    """Pin a Docker command to the verified socket and its private empty config."""
    if (not argv or argv[0] != "docker" or len(argv) < 2
            or argv[1] not in {"image", "ps", "rm", "run", "exec", "inspect"}
            or any(argument in {"--host", "--context", "--config", "-H"}
                   or argument.startswith(("--host=", "--context=", "--config=", "-H")) for argument in argv[1:])):
        raise DockerBoundaryError("Docker commands must use the owned verified socket without host or context overrides")
    _verify_empty_config(config_dir)
    path = await asyncio.to_thread(verify_local_docker_socket)
    _verify_empty_config(config_dir)
    return ["docker", "--config", str(config_dir), "--host", f"unix://{path}", *argv[1:]]
