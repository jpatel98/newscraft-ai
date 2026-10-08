"""Private server-owned conversation browser storage, outside model mounts."""
from __future__ import annotations

import json
import os
import secrets
import stat
from typing import Any

from .isolation import TenantRuntime

MAX_STATE_BYTES = 1024 * 1024
STATE_FILE = 'browser-state.json'


class BrowserStateError(RuntimeError):
    pass


def _root(runtime: TenantRuntime) -> int:
    if runtime.hermes_home.is_relative_to(runtime.workspace) or runtime.workspace.is_relative_to(runtime.hermes_home):
        raise BrowserStateError('Browser state must be outside the model workspace')
    try:
        return os.open(runtime.hermes_home, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    except OSError as exc:
        raise BrowserStateError('Private browser state is unavailable') from exc


def _validate(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != {'storage', 'input_tainted', 'last_url'}:
        raise BrowserStateError('Private browser state has an invalid shape')
    if (not isinstance(value['storage'], dict) or not isinstance(value['input_tainted'], bool)
            or not isinstance(value['last_url'], str) or len(value['last_url']) > 8192):
        raise BrowserStateError('Private browser state is invalid')
    storage = value['storage']
    if set(storage) != {'cookies', 'origins'} or not isinstance(storage['cookies'], list) or not isinstance(storage['origins'], list):
        raise BrowserStateError('Private browser storage is invalid')
    return value


def load_browser_state(runtime: TenantRuntime) -> dict[str, Any]:
    root = _root(runtime)
    fd = None
    try:
        try:
            fd = os.open(STATE_FILE, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, dir_fd=root)
        except FileNotFoundError:
            return {'storage': {'cookies': [], 'origins': []}, 'input_tainted': False, 'last_url': ''}
        metadata = os.fstat(fd)
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_size > MAX_STATE_BYTES or metadata.st_uid != os.getuid() or metadata.st_mode & 0o077:
            raise BrowserStateError('Private browser state file is unsafe')
        raw = bytearray()
        while chunk := os.read(fd, 65536):
            raw.extend(chunk)
            if len(raw) > MAX_STATE_BYTES:
                raise BrowserStateError('Private browser state exceeds 1 MiB')
        return _validate(json.loads(raw))
    except (OSError, ValueError) as exc:
        raise BrowserStateError('Private browser state could not be read safely') from exc
    finally:
        if fd is not None: os.close(fd)
        os.close(root)


def save_browser_state(runtime: TenantRuntime, state: dict[str, Any]) -> None:
    raw = json.dumps(_validate(state), ensure_ascii=False).encode()
    if len(raw) > MAX_STATE_BYTES:
        raise BrowserStateError('Private browser state exceeds 1 MiB')
    root = _root(runtime)
    temporary = 'browser-state-' + secrets.token_hex(12)
    fd = None
    try:
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=root)
        os.fchmod(fd, 0o600)
        offset = 0
        while offset < len(raw): offset += os.write(fd, raw[offset:])
        os.fsync(fd)
        os.rename(temporary, STATE_FILE, src_dir_fd=root, dst_dir_fd=root)
        os.fsync(root)
    except OSError as exc:
        raise BrowserStateError('Private browser state could not be saved safely') from exc
    finally:
        if fd is not None: os.close(fd)
        try: os.unlink(temporary, dir_fd=root)
        except FileNotFoundError: pass
        os.close(root)
