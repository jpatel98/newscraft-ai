"""Read-only admission proof for operator-provisioned XFS project quotas.

No quota is assigned, mounted, enabled, changed, or inferred from workspace files.
Unsupported storage fails closed. Kernel enforcement remains a deployment test.
"""
from __future__ import annotations

import asyncio
import fcntl
import hashlib
import json
import os
import platform
import re
import stat
import struct
import time
from pathlib import Path
from types import SimpleNamespace
from typing import Any

MAX_PROOF_SECONDS = 8
MAX_QUERY_BYTES = 128 * 1024
MAX_REGISTRY_BYTES = 1024 * 1024
MAX_REGISTRY_ENTRIES = 4096
MAX_SCAN_DEPTH = 64
UINT32_MAX = (1 << 32) - 1
FS_IOC_FSGETXATTR = 0x801C581F
FS_XFLAG_PROJINHERIT = 0x00000200
# Linux x86_64/aarch64 native and compat UAPI. Exclude high-word aliases too:
# ioctl's request is truncated to unsigned int by the kernel.
REQUIRED_IOCTL_DENIES = (0x401C5820, 0x40086602, 0x40046602)
SUPPORTED_ARCHITECTURES = {"x86_64": "SCMP_ARCH_X86_64", "aarch64": "SCMP_ARCH_AARCH64"}
DENY_ACTIONS = {"SCMP_ACT_ERRNO", "SCMP_ACT_KILL", "SCMP_ACT_KILL_PROCESS", "SCMP_ACT_KILL_THREAD"}
_SCOPE_RE = re.compile(r"^newscraft-[a-f0-9]{32}$")
_SAFE_MOUNT = re.compile(r"^/[A-Za-z0-9_./:+-]+$")
_COMMANDS = {"findmnt": "/usr/bin/findmnt", "xfs_io": "/usr/sbin/xfs_io", "xfs_quota": "/usr/sbin/xfs_quota"}


class WorkspaceQuotaError(RuntimeError):
    """Computer access cannot prove enforced persistent storage bounds."""


def _integer(value: Any, name: str, upper: int = (1 << 63) - 1) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not 0 < value <= upper:
        raise WorkspaceQuotaError(f"Quota {name} must be a finite positive integer")
    return value


def _limits() -> tuple[int, int]:
    try:
        values = (int(os.environ.get("NEWSCRAFT_WORKSPACE_MAX_BYTES", str(256 * 1024 * 1024))),
                  int(os.environ.get("NEWSCRAFT_WORKSPACE_MAX_INODES", "10000")))
    except ValueError:
        raise WorkspaceQuotaError("Workspace quota maxima must be finite positive integers") from None
    return (_integer(values[0], "maximum bytes", 2 * 1024 * 1024 * 1024),
            _integer(values[1], "maximum inodes", 100000))


def _open_directory(path: Path) -> int:
    if not path.is_absolute() or ".." in path.parts or path == Path("/"):
        raise WorkspaceQuotaError("Quota directory must be a dedicated absolute path")
    descriptor = os.open("/", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        for component in path.parts[1:]:
            child = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=descriptor)
            os.close(descriptor)
            descriptor = child
        return descriptor
    except BaseException:
        os.close(descriptor)
        raise


def _trusted_stat(info: os.stat_result) -> None:
    if info.st_uid != 0 or info.st_mode & 0o022:
        raise WorkspaceQuotaError("Quota operator configuration must be root-owned and not writable by the service")


def _read_trusted(path: Path, maximum: int) -> bytes:
    """Open every component without following links; no service-writable assets."""
    if not path.is_absolute() or ".." in path.parts:
        raise WorkspaceQuotaError("Quota operator configuration must use an absolute path")
    descriptor = os.open("/", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        _trusted_stat(os.fstat(descriptor))
        for component in path.parts[1:-1]:
            child = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=descriptor)
            os.close(descriptor)
            descriptor = child
            _trusted_stat(os.fstat(descriptor))
        child = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK, dir_fd=descriptor)
        os.close(descriptor)
        descriptor = child
        info = os.fstat(descriptor)
        _trusted_stat(info)
        if not stat.S_ISREG(info.st_mode) or info.st_size > maximum:
            raise WorkspaceQuotaError("Quota operator configuration must be a bounded regular file")
        content = os.read(descriptor, maximum + 1)
        after = os.fstat(descriptor)
        if len(content) > maximum or (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns) != (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns):
            raise WorkspaceQuotaError("Quota operator configuration changed during inspection")
        return content
    except OSError:
        raise WorkspaceQuotaError("Quota operator configuration is missing or cannot be read safely") from None
    finally:
        os.close(descriptor)


def _json(content: bytes) -> Any:
    def unique(pairs):
        result = {}
        for name, value in pairs:
            if name in result:
                raise WorkspaceQuotaError("Quota operator configuration has duplicate JSON fields")
            result[name] = value
        return result
    try:
        return json.loads(content, object_pairs_hook=unique)
    except (ValueError, UnicodeError):
        raise WorkspaceQuotaError("Quota operator configuration must be valid JSON") from None


def _registry() -> tuple[Path, dict[str, dict[str, Any]]]:
    raw = os.environ.get("NEWSCRAFT_QUOTA_REGISTRY", "")
    if not raw:
        raise WorkspaceQuotaError("Provision NEWSCRAFT_QUOTA_REGISTRY outside the sandbox before computer access")
    path = Path(raw)
    registry = _json(_read_trusted(path, MAX_REGISTRY_BYTES))
    if (not isinstance(registry, dict) or set(registry) != {"version", "workspaces"}
            or type(registry["version"]) is not int or registry["version"] != 1):
        raise WorkspaceQuotaError("Quota registry schema is unsupported")
    entries = registry["workspaces"]
    if not isinstance(entries, list) or not 0 < len(entries) <= MAX_REGISTRY_ENTRIES:
        raise WorkspaceQuotaError("Quota registry requires bounded operator-assigned workspaces")
    max_bytes, max_inodes = _limits()
    scopes: dict[str, dict[str, Any]] = {}
    projects = set()
    paths = set()
    fields = {"scope", "workspace", "device", "inode", "mount_target", "mount_source", "project_id", "hard_bytes", "hard_inodes"}
    for entry in entries:
        if not isinstance(entry, dict) or set(entry) != fields or not _SCOPE_RE.fullmatch(str(entry.get("scope", ""))):
            raise WorkspaceQuotaError("Quota registry workspace identity is invalid")
        scope = entry["scope"]
        workspace = Path(str(entry["workspace"]))
        mount = Path(str(entry["mount_target"]))
        if (not workspace.is_absolute() or not mount.is_absolute() or workspace == mount
                or ".." in workspace.parts or ".." in mount.parts or not workspace.is_relative_to(mount)
                or not _SAFE_MOUNT.fullmatch(str(mount)) or not _SAFE_MOUNT.fullmatch(str(entry["mount_source"]))
                or path.is_relative_to(workspace)):
            raise WorkspaceQuotaError("Quota registry paths are unsafe or visible inside the sandbox")
        project = _integer(entry["project_id"], "project ID", UINT32_MAX)
        _integer(entry["device"], "device")
        _integer(entry["inode"], "inode")
        _integer(entry["hard_bytes"], "hard bytes", max_bytes)
        _integer(entry["hard_inodes"], "hard inodes", max_inodes)
        if entry["hard_bytes"] % 1024:
            raise WorkspaceQuotaError("Quota hard bytes must be an exact 1 KiB multiple")
        identity = (entry["device"], project)
        if (scope in scopes or identity in projects
                or any(workspace.is_relative_to(Path(existing)) or Path(existing).is_relative_to(workspace) for existing in paths)):
            raise WorkspaceQuotaError("Quota projects and workspaces must belong to exactly one conversation")
        scopes[scope] = dict(entry)
        projects.add(identity)
        paths.add(str(workspace))
    return path, scopes


def _ioctl_allow_safe(rule: dict[str, Any]) -> bool:
    args = rule.get("args", [])
    if not isinstance(args, list):
        return False
    request_args = [arg for arg in args if isinstance(arg, dict) and arg.get("index") == 1]
    # libseccomp allows one comparison per argument. Whitelist an exact safe
    # 32-bit request; a generic allow can reintroduce truncated high-word aliases.
    if len(request_args) != 1:
        return False
    arg = request_args[0]
    value = arg.get("value")
    return arg.get("op") == "SCMP_CMP_EQ" and type(value) is int and 0 <= value <= UINT32_MAX and value not in REQUIRED_IOCTL_DENIES


def validate_seccomp_profile(profile: Any, architecture: str) -> None:
    native = SUPPORTED_ARCHITECTURES.get(architecture)
    if (not native or not isinstance(profile, dict) or not isinstance(profile.get("defaultAction"), str)
            or profile["defaultAction"] not in DENY_ACTIONS):
        raise WorkspaceQuotaError("Quota protection requires a supported architecture and default-deny seccomp profile")
    architectures = profile.get("architectures", [])
    if architectures != [native] or profile.get("archMap"):
        raise WorkspaceQuotaError("Quota seccomp profile must explicitly restrict the native supported architecture")
    rules = profile.get("syscalls")
    if not isinstance(rules, list) or not 1 <= len(rules) <= 1024:
        raise WorkspaceQuotaError("Quota seccomp rules are missing or unbounded")
    denied = set()
    for rule in rules:
        if (not isinstance(rule, dict) or not isinstance(rule.get("names"), list)
                or not 0 < len(rule["names"]) <= 512
                or any(not isinstance(name, str) or not re.fullmatch(r"[a-z0-9_]+", name) for name in rule["names"])):
            raise WorkspaceQuotaError("Quota seccomp syscall rule is invalid")
        action = rule.get("action")
        if not isinstance(action, str) or action not in DENY_ACTIONS | {"SCMP_ACT_ALLOW"}:
            raise WorkspaceQuotaError("Quota seccomp policy cannot use trace, notify, log or unknown actions")
        names = rule["names"]
        args = rule.get("args", [])
        indexes = set()
        if not isinstance(args, list) or len(args) > 6:
            raise WorkspaceQuotaError("Quota seccomp argument rules are invalid")
        for arg in args:
            if (not isinstance(arg, dict) or type(arg.get("index")) is not int or not 0 <= arg["index"] <= 5
                    or arg["index"] in indexes or not isinstance(arg.get("op"), str)
                    or arg["op"] not in {"SCMP_CMP_NE", "SCMP_CMP_LT", "SCMP_CMP_LE", "SCMP_CMP_EQ", "SCMP_CMP_GE", "SCMP_CMP_GT", "SCMP_CMP_MASKED_EQ"}
                    or type(arg.get("value")) is not int or not 0 <= arg["value"] <= (1 << 64) - 1
                    or (arg.get("op") == "SCMP_CMP_MASKED_EQ" and (type(arg.get("valueTwo")) is not int or not 0 <= arg["valueTwo"] <= (1 << 64) - 1))):
                raise WorkspaceQuotaError("Quota seccomp requires one valid comparison per argument")
            indexes.add(arg["index"])
        if action == "SCMP_ACT_ALLOW" and any(name in {"file_setattr", "quotactl", "quotactl_fd", "mount", "mount_setattr", "fsopen", "fsconfig", "fsmount", "move_mount", "open_tree", "bpf"} for name in names):
            raise WorkspaceQuotaError("Quota seccomp policy permits a filesystem administration bypass")
        if "ioctl" not in names:
            continue
        if rule.get("includes") or rule.get("excludes"):
            raise WorkspaceQuotaError("Quota ioctl rules cannot depend on capability or architecture conditions")
        if action == "SCMP_ACT_ALLOW" and not _ioctl_allow_safe(rule):
            raise WorkspaceQuotaError("Quota seccomp ioctl allow rule permits project inheritance changes")
        if action in DENY_ACTIONS and len(args) == 1:
            arg = args[0]
            if arg.get("index") == 1 and arg.get("op") == "SCMP_CMP_MASKED_EQ" and arg.get("value") == UINT32_MAX:
                denied.add(arg.get("valueTwo"))
    if not set(REQUIRED_IOCTL_DENIES).issubset(denied):
        raise WorkspaceQuotaError("Quota seccomp profile lacks explicit low-word filesystem ioctl denies")


def verify_seccomp_profile() -> dict[str, Any]:
    path = Path(os.environ.get("NEWSCRAFT_SANDBOX_SECCOMP_PROFILE", ""))
    if not str(path) or str(path) == ".":
        raise WorkspaceQuotaError("Provision NEWSCRAFT_SANDBOX_SECCOMP_PROFILE to protect quota inheritance")
    content = _read_trusted(path, MAX_REGISTRY_BYTES)
    architecture = platform.machine().lower()
    validate_seccomp_profile(_json(content), architecture)
    return {"seccomp_profile": str(path), "seccomp_sha256": hashlib.sha256(content).hexdigest(),
            "architecture": architecture, "ioctl_denies": list(REQUIRED_IOCTL_DENIES)}


def _trusted_command(name: str) -> str:
    candidate = Path(_COMMANDS[name])
    # Distribution /usr/sbin tools must be regular immutable-to-service files.
    _trusted_stat(candidate.stat())
    if candidate.is_symlink() or not candidate.is_file() or not os.access(candidate, os.X_OK):
        raise WorkspaceQuotaError("Read-only quota query tools are not available safely")
    for parent in candidate.parents:
        _trusted_stat(parent.stat())
    return str(candidate)


async def _command(name: str, args: list[str], *, descriptors: tuple[int, ...] = ()) -> str:
    binary = _trusted_command(name)
    process = await asyncio.create_subprocess_exec(binary, *args, stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, pass_fds=descriptors,
        cwd="/", env={"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LC_ALL": "C", "LANG": "C"})
    async def bounded(stream):
        content = bytearray()
        while chunk := await stream.read(16384):
            content.extend(chunk)
            if len(content) > MAX_QUERY_BYTES:
                raise WorkspaceQuotaError("Quota query output exceeded its limit")
        return bytes(content)
    try:
        stdout, stderr, code = await asyncio.wait_for(asyncio.gather(bounded(process.stdout), bounded(process.stderr), process.wait()), timeout=2)
        if code or stderr.strip():
            raise WorkspaceQuotaError("Read-only quota query was rejected; operator access is required")
        return stdout.decode("ascii")
    except BaseException:
        if process.returncode is None:
            process.kill()
        await process.wait()
        raise


def _mount(output: str, entry: dict[str, Any]) -> dict[str, Any]:
    parsed = _json(output.encode())
    mounts = parsed.get("filesystems") if isinstance(parsed, dict) else None
    if not isinstance(mounts, list) or len(mounts) != 1 or not isinstance(mounts[0], dict):
        raise WorkspaceQuotaError("Quota mount identity could not be verified")
    mount = mounts[0]
    options = set(str(mount.get("options", "")).split(","))
    major_minor = f"{os.major(entry['device'])}:{os.minor(entry['device'])}"
    if (mount.get("fstype") != "xfs" or mount.get("target") != entry["mount_target"]
            or mount.get("source") != entry["mount_source"] or mount.get("maj:min") != major_minor
            or mount.get("fsroot") != "/" or not {"prjquota", "pquota"}.intersection(options)
            or options.intersection({"pqnoenforce", "prjquota=noenforce", "noquota", "ro"})):
        raise WorkspaceQuotaError("Persistent workspace requires the exact enforced XFS project-quota mount")
    return mount


def _enforcement(output: str, entry: dict[str, Any]) -> None:
    expected = f"Project quota state on {entry['mount_target']} ({entry['mount_source']})"
    lines = [line.strip() for line in output.splitlines() if line.strip()]
    if (sum(line == expected for line in lines) != 1 or not lines or lines[0] != expected
            or sum(line == "Accounting: ON" for line in lines) != 1
            or sum(line == "Enforcement: ON" for line in lines) != 1
            or any("OFF" in line for line in lines)):
        raise WorkspaceQuotaError("XFS project quota accounting and enforcement must both be active")


def _hard_limit(output: str, entry: dict[str, Any], kind: str) -> int:
    # quota -N -n -v -b/-i yields device used soft hard warnings timer mount.
    fields = output.split()
    if len(fields) != 7 or fields[0] != entry["mount_source"] or fields[-1] != entry["mount_target"]:
        raise WorkspaceQuotaError("XFS quota limit output is missing or ambiguous")
    try:
        used, soft, hard = (int(value) for value in fields[1:4])
    except ValueError:
        raise WorkspaceQuotaError("XFS quota hard limit must be an exact integer") from None
    if min(used, soft) < 0:
        raise WorkspaceQuotaError("XFS quota usage or limits are invalid")
    _integer(hard, "hard limit")
    actual = hard * 1024 if kind == "bytes" else hard
    if actual != entry[f"hard_{kind}"]:
        raise WorkspaceQuotaError("Kernel quota hard limit differs from the operator assignment")
    return actual


def _attributes(descriptor: int) -> tuple[int, int]:
    buffer = bytearray(28)
    fcntl.ioctl(descriptor, FS_IOC_FSGETXATTR, buffer, True)
    flags, _, _, project, _ = struct.unpack("=5I", buffer[:20])
    return project, flags


def _same_directory(descriptor: int, path: Path, entry: dict[str, Any]) -> None:
    opened = os.fstat(descriptor)
    current = _open_directory(path)
    try:
        actual = os.fstat(current)
        identity = (entry["device"], entry["inode"])
        if (opened.st_dev, opened.st_ino) != identity or (actual.st_dev, actual.st_ino) != identity:
            raise WorkspaceQuotaError("Conversation workspace inode changed or has the wrong assignment")
    finally:
        os.close(current)


def _tree(descriptor: int, entry: dict[str, Any], deadline: float) -> None:
    checked = 0
    seen = set()
    def visit(fd: int, depth: int):
        nonlocal checked
        if time.monotonic() > deadline or depth > MAX_SCAN_DEPTH:
            raise WorkspaceQuotaError("Quota tree proof exceeded its bound")
        info = os.fstat(fd)
        checked += 1
        identity = (info.st_dev, info.st_ino)
        if checked > entry["hard_inodes"] or info.st_dev != entry["device"]:
            raise WorkspaceQuotaError("Workspace tree exceeds its inode bound or crosses a mount")
        project, flags = _attributes(fd)
        is_directory = stat.S_ISDIR(info.st_mode)
        if project != entry["project_id"] or (is_directory and not flags & FS_XFLAG_PROJINHERIT):
            raise WorkspaceQuotaError("Every workspace inode must have the assigned project and directory inheritance")
        if not is_directory:
            return
        if identity in seen:
            raise WorkspaceQuotaError("Quota tree has an aliased directory")
        seen.add(identity)
        with os.scandir(fd) as items:
            for item in items:
                before = item.stat(follow_symlinks=False)
                if not (stat.S_ISDIR(before.st_mode) or stat.S_ISREG(before.st_mode)):
                    raise WorkspaceQuotaError("Quota tree cannot contain links, devices, or special files")
                child = os.open(item.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK, dir_fd=fd)
                try:
                    after = os.fstat(child)
                    if (before.st_dev, before.st_ino, before.st_mode) != (after.st_dev, after.st_ino, after.st_mode):
                        raise WorkspaceQuotaError("Quota tree changed during verification")
                    visit(child, depth + 1)
                finally:
                    os.close(child)
    visit(descriptor, 0)


async def verify_workspace_quota(runtime: Any) -> dict[str, Any]:
    """Raise before computer access or model-directed persistent workspace writes."""
    descriptor = None
    try:
        if platform.system() != "Linux" or platform.machine().lower() not in SUPPORTED_ARCHITECTURES:
            raise WorkspaceQuotaError("Persistent computer access requires provisioned Linux XFS project quotas")
        if not _SCOPE_RE.fullmatch(str(runtime.task_key)) or not getattr(runtime, "conversation_id", None):
            raise WorkspaceQuotaError("Quota verification requires a server-bound conversation runtime")
        registry_path, entries = _registry()
        entry = entries.get(runtime.task_key)
        if entry is None or entry["workspace"] != str(runtime.workspace):
            raise WorkspaceQuotaError("Operator must assign a unique project quota to this conversation workspace")
        profile = verify_seccomp_profile()
        if Path(profile["seccomp_profile"]).is_relative_to(Path(entry["workspace"])):
            raise WorkspaceQuotaError("Quota seccomp profile must be outside the sandbox")
        path = Path(entry["workspace"])
        descriptor = _open_directory(path)
        _same_directory(descriptor, path, entry)
        async with asyncio.timeout(MAX_PROOF_SECONDS):
            mount_output = await _command("findmnt", ["--json", "--target", str(path), "--output", "TARGET,SOURCE,FSTYPE,OPTIONS,FSROOT,MAJ:MIN"])
            _mount(mount_output, entry)
            state, blocks, inodes, attrs = await asyncio.gather(
                _command("xfs_quota", ["-x", "-D", "/dev/null", "-P", "/dev/null", "-c", "state -p", entry["mount_target"]]),
                _command("xfs_quota", ["-D", "/dev/null", "-P", "/dev/null", "-c", f"quota -p -b -n -N -v {entry['project_id']}", entry["mount_target"]]),
                _command("xfs_quota", ["-D", "/dev/null", "-P", "/dev/null", "-c", f"quota -p -i -n -N -v {entry['project_id']}", entry["mount_target"]]),
                _command("xfs_io", ["-r", "-c", "stat", f"/proc/self/fd/{descriptor}"], descriptors=(descriptor,)),
            )
            _enforcement(state, entry)
            hard_bytes = _hard_limit(blocks, entry, "bytes")
            hard_inodes = _hard_limit(inodes, entry, "inodes")
            projects = re.findall(r"^fsxattr\.projid = ([0-9]+)$", attrs, flags=re.M)
            # xfs_io emits xflags annotations after the raw hexadecimal value.
            flags = re.findall(r"^fsxattr\.xflags = (0x[0-9a-fA-F]+)(?: .*|)$", attrs, flags=re.M)
            if projects != [str(entry["project_id"])] or len(flags) != 1 or not int(flags[0], 16) & FS_XFLAG_PROJINHERIT:
                raise WorkspaceQuotaError("Read-only XFS inode attributes do not prove project inheritance")
            _tree(descriptor, entry, time.monotonic() + 2)
            _same_directory(descriptor, path, entry)
            final_mount, final_state, final_blocks, final_inodes = await asyncio.gather(
                _command("findmnt", ["--json", "--target", str(path), "--output", "TARGET,SOURCE,FSTYPE,OPTIONS,FSROOT,MAJ:MIN"]),
                _command("xfs_quota", ["-x", "-D", "/dev/null", "-P", "/dev/null", "-c", "state -p", entry["mount_target"]]),
                _command("xfs_quota", ["-D", "/dev/null", "-P", "/dev/null", "-c", f"quota -p -b -n -N -v {entry['project_id']}", entry["mount_target"]]),
                _command("xfs_quota", ["-D", "/dev/null", "-P", "/dev/null", "-c", f"quota -p -i -n -N -v {entry['project_id']}", entry["mount_target"]]),
            )
            _mount(final_mount, entry)
            _enforcement(final_state, entry)
            _hard_limit(final_blocks, entry, "bytes")
            _hard_limit(final_inodes, entry, "inodes")
            refreshed_path, refreshed_entries = _registry()
            if refreshed_path != registry_path or refreshed_entries.get(runtime.task_key) != entry or verify_seccomp_profile() != profile:
                raise WorkspaceQuotaError("Quota assignment or seccomp proof changed before admission")
        return {"quota_enforced": True, "configured": True, "backend": "xfs-project", "scope": runtime.task_key,
                "hard_bytes": hard_bytes, "hard_inodes": hard_inodes, "project_inheritance": True,
                "kernel_live_write_tested": False, **profile}
    except WorkspaceQuotaError:
        raise
    except (OSError, ValueError, UnicodeError, TimeoutError, AttributeError):
        raise WorkspaceQuotaError("Persistent workspace quota proof is unavailable; computer access is blocked") from None
    finally:
        if descriptor is not None:
            os.close(descriptor)


async def quota_readiness() -> dict[str, Any]:
    """Verify one provisioned assignment; every admitted conversation is rechecked."""
    try:
        if platform.system() != "Linux":
            raise WorkspaceQuotaError("Persistent computer access requires provisioned Linux XFS project quotas")
        _, entries = _registry()
        scope, entry = next(iter(entries.items()))
        proof = await verify_workspace_quota(SimpleNamespace(task_key=scope, workspace=Path(entry["workspace"]), conversation_id="quota-readiness"))
        return {"configured": True, "quota_enforced": True, "backend": "xfs-project", "max_bytes": _limits()[0],
                "max_inodes": _limits()[1], "per_conversation_verification": True, "kernel_live_write_tested": False}
    except WorkspaceQuotaError as exc:
        return {"configured": False, "quota_enforced": False, "backend": "unavailable", "reason": str(exc), "kernel_live_write_tested": False}
