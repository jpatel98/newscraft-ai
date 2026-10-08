from __future__ import annotations

import asyncio
import copy
import json
import os
import stat
import tempfile
import time
import unittest
from contextlib import ExitStack
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

from hermes_chat import quota


class QuotaContractTests(unittest.IsolatedAsyncioTestCase):
    def _fixture(self, root):
        path = Path(root).resolve() / "workspace"
        path.mkdir()
        info = path.stat()
        scope = "newscraft-" + "a" * 32
        entry = {"scope": scope, "workspace": str(path), "device": info.st_dev, "inode": info.st_ino,
                 "mount_target": str(path.parent), "mount_source": "/dev/test-xfs", "project_id": 123,
                 "hard_bytes": 1024 * 1024, "hard_inodes": 256}
        runtime = SimpleNamespace(task_key=scope, workspace=path, conversation_id="server-conversation")
        return runtime, entry

    def _mount(self, entry, **changes):
        return json.dumps({"filesystems": [{"target": entry["mount_target"], "source": entry["mount_source"],
            "fstype": "xfs", "options": "rw,relatime,prjquota", "fsroot": "/",
            "maj:min": f"{os.major(entry['device'])}:{os.minor(entry['device'])}", **changes}]})

    def _state(self, entry, active="ON"):
        return f"Project quota state on {entry['mount_target']} ({entry['mount_source']})\n  Accounting: ON\n  Enforcement: {active}\n  Inode: #123 (1 blocks, 1 extents)\n"

    def _report(self, entry, kind, hard=None):
        limit = entry["hard_bytes"] // 1024 if kind == "bytes" else entry["hard_inodes"]
        return f"{entry['mount_source']} 1 0 {limit if hard is None else hard} 00 [--------] {entry['mount_target']}\n"

    def _patches(self, entry, command=None):
        async def queries(name, args, **kwargs):
            if name == "findmnt":
                return self._mount(entry)
            if name == "xfs_io":
                return "fsxattr.projid = 123\nfsxattr.xflags = 0x200 [proj-inherit]\n"
            if "state -p" in args:
                return self._state(entry)
            return self._report(entry, "bytes" if " -b " in " ".join(args) else "inodes")
        stack = ExitStack()
        stack.enter_context(patch.object(quota.platform, "system", return_value="Linux"))
        stack.enter_context(patch.object(quota.platform, "machine", return_value="x86_64"))
        stack.enter_context(patch.object(quota, "_registry", return_value=(Path("/etc/newscraft/quotas.json"), {entry["scope"]: entry})))
        stack.enter_context(patch.object(quota, "verify_seccomp_profile", return_value={"seccomp_profile": "/etc/newscraft/seccomp.json", "seccomp_sha256": "a" * 64, "architecture": "x86_64", "ioctl_denies": list(quota.REQUIRED_IOCTL_DENIES)}))
        stack.enter_context(patch.object(quota, "_attributes", return_value=(123, quota.FS_XFLAG_PROJINHERIT)))
        stack.enter_context(patch.object(quota, "_command", side_effect=command or queries))
        return stack, queries

    async def test_supported_contract_checks_kernel_metadata_not_workspace_markers(self):
        with tempfile.TemporaryDirectory() as root:
            runtime, entry = self._fixture(root)
            (runtime.workspace / ".quota.json").write_text('{"quota_enforced": false}')
            stack, _ = self._patches(entry)
            with stack:
                result = await quota.verify_workspace_quota(runtime)
            self.assertTrue(result["quota_enforced"])
            self.assertEqual(result["hard_bytes"], 1024 * 1024)
            self.assertEqual(result["hard_inodes"], 256)
            self.assertFalse(result["kernel_live_write_tested"])
            self.assertEqual(result["seccomp_profile"], "/etc/newscraft/seccomp.json")

    async def test_unsupported_mac_storage_fails_before_any_query(self):
        with patch.object(quota.platform, "system", return_value="Darwin"), patch.object(quota, "_command") as query:
            with self.assertRaisesRegex(quota.WorkspaceQuotaError, "Linux XFS"):
                await quota.verify_workspace_quota(SimpleNamespace())
            self.assertFalse((await quota.quota_readiness())["configured"])
        query.assert_not_called()

    async def test_wrong_backend_bind_mount_or_noenforce_is_rejected(self):
        with tempfile.TemporaryDirectory() as root:
            runtime, entry = self._fixture(root)
            for change in ({"fstype": "ext4"}, {"fsroot": "/subtree"}, {"options": "rw,pqnoenforce"},
                           {"source": "/dev/other"}, {"maj:min": "999:99"}, {"target": "/other"}):
                async def queries(name, args, **kwargs):
                    return self._mount(entry, **change)
                stack, _ = self._patches(entry, queries)
                with self.subTest(change=change), stack, self.assertRaises(quota.WorkspaceQuotaError):
                    await quota.verify_workspace_quota(runtime)

    async def test_accounting_without_enforcement_never_satisfies_gate(self):
        with tempfile.TemporaryDirectory() as root:
            runtime, entry = self._fixture(root)
            stack, normal = self._patches(entry)
            async def queries(name, args, **kwargs):
                return self._state(entry, "OFF") if "state -p" in args else await normal(name, args, **kwargs)
            with stack, patch.object(quota, "_command", side_effect=queries), self.assertRaisesRegex(quota.WorkspaceQuotaError, "both be active"):
                await quota.verify_workspace_quota(runtime)

    async def test_missing_unlimited_or_wrong_hard_limit_is_rejected(self):
        with tempfile.TemporaryDirectory() as root:
            runtime, entry = self._fixture(root)
            for hard in (0, -1, 9999999):
                stack, normal = self._patches(entry)
                async def queries(name, args, **kwargs):
                    return self._report(entry, "bytes", hard) if " -b " in " ".join(args) else await normal(name, args, **kwargs)
                with self.subTest(hard=hard), stack, patch.object(quota, "_command", side_effect=queries), self.assertRaises(quota.WorkspaceQuotaError):
                    await quota.verify_workspace_quota(runtime)

    async def test_missing_inode_hard_limit_is_rejected(self):
        with tempfile.TemporaryDirectory() as root:
            runtime, entry = self._fixture(root)
            stack, normal = self._patches(entry)
            async def queries(name, args, **kwargs):
                return self._report(entry, "inodes", 0) if " -i " in " ".join(args) else await normal(name, args, **kwargs)
            with stack, patch.object(quota, "_command", side_effect=queries), self.assertRaises(quota.WorkspaceQuotaError):
                await quota.verify_workspace_quota(runtime)

    async def test_inode_project_and_inheritance_are_required_for_entire_tree(self):
        with tempfile.TemporaryDirectory() as root:
            runtime, entry = self._fixture(root)
            nested = runtime.workspace / "nested"
            nested.mkdir()
            (nested / "file").write_text("existing output")
            for attrs in ((0, quota.FS_XFLAG_PROJINHERIT), (123, 0)):
                stack, _ = self._patches(entry)
                with self.subTest(attrs=attrs), stack, patch.object(quota, "_attributes", return_value=attrs), self.assertRaises(quota.WorkspaceQuotaError):
                    await quota.verify_workspace_quota(runtime)

    async def test_many_files_and_background_writer_fixture_cannot_bypass_project_check(self):
        # Real filesystem contents exercise the walk; quota attributes/queries are
        # contract fixtures. This is not a kernel EDQUOT concurrency test.
        with tempfile.TemporaryDirectory() as root:
            runtime, entry = self._fixture(root)
            for number in range(150):
                (runtime.workspace / f"output-{number}").write_text("x")
            stack, _ = self._patches(entry)
            with stack, patch.object(quota, "_attributes", return_value=(123, quota.FS_XFLAG_PROJINHERIT)) as attributes:
                self.assertTrue((await quota.verify_workspace_quota(runtime))["quota_enforced"])
                self.assertEqual(attributes.call_count, 151)
            bad_inode = (runtime.workspace / "output-99").stat().st_ino
            def changed_by_previous_background_writer(fd):
                return (0 if os.fstat(fd).st_ino == bad_inode else 123, quota.FS_XFLAG_PROJINHERIT)
            stack, _ = self._patches(entry)
            with stack, patch.object(quota, "_attributes", side_effect=changed_by_previous_background_writer), self.assertRaises(quota.WorkspaceQuotaError):
                await quota.verify_workspace_quota(runtime)

    async def test_workspace_replacement_during_query_is_rejected(self):
        with tempfile.TemporaryDirectory() as root:
            runtime, entry = self._fixture(root)
            stack, normal = self._patches(entry)
            switched = False
            async def queries(name, args, **kwargs):
                nonlocal switched
                if name == "xfs_io" and not switched:
                    switched = True
                    runtime.workspace.rename(runtime.workspace.with_name("old-workspace"))
                    runtime.workspace.mkdir()
                return await normal(name, args, **kwargs)
            with stack, patch.object(quota, "_command", side_effect=queries), self.assertRaisesRegex(quota.WorkspaceQuotaError, "inode changed"):
                await quota.verify_workspace_quota(runtime)

    async def test_enforcement_changed_during_verification_is_rejected(self):
        with tempfile.TemporaryDirectory() as root:
            runtime, entry = self._fixture(root)
            stack, normal = self._patches(entry)
            checks = 0
            async def queries(name, args, **kwargs):
                nonlocal checks
                if "state -p" in args:
                    checks += 1
                    return self._state(entry, "ON" if checks == 1 else "OFF")
                return await normal(name, args, **kwargs)
            with stack, patch.object(quota, "_command", side_effect=queries), self.assertRaises(quota.WorkspaceQuotaError):
                await quota.verify_workspace_quota(runtime)

    async def test_operator_assignment_or_seccomp_change_before_admission_is_rejected(self):
        with tempfile.TemporaryDirectory() as root:
            runtime, entry = self._fixture(root)
            stack, _ = self._patches(entry)
            changed = {**entry, "hard_inodes": entry["hard_inodes"] + 1}
            with stack, patch.object(quota, "_registry", side_effect=[
                    (Path("/etc/newscraft/quotas.json"), {entry["scope"]: entry}),
                    (Path("/etc/newscraft/quotas.json"), {entry["scope"]: changed})]), self.assertRaisesRegex(quota.WorkspaceQuotaError, "changed before admission"):
                await quota.verify_workspace_quota(runtime)
            stack, _ = self._patches(entry)
            profile = {"seccomp_profile": "/etc/newscraft/seccomp.json", "seccomp_sha256": "a" * 64,
                       "architecture": "x86_64", "ioctl_denies": list(quota.REQUIRED_IOCTL_DENIES)}
            with stack, patch.object(quota, "verify_seccomp_profile", side_effect=[profile, {**profile, "seccomp_sha256": "b" * 64}]), self.assertRaisesRegex(quota.WorkspaceQuotaError, "changed before admission"):
                await quota.verify_workspace_quota(runtime)

    async def test_symlink_wrong_inode_and_wrong_scope_reject_admission(self):
        with tempfile.TemporaryDirectory() as root:
            runtime, entry = self._fixture(root)
            (runtime.workspace / "escape").symlink_to(Path(root) / "outside")
            stack, _ = self._patches(entry)
            with stack, self.assertRaises(quota.WorkspaceQuotaError):
                await quota.verify_workspace_quota(runtime)
            (runtime.workspace / "escape").unlink()
            entry["inode"] += 1
            stack, _ = self._patches(entry)
            with stack, self.assertRaises(quota.WorkspaceQuotaError):
                await quota.verify_workspace_quota(runtime)
            entry["inode"] -= 1
            runtime.task_key = "newscraft-" + "b" * 32
            stack, _ = self._patches(entry)
            with stack, self.assertRaisesRegex(quota.WorkspaceQuotaError, "assign a unique"):
                await quota.verify_workspace_quota(runtime)

    async def test_read_query_failure_and_timeouts_fail_closed_without_details(self):
        with tempfile.TemporaryDirectory() as root:
            runtime, entry = self._fixture(root)
            for error in (OSError("fixture-sensitive-request-details"), TimeoutError()):
                async def queries(*args, **kwargs):
                    raise error
                stack, _ = self._patches(entry, queries)
                with stack, self.assertRaises(quota.WorkspaceQuotaError) as caught:
                    await quota.verify_workspace_quota(runtime)
                self.assertNotIn("fixture-sensitive", str(caught.exception))


class QuotaPolicyTests(unittest.TestCase):
    def _profile(self):
        return {"defaultAction": "SCMP_ACT_ERRNO", "defaultErrnoRet": 1, "architectures": ["SCMP_ARCH_X86_64"], "syscalls": [
            {"names": ["read", "write", "openat"], "action": "SCMP_ACT_ALLOW"},
            {"names": ["ioctl"], "action": "SCMP_ACT_ALLOW", "args": [
                {"index": 1, "op": "SCMP_CMP_EQ", "value": quota.FS_IOC_FSGETXATTR}]},
            *[{"names": ["ioctl"], "action": "SCMP_ACT_ERRNO", "errnoRet": 13, "args": [
                {"index": 1, "op": "SCMP_CMP_MASKED_EQ", "value": quota.UINT32_MAX, "valueTwo": request}]} for request in quota.REQUIRED_IOCTL_DENIES]]}

    def test_native_default_deny_policy_protects_ioctl_low_word(self):
        quota.validate_seccomp_profile(self._profile(), "x86_64")
        profile = self._profile()
        profile["architectures"] = ["SCMP_ARCH_AARCH64"]
        quota.validate_seccomp_profile(profile, "aarch64")

    def test_malformed_seccomp_values_fail_with_bounded_configuration_error(self):
        profiles = []
        profile = self._profile(); profile["defaultAction"] = {}; profiles.append(profile)
        profile = self._profile(); profile["syscalls"][0]["action"] = []; profiles.append(profile)
        profile = self._profile(); profile["syscalls"][0]["names"] = [None]; profiles.append(profile)
        profile = self._profile(); profile["syscalls"][1]["args"][0]["op"] = {}; profiles.append(profile)
        profile = self._profile(); profile["syscalls"][1]["args"][0]["index"] = True; profiles.append(profile)
        for profile in profiles:
            with self.subTest(profile=profile), self.assertRaises(quota.WorkspaceQuotaError):
                quota.validate_seccomp_profile(profile, "x86_64")

    def test_default_allow_compat_architecture_and_high_word_bypass_are_rejected(self):
        profiles = []
        profile = self._profile(); profile["defaultAction"] = "SCMP_ACT_ALLOW"; profiles.append(profile)
        profile = self._profile(); profile["architectures"].append("SCMP_ARCH_X86"); profiles.append(profile)
        profile = self._profile(); profile["syscalls"][1]["args"] = profile["syscalls"][1]["args"][1:]; profiles.append(profile)
        profile = self._profile(); profile["syscalls"][1]["args"] = []; profiles.append(profile)
        profile = self._profile(); profile["syscalls"][1]["args"][0]["value"] |= 1 << 32; profiles.append(profile)
        profile = self._profile(); profile["syscalls"][1]["args"].append({"index": 1, "op": "SCMP_CMP_NE", "value": quota.REQUIRED_IOCTL_DENIES[0]}); profiles.append(profile)
        profile = self._profile(); profile["archMap"] = [{"architecture": "SCMP_ARCH_X86_64", "subArchitectures": ["SCMP_ARCH_X86"]}]; profiles.append(profile)
        profile = self._profile(); profile["syscalls"][-1]["args"].append({"index": 0, "op": "SCMP_CMP_EQ", "value": 999}); profiles.append(profile)
        profile = self._profile(); profile["syscalls"] = profile["syscalls"][:-1]; profiles.append(profile)
        profile = self._profile(); profile["syscalls"][-1]["includes"] = {"caps": ["CAP_SYS_ADMIN"]}; profiles.append(profile)
        profile = self._profile(); profile["syscalls"][0]["names"].append("file_setattr"); profiles.append(profile)
        for profile in profiles:
            with self.subTest(profile=profile), self.assertRaises(quota.WorkspaceQuotaError):
                quota.validate_seccomp_profile(profile, "x86_64")
        with self.assertRaises(quota.WorkspaceQuotaError):
            quota.validate_seccomp_profile(self._profile(), "riscv64")

    def test_forged_service_owned_workspace_metadata_does_not_become_operator_proof(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root).resolve() / "forged-registry.json"
            path.write_text('{"version": 1, "workspaces": []}')
            with self.assertRaises(quota.WorkspaceQuotaError):
                quota._read_trusted(path, quota.MAX_REGISTRY_BYTES)

    def test_operator_configuration_ownership_mode_and_duplicate_json_are_required(self):
        for uid, mode in ((501, stat.S_IFREG | 0o600), (0, stat.S_IFREG | 0o666), (0, stat.S_IFREG | 0o620)):
            with self.subTest(uid=uid, mode=mode), self.assertRaises(quota.WorkspaceQuotaError):
                quota._trusted_stat(SimpleNamespace(st_uid=uid, st_mode=mode))
        with self.assertRaises(quota.WorkspaceQuotaError):
            quota._json(b'{"version":1,"version":1}')

    def test_registry_rejects_shared_projects_unbounded_limits_and_workspace_local_registry(self):
        entry = {"scope": "newscraft-" + "a" * 32, "workspace": "/srv/xfs/conversation", "device": 2049,
                 "inode": 100, "mount_target": "/srv/xfs", "mount_source": "/dev/sdb1", "project_id": 1,
                 "hard_bytes": 1048576, "hard_inodes": 100}
        mutations = []
        second = {**entry, "scope": "newscraft-" + "b" * 32, "workspace": "/srv/xfs/other"}; mutations.append([entry, second])
        overlapping = {**second, "project_id": 2, "workspace": "/srv/xfs/conversation/nested"}
        mutations.append([entry, overlapping]); mutations.append([overlapping, entry])
        mutations.append([{**entry, "hard_bytes": 0}]); mutations.append([{**entry, "hard_inodes": 0}])
        mutations.append([{**entry, "hard_bytes": 16 * 1024 * 1024 * 1024}]); mutations.append([{**entry, "project_id": 0}])
        for entries in mutations:
            with self.subTest(entries=entries), patch.dict(os.environ, {"NEWSCRAFT_QUOTA_REGISTRY": "/etc/newscraft/quotas.json"}), patch.object(quota, "_read_trusted", return_value=json.dumps({"version": 1, "workspaces": entries}).encode()), self.assertRaises(quota.WorkspaceQuotaError):
                quota._registry()
        with patch.dict(os.environ, {"NEWSCRAFT_QUOTA_REGISTRY": "/srv/xfs/conversation/.quota.json"}), patch.object(quota, "_read_trusted", return_value=json.dumps({"version": 1, "workspaces": [entry]}).encode()), self.assertRaises(quota.WorkspaceQuotaError):
            quota._registry()

    def test_tree_walk_has_inode_and_time_bounds(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root).resolve()
            (path / "one").write_text("1")
            info = path.stat()
            entry = {"device": info.st_dev, "project_id": 1, "hard_inodes": 1}
            fd = quota._open_directory(path)
            try:
                with patch.object(quota, "_attributes", return_value=(1, quota.FS_XFLAG_PROJINHERIT)):
                    with self.assertRaises(quota.WorkspaceQuotaError):
                        quota._tree(fd, entry, time.monotonic() + 1)
                    with self.assertRaises(quota.WorkspaceQuotaError):
                        quota._tree(fd, entry, time.monotonic() - 1)
            finally:
                os.close(fd)
