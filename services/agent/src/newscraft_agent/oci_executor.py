"""Rootless OCI computer adapter. No host mounts, network, image pulls or daemon setup.

Each action uses a fresh container. Only a validated, bounded conversation
snapshot survives; container memory, processes and /tmp do not. A root-owned,
capability-free namespace PID 1 supplies a wall-clock watchdog; untrusted execs
run as UID 1000. The worker independently enforces deadlines and confirms removal.
"""
from __future__ import annotations

import asyncio
import contextlib
from dataclasses import dataclass
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys

from .executor_state import ExecutorError, ExecutorUncertain, SnapshotStore, canonical_archive, MAX_ARCHIVE, MAX_FILE
from .executor_payloads import GUARD, RESTORE, SNAPSHOT, WATCHDOG
from .isolation import conversation_identity, guard_tool_arguments
# Reuse owned, no-follow file/terminal payloads, not the historical runtime.
from .sandbox import _FILE_PROGRAM, _TERMINAL_PROGRAM, schemas as computer_schemas

IMAGE = re.compile(r"^(?:[a-zA-Z0-9][a-zA-Z0-9._:/-]*@)?sha256:[a-f0-9]{64}$")
IDENTITY = re.compile(r"^[a-f0-9]{64}$")
COMPUTER_TOOLS = frozenset({"terminal", "read_file", "write_file", "list_files"})
MEMORY = 256 * 1024 * 1024
WORKSPACE_MOUNT = "rw,nosuid,nodev,noexec,size=8388608,nr_inodes=512,uid=1000,gid=1000,mode=0700"
TMP_MOUNT = "rw,nosuid,nodev,noexec,size=16777216,nr_inodes=1024,uid=1000,gid=1000,mode=0700"


@dataclass(frozen=True)
class ResourcePolicy:
    memory: int = MEMORY
    pids: int = 64
    temporary: str = TMP_MOUNT
    watchdog: str = WATCHDOG
    nofile: int = 256
    fsize: int = MAX_FILE


DEFAULT_POLICY = ResourcePolicy()


def owned_computer_schemas():
    tools = computer_schemas()
    for tool in tools:
        schema = tool["parameters"]
        # Provider-neutral optional fields: the Responses adapter adds its
        # strict null form, while Messages may omit these fields entirely.
        schema["required"] = [name for name, value in schema["properties"].items()
                              if "null" not in value.get("type", [])]
    return tools


@dataclass(frozen=True)
class OCIConfig:
    image: str
    socket: Path
    state_root: Path
    binary: str = "/usr/bin/docker"
    browser_image: str | None = None
    browser_seccomp: Path | None = None
    browser_seccomp_sha256: str | None = None

    def __post_init__(self):
        if not IMAGE.fullmatch(self.image):
            raise ValueError("NEWSCRAFT_EXECUTOR_IMAGE must be a reviewed immutable sha256 image reference.")
        if not self.socket.is_absolute() or not self.state_root.is_absolute() or not Path(self.binary).is_absolute():
            raise ValueError("Computer socket, state and Docker binary paths must be absolute.")
        if any((self.browser_image, self.browser_seccomp, self.browser_seccomp_sha256)):
            if (not self.browser_image or not IMAGE.fullmatch(self.browser_image)
                    or not self.browser_seccomp or not self.browser_seccomp.is_absolute()
                    or not self.browser_seccomp_sha256 or not IDENTITY.fullmatch(self.browser_seccomp_sha256)):
                raise ValueError("Browser execution requires an immutable image and an explicitly reviewed, hash-pinned seccomp profile.")


@dataclass(frozen=True)
class CommandResult:
    code: int
    stdout: bytes = b""
    stderr: bytes = b""


class DockerEngine:
    """All daemon commands are fixed argv; model text is sent only on stdin."""
    def __init__(self, config: OCIConfig):
        self.config = config
        self.policy = DEFAULT_POLICY
        self.image = config.image
        self.image_contract = "newscraft.executor.contract"

    def argv(self, args):
        return [self.config.binary, "--host", "unix://" + str(self.config.socket),
                "--config", str(self.config.state_root / "unused-docker-config"), *args]

    def security_options(self):
        return ["no-new-privileges=true"]

    def validate_host(self):
        if sys.platform != "linux" or os.getuid() == 0:
            raise ExecutorError("The computer requires a non-root Linux worker with an existing rootless Docker daemon.")
        path = self.config.socket
        for part in (path, *path.parents):
            if part.is_symlink():
                raise ExecutorError("The computer socket must not traverse symlinks.")
        try:
            info, parent = path.stat(), path.parent.stat()
            if (not stat.S_ISSOCK(info.st_mode) or info.st_uid != os.getuid()
                    or parent.st_uid != os.getuid() or parent.st_mode & 0o077):
                raise ValueError()
            if not os.access(self.config.binary, os.X_OK):
                raise ValueError()
        except (OSError, ValueError):
            raise ExecutorError("The private rootless Docker socket or executable is unavailable.") from None

    async def command(self, args, *, data=None, seconds=5, limit=256 * 1024):
        # Never inherit provider keys, proxy settings, Docker contexts or auth.
        env = {"PATH": "/usr/local/bin:/usr/bin:/bin", "LANG": "C.UTF-8"}
        process = None
        tasks = []
        total = 0
        async def read(stream):
            nonlocal total
            parts = []
            while chunk := await stream.read(32768):
                total += len(chunk)
                if total > limit:
                    raise ExecutorError("Computer command output exceeded its limit.")
                parts.append(chunk)
            return b"".join(parts)
        async def write():
            if process.stdin is not None:
                try:
                    process.stdin.write(data)
                    await process.stdin.drain()
                except (BrokenPipeError, ConnectionResetError):
                    pass
                finally:
                    process.stdin.close()
        try:
            async with asyncio.timeout(seconds):
                process = await asyncio.create_subprocess_exec(
                    *self.argv(args),
                    env=env, stdin=asyncio.subprocess.PIPE if data is not None else asyncio.subprocess.DEVNULL,
                    stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
                tasks = [asyncio.create_task(read(process.stdout)), asyncio.create_task(read(process.stderr)), asyncio.create_task(write())]
                out, err, _ = await asyncio.gather(*tasks)
                return CommandResult(await process.wait(), out, err)
        except (OSError, TimeoutError):
            raise ExecutorError("The computer daemon command did not complete.") from None
        finally:
            if process is not None and process.returncode is None:
                with contextlib.suppress(ProcessLookupError):
                    process.kill()
                await process.wait()
            for task in tasks:
                if not task.done():
                    task.cancel()
            if tasks:
                await asyncio.gather(*tasks, return_exceptions=True)

    @staticmethod
    def document(result):
        if result.code != 0:
            raise ExecutorError("The required computer daemon operation failed.")
        try:
            return json.loads(result.stdout)
        except (ValueError, UnicodeError):
            raise ExecutorError("The computer daemon returned an invalid response.") from None

    async def probe_host(self):
        self.validate_host()
        info = self.document(await self.command(["info", "--format", "{{json .}}"] ))
        if (not isinstance(info, dict) or info.get("OSType") != "linux"
                or info.get("CgroupVersion") != "2" or info.get("CgroupDriver") != "systemd"
                or not any("rootless" in s for s in info.get("SecurityOptions", []))
                or not any("seccomp" in s and "builtin" in s for s in info.get("SecurityOptions", []))
                or not info.get("ID")
                or not all(info.get(key) is True for key in ("MemoryLimit", "SwapLimit", "PidsLimit", "CpuCfsQuota"))):
            raise ExecutorError("Rootless Docker, default seccomp and enforced cgroup v2 CPU/memory/PID limits are required.")
        return hashlib.sha256(json.dumps([str(self.config.socket), info["ID"]]).encode()).hexdigest()

    async def probe(self):
        self.daemon = await self.probe_host()
        image = self.document(await self.command(["image", "inspect", self.image, "--format", "{{json .}}"] ))
        if (not isinstance(image, dict) or not IMAGE.fullmatch(str(image.get("Id", "")))
                or image.get("Config", {}).get("Labels", {}).get(self.image_contract) != "v1"
                or image.get("Config", {}).get("Volumes")
                or image.get("Config", {}).get("OnBuild")):
            raise ExecutorError("A pre-provisioned reviewed computer image with the v1 contract is required.")
        if self.image not in {image["Id"], *(image.get("RepoDigests") or [])}:
            raise ExecutorError("The computer image digest does not match its configured identity.")
        return image["Id"]

    @staticmethod
    def labels(scope, run, operation):
        return {"newscraft.executor": "v1", "newscraft.scope": scope, "newscraft.run": run, "newscraft.operation": operation}

    async def create(self, image, name, labels):
        policy = self.policy
        args = ["container", "create", "--name", name, "--pull=never", "--network=none",
                "--read-only", "--cap-drop=ALL", "--no-healthcheck",
                "--cgroupns=private", "--ipc=private", "--user=0:0", "--workdir=/",
                "--memory", str(policy.memory), "--memory-swap", str(policy.memory), "--cpus=1", "--pids-limit=" + str(policy.pids),
                f"--ulimit=nofile={policy.nofile}:{policy.nofile}", f"--ulimit=fsize={policy.fsize}:{policy.fsize}", "--stop-timeout=1",
                "--log-driver=none", "--tmpfs", "/workspace:" + WORKSPACE_MOUNT,
                "--tmpfs", "/tmp:" + policy.temporary, "--shm-size=8m", "--entrypoint=/usr/local/bin/python3"]
        args += ["--security-opt=" + option for option in self.security_options()]
        for key, value in labels.items():
            args += ["--label", key + "=" + value]
        args += [image, "-I", "-S", "-c", policy.watchdog]
        result = await self.command(args)
        value = result.stdout.decode("ascii", errors="ignore").strip()
        if result.code or not IDENTITY.fullmatch(value):
            raise ExecutorUncertain("Container admission was not confirmed; its pending record is retained.")
        return value

    async def inspect(self, reference):
        # Listing (including stopped containers) distinguishes absence from a
        # daemon failure without trusting localized error strings.
        result = await self.command(["container", "ls", "--all", "--no-trunc", "--filter", "name=^/" + reference + "$", "--format", "{{.ID}}"])
        if result.code:
            raise ExecutorUncertain("Computer cleanup cannot be confirmed while the daemon is unavailable.")
        ids = result.stdout.decode("ascii", errors="ignore").split()
        if not ids:
            return None
        if len(ids) != 1 or not IDENTITY.fullmatch(ids[0]):
            raise ExecutorUncertain("Computer identity could not be verified.")
        item = self.document(await self.command(["container", "inspect", ids[0], "--format", "{{json .}}"] ))
        if item.get("Id") != ids[0] or item.get("Name") != "/" + reference:
            raise ExecutorUncertain("Computer identity does not match the saved action.")
        return item

    @staticmethod
    def verify_container(item, labels, image, *, policy=DEFAULT_POLICY, seccomp=None):
        host, config = item.get("HostConfig", {}), item.get("Config", {})
        security = set(host.get("SecurityOpt") or [])
        if seccomp is not None:
            profiles = [value for value in security if value.startswith("seccomp=")]
            try:
                if len(profiles) != 1 or json.loads(profiles[0][len("seccomp="):]) != seccomp:
                    raise ValueError()
                security.remove(profiles[0])
            except (ValueError, TypeError):
                raise ExecutorError("The browser did not retain its reviewed seccomp profile.") from None
        if (any(config.get("Labels", {}).get(k) != v for k, v in labels.items())
                or item.get("Image") != image or config.get("User") != "0:0"
                or config.get("WorkingDir") != "/"
                or config.get("Entrypoint") != ["/usr/local/bin/python3"]
                or config.get("Cmd") != ["-I", "-S", "-c", policy.watchdog]
                or config.get("Healthcheck", {}).get("Test") != ["NONE"]
                or host.get("Privileged") or not host.get("ReadonlyRootfs")
                or host.get("NetworkMode") != "none" or host.get("CapAdd")
                or "ALL" not in (host.get("CapDrop") or [])
                or security not in ({"no-new-privileges=true"}, {"no-new-privileges"})
                or host.get("CgroupnsMode") != "private" or host.get("IpcMode") != "private"
                or host.get("PidMode") or host.get("UTSMode") or host.get("Binds") or host.get("Devices")
                or any(m.get("Type") != "tmpfs" for m in item.get("Mounts", []))
                or host.get("Memory") != policy.memory or host.get("MemorySwap") != policy.memory
                or host.get("NanoCpus") != 1_000_000_000 or host.get("PidsLimit") != policy.pids
                or host.get("Tmpfs") != {"/workspace": WORKSPACE_MOUNT, "/tmp": policy.temporary}
                or host.get("LogConfig", {}).get("Type") != "none"):
            raise ExecutorError("The created computer did not retain its required isolation and resource limits.")

    async def start(self, identity):
        if (await self.command(["container", "start", identity])).code:
            raise ExecutorError("The isolated computer could not start.")

    async def restore(self, identity, snapshot):
        if snapshot and (await self.exec_program(identity, RESTORE, data=snapshot)).code:
            raise ExecutorError("The private conversation files could not be restored.")

    async def exec_program(self, identity, program, **kwargs):
        return await self.command(["container", "exec", "--interactive", "--user=1000:1000",
            "--workdir=/workspace", identity, "/usr/local/bin/python3", "-I", "-S", "-c", GUARD + program], **kwargs)

    async def execute(self, identity, name, arguments):
        request = dict(arguments)
        if name == "terminal":
            request["workdir"] = request.get("workdir") or "/workspace"
            program = _TERMINAL_PROGRAM
        else:
            request["operation"] = name
            program = _FILE_PROGRAM
        result = await self.exec_program(identity, program,
            data=json.dumps(request).encode(), seconds=arguments.get("timeout_seconds") or 30, limit=128 * 1024)
        if name == "terminal":
            return {"exit_code": result.code, "stdout": result.stdout[:16384].decode(errors="replace"),
                    "stderr": result.stderr[:8192].decode(errors="replace"),
                    "truncated": len(result.stdout) > 16384 or len(result.stderr) > 8192}
        if result.code:
            return {"error": "The scoped file action failed."}
        output = self.document(result)
        if not isinstance(output, dict):
            raise ExecutorError("The scoped file action returned invalid data.")
        return output

    async def snapshot(self, identity):
        result = await self.exec_program(identity, SNAPSHOT, seconds=10, limit=MAX_ARCHIVE)
        if result.code:
            raise ExecutorError("The conversation files could not be snapshotted.")
        return canonical_archive(result.stdout)

    async def remove(self, identity):
        # A failed remove still requires inspect; never equate CLI termination
        # with termination of code that was already admitted by the daemon.
        await self.command(["container", "rm", "--force", "--volumes", identity])


class OCIComputer:
    def __init__(self, runtime, thread_id, run_id, *, config, engine=None, store=None):
        conversation_identity(thread_id)
        if runtime.conversation_id != thread_id or not isinstance(run_id, str) or not 0 < len(run_id) <= 256:
            raise ExecutorError("A server-owned conversation/run identity is required for computer access.")
        self.scope = hashlib.sha256(json.dumps([runtime.key, thread_id]).encode()).hexdigest()
        self.run = hashlib.sha256(run_id.encode()).hexdigest()
        self.config = config
        self.engine = engine or DockerEngine(config)
        self.store = store or SnapshotStore(config.state_root)
        self._lock = asyncio.Lock()

    @staticmethod
    def schemas():
        return [tool for tool in owned_computer_schemas() if tool["name"] in COMPUTER_TOOLS]

    async def _clean(self, row):
        if await self.engine.probe_host() != row["daemon"]:
            return False
        item = await self.engine.inspect(row["name"])
        if item is None:
            # A timed-out create may still finish in the daemon. Absence alone
            # cannot prove it will never appear. Keep its quarantine durable.
            return row["phase"] != "creating"
        labels = self.engine.labels(self.scope, self.run, row["operation"])
        if any(item.get("Config", {}).get("Labels", {}).get(k) != v for k, v in labels.items()):
            return False
        if row["container"] and item.get("Id") != row["container"]:
            return False
        await self.engine.remove(item["Id"])
        return await self.engine.inspect(row["name"]) is None

    async def cancel(self):
        for row in self.store.pending(self.scope, self.run):
            try:
                if not await self._clean(row):
                    return False
                self.store.cancelled(self.scope, row["operation"])
            except (ExecutorError, OSError, TimeoutError):
                return False
        return True

    async def close(self):
        if not await self.cancel():
            raise ExecutorUncertain("Computer cancellation is not confirmed; scoped recovery is required.")

    def request_key(self, name, safe):
        return hashlib.sha256(json.dumps([self.config.image, name, safe], sort_keys=True).encode()).hexdigest()

    async def completed(self, name, arguments, *, operation_id):
        if name not in COMPUTER_TOOLS or not IDENTITY.fullmatch(operation_id):
            return None
        safe = guard_tool_arguments(name, arguments)
        return self.store.receipt(self.scope, self.run, operation_id, self.request_key(name, safe))

    async def execute(self, name, arguments, *, operation_id):
        if name not in COMPUTER_TOOLS or not IDENTITY.fullmatch(operation_id):
            raise ValueError("Unknown computer tool or invalid operation identity")
        safe = guard_tool_arguments(name, arguments)
        if name == "terminal":
            if not isinstance(safe.get("command"), str) or not 0 < len(safe["command"].encode()) <= 16000:
                raise ValueError("Terminal command exceeds its limit")
            if safe.get("timeout_seconds") is not None and (type(safe["timeout_seconds"]) is not int or not 1 <= safe["timeout_seconds"] <= 60):
                raise ValueError("Invalid terminal timeout")
        elif name == "write_file" and (not isinstance(safe.get("content"), str) or len(safe["content"].encode()) > MAX_FILE):
            raise ValueError("File content exceeds its limit")
        async with self._lock:
            image = await self.engine.probe()
            container_name = "newscraft-action-" + hashlib.sha256((self.scope + self.run + operation_id).encode()).hexdigest()[:40]
            request = self.request_key(name, safe)
            admitted = self.store.admit(self.scope, self.run, operation_id, container_name, self.engine.daemon, request)
            if "receipt" in admitted:
                return admitted["receipt"]
            labels = self.engine.labels(self.scope, self.run, operation_id)
            try:
                identity = await self.engine.create(image, container_name, labels)
                self.store.created(self.scope, operation_id, identity)
                item = await self.engine.inspect(container_name)
                if item is None:
                    raise ExecutorUncertain("The admitted computer disappeared before dispatch.")
                self.engine.verify_container(item, labels, image)
                await self.engine.start(identity)
                await self.engine.restore(identity, canonical_archive(admitted["snapshot"]))
                result = await self.engine.execute(identity, name, safe)
                # A failed action must never replace the last committed files,
                # even when it modified them before reporting the failure.
                failed = bool(result.get("error") or result.get("exit_code", 0) != 0)
                snapshot = None if failed else await self.engine.snapshot(identity)
                row = next(r for r in self.store.pending(self.scope, self.run) if r["operation"] == operation_id)
                if not await self._clean(row):
                    raise ExecutorUncertain("Computer termination could not be confirmed.")
                self.store.finish(self.scope, operation_id, result, snapshot)
                return result
            except asyncio.CancelledError:
                if not await asyncio.shield(self.cancel()):
                    raise ExecutorUncertain("Computer cancellation could not be confirmed.") from None
                raise
            except BaseException as exc:
                if not await self.cancel():
                    raise ExecutorUncertain("Computer outcome is uncertain; it will not be repeated.") from None
                if isinstance(exc, ExecutorUncertain):
                    raise
                if isinstance(exc, (ExecutorError, ValueError, StopIteration)):
                    return {"error": "The isolated computer action failed; changes were discarded and execution was stopped."}
                raise


class OCIBrowserComputer(OCIComputer):
    """One conversation boundary with separate terminal and browser containers."""
    def __init__(self, runtime, thread_id, run_id, *, config, engine=None, store=None, browser_backend=None,
                 resource_fetcher=None, allowed_urls=None, synthetic_fixture=False):
        super().__init__(runtime, thread_id, run_id, config=config, engine=engine, store=store)
        from .browser_controller import BrowserController
        from .browser_executor import OCIBrowserBackend
        self.browser = BrowserController(runtime, thread_id, run_id, scope=self.scope, run=self.run,
            backend=browser_backend or OCIBrowserBackend(config), store=self.store,
            policy={"image": config.browser_image, "seccomp": config.browser_seccomp_sha256},
            resource_fetcher=resource_fetcher, allowed_urls=allowed_urls, synthetic_fixture=synthetic_fixture)

    @staticmethod
    def schemas():
        tools = owned_computer_schemas()
        browser = next(tool for tool in tools if tool["name"] == "browser")
        browser["description"] = ("Interact with the conversation's isolated public-web browser: navigate, snapshot, click, fill/type, key, scroll, screenshot, or reset. "
            "Pages stay interactive within a run; later runs restore private storage and reload the last URL. "
            "Screenshots are saved under /workspace/browser-screenshots. Terminal code cannot access the browser process/profile. "
            "Public GET/HEAD only; no login cookies, external writes, downloads or sockets. Input taints citation evidence until reset.")
        return tools

    async def completed(self, name, arguments, *, operation_id):
        if name == "browser":
            return await self.browser.completed(arguments, operation_id=operation_id)
        return await super().completed(name, arguments, operation_id=operation_id)

    async def execute(self, name, arguments, *, operation_id):
        if name == "browser":
            async with self._lock:
                return await self.browser.execute(arguments, operation_id=operation_id)
        return await super().execute(name, arguments, operation_id=operation_id)

    def browser_receipt(self, identity):
        return self.browser.evidence(identity)

    async def recover(self):
        await self.browser.recover()
        if not await super().cancel():
            raise ExecutorUncertain("Previous terminal execution still requires confirmed cleanup.")

    async def cancel(self):
        browser = await self.browser.cancel()
        computer = await super().cancel()
        return browser and computer


class OCIComputerFactory:
    def __init__(self, config):
        self.config = config

    @property
    def policy(self):
        return {"kind": "rootless-oci-v1", "image": self.config.image,
                "browser": {"image": self.config.browser_image, "seccomp": self.config.browser_seccomp_sha256} if self.config.browser_image else None,
                "endpoint": hashlib.sha256(json.dumps([str(self.config.socket), str(self.config.state_root), self.config.binary]).encode()).hexdigest()}

    def __call__(self, runtime, thread_id, run_id):
        adapter = OCIBrowserComputer if self.config.browser_image else OCIComputer
        return adapter(runtime, thread_id, run_id, config=self.config)

    async def readiness(self):
        from .browser_network import BrowserNetworkError, require_browser_runtime
        try:
            if self.config.browser_image:
                require_browser_runtime()
            await DockerEngine(self.config).probe()
            if self.config.browser_image:
                from .browser_executor import OCIBrowserBackend
                await OCIBrowserBackend(self.config).probe()
        except (ExecutorError, BrowserNetworkError) as exc:
            return {"configured": False, "terminal": False, "workspaceFiles": False, "browser": False,
                    "sandbox": "rootless-oci", "sandboxReason": str(exc), "tools": [], "accessVerified": False}
        adapter = OCIBrowserComputer if self.config.browser_image else OCIComputer
        return {"configured": True, "terminal": True, "workspaceFiles": True, "browser": bool(self.config.browser_image),
                "sandbox": "rootless-oci", "sandboxReason": "Rootless daemon/image/limits checked; action isolation still requires live acceptance.",
                "tools": [t["name"] for t in adapter.schemas()], "accessVerified": False}
