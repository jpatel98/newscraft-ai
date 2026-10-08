"""Synthetic daemon fixtures. These tests do not start Docker or prove a kernel sandbox."""
import asyncio
import copy
import hashlib
import io
import json
import os
from pathlib import Path
import sqlite3
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch

from hermes_chat.executor_state import (ExecutorError, ExecutorUncertain, SnapshotStore, canonical_archive,
    MAX_ARCHIVE, MAX_FILE, MAX_FILES, MAX_WORKSPACE)
from hermes_chat.isolation import TenantIsolation
from hermes_chat.oci_executor import (OCIConfig, OCIComputer, DockerEngine, CommandResult, MEMORY,
    WORKSPACE_MOUNT, TMP_MOUNT, WATCHDOG)

IMAGE = "sha256:" + "a" * 64
CONTAINER = "b" * 64
DAEMON = "d" * 64


def operation(value):
    return hashlib.sha256(value.encode()).hexdigest()


def archive(files=None, *, export=False, member=None):
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode="w") as tar:
        for name, value in (files or {}).items():
            item = tarfile.TarInfo(("workspace/" if export else "") + name)
            data = value.encode() if isinstance(value, str) else value
            item.size = len(data)
            tar.addfile(item, io.BytesIO(data))
        if member:
            tar.addfile(member)
    return output.getvalue()


def contents(data):
    if not data:
        return {}
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:") as tar:
        return {item.name: tar.extractfile(item).read().decode() for item in tar if item.isfile()}


def container_document(name, labels):
    return {"Id": CONTAINER, "Name": "/" + name, "Image": IMAGE,
        "Config": {"Labels": labels, "User": "0:0", "WorkingDir": "/", "Entrypoint": ["/usr/local/bin/python3"], "Cmd": ["-I", "-S", "-c", WATCHDOG], "Healthcheck": {"Test": ["NONE"]}},
        "HostConfig": {"Privileged": False, "ReadonlyRootfs": True, "NetworkMode": "none", "CapAdd": [],
            "CapDrop": ["ALL"], "SecurityOpt": ["no-new-privileges=true"], "CgroupnsMode": "private", "IpcMode": "private",
            "PidMode": "", "UTSMode": "", "Binds": [], "Devices": [], "Memory": MEMORY, "MemorySwap": MEMORY,
            "NanoCpus": 1_000_000_000, "PidsLimit": 64, "Tmpfs": {"/workspace": WORKSPACE_MOUNT, "/tmp": TMP_MOUNT},
            "LogConfig": {"Type": "none"}}, "Mounts": []}


class FakeEngine:
    labels = staticmethod(DockerEngine.labels)
    verify_container = staticmethod(DockerEngine.verify_container)
    def __init__(self):
        self.daemon = DAEMON
        self.items = {}
        self.files = {}
        self.executions = []
        self.creates = 0
        self.create_error = False
        self.fail_remove = False
        self.lost_create = False
        self.running = asyncio.Event()
        self.block = False
        self.bad_snapshot = None
    async def probe(self):
        return IMAGE
    async def probe_host(self):
        return self.daemon
    async def create(self, image, name, labels):
        self.creates += 1
        if not self.lost_create:
            self.items[name] = container_document(name, labels)
        if self.create_error or self.lost_create:
            raise ExecutorError("synthetic interrupted create")
        return CONTAINER
    async def inspect(self, name):
        return copy.deepcopy(self.items.get(name))
    async def start(self, identity):
        pass
    async def restore(self, identity, data):
        self.files = contents(data)
    async def execute(self, identity, name, args):
        self.executions.append((name, args))
        self.running.set()
        if self.block:
            await asyncio.Event().wait()
        if name == "write_file":
            self.files[args["path"].removeprefix("/workspace/")] = args["content"]
            return {"bytes": len(args["content"].encode())}
        if name == "read_file":
            return {"content": self.files[args["path"].removeprefix("/workspace/")]}
        if name == "terminal":
            self.files["calculated.csv"] = "total\n3\n"
            return {"exit_code": 0, "stdout": "3\n"}
        return {"entries": sorted(self.files)}
    async def snapshot(self, identity):
        return canonical_archive(self.bad_snapshot or archive(self.files, export=True), container_export=True)
    async def remove(self, identity):
        if self.fail_remove:
            raise ExecutorError("synthetic cleanup failure")
        self.items.clear()


class ArchiveTests(unittest.TestCase):
    def test_snapshot_preserves_only_regular_files_with_normalized_metadata(self):
        data = canonical_archive(archive({"reports/brief.md": "Verified [1]"}, export=True), container_export=True)
        self.assertEqual(contents(data), {"reports/brief.md": "Verified [1]"})
        with tarfile.open(fileobj=io.BytesIO(data)) as tar:
            self.assertEqual(tar.getmembers()[0].uid, 1000)
            self.assertEqual(tar.getmembers()[0].mode, 0o600)

    def test_traversal_duplicates_links_special_files_and_sparse_entries_are_rejected(self):
        for name in ["../escape", "/outside", "a/../escape", "a\\b", "a//b", "a/./b", "a\x01b"]:
            with self.subTest(name=name), self.assertRaises(ExecutorError):
                canonical_archive(archive({name: "synthetic"}))
        for kind in [tarfile.SYMTYPE, tarfile.LNKTYPE, tarfile.FIFOTYPE, tarfile.CHRTYPE, tarfile.BLKTYPE]:
            item = tarfile.TarInfo("link")
            item.type, item.linkname = kind, "/host/secret"
            with self.subTest(kind=kind), self.assertRaises(ExecutorError):
                canonical_archive(archive(member=item))
        for data in [archive({"file": "x", "file/child": "y"}), archive({"big": b"x" * (MAX_FILE + 1)}),
                     archive({str(i): b"" for i in range(MAX_FILES + 1)}),
                     archive({str(i): b"x" * MAX_FILE for i in range(MAX_WORKSPACE // MAX_FILE + 1)}),
                     b"x" * (MAX_ARCHIVE + 1), b"not an archive"]:
            with self.assertRaises(ExecutorError):
                canonical_archive(data)


class ComputerTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name).resolve()
        self.isolation = TenantIsolation(root / "state", root / "staging")
        self.config = OCIConfig(IMAGE, root / "socket", root / "computer")
        self.store = SnapshotStore(self.config.state_root)
        self.engine = FakeEngine()
        self.computer = self.make()
    def tearDown(self):
        self.temp.cleanup()
    def make(self, tenant="tenant-one", thread="thread-one", run="run-one", engine=None):
        runtime = self.isolation.resolve(tenant, thread)
        return OCIComputer(runtime, thread, run, config=self.config, engine=engine or self.engine, store=self.store)

    async def test_files_survive_new_run_and_worker_object_without_sharing_tenants_or_threads(self):
        await self.computer.execute("write_file", {"path": "brief.md", "content": "verified [1]"}, operation_id=operation("write"))
        self.assertFalse(self.engine.items)
        new = self.make(run="run-two", engine=FakeEngine())
        result = await new.execute("read_file", {"path": "brief.md"}, operation_id=operation("read"))
        self.assertEqual(result["content"], "verified [1]")
        for computer in [self.make(tenant="tenant-two"), self.make(thread="thread-two")]:
            result = await computer.execute("list_files", {"path": "/workspace"}, operation_id=operation("list"))
            self.assertEqual(result["entries"], [])
        self.assertFalse(self.isolation.workspace_root.exists())  # No host workspace bind/extraction.

    async def test_duplicate_operation_replays_receipt_without_reexecution(self):
        result = await self.computer.execute("terminal", {"command": "synthetic calculation"}, operation_id=operation("same"))
        again = await self.make().execute("terminal", {"command": "synthetic calculation"}, operation_id=operation("same"))
        self.assertEqual(result, again)
        self.assertEqual(self.engine.creates, 1)

    async def test_cancel_waits_for_container_removal_and_discards_uncommitted_files(self):
        self.engine.block = True
        task = asyncio.create_task(self.computer.execute("terminal", {"command": "synthetic block"}, operation_id=operation("block")))
        await self.engine.running.wait()
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertFalse(self.engine.items)
        self.assertTrue(await self.make().cancel())
        self.assertFalse(self.store.pending(self.computer.scope, self.computer.run))
        self.engine.block = False
        with self.assertRaises(ExecutorUncertain):
            await self.make().execute("terminal", {"command": "synthetic block"}, operation_id=operation("block"))

    async def test_same_operation_with_changed_arguments_is_rejected(self):
        await self.computer.execute("terminal", {"command": "synthetic calculation"}, operation_id=operation("same"))
        with self.assertRaises(ExecutorError):
            await self.make().execute("terminal", {"command": "different calculation"}, operation_id=operation("same"))
        self.assertEqual(self.engine.creates, 1)

    async def test_worker_crash_recovery_cleans_exact_saved_container_before_new_actions(self):
        op = operation("crashed")
        name = "newscraft-action-crashfixture"
        self.store.admit(self.computer.scope, self.computer.run, op, name, DAEMON, "synthetic-request")
        labels = self.engine.labels(self.computer.scope, self.computer.run, op)
        self.engine.items[name] = container_document(name, labels)
        self.store.created(self.computer.scope, op, CONTAINER)
        self.assertTrue(await self.make().cancel())
        self.assertFalse(self.engine.items)
        self.assertFalse(self.store.pending(self.computer.scope, self.computer.run))

    async def test_unconfirmed_create_and_failed_removal_are_durably_quarantined(self):
        self.engine.lost_create = True
        with self.assertRaises(ExecutorUncertain):
            await self.computer.execute("terminal", {"command": "synthetic"}, operation_id=operation("lost"))
        self.assertFalse(await self.make().cancel())
        self.assertEqual(self.engine.executions, [])
        self.assertTrue(self.store.pending(self.computer.scope, self.computer.run))
        with self.assertRaises(ExecutorUncertain):
            await self.make(run="other-run").execute("terminal", {"command": "new"}, operation_id=operation("other"))
        self.assertEqual(self.engine.creates, 1)

    async def test_cleanup_refuses_other_labels_container_or_daemon(self):
        op, name = operation("pending"), "newscraft-action-pending"
        self.store.admit(self.computer.scope, self.computer.run, op, name, DAEMON, "synthetic-request")
        self.store.created(self.computer.scope, op, CONTAINER)
        labels = self.engine.labels(self.computer.scope, self.computer.run, op)
        self.engine.items[name] = container_document(name, labels)
        self.engine.items[name]["Config"]["Labels"]["newscraft.scope"] = "other"
        self.assertFalse(await self.computer.cancel())
        self.engine.items[name] = container_document(name, labels)
        self.engine.daemon = "different-daemon"
        self.assertFalse(await self.computer.cancel())
        self.engine.daemon = DAEMON
        self.engine.fail_remove = True
        self.assertFalse(await self.computer.cancel())
        self.assertTrue(self.engine.items)

    async def test_unsafe_snapshot_discards_changes_and_confirms_stop(self):
        item = tarfile.TarInfo("workspace/link")
        item.type, item.linkname = tarfile.SYMTYPE, "/etc/passwd"
        self.engine.bad_snapshot = archive(member=item)
        result = await self.computer.execute("terminal", {"command": "synthetic"}, operation_id=operation("unsafe"))
        self.assertIn("error", result)
        self.assertFalse(self.engine.items)
        self.assertFalse(self.store.pending(self.computer.scope, self.computer.run))

    async def test_nonzero_terminal_and_file_errors_preserve_the_last_committed_snapshot(self):
        await self.computer.execute("write_file", {"path": "original.md", "content": "committed"}, operation_id=operation("original"))
        original_execute = self.engine.execute
        for name, args, result in [
            ("terminal", {"command": "synthetic failing overwrite"}, {"exit_code": 1, "stderr": "synthetic failure"}),
            ("write_file", {"path": "original.md", "content": "partial"}, {"error": "synthetic file error"})]:
            async def failed(identity, tool, arguments):
                self.engine.files["original.md"] = "partial replacement"
                self.engine.files["uncommitted.txt"] = "discard this"
                return result
            self.engine.execute = failed
            self.assertEqual(await self.computer.execute(name, args, operation_id=operation("failed-" + name)), result)
            self.assertFalse(self.engine.items)
            self.engine.execute = original_execute
            fresh = self.make(run="read-after-" + name, engine=FakeEngine())
            read = await fresh.execute("read_file", {"path": "original.md"}, operation_id=operation("read-after-" + name))
            self.assertEqual(read["content"], "committed")
            self.assertNotIn("uncommitted.txt", fresh.engine.files)

    async def test_completed_receipt_recovery_needs_no_daemon_and_requires_exact_request(self):
        args = {"command": "synthetic calculation"}
        result = await self.computer.execute("terminal", args, operation_id=operation("receipt"))
        recovered = self.make()
        async def unavailable():
            raise AssertionError("Receipt recovery must not dispatch to the daemon")
        recovered.engine.probe = unavailable
        self.assertEqual(await recovered.completed("terminal", args, operation_id=operation("receipt")), result)
        with self.assertRaises(ExecutorError):
            await recovered.completed("terminal", {"command": "changed"}, operation_id=operation("receipt"))
        self.assertIsNone(await self.make(tenant="tenant-other").completed("terminal", args, operation_id=operation("receipt")))

    async def test_injection_cannot_select_identity_network_environment_or_host_paths(self):
        for args in [{"command": "synthetic", "env": {"SECRET": "x"}}, {"path": "../../host"},
                     {"path": "/etc/passwd"}, {"path": "brief", "container": "another"}]:
            with self.assertRaises(ValueError):
                await self.computer.execute("terminal" if "command" in args else "read_file", args, operation_id=operation(str(args)))
        self.assertEqual(self.engine.creates, 0)

    async def test_store_limit_rejects_admission_before_container_creation(self):
        with patch("hermes_chat.executor_state.MAX_OPERATIONS", 0):
            with self.assertRaises(ExecutorError):
                await self.computer.execute("terminal", {"command": "synthetic"}, operation_id=operation("quota"))
        self.assertEqual(self.engine.creates, 0)


class EngineTests(unittest.IsolatedAsyncioTestCase):
    async def test_tmpfs_restore_and_snapshot_use_guarded_exec_and_never_docker_cp_or_pause(self):
        engine = DockerEngine(OCIConfig(IMAGE, Path("/fixture/socket"), Path("/fixture/state")))
        requests = []
        async def command(args, **kwargs):
            requests.append((args, kwargs))
            return CommandResult(0, archive({"brief.md": "synthetic"}))
        engine.command = command
        await engine.restore(CONTAINER, archive({"brief.md": "synthetic"}))
        self.assertEqual(contents(await engine.snapshot(CONTAINER)), {"brief.md": "synthetic"})
        for args, kwargs in requests:
            self.assertEqual(args[:2], ["container", "exec"])
            self.assertIn("--user=1000:1000", args)
            self.assertIn('status["NoNewPrivs"]', args[-1])
            self.assertIn('"CapBnd"', args[-1])
        self.assertIn("quiesce()", requests[-1][0][-1])

    async def test_create_has_no_mounts_network_or_implicit_pull_and_exec_uses_unprivileged_uid(self):
        config = OCIConfig(IMAGE, Path("/fixture/socket"), Path("/fixture/private"))
        engine = DockerEngine(config)
        requests = []
        async def command(args, **kwargs):
            requests.append((args, kwargs))
            return CommandResult(0, (CONTAINER + "\n").encode() if args[:2] == ["container", "create"] else b"synthetic")
        engine.command = command
        await engine.create(IMAGE, "newscraft-action-fixture", engine.labels("scope", "run", "op"))
        args = requests[0][0]
        for required in ["--network=none", "--pull=never", "--read-only", "--cap-drop=ALL", "--pids-limit=64", "--workdir=/", "--no-healthcheck"]:
            self.assertIn(required, args)
        self.assertNotIn("--mount", args)
        self.assertNotIn("--volume", args)
        self.assertNotIn("--privileged", args)
        await engine.execute(CONTAINER, "terminal", {"command": "echo injected; $(not_on_host)"})
        args, kwargs = requests[-1]
        self.assertIn("--user=1000:1000", args)
        self.assertNotIn("echo injected", " ".join(args))
        self.assertIn("$(not_on_host)", kwargs["data"].decode())

    async def test_inspected_container_must_retain_every_isolation_boundary(self):
        labels = DockerEngine.labels("scope", "run", "op")
        original = container_document("fixture", labels)
        DockerEngine.verify_container(original, labels, IMAGE)
        for key, value in {"Privileged": True, "ReadonlyRootfs": False, "NetworkMode": "host", "CapAdd": ["SYS_ADMIN"],
                           "CapDrop": [], "SecurityOpt": [], "PidMode": "host", "Binds": ["/:/host"], "Memory": 0,
                           "MemorySwap": -1, "NanoCpus": 0, "PidsLimit": 0, "Tmpfs": {}}.items():
            changed = copy.deepcopy(original)
            changed["HostConfig"][key] = value
            with self.subTest(key=key), self.assertRaises(ExecutorError):
                DockerEngine.verify_container(changed, labels, IMAGE)

    async def test_probe_rejects_rootful_daemons_missing_limits_and_unpinned_images(self):
        engine = DockerEngine(OCIConfig(IMAGE, Path("/fixture/socket"), Path("/fixture/state")))
        engine.validate_host = lambda: None  # Only this synthetic fixture skips host OS checks.
        good = {"ID": "fixture", "OSType": "linux", "CgroupVersion": "2", "CgroupDriver": "systemd",
                "SecurityOptions": ["name=rootless", "name=seccomp,profile=builtin"],
                "MemoryLimit": True, "SwapLimit": True, "PidsLimit": True, "CpuCfsQuota": True}
        image = {"Id": IMAGE, "Config": {"Labels": {"newscraft.executor.contract": "v1"}}}
        for change in [{}, {"SecurityOptions": ["name=seccomp,profile=builtin"]}, {"CgroupVersion": "1"}, {"MemoryLimit": False}, {"PidsLimit": False}]:
            async def command(args, **kwargs):
                return CommandResult(0, json.dumps({**good, **change} if args[0] == "info" else image).encode())
            engine.command = command
            if change:
                with self.assertRaises(ExecutorError):
                    await engine.probe()
            else:
                self.assertEqual(await engine.probe(), IMAGE)
        with self.assertRaises(ValueError):
            OCIConfig("python:latest", Path("/fixture/socket"), Path("/fixture/state"))

    async def test_actual_process_transport_bounds_output_and_does_not_inherit_secrets(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            binary = root / "synthetic-docker"
            binary.write_text(f"#!{sys.executable}\nimport os,sys,time,json\n"
                "if sys.argv[-1]=='overflow': sys.stdout.write('x'*10000)\n"
                "elif sys.argv[-1]=='timeout': time.sleep(5)\n"
                "else: print(json.dumps(sorted(os.environ)))\n")
            binary.chmod(0o700)
            engine = DockerEngine(OCIConfig(IMAGE, root / "socket", root / "state", str(binary)))
            with patch.dict(os.environ, {"OPENAI_API_KEY": "synthetic-must-not-inherit", "DOCKER_CONTEXT": "must-not-inherit"}):
                result = await engine.command(["inspect-fixture"])
            self.assertNotIn("OPENAI_API_KEY", json.loads(result.stdout))
            self.assertNotIn("DOCKER_CONTEXT", json.loads(result.stdout))
            with self.assertRaises(ExecutorError):
                await engine.command(["overflow"], limit=100)
            with self.assertRaises(ExecutorError):
                await engine.command(["timeout"], seconds=.05)


if __name__ == "__main__":
    unittest.main()
