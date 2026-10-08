"""Real controller/store/RPC integration with synthetic container and page peers.

No Docker, browser binary, public website or paid API is used by these tests.
"""
import asyncio
import base64
import copy
import hashlib
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import AsyncMock, patch

from hermes_chat.browser_controller import browser_arguments
from hermes_chat.browser_executor import BROWSER_POLICY, OCIBrowserBackend, reviewed_seccomp
from hermes_chat.browser_store import BrowserStore, EMPTY
from hermes_chat.executor_state import ExecutorError, ExecutorUncertain, SnapshotStore
from hermes_chat.isolation import TenantIsolation
from hermes_chat.oci_executor import DockerEngine, OCIConfig, OCIBrowserComputer, OCIComputerFactory
from hermes_chat.retrieval import ResearchTools, RetrievalConfig
from test_browser_rpc import ProtocolProcess, URL, response
from test_oci_executor import FakeEngine, IMAGE, operation, archive

PROFILE = {"defaultAction": "SCMP_ACT_ERRNO", "syscalls": [
    {"names": ["clone", "setns", "unshare"], "action": "SCMP_ACT_ALLOW"}]}
# Deliberately insufficient for a real browser; only a synthetic inspect fixture.
PROFILE_BYTES = json.dumps(PROFILE).encode()
PROFILE_HASH = hashlib.sha256(PROFILE_BYTES).hexdigest()
ARTICLE = ("The source reports a confirmed event with three measured results. " * 12)
HTML = ("<html><head><title>Research fixture</title></head><body><article>" + ARTICLE + "</article></body></html>").encode()
PRIVATE_MARKER = "synthetic-private-profile"
STORAGE = {"cookies": [], "origins": [{"origin": "https://fixture.example", "localStorage": [
    {"name": "private-fixture", "value": PRIVATE_MARKER}]}]}
PNG = b"\x89PNG\r\n\x1a\nsynthetic-image"


class BrowserPeer(ProtocolProcess):
    def __init__(self):
        super().__init__()
        self.fail_action = None
        self.seen_storage = None

    def receive(self, message):
        if message.get("event") is None:
            self.seen_storage = copy.deepcopy(message["storage_state"])
            self.url = message.get("last_url")
        if message.get("event") == "command" and message["action"] == self.fail_action:
            self.emit({"event": "result", "id": message["id"], "error": "synthetic partial action"})
            return
        super().receive(message)

    def result(self, message):
        result = {"url": self.url, "title": "Research fixture", "text": ARTICLE + f"Clicks {self.count}",
                  "evidence_text": ARTICLE, "page_id": self.page, "navigation_id": self.nav,
                  "scripts_enabled": True, "storage_state": copy.deepcopy(STORAGE)}
        if message["action"] == "screenshot":
            result["screenshot_base64"] = base64.b64encode(PNG).decode()
        self.emit({"event": "result", "id": message["id"], "result": result})


class BrowserEngine(FakeEngine):
    def __init__(self):
        super().__init__()
        self.peers = []
        self.programs = []

    async def create(self, image, name, labels):
        identity = await super().create(image, name, labels)
        item = self.items[name]
        item["State"] = {"Running": False, "Status": "created"}
        item["Config"]["Cmd"][-1] = BROWSER_POLICY.watchdog
        item["HostConfig"].update(Memory=BROWSER_POLICY.memory, MemorySwap=BROWSER_POLICY.memory,
            PidsLimit=BROWSER_POLICY.pids, SecurityOpt=["no-new-privileges=true", "seccomp=" + json.dumps(PROFILE)])
        item["HostConfig"]["Tmpfs"]["/tmp"] = BROWSER_POLICY.temporary
        return identity

    async def start(self, identity):
        for item in self.items.values():
            if item["Id"] == identity:
                item["State"] = {"Running": True, "Status": "running"}

    @staticmethod
    def verify_container(item, labels, image):
        DockerEngine.verify_container(item, labels, image, policy=BROWSER_POLICY, seccomp=PROFILE)

    async def spawn_browser(self, identity, program, limit):
        self.programs.append(program)
        peer = BrowserPeer()
        self.peers.append(peer)
        return peer

    async def remove(self, identity):
        await super().remove(identity)
        for peer in self.peers:
            if peer.returncode is None:
                peer.kill()


def fixture_config(root):
    return OCIConfig(IMAGE, root / "socket", root / "computer", browser_image=IMAGE,
        browser_seccomp=root / "reviewed.json", browser_seccomp_sha256=PROFILE_HASH)


def browser_factory(root):
    config = fixture_config(root)
    terminal, browser = FakeEngine(), BrowserEngine()
    fetch = AsyncMock(return_value=response(body=HTML))
    def factory(runtime, thread, run):
        return OCIBrowserComputer(runtime, thread, run, config=config, engine=terminal, browser_backend=browser,
            resource_fetcher=fetch, allowed_urls=frozenset({URL}), synthetic_fixture=True)
    factory.policy = {"kind": "synthetic-browser-oci-fixture"}
    return factory, terminal, browser, fetch


class BrowserControllerTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name).resolve()
        self.isolation = TenantIsolation(self.root / "identities", self.root / "staging")
        self.factory, self.terminal, self.engine, self.fetch = browser_factory(self.root)
        self.computers = []
        self.computer = self.make()

    def make(self, tenant="tenant-one", thread="thread-one", run="run-one"):
        value = self.factory(self.isolation.resolve(tenant, thread), thread, run)
        self.computers.append(value)
        return value

    async def asyncTearDown(self):
        self.engine.fail_remove = False
        for value in self.computers:
            await value.cancel()
        self.temp.cleanup()

    async def action(self, action, identity=None, computer=None, **args):
        return await (computer or self.computer).execute("browser", {"action": action, **args},
            operation_id=operation(identity or action))

    async def test_live_page_survives_terminal_actions_without_sharing_its_process_or_profile(self):
        first = await self.action("navigate", url=URL)
        self.assertTrue(first["evidence_available"])
        await self.computer.execute("write_file", {"path": "brief.md", "content": "Research [1]"}, operation_id=operation("file"))
        second = await self.action("click", selector="button")
        third = await self.action("snapshot")
        self.assertTrue(second["text"].endswith("Clicks 1"))
        self.assertEqual(second["text"], third["text"])
        self.assertEqual(self.engine.creates, 1)
        self.assertEqual(self.terminal.creates, 1)
        self.assertEqual(self.fetch.await_count, 1)
        self.assertNotIn(PRIVATE_MARKER, json.dumps([first, second, third, self.terminal.files]))
        self.assertNotIn("storage_state", first)
        self.assertNotIn("evidence_text", first)
        self.assertIn("chromium_sandbox=True", self.engine.programs[0])
        await self.computer.close()
        self.assertFalse(self.engine.items)

    async def test_profile_survives_run_and_worker_restart_but_is_scoped_to_tenant_and_conversation(self):
        await self.action("navigate", url=URL)
        await self.computer.close()
        resumed = self.make(run="run-two")
        await self.action("navigate", "resume", computer=resumed, url=URL)
        self.assertEqual(self.engine.peers[-1].seen_storage, STORAGE)
        await resumed.close()
        for other in [self.make(tenant="tenant-two"), self.make(thread="thread-two")]:
            await self.action("navigate", "other", computer=other, url=URL)
            self.assertEqual(self.engine.peers[-1].seen_storage, EMPTY["storage"])
            await other.close()
        self.assertFalse(self.isolation.workspace_root.exists())

    async def test_screenshot_merges_into_conversation_files_and_never_returns_encoded_bytes(self):
        await self.computer.execute("write_file", {"path": "brief.md", "content": "Research [1]"}, operation_id=operation("file"))
        await self.action("navigate", url=URL)
        result = await self.action("screenshot")
        self.assertEqual(result["screenshot_sha256"], hashlib.sha256(PNG).hexdigest())
        self.assertNotIn("screenshot_base64", result)
        with self.computer.store.connect() as db:
            data = db.execute("SELECT snapshot FROM workspaces WHERE scope=?", (self.computer.scope,)).fetchone()[0]
        with tarfile.open(fileobj=io.BytesIO(data)) as snapshot:
            self.assertEqual(snapshot.extractfile("brief.md").read(), b"Research [1]")
            self.assertEqual(snapshot.extractfile(result["screenshot_path"].removeprefix("/workspace/")).read(), PNG)

    async def test_multilingual_page_results_remain_within_the_public_receipt_bound(self):
        await self.action("navigate", url=URL)
        session = self.computer.browser.session
        with patch.object(session, "command", new_callable=AsyncMock, return_value=({
                "url": URL, "text": "界" * 24000, "title": "界" * 512,
                "links": [{"text": "界" * 160, "href": "界" * 512}] * 30}, None)):
            result = await self.action("snapshot")
        self.assertNotIn("error", result)
        self.assertLessEqual(len(result["text"].encode()), 24000)
        self.assertLess(len(json.dumps(result, ensure_ascii=False).encode()), 96000)

    async def test_duplicate_receipt_and_private_evidence_replay_without_browser_dispatch(self):
        first = await self.action("navigate", url=URL)
        await self.computer.close()
        resumed = self.make()
        result = await resumed.completed("browser", {"action": "navigate", "url": URL}, operation_id=operation("navigate"))
        self.assertEqual(first, result)
        self.assertEqual(await self.action("navigate", computer=resumed, url=URL), first)
        self.assertEqual(self.engine.creates, 1)
        tools = ResearchTools(RetrievalConfig())
        tools.bind_run("tenant-one", "thread-one", "run-one")
        tools.remember_browser_receipt(resumed.browser_receipt(first["receipt_id"]))
        self.assertIn(URL, tools._fetched)
        with self.assertRaises(ExecutorError):
            await resumed.completed("browser", {"action": "snapshot"}, operation_id=operation("navigate"))
        self.assertIsNone(self.make(tenant="tenant-two").browser_receipt(first["receipt_id"]))

    async def test_failed_input_persists_taint_before_effect_and_reset_restores_citation_eligibility(self):
        await self.action("navigate", url=URL)
        self.engine.peers[0].fail_action = "fill"
        failed = await self.action("fill", selector="input", text="invented quote")
        self.assertIn("error", failed)
        self.assertFalse(self.engine.items)
        resumed = self.make(run="run-two")
        read = await self.action("navigate", "tainted", computer=resumed, url=URL)
        self.assertTrue(read["input_tainted"])
        self.assertFalse(read["evidence_available"])
        await self.action("reset", computer=resumed)
        clean = await self.action("navigate", "clean", computer=resumed, url=URL)
        self.assertTrue(clean["evidence_available"])
        self.assertEqual(self.engine.peers[-1].seen_storage, EMPTY["storage"])

    async def test_cancellation_drains_gateway_and_removes_container_before_acknowledgement(self):
        entered, stopped = asyncio.Event(), asyncio.Event()
        async def blocked(*args, **kwargs):
            entered.set()
            try:
                await asyncio.Event().wait()
            finally:
                stopped.set()
        self.fetch.side_effect = blocked
        task = asyncio.create_task(self.action("navigate", url=URL))
        await asyncio.wait_for(entered.wait(), 2)
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertTrue(stopped.is_set())
        self.assertFalse(self.engine.items)
        with self.assertRaises(ExecutorUncertain):
            await self.action("navigate", url=URL)

    async def test_worker_recovery_terminates_exact_saved_browser_before_replaying_receipts(self):
        first = await self.action("navigate", url=URL)
        resumed = self.make()
        await resumed.recover()
        self.assertFalse(self.engine.items)
        self.assertEqual(await self.action("navigate", computer=resumed, url=URL), first)
        self.assertEqual(self.engine.creates, 1)
        self.assertIsNone(resumed.browser.session)

    async def test_uncertain_create_is_quarantined_without_retry(self):
        self.engine.lost_create = True
        with self.assertRaises(ExecutorUncertain):
            await self.action("navigate", url=URL)
        self.assertFalse(await self.computer.cancel())
        with self.assertRaises(ExecutorUncertain):
            await self.action("navigate", "different", url=URL)
        self.assertEqual(self.engine.creates, 1)

    async def test_new_turn_recovers_absent_previous_run_browser_without_repeating_action(self):
        first = await self.action("navigate", url=URL)
        old = self.computer.browser.store.session(self.computer.scope)
        await self.engine.remove(old["container"])  # Crashed worker left its row behind.
        resumed = self.make(run="run-two")
        await resumed.recover()
        self.assertIsNone(resumed.browser.store.session(resumed.scope))
        self.assertEqual(await self.computer.completed("browser", {"action": "navigate", "url": URL},
            operation_id=operation("navigate")), first)
        self.assertEqual(self.engine.creates, 1)
        await self.action("navigate", "new-turn", computer=resumed, url=URL)
        self.assertEqual(self.engine.peers[-1].seen_storage, STORAGE)
        self.assertEqual(self.engine.creates, 2)

    async def test_new_turn_reaps_exact_exited_previous_container(self):
        await self.action("navigate", url=URL)
        next(iter(self.engine.items.values()))["State"] = {"Running": False, "Status": "exited"}
        resumed = self.make(run="run-two")
        await resumed.recover()
        self.assertFalse(self.engine.items)
        self.assertIsNone(resumed.browser.store.session(resumed.scope))
        self.assertEqual(resumed.browser.store.profile(resumed.scope)["storage"], STORAGE)

    async def test_previous_run_recovery_rejects_unknown_create_and_unconfirmed_ownership(self):
        await self.action("navigate", url=URL)
        name, original = next(iter(self.engine.items.items()))
        original = copy.deepcopy(original)
        stopped = {"Running": False, "Status": "exited"}
        resumed = self.make(run="run-two")
        for change in [{"State": {}}, {"State": {"Running": False, "Status": "created"}},
                       {"State": stopped, "Id": "f" * 64},
                       {"State": stopped, "Config": {"Labels": {}}}]:
            self.engine.items[name] = {**copy.deepcopy(original), **change}
            with self.subTest(change=change), self.assertRaises(ExecutorUncertain):
                await resumed.recover()
            self.assertTrue(self.engine.items)
        self.engine.items[name] = {**copy.deepcopy(original), "State": stopped}
        daemon = self.engine.daemon
        self.engine.daemon = "different-daemon"
        with self.assertRaises(ExecutorUncertain):
            await resumed.recover()
        self.engine.daemon = daemon
        self.engine.items.clear()
        with self.computer.store.connect() as db:
            db.execute("UPDATE browser_sessions SET phase='creating',container=NULL WHERE scope=?", (self.computer.scope,))
        with self.assertRaises(ExecutorUncertain):
            await resumed.recover()
        self.assertIsNotNone(resumed.browser.store.session(resumed.scope))

    async def test_foreign_daemon_container_or_run_cannot_be_removed(self):
        await self.action("navigate", url=URL)
        other_run = self.make(run="run-two")
        self.assertFalse(await other_run.cancel())
        with self.assertRaises(ExecutorUncertain):
            await other_run.recover()
        self.assertTrue(self.engine.items)
        original = self.engine.daemon
        self.engine.daemon = "different-daemon"
        self.assertFalse(await self.computer.cancel())
        self.engine.daemon = original
        item = next(iter(self.engine.items.values()))
        identity = item["Id"]
        item["Id"] = "f" * 64
        self.assertFalse(await self.computer.cancel())
        item["Id"] = identity
        self.assertTrue(await self.computer.cancel())

    async def test_cancelled_action_cannot_create_a_late_container(self):
        controller = self.computer.browser
        op = operation("admission-race")
        controller.store.admit_action(controller.scope, controller.run, op, "request")
        controller.store.closed(controller.scope, controller.run)
        with self.assertRaises(ExecutorUncertain):
            await controller.start(op)
        self.assertEqual(self.engine.creates, 0)

    async def test_shared_retention_limit_blocks_browser_before_daemon_effects(self):
        with patch("hermes_chat.executor_state.MAX_OPERATIONS", 0):
            with self.assertRaises(ExecutorError):
                await self.action("navigate", url=URL)
        self.assertEqual(self.engine.creates, 0)

    async def test_pending_browser_action_blocks_terminal_admission(self):
        controller = self.computer.browser
        controller.store.admit_action(controller.scope, controller.run, operation("pending"), "request")
        with self.assertRaises(ExecutorUncertain):
            await self.computer.execute("terminal", {"command": "synthetic"}, operation_id=operation("terminal"))
        self.assertEqual(self.terminal.creates, 0)

    async def test_pipe_failure_still_removes_container_but_cannot_claim_success(self):
        await self.action("navigate", url=URL)
        session = self.computer.browser.session
        original = session.close
        async def failed():
            await original()
            raise OSError("synthetic pipe error")
        session.close = failed
        self.assertFalse(await self.computer.cancel())
        self.assertFalse(self.engine.items)
        self.assertTrue(await self.computer.cancel())


    async def test_readiness_rejects_unsupported_worker_before_daemon_probes(self):
        factory = OCIComputerFactory(fixture_config(self.root))
        with patch.object(DockerEngine, "probe", new_callable=AsyncMock, return_value=IMAGE) as terminal, \
             patch.object(OCIBrowserBackend, "probe", new_callable=AsyncMock, return_value=IMAGE) as browser:
            self.assertTrue((await factory.readiness())["configured"])
            for target, value in [("sys.version_info", (3, 12)), ("sys.implementation.name", "pypy"),
                                  ("asyncio.get_running_loop", lambda: object())]:
                terminal.reset_mock()
                browser.reset_mock()
                with self.subTest(runtime=target), patch("hermes_chat.browser_network." + target, value):
                    ready = await factory.readiness()
                self.assertFalse(ready["configured"])
                self.assertFalse(ready["browser"])
                self.assertEqual(ready["tools"], [])
                self.assertIn("CPython 3.11", ready["sandboxReason"])
                terminal.assert_not_awaited()
                browser.assert_not_awaited()

    async def test_unsupported_worker_cannot_admit_browser_even_without_readiness(self):
        with patch("hermes_chat.browser_network.sys.version_info", (3, 12)):
            with self.assertRaisesRegex(ExecutorError, "CPython 3.11"):
                await self.computer.recover()
            result = await self.action("navigate", url=URL)
        self.assertIn("error", result)
        self.assertEqual(self.engine.creates, 0)
        self.fetch.assert_not_awaited()


class BrowserBoundaryTests(unittest.IsolatedAsyncioTestCase):
    async def test_reviewed_policy_requires_exact_private_file_and_deny_default(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root).resolve() / "profile.json"
            path.write_bytes(PROFILE_BYTES)
            path.chmod(0o600)
            self.assertEqual(reviewed_seccomp(path, PROFILE_HASH), PROFILE)
            for change in [b"{}", json.dumps({**PROFILE, "defaultAction": "SCMP_ACT_ALLOW"}).encode()]:
                path.write_bytes(change)
                with self.assertRaises(ExecutorError):
                    reviewed_seccomp(path, hashlib.sha256(change).hexdigest())
            path.write_bytes(PROFILE_BYTES)
            with self.assertRaises(ExecutorError):
                reviewed_seccomp(path, "0" * 64)
            path.chmod(0o666)
            with self.assertRaises(ExecutorError):
                reviewed_seccomp(path, PROFILE_HASH)
            path.chmod(0o600)
            link = path.with_name("link")
            link.symlink_to(path)
            with self.assertRaises(ExecutorError):
                reviewed_seccomp(link, PROFILE_HASH)

    async def test_browser_rpc_uses_fixed_argv_and_no_provider_or_host_environment(self):
        with tempfile.TemporaryDirectory() as root:
            backend = OCIBrowserBackend(fixture_config(Path(root).resolve()))
            with patch("asyncio.create_subprocess_exec", new_callable=AsyncMock) as spawn:
                await backend.spawn_browser("b" * 64, "# trusted fixed program", 1024)
            argv = spawn.await_args.args
            self.assertIn("--user=1000:1000", argv)
            self.assertIn("--workdir=/tmp", argv)
            self.assertIn("MEMORY_LIMIT=1073741824", argv[-1])
            self.assertEqual(set(spawn.await_args.kwargs["env"]), {"PATH", "LANG"})
            self.assertNotIn("--privileged", argv)
            self.assertNotIn("--network=host", argv)

    async def test_configured_browser_fails_readiness_if_profile_or_backend_probe_fails(self):
        with tempfile.TemporaryDirectory() as root:
            factory = OCIComputerFactory(fixture_config(Path(root).resolve()))
            with patch.object(DockerEngine, "probe", new_callable=AsyncMock, return_value=IMAGE):
                ready = await factory.readiness()
            self.assertFalse(ready["configured"])
            self.assertFalse(ready["browser"])

    async def test_browser_arguments_reject_private_urls_and_identity_overrides(self):
        for args in [{"action": "navigate", "url": "http://127.0.0.1/secret"},
                     {"action": "navigate", "url": "file:///etc/passwd"},
                     {"action": "navigate", "url": URL, "tenant": "other"},
                     {"action": "snapshot", "text": "unexpected"},
                     {"action": "scroll", "delta_y": True}]:
            with self.assertRaises(ValueError):
                browser_arguments(args)


if __name__ == "__main__":
    unittest.main()
