"""Owned Docker computer access with conversation persistence and no host tools.

The operator must provision NEWSCRAFT_SANDBOX_IMAGE with Python 3, Playwright,
Chromium, and a POSIX shell. This module never installs/pulls an image or starts
Docker. The container has no network; browser documents are fetched through a
bounded public HTTP gateway. Chromium JavaScript state persists across actions.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
import secrets
import shutil
from datetime import datetime, timezone
from typing import Any, Mapping

from .isolation import TenantIsolationError, TenantRuntime, conversation_identity, current_tenant_run, guard_tool_arguments, workspace_path

MAX_OUTPUT_BYTES = 128 * 1024
MAX_FILE_BYTES = 1024 * 1024
MAX_PAGE_BYTES = 2 * 1024 * 1024
_IMAGE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,255}$")
_CONTAINER_ID_RE = re.compile(r"^[a-f0-9]{12,64}$")
_IMAGE_CONTRACT = {
    "newscraft.sandbox.contract": "v1", "newscraft.python": "3.12",
    "newscraft.playwright": "1.63.0", "newscraft.chromium": "installed",
}


class SandboxError(RuntimeError):
    """A bounded computer action could not safely complete."""


def _tool(name: str, description: str, properties: dict[str, Any]) -> dict[str, Any]:
    return {"type": "function", "name": name, "description": description, "strict": True,
            "parameters": {"type": "object", "properties": properties,
                           "required": list(properties), "additionalProperties": False}}


def schemas() -> list[dict[str, Any]]:
    path = {"type": "string", "description": "A path beneath /workspace; relative paths are accepted."}
    return [
        _tool("terminal", "Run a bounded POSIX shell command in the conversation's isolated, network-disabled computer.", {
            "command": {"type": "string"}, "workdir": {"type": ["string", "null"]},
            "timeout_seconds": {"type": ["integer", "null"], "minimum": 1, "maximum": 60}}),
        _tool("read_file", "Read a UTF-8 file from this conversation's /workspace.", {"path": path}),
        _tool("write_file", "Write a UTF-8 file in this conversation's /workspace (up to 1 MiB).", {
            "path": path, "content": {"type": "string"}}),
        _tool("list_files", "List up to 200 entries in this conversation's /workspace directory.", {"path": path}),
        _tool("browser", "Use persistent interactive Chromium with JavaScript and resources in the conversation computer. Navigate, click, fill/type, press a key, scroll, read a snapshot, or save a PNG screenshot. Reset clears browser storage and input taint for a fresh cited read. Public GET/HEAD network only; outbound writes, sockets, authentication and downloads require separate authorization.", {
            "action": {"type": "string", "enum": ["navigate", "snapshot", "click", "fill", "type", "key", "scroll", "screenshot", "reset"]},
            "url": {"type": ["string", "null"]}, "selector": {"type": ["string", "null"]},
            "text": {"type": ["string", "null"], "maxLength": 4096},
            "key": {"type": ["string", "null"], "maxLength": 64},
            "delta_y": {"type": ["integer", "null"], "minimum": -4000, "maximum": 4000}}),
    ]


# This code runs only INSIDE the sandbox. openat/no-follow checks prevent a
# symlink planted by a terminal action from redirecting a file tool elsewhere.
_FILE_PROGRAM = r'''
import json, os, stat, sys
request = json.load(sys.stdin)
root = os.open('/workspace', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
opened = [root]
try:
    parts = request['path'].removeprefix('/workspace').strip('/').split('/')
    parts = [part for part in parts if part]
    fd = root
    for part in parts[:-1]:
        if request['operation'] == 'write_file':
            try: os.mkdir(part, mode=0o700, dir_fd=fd)
            except FileExistsError: pass
        fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
        opened.append(fd)
    operation = request['operation']
    if operation == 'list_files':
        if parts:
            fd = os.open(parts[-1], os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            opened.append(fd)
        names = sorted(os.listdir(fd))
        print(json.dumps({'path': request['path'], 'entries': names[:200], 'truncated': len(names) > 200}))
    else:
        if not parts: raise ValueError('path must name a regular file')
        if operation == 'write_file':
            data = request['content'].encode('utf-8')
            if len(data) > 1048576: raise ValueError('file content exceeds 1 MiB')
            # Check an existing target before opening it for a write: never
            # block on a FIFO or write through a link/device/socket.
            try:
                existing = os.stat(parts[-1], dir_fd=fd, follow_symlinks=False)
                if not stat.S_ISREG(existing.st_mode): raise ValueError('target is not a regular file')
            except FileNotFoundError: pass
            file_fd = os.open(parts[-1], os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600, dir_fd=fd)
            opened.append(file_fd)
            if not stat.S_ISREG(os.fstat(file_fd).st_mode): raise ValueError('target is not a regular file')
            os.ftruncate(file_fd, 0)
            offset = 0
            while offset < len(data): offset += os.write(file_fd, data[offset:])
            os.fsync(file_fd)
            print(json.dumps({'path': request['path'], 'bytes': len(data)}))
        else:
            file_fd = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
            opened.append(file_fd)
            info = os.fstat(file_fd)
            if not stat.S_ISREG(info.st_mode): raise ValueError('path is not a regular file')
            if info.st_size > 1048576: raise ValueError('file exceeds 1 MiB')
            data = os.read(file_fd, 24576)
            print(json.dumps({'path': request['path'], 'content': data.decode('utf-8', errors='replace'),
                              'bytes': info.st_size, 'truncated': info.st_size > len(data)}, ensure_ascii=False))
except Exception:
    print(json.dumps({'error': 'Workspace operation rejected: unavailable, unsafe, oversized, or non-UTF-8 path'}))
finally:
    for fd in reversed(opened): os.close(fd)
'''

_TERMINAL_PROGRAM = r'''
import json, os, sys
request = json.load(sys.stdin)
fd = os.open('/workspace', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
try:
    for component in request['workdir'].removeprefix('/workspace').strip('/').split('/'):
        if component:
            next_fd = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd)
            fd = next_fd
    os.fchdir(fd)
finally: os.close(fd)
os.execve('/bin/sh', ['/bin/sh', '-c', request['command']], {
    'PATH': '/usr/local/bin:/usr/bin:/bin', 'HOME': '/workspace',
    'TMPDIR': '/tmp', 'LANG': 'C.UTF-8', 'PYTHONUNBUFFERED': '1'})
'''

from .browser_rpc import BrowserProtocolError, BrowserSession, _BROWSER_PROGRAM
from .browser_network import BrowserNetworkError, _public_url




class ComputerSandbox:
    """One lazily created container for one tenant's conversation workspace."""

    def __init__(self, runtime: TenantRuntime, conversation_id: str, *, image: str | None = None, timeout_seconds: int = 30,
                 resource_fetcher: Any = None, allowed_urls: frozenset[str] | None = None, synthetic_fixture: bool = False):
        conversation_identity(conversation_id)
        if runtime.conversation_id != conversation_id:
            raise TenantIsolationError("Sandbox requires a conversation-scoped runtime")
        self.runtime = runtime
        self.conversation_id = conversation_id
        self.image = image or os.environ.get("NEWSCRAFT_SANDBOX_IMAGE", "")
        if self.image and not _IMAGE_RE.fullmatch(self.image):
            raise SandboxError("NEWSCRAFT_SANDBOX_IMAGE is invalid")
        self.timeout_seconds = max(1, min(int(timeout_seconds), 60))
        identity = hashlib.sha256(f"{runtime.key}\x00{conversation_id}".encode()).hexdigest()[:24]
        self.name = f"newscraft-{identity}-{secrets.token_hex(6)}"
        self._started = False
        self._closed = False
        self._prepared = False
        self._lock = asyncio.Lock()
        if resource_fetcher is not None and not allowed_urls:
            raise SandboxError("Custom resource providers require a trusted exact URL allowlist")
        if synthetic_fixture and resource_fetcher is None:
            raise SandboxError("Synthetic browsing requires a trusted fixture resource provider")
        self._resource_fetcher = resource_fetcher
        self._allowed_urls = frozenset(allowed_urls) if allowed_urls is not None else None
        self._synthetic_fixture = synthetic_fixture
        self._browser: BrowserSession | None = None
        self._browser_receipts: dict[str, Any] = {}
        self._run_identity = current_tenant_run()

    @staticmethod
    def schemas() -> list[dict[str, Any]]:
        return schemas()

    @staticmethod
    async def readiness() -> dict[str, Any]:
        from .quota import quota_readiness
        quota = await quota_readiness()
        if not quota.get("configured"):
            return {"ready": False, "configured": False, "verified": False, "quota": quota,
                    "reason": "Enforced workspace byte/inode quotas and reviewed seccomp policy are required"}
        image = os.environ.get("NEWSCRAFT_SANDBOX_IMAGE", "")
        if not image or not _IMAGE_RE.fullmatch(image):
            return {"ready": False, "configured": False, "verified": False, "reason": "Provision NEWSCRAFT_SANDBOX_IMAGE with Python, Playwright and Chromium"}
        if not shutil.which("docker"):
            return {"ready": False, "configured": False, "verified": False, "reason": "Docker CLI is unavailable; no host computer fallback is allowed"}
        if os.getuid() == 0:
            return {"ready": False, "configured": False, "verified": False, "reason": "Run the research service as a non-root user that owns its workspace"}
        try:
            sandbox = object.__new__(ComputerSandbox)
            sandbox._closed = False
            await sandbox._image_manifest(image)
        except (OSError, SandboxError, TimeoutError):
            return {"ready": False, "configured": False, "verified": False,
                    "reason": "Sandbox image, Docker, or reviewed capability manifest is unavailable; provision separately"}
        return {"ready": True, "configured": True, "verified": False,
                "capabilities": {name: {"configured": True, "verified": False} for name in ("terminal", "files", "browser")},
                "reason": "Reviewed image capability manifest matches; live execution is not verified"}

    async def _image_manifest(self, image: str) -> None:
        code, output, _ = await self._process(
            ["docker", "image", "inspect", "--format", "{{json .Config.Labels}}", image], timeout=5)
        try:
            labels = json.loads(output)
        except (ValueError, TypeError) as exc:
            raise SandboxError("Sandbox image has no reviewed capability manifest") from exc
        if code or not isinstance(labels, dict) or any(labels.get(key) != value for key, value in _IMAGE_CONTRACT.items()):
            raise SandboxError("Sandbox image capability manifest does not match deploy/sandbox.Dockerfile")

    def _docker_env(self) -> dict[str, str]:
        # Every invocation pins the local daemon and a private empty config.
        # Never forward credentials, contexts or ambient proxy settings.
        return {"PATH": os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin"), "LANG": "C.UTF-8"}

    async def _process(self, argv: list[str], *, payload: dict[str, Any] | None = None, timeout: float = 30) -> tuple[int, str, str]:
        from .docker_boundary import DockerBoundaryError, empty_docker_config, verified_docker_argv
        try:
            with empty_docker_config() as config:
                argv = await verified_docker_argv(argv, config_dir=config)
                return await self._process_pinned(argv, payload=payload, timeout=timeout)
        except DockerBoundaryError as exc:
            raise SandboxError("Docker daemon must be local to the verified workspace quota") from exc

    async def _process_pinned(self, argv: list[str], *, payload: dict[str, Any] | None, timeout: float) -> tuple[int, str, str]:
        process = await asyncio.create_subprocess_exec(*argv, stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, env=self._docker_env())
        async def consume(stream: asyncio.StreamReader) -> bytes:
            result = bytearray()
            while chunk := await stream.read(16384):
                result.extend(chunk)
                if len(result) > MAX_OUTPUT_BYTES:
                    raise SandboxError("Computer output exceeded 128 KiB; container stopped")
            return bytes(result)
        async def communicate() -> tuple[int, str, str]:
            if process.stdin:
                if payload is not None:
                    process.stdin.write(json.dumps(payload).encode())
                    await process.stdin.drain()
                process.stdin.close()
            stdout, stderr, code = await asyncio.gather(consume(process.stdout), consume(process.stderr), process.wait())
            return code, stdout.decode("utf-8", errors="replace"), stderr.decode("utf-8", errors="replace")
        try:
            return await asyncio.wait_for(communicate(), timeout=timeout)
        except BaseException:
            if process.returncode is None:
                try:
                    process.kill()
                except ProcessLookupError:
                    pass
            await process.wait()
            raise

    async def _remove(self) -> None:
        if self._browser is not None:
            browser, self._browser = self._browser, None
            await browser.close()
        if self._started:
            for _ in range(2):
                try:
                    code, _, _ = await self._process(["docker", "rm", "--force", self.name], timeout=10)
                    if code == 0:
                        self._started = False
                        return
                except (OSError, SandboxError, TimeoutError):
                    pass
            self._closed = True
            raise SandboxError("Container cleanup is unconfirmed; session blocked pending operator cleanup")

    async def _reclaim_scope(self) -> None:
        # The durable worker must own the conversation lease before entering
        # this method. Reclaim a crashed worker's detached compute before any
        # new container can write the persisted conversation workspace.
        code, output, _ = await self._process(
            ["docker", "ps", "--all", "--quiet", "--no-trunc",
             "--filter", "label=newscraft.managed=research-agent",
             "--filter", "label=newscraft.scope=" + self.runtime.task_key], timeout=5)
        identities = output.split()
        if code or len(identities) > 20 or any(not _CONTAINER_ID_RE.fullmatch(identity) for identity in identities):
            raise SandboxError("Conversation containers could not be reclaimed safely")
        for identity in identities:
            code, output, _ = await self._process(
                ["docker", "inspect", "--format", "{{json .Config.Labels}}", identity], timeout=5)
            try:
                labels = json.loads(output)
            except ValueError as exc:
                raise SandboxError("Conversation container ownership could not be verified") from exc
            if code or not isinstance(labels, dict) or labels.get("newscraft.scope") != self.runtime.task_key or labels.get("newscraft.managed") != "research-agent":
                raise SandboxError("Conversation container ownership could not be verified")
            code, _, _ = await self._process(["docker", "rm", "--force", identity], timeout=10)
            if code:
                raise SandboxError("Crashed conversation container could not be stopped")

    async def prepare(self) -> None:
        """Reclaim crashed compute under the caller's conversation OS lock.

        Call at run entry before checkpoint/workspace reads, even when the
        recovered run will not use computer tools. No image is pulled, started,
        or required for reclaiming an existing owned container.
        """
        if self._closed:
            raise SandboxError("Computer session is closed")
        if not self._prepared:
            await self._reclaim_scope()
            self._prepared = True

    async def _start(self) -> None:
        if self._closed:
            raise SandboxError("Computer session is closed")
        if self._started:
            return
        if not self.image:
            raise SandboxError("Provision NEWSCRAFT_SANDBOX_IMAGE before using computer tools")
        if os.getuid() == 0:
            raise SandboxError("Research service must run as a non-root workspace owner")
        root = self.runtime.workspace
        if not root.is_absolute() or any(path.is_symlink() for path in (root, *root.parents)) or not root.is_dir():
            raise SandboxError("Conversation workspace is unavailable or unsafe")
        # Mount syntax uses commas as separators; no user path may add options.
        if any(c in str(root) for c in (",", "\n", "\x00")):
            raise SandboxError("Conversation mount path is invalid")
        await self._image_manifest(self.image)
        await self.prepare()
        from .quota import WorkspaceQuotaError, verify_workspace_quota
        try:
            quota = await verify_workspace_quota(self.runtime)
        except WorkspaceQuotaError as exc:
            raise SandboxError("Conversation workspace quota/security policy is not enforced") from exc
        if not quota.get("quota_enforced") or not quota.get("seccomp_profile"):
            raise SandboxError("Conversation workspace requires enforced byte/inode quota and reviewed seccomp policy")
        argv = ["docker", "run", "--detach", "--pull=never", "--name", self.name,
                "--init",
                "--label", "newscraft.scope=" + self.runtime.task_key,
                "--label", "newscraft.managed=research-agent", "--network=none",
                "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges",
                "--security-opt", "seccomp=" + quota["seccomp_profile"],
                "--pids-limit=128", "--memory=768m", "--memory-swap=768m", "--cpus=1",
                "--ulimit", "nofile=256:256", "--ulimit", "fsize=33554432:33554432",
                "--user", f"{os.getuid()}:{os.getgid()}", "--workdir", "/workspace",
                "--tmpfs", "/tmp:rw,noexec,nosuid,nodev,size=128m,mode=1777",
                "--shm-size=128m", "--mount", f"type=bind,source={root},target=/workspace",
                "--env", "HOME=/workspace", "--env", "TMPDIR=/tmp", "--entrypoint", "python3",
                self.image, "-c", "import time; time.sleep(86400)"]
        # Mark it before creation so cancellation after Docker creates the
        # container still removes the owned name and all its exec children.
        self._started = True
        try:
            code, _, _ = await self._process(argv, timeout=20)
            if code:
                raise SandboxError("Sandbox could not start; check provisioned image and Docker")
        except BaseException:
            await asyncio.shield(self._remove())
            raise

    async def _exec_json(self, program: str, payload: dict[str, Any], timeout: float) -> dict[str, Any]:
        code, output, _ = await self._process(
            ["docker", "exec", "--interactive", self.name, "python3", "-I", "-c", program],
            payload=payload, timeout=timeout)
        if code:
            raise SandboxError("Computer operation failed inside the sandbox")
        try:
            result = json.loads(output)
            if not isinstance(result, dict):
                raise ValueError("not an object")
            return result
        except (ValueError, TypeError) as exc:
            raise SandboxError("Computer operation returned invalid output") from exc

    def browser_receipt(self, receipt_id: Any) -> Any | None:
        """Resolve an opaque id to the private host-issued evidence capability."""
        return self._browser_receipts.get(receipt_id) if isinstance(receipt_id, str) else None

    def _save_screenshot(self, data: bytes) -> str:
        root = os.open(self.runtime.workspace, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
        folder = None
        descriptor = None
        name = "capture-" + secrets.token_hex(12) + ".png"
        try:
            try:
                os.mkdir("browser-screenshots", mode=0o700, dir_fd=root)
            except FileExistsError:
                pass
            folder = os.open("browser-screenshots", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=root)
            descriptor = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=folder)
            offset = 0
            while offset < len(data):
                offset += os.write(descriptor, data[offset:])
            os.fsync(descriptor)
            return "/workspace/browser-screenshots/" + name
        except OSError as exc:
            raise SandboxError("Browser screenshot could not be persisted safely within the quota") from exc
        finally:
            if descriptor is not None:
                os.close(descriptor)
            if folder is not None:
                os.close(folder)
            os.close(root)

    async def _browser_action(self, args: dict[str, Any]) -> dict[str, Any]:
        action = args.get("action")
        if action not in {"navigate", "snapshot", "click", "fill", "type", "key", "scroll", "screenshot", "reset"}:
            raise SandboxError("Browser action is invalid")
        from .browser_state import BrowserStateError, load_browser_state, save_browser_state
        if action == "reset":
            await self._remove()
            try:
                save_browser_state(self.runtime, {"storage": {"cookies": [], "origins": []}, "input_tainted": False, "last_url": ""})
            except BrowserStateError as exc:
                raise SandboxError("Private browser state could not be reset safely") from exc
            self._browser_receipts.clear()
            return {"reset": True, "storage_cleared": True, "input_tainted": False, "evidence_available": False}
        payload: dict[str, Any] = {"action": action}
        if action == "navigate":
            try:
                url, _, _ = _public_url(args.get("url"))
            except BrowserNetworkError as exc:
                raise SandboxError("Browser navigation URL is not a public HTTP(S) destination") from exc
            if self._allowed_urls is not None and url not in self._allowed_urls:
                raise SandboxError("Browser URL is outside the trusted request allowlist")
            payload["url"] = url
        if action in {"click", "fill", "type"}:
            selector = args.get("selector")
            if not isinstance(selector, str) or not selector or len(selector) > 512:
                raise SandboxError("Browser action requires a bounded CSS selector")
            payload["selector"] = selector
        if action in {"fill", "type"}:
            text = args.get("text")
            if not isinstance(text, str) or len(text) > 4096:
                raise SandboxError("Browser entered text must be at most 4096 characters")
            payload["text"] = text
        if action == "key":
            key = args.get("key")
            if not isinstance(key, str) or not key or len(key) > 64:
                raise SandboxError("Browser key must be a bounded Playwright key chord")
            payload["key"] = key
        if action == "scroll":
            delta = args.get("delta_y")
            if isinstance(delta, bool) or not isinstance(delta, int) or not -4000 <= delta <= 4000:
                raise SandboxError("Browser scroll must be between -4000 and 4000 pixels")
            payload["delta_y"] = delta
        await self._start()
        if self._browser is None:
            try:
                state = load_browser_state(self.runtime)
            except BrowserStateError as exc:
                raise SandboxError("Private browser state could not be loaded safely") from exc
            self._browser = self._make_browser(state)
        try:
            result, document = await self._browser.command(payload, timeout=self.timeout_seconds)
        except BrowserProtocolError as exc:
            raise SandboxError("Interactive browser failed within its protocol or network budget") from exc
        try:
            save_browser_state(self.runtime, {"storage": self._browser.storage_state,
                "input_tainted": self._browser.input_tainted, "last_url": self._browser.last_url})
        except BrowserStateError as exc:
            raise SandboxError("Private browser state could not be persisted safely") from exc
        image = result.pop("_screenshot_bytes", None)
        if image is not None:
            result["screenshot_path"] = self._save_screenshot(image)
        result["input_tainted"] = self._browser.input_tainted
        evidence = result.pop("evidence_text", None)
        run = current_tenant_run() or self._run_identity
        if document and run and isinstance(evidence, str):
            from .browser_evidence import _issue_browser_receipt
            response = document["response"]
            receipt_id = secrets.token_hex(24)
            if run.runtime.key != self.runtime.key or run.thread_id != self.conversation_id:
                raise SandboxError("Browser run identity is inconsistent")
            receipt = _issue_browser_receipt(receipt_id=receipt_id, tenant_key=self.runtime.key,
                conversation_id=self.conversation_id, run_id=run.run_id, final_url=result["url"],
                rendered_text=evidence, title=result.get("title", ""), main_document_url=response.url,
                main_document_sha256=response.sha256, main_document_html=response.body.decode("utf-8", errors="replace"),
                response_headers=response.headers,
                fetched_at=datetime.fromtimestamp(document["fetched_at"], tz=timezone.utc).isoformat(),
                validated_request_count=document["validated_request_count"], navigation_id=result["navigation_id"],
                javascript_enabled=True, synthetic_fixture=self._synthetic_fixture,
                public_network_validated=not self._synthetic_fixture)
            self._browser_receipts[receipt_id] = receipt
            while len(self._browser_receipts) > 32:
                self._browser_receipts.pop(next(iter(self._browser_receipts)))
            result["receipt_id"] = receipt_id
        result["evidence_available"] = bool(result.get("receipt_id"))
        return result

    def _make_browser(self, state: dict[str, Any]) -> BrowserSession:
        return BrowserSession(self.name, env=self._docker_env(),
            browser_uid=os.getuid() + 65536, group_id=os.getgid(),
            resource_fetcher=self._resource_fetcher, allowed_urls=self._allowed_urls,
            storage_state=state["storage"], input_tainted=state["input_tainted"], last_url=state["last_url"])

    async def execute(self, name: str, args: Mapping[str, Any]) -> dict[str, Any]:
        async with self._lock:
            try:
                safe = guard_tool_arguments(name, args)
                if name not in {"terminal", "read_file", "write_file", "list_files", "browser"}:
                    raise SandboxError("Unknown computer tool")
                if name == "terminal":
                    command = safe.get("command")
                    if not isinstance(command, str) or not command or len(command.encode()) > 16384 or "\x00" in command:
                        raise SandboxError("Terminal command is invalid or exceeds 16 KiB")
                    timeout = self.timeout_seconds if safe.get("timeout_seconds") is None else safe["timeout_seconds"]
                    if isinstance(timeout, bool) or not isinstance(timeout, int) or not 1 <= timeout <= 60:
                        raise SandboxError("Terminal timeout must be between 1 and 60 seconds")
                    safe = {"command": command, "workdir": workspace_path(safe.get("workdir") or "/workspace")}
                    await self._start()
                    code, stdout, stderr = await self._process(
                        ["docker", "exec", "--interactive", self.name, "python3", "-I", "-c", _TERMINAL_PROGRAM],
                        payload=safe, timeout=timeout)
                    return {"exit_code": code, "stdout": stdout, "stderr": stderr, "network_enabled": False}
                if name in {"read_file", "write_file", "list_files"}:
                    safe["path"] = workspace_path(safe.get("path", "/workspace"))
                    if name == "write_file":
                        content = safe.get("content")
                        if not isinstance(content, str) or len(content.encode()) > MAX_FILE_BYTES:
                            raise SandboxError("File content must be a UTF-8 string up to 1 MiB")
                    safe["operation"] = name
                    await self._start()
                    return await self._exec_json(_FILE_PROGRAM, safe, self.timeout_seconds)
                return await self._browser_action(safe)
            except asyncio.CancelledError:
                await asyncio.shield(self._remove())
                raise
            except (TimeoutError, SandboxError) as exc:
                await asyncio.shield(self._remove())
                if isinstance(exc, TimeoutError):
                    raise SandboxError("Computer action timed out; container and subprocesses stopped") from exc
                raise

    async def close(self) -> None:
        self._closed = True
        await asyncio.shield(self._remove())
