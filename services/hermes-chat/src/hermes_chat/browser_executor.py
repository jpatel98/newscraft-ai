"""Browser process boundary. The interaction/citation controller is provider-neutral.

The concrete backend uses its own rootless OCI container, never the terminal's
container or workspace. No Docker setup, image pull or security-policy change is
performed here; an operator must supply a reviewed immutable image and profile.
"""
import asyncio
import hashlib
import json
import os
from pathlib import Path
import stat
from typing import Protocol, Any

from .executor_payloads import guard_program, watchdog_program
from .executor_state import ExecutorError
from .oci_executor import DockerEngine, ResourcePolicy

BROWSER_MEMORY = 1024 * 1024 * 1024
BROWSER_TMP = "rw,nosuid,nodev,noexec,size=134217728,nr_inodes=8192,uid=1000,gid=1000,mode=0700"
BROWSER_POLICY = ResourcePolicy(memory=BROWSER_MEMORY, pids=128, temporary=BROWSER_TMP,
    watchdog=watchdog_program(360), nofile=1024, fsize=64 * 1024 * 1024)
BROWSER_GUARD = guard_program(memory=BROWSER_MEMORY, pids=128, temp_bytes=134217728, temp_inodes=8192)


class BrowserBackend(Protocol):
    daemon: str
    async def probe(self) -> str: ...
    async def probe_host(self) -> str: ...
    def labels(self, scope: str, run: str, operation: str) -> dict: ...
    async def create(self, image: str, name: str, labels: dict) -> str: ...
    async def inspect(self, name: str) -> dict | None: ...
    def verify_container(self, item: dict, labels: dict, image: str) -> None: ...
    async def start(self, identity: str) -> None: ...
    async def spawn_browser(self, identity: str, program: str, limit: int) -> Any: ...
    async def remove(self, identity: str) -> None: ...


def reviewed_seccomp(path: Path, digest: str) -> dict:
    """Verify existing operator-owned bytes; never install or edit the policy."""
    if any(part.is_symlink() for part in (path, *path.parents)):
        raise ExecutorError("The browser seccomp profile must not traverse symlinks.")
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK)
        with os.fdopen(fd, "rb") as source:
            metadata = os.fstat(source.fileno())
            if (not stat.S_ISREG(metadata.st_mode) or metadata.st_uid not in {0, os.getuid()}
                    or metadata.st_mode & 0o022 or metadata.st_size > 256 * 1024):
                raise ValueError()
            raw = source.read(256 * 1024 + 1)
        if len(raw) > 256 * 1024 or hashlib.sha256(raw).hexdigest() != digest:
            raise ValueError()
        profile = json.loads(raw)
        if profile.get("defaultAction") != "SCMP_ACT_ERRNO" or not isinstance(profile.get("syscalls"), list):
            raise ValueError()
        allowed = {name for rule in profile["syscalls"] if rule.get("action") == "SCMP_ACT_ALLOW"
                   and not rule.get("args") and not rule.get("includes") and not rule.get("excludes")
                   for name in rule.get("names", [])}
        if not {"clone", "setns", "unshare"}.issubset(allowed):
            raise ValueError()
        return profile
    except (OSError, ValueError, TypeError, AttributeError):
        raise ExecutorError("A readable, hash-matched deny-by-default Chromium seccomp profile is required.") from None


class OCIBrowserBackend(DockerEngine):
    def __init__(self, config):
        super().__init__(config)
        self.image = config.browser_image
        self.image_contract = "newscraft.browser.contract"
        self.policy = BROWSER_POLICY

    def profile(self):
        return reviewed_seccomp(self.config.browser_seccomp, self.config.browser_seccomp_sha256)

    def security_options(self):
        self.profile()
        return ["no-new-privileges=true", "seccomp=" + str(self.config.browser_seccomp)]

    async def probe(self):
        self.profile()
        return await super().probe()

    def verify_container(self, item, labels, image):
        DockerEngine.verify_container(item, labels, image, policy=self.policy, seccomp=self.profile())

    async def spawn_browser(self, identity, program, limit):
        # No model input in argv and no inherited worker/provider/Docker secrets.
        return await asyncio.create_subprocess_exec(*self.argv([
            "container", "exec", "--interactive", "--user=1000:1000", "--workdir=/tmp",
            identity, "/usr/local/bin/python3", "-I", "-u", "-c", BROWSER_GUARD + program]),
            env={"PATH": "/usr/local/bin:/usr/bin:/bin", "LANG": "C.UTF-8"},
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE, limit=limit)
