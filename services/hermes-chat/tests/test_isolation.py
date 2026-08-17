from __future__ import annotations

import concurrent.futures
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from contextlib import nullcontext
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import MagicMock, patch
from pathlib import Path

from hermes_chat.isolation import (
    TENANT_HEADER,
    TenantIsolation,
    TenantIsolationError,
    current_tenant_run,
    tenant_run_scope,
)
from hermes_chat.service import (
    _bind_tenant_terminal_scope,
    _disable_shared_delegation_recovery,
    _header_mapping,
    _install_forward_header_scope,
    _install_agent_scope,
    _install_browser_profile_scope,
    _install_process_scope,
    _install_prompt_backend_scope,
    _install_registry_scope,
    _install_session_search_scope,
    _install_session_context_scope,
    _install_tenant_builder,
    _install_tenant_run_scope,
)


class HermesIsolationTests(unittest.TestCase):
    def test_resolves_opaque_keys_to_private_independent_state_roots(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            isolation = TenantIsolation(root / "home", root / "workspace")

            account_a = isolation.resolve("tenant-a-opaque")
            account_b = isolation.resolve("tenant-b-opaque")
            isolation.ensure(account_a)
            isolation.ensure(account_b)

            self.assertNotEqual(account_a.hermes_home, account_b.hermes_home)
            self.assertNotEqual(account_a.workspace, account_b.workspace)
            self.assertNotEqual(account_a.browser_profile, account_b.browser_profile)
            self.assertEqual(account_a.task_key, isolation.resolve("tenant-a-opaque").task_key)
            self.assertTrue(account_a.hermes_home.is_relative_to((root / "home").resolve()))
            self.assertTrue(account_a.workspace.is_relative_to((root / "workspace").resolve()))
            self.assertEqual(account_a.hermes_home.stat().st_mode & 0o777, 0o700)
            self.assertEqual(account_a.workspace.stat().st_mode & 0o777, 0o700)
            self.assertEqual(account_a.browser_profile.stat().st_mode & 0o777, 0o700)

    def test_rejects_missing_or_path_like_tenant_keys(self) -> None:
        isolation = TenantIsolation(Path("/tmp/newscraft-test-home"), Path("/tmp/newscraft-test-workspace"))

        for value in ("", "../other", "/tmp/other", "tenant/a", "tenant with spaces"):
            with self.subTest(value=value):
                with self.assertRaises(TenantIsolationError):
                    isolation.resolve(value)

    def test_rejects_symlinked_state_roots(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            real_home = root / "real-home"
            real_home.mkdir()
            alias = root / "home-alias"
            alias.symlink_to(real_home, target_is_directory=True)
            with self.assertRaises(TenantIsolationError):
                TenantIsolation(alias, root / "workspace")

    def test_tenant_context_does_not_bleed_between_simultaneous_runs(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            isolation = TenantIsolation(root / "home", root / "workspace")
            account_a = isolation.resolve("tenant-a-opaque")
            account_b = isolation.resolve("tenant-b-opaque")
            isolation.ensure(account_a)
            isolation.ensure(account_b)
            entered = threading.Barrier(2)

            def run(account, marker: str) -> tuple[str, str, str]:
                with tenant_run_scope(
                    account,
                    thread_id=f"thread-{marker}",
                    run_id=f"run-{marker}",
                    home_override=lambda _path: nullcontext(),
                    session_scope=lambda _run: nullcontext(),
                ):
                    entered.wait(timeout=5)
                    current = current_tenant_run()
                    assert current is not None
                    time.sleep(0.02)
                    return current.runtime.key, current.runtime.task_key, current.thread_id

            with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
                results = list(
                    pool.map(
                        lambda args: run(*args),
                        ((account_a, "a"), (account_b, "b")),
                    )
                )

            self.assertEqual(
                {result[0] for result in results},
                {"tenant-a-opaque", "tenant-b-opaque"},
            )
            self.assertEqual(
                {result[1] for result in results},
                {account_a.task_key, account_b.task_key},
            )
            self.assertEqual({result[2] for result in results}, {"thread-a", "thread-b"})
            self.assertIsNone(current_tenant_run())

    def test_tenant_header_and_session_search_profile_are_server_bound(self) -> None:
        from starlette.datastructures import Headers

        isolation = TenantIsolation(Path("/tmp/newscraft-test-home"), Path("/tmp/newscraft-test-workspace"))
        self.assertEqual(TENANT_HEADER, "x-newscraft-tenant-key")
        with self.assertRaises(TenantIsolationError):
            isolation.tenant_from_headers({})
        with self.assertRaises(TenantIsolationError):
            _header_mapping(
                [
                    ("x-newscraft-tenant-key", "tenant-a-opaque"),
                    ("x-newscraft-tenant-key", "tenant-b-opaque"),
                ]
            )
        with self.assertRaises(TenantIsolationError):
            _header_mapping(
                Headers(
                    raw=[
                        (TENANT_HEADER.encode(), b"tenant-a-opaque"),
                        (TENANT_HEADER.upper().encode(), b"tenant-b-opaque"),
                    ]
                )
            )
        self.assertEqual(
            isolation.tenant_from_headers(
                _header_mapping(Headers(raw=[(TENANT_HEADER.upper().encode(), b"tenant-a-opaque")]))
            ),
            "tenant-a-opaque",
        )
        with self.assertRaises(TenantIsolationError):
            isolation.guard_tool_arguments("session_search", {"query": "marker", "profile": "other"})
        with self.assertRaises(TenantIsolationError):
            isolation.guard_tool_arguments(
                "session_search", {"session_id": "other-profile/session-a"}
            )
        with self.assertRaises(TenantIsolationError):
            isolation.guard_tool_arguments(
                "session_search", {"session_id": "@session:other-profile/session-a"}
            )
        with self.assertRaises(TenantIsolationError):
            isolation.guard_tool_arguments(
                "write_file", {"path": "/workspace/notes.txt", "content": "x", "cross_profile": True}
            )
        safe = isolation.guard_tool_arguments("session_search", {"query": "marker"})
        self.assertEqual(safe, {"query": "marker"})

        runtime = isolation.resolve("tenant-a-opaque")
        with tenant_run_scope(
            runtime,
            thread_id="thread-a",
            run_id="run-a",
            home_override=lambda _path: nullcontext(),
            session_scope=lambda _run: nullcontext(),
        ):
            self.assertEqual(
                isolation.guard_tool_arguments("read_file", {"path": "/workspace/notes.txt"}),
                {"path": "/workspace/notes.txt"},
            )
            self.assertEqual(
                isolation.guard_tool_arguments("read_file", {"path": "/tmp/agent.txt"}),
                {"path": "/tmp/agent.txt"},
            )
            with self.assertRaises(TenantIsolationError):
                isolation.guard_tool_arguments(
                    "read_file",
                    {"path": str(isolation.resolve("tenant-b-opaque").workspace / "notes.txt")},
                )
            self.assertEqual(
                isolation.guard_tool_arguments("cronjob", {"workdir": "/workspace/project"}),
                {"workdir": "/workspace/project"},
            )
            self.assertEqual(
                isolation.guard_tool_arguments("terminal", {"workdir": "/workspace/project"}),
                {"workdir": "/workspace/project"},
            )
            with self.assertRaises(TenantIsolationError):
                isolation.guard_tool_arguments("cronjob", {"workdir": "../other-account"})
            with self.assertRaises(TenantIsolationError):
                isolation.guard_tool_arguments("cronjob", {"workdir": "/Users/jigar/private"})
            with self.assertRaises(TenantIsolationError):
                isolation.guard_tool_arguments("terminal", {"workdir": "/Users/jigar/private"})

    def test_agui_forwarded_header_collection_preserves_duplicate_tenant_values(self) -> None:
        from starlette.datastructures import Headers

        agui_server = SimpleNamespace(
            _FORWARD_HEADERS=("x-test-id", TENANT_HEADER),
            _collect_forward_headers=lambda headers: {
                name: headers.get(name)
                for name in ("x-test-id", TENANT_HEADER)
                if headers.get(name)
            },
        )
        _install_forward_header_scope(agui_server)

        collected = agui_server._collect_forward_headers(
            Headers(
                raw=[
                    (TENANT_HEADER.encode(), b"tenant-a-opaque"),
                    (TENANT_HEADER.upper().encode(), b"tenant-b-opaque"),
                ]
            )
        )
        with self.assertRaises(TenantIsolationError):
            _header_mapping(collected)

        one = agui_server._collect_forward_headers(
            Headers(raw=[(TENANT_HEADER.upper().encode(), b"tenant-a-opaque")])
        )
        self.assertEqual(_header_mapping(one)[TENANT_HEADER.upper()], "tenant-a-opaque")


class TwoAccountHermesHarnessTests(unittest.TestCase):
    """Staging harness for the state surfaces that must remain account-local."""

    def test_full_matrix_concurrent_and_after_restart(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            isolation = TenantIsolation(root / "home", root / "workspace")
            harness = _TenantHarness(isolation)
            self.addCleanup(harness.close)
            markers = {
                "tenant-a-opaque": "ACCOUNT_A_ONLY_7f4f",
                "tenant-b-opaque": "ACCOUNT_B_ONLY_3a12",
            }

            with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
                list(pool.map(lambda item: harness.seed(*item), markers.items()))

            for key, own_marker in markers.items():
                other_marker = next(value for other_key, value in markers.items() if other_key != key)
                visible = harness.visible_state(key)
                self.assertIn(own_marker, visible)
                self.assertNotIn(other_marker, visible)

            restarted = _TenantHarness(TenantIsolation(root / "home", root / "workspace"))
            for key, own_marker in markers.items():
                other_marker = next(value for other_key, value in markers.items() if other_key != key)
                visible = restarted.visible_state(key)
                self.assertIn(own_marker, visible)
                self.assertNotIn(other_marker, visible)

    def test_real_hermes_session_search_stays_in_the_active_tenant_db(self) -> None:
        from hermes_state import SessionDB
        from tools.session_search_tool import session_search

        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            isolation = TenantIsolation(root / "home", root / "workspace")
            accounts = {
                "tenant-a-opaque": "CHAT_A_ONLY_8c1e",
                "tenant-b-opaque": "CHAT_B_ONLY_2d7a",
            }
            for key, marker in accounts.items():
                runtime = isolation.resolve(key)
                isolation.ensure(runtime)
                with tenant_run_scope(runtime, thread_id=f"thread-{key}", run_id=f"run-{key}"):
                    db = SessionDB()
                    try:
                        session_id = f"session-{key}"
                        db.create_session(session_id, "newscraft")
                        db.append_message(session_id, "user", marker)
                    finally:
                        db.close()

            _install_session_search_scope()
            restarted = TenantIsolation(root / "home", root / "workspace")
            for key, own_marker in accounts.items():
                other_marker = next(value for other_key, value in accounts.items() if other_key != key)
                runtime = restarted.resolve(key)
                with tenant_run_scope(runtime, thread_id=f"thread-{key}", run_id=f"run-{key}"):
                    own = json.loads(session_search(query=own_marker))
                    foreign = json.loads(session_search(query=other_marker))
                own_text = json.dumps(own.get("results", []), ensure_ascii=False)
                foreign_text = json.dumps(foreign.get("results", []), ensure_ascii=False)
                self.assertIn(own_marker, own_text)
                self.assertNotIn(other_marker, foreign_text)

    def test_real_hermes_cron_store_stays_in_the_active_tenant_home(self) -> None:
        from cron.jobs import create_job, list_jobs, use_cron_store

        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            isolation = TenantIsolation(root / "home", root / "workspace")
            accounts = {
                "tenant-a-opaque": "CRON_A_ONLY_0b91",
                "tenant-b-opaque": "CRON_B_ONLY_6e2d",
            }

            def create_for_account(item: tuple[str, str]) -> None:
                key, marker = item
                runtime = isolation.resolve(key)
                isolation.ensure(runtime)
                with tenant_run_scope(runtime, thread_id=f"thread-{key}", run_id=f"run-{key}"), \
                    use_cron_store(runtime.hermes_home):
                    create_job(
                        prompt=marker,
                        schedule="every 1h",
                        name=f"job-{key}",
                        deliver="local",
                    )

            with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
                list(pool.map(create_for_account, accounts.items()))

            restarted = TenantIsolation(root / "home", root / "workspace")
            for key, own_marker in accounts.items():
                other_marker = next(value for other_key, value in accounts.items() if other_key != key)
                runtime = restarted.resolve(key)
                with tenant_run_scope(runtime, thread_id=f"restart-{key}", run_id=f"restart-{key}"), \
                    use_cron_store(runtime.hermes_home):
                    jobs = list_jobs(include_disabled=True)
                jobs_text = json.dumps(jobs, ensure_ascii=False)
                self.assertIn(own_marker, jobs_text)
                self.assertNotIn(other_marker, jobs_text)

    def test_real_hermes_memory_and_skills_stay_in_the_active_tenant_home(self) -> None:
        from tools.memory_tool import MemoryStore
        from tools.skills_tool import skill_view, skills_list

        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            isolation = TenantIsolation(root / "home", root / "workspace")
            accounts = {
                "tenant-a-opaque": ("MEMORY_A_ONLY_3b6a", "skill-a-only"),
                "tenant-b-opaque": ("MEMORY_B_ONLY_9d2e", "skill-b-only"),
            }
            for key, (marker, skill_name) in accounts.items():
                runtime = isolation.resolve(key)
                isolation.ensure(runtime)
                (runtime.hermes_home / "memories" / "MEMORY.md").write_text(
                    marker,
                    encoding="utf-8",
                )
                (runtime.hermes_home / "skills" / skill_name).mkdir()
                (runtime.hermes_home / "skills" / skill_name / "SKILL.md").write_text(
                    f"---\nname: {skill_name}\ndescription: {marker}\n---\n{marker}\n",
                    encoding="utf-8",
                )

            restarted = TenantIsolation(root / "home", root / "workspace")
            for key, (own_marker, own_skill) in accounts.items():
                other_marker, other_skill = next(
                    value for other_key, value in accounts.items() if other_key != key
                )
                runtime = restarted.resolve(key)
                with tenant_run_scope(runtime, thread_id=f"thread-{key}", run_id=f"run-{key}"):
                    memory = MemoryStore()
                    memory.load_from_disk()
                    memory_text = json.dumps(
                        {
                            "memory": memory.memory_entries,
                            "user": memory.user_entries,
                        },
                        ensure_ascii=False,
                    )
                    listed = skills_list()
                    viewed = skill_view(own_skill)
                self.assertIn(own_marker, memory_text)
                self.assertNotIn(other_marker, memory_text)
                self.assertIn(own_skill, listed)
                self.assertNotIn(other_skill, listed)
                self.assertIn(own_marker, viewed)
                self.assertNotIn(other_marker, viewed)


class TenantAguiBoundaryTests(unittest.TestCase):
    def test_wrapped_agui_runs_keep_headers_context_and_state_separate(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            isolation = TenantIsolation(root / "home", root / "workspace")
            observed: list[tuple[str, str, dict[str, str]]] = []
            entered = threading.Barrier(2)

            def original_run(
                run_input,
                _config,
                _bridge,
                forwarded_headers,
                approval_cb=None,
                on_agent=None,
            ):
                self.assertIsNone(approval_cb)
                self.assertIsNone(on_agent)
                current = current_tenant_run()
                self.assertIsNotNone(current)
                assert current is not None
                entered.wait(timeout=5)
                marker = Path(fake_home.get_hermes_home()) / "boundary-marker.txt"
                marker.write_text(current.runtime.key, encoding="utf-8")
                observed.append((current.runtime.key, current.runtime.task_key, forwarded_headers))
                return {"ok": True}

            agui_server = SimpleNamespace(_run_turn=original_run, _FORWARD_HEADERS=())
            settings = SimpleNamespace()
            fake_home = _fake_hermes_constants()
            fake_gateway = _fake_gateway()
            with patch.dict(
                sys.modules,
                {"hermes_constants": fake_home, "gateway": fake_gateway},
            ), patch("hermes_chat.service._write_runtime_config") as write_config:
                _install_tenant_run_scope(
                    agui_server,
                    settings,
                    {"vision"},
                    {},
                    isolation,
                )

                with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
                    results = list(
                        pool.map(
                            lambda key: agui_server._run_turn(
                                SimpleNamespace(thread_id=f"thread-{key}", run_id=f"run-{key}"),
                                None,
                                None,
                                {
                                    TENANT_HEADER: key,
                                    "x-test-id": f"test-{key}",
                                },
                            ),
                            ("tenant-a-opaque", "tenant-b-opaque"),
                        )
                    )

            self.assertEqual(results, [{"ok": True}, {"ok": True}])
            write_config.assert_any_call(settings, {"vision"}, existing={})
            self.assertEqual(
                {(key, task) for key, task, _headers in observed},
                {
                    ("tenant-a-opaque", "newscraft-tenant-a-opaque"),
                    ("tenant-b-opaque", "newscraft-tenant-b-opaque"),
                },
            )
            self.assertEqual(
                {frozenset(headers.items()) for _key, _task, headers in observed},
                {
                    frozenset({("x-test-id", "test-tenant-a-opaque")}),
                    frozenset({("x-test-id", "test-tenant-b-opaque")}),
                },
            )
            self.assertIsNone(current_tenant_run())
            for key in ("tenant-a-opaque", "tenant-b-opaque"):
                runtime = isolation.resolve(key)
                self.assertEqual(
                    (runtime.hermes_home / "boundary-marker.txt").read_text(encoding="utf-8"),
                    key,
                )

            restarted = TenantIsolation(root / "home", root / "workspace")
            for key in ("tenant-a-opaque", "tenant-b-opaque"):
                runtime = restarted.resolve(key)
                self.assertEqual(
                    (runtime.hermes_home / "boundary-marker.txt").read_text(encoding="utf-8"),
                    key,
                )

            with self.assertRaises(TenantIsolationError):
                agui_server._run_turn(SimpleNamespace(thread_id="thread", run_id="run"), None, None, {})


class HermesHookScopeTests(unittest.TestCase):
    def _runtime(self, root: Path):
        isolation = TenantIsolation(root / "home", root / "workspace")
        runtime = isolation.resolve("tenant-a-opaque")
        isolation.ensure(runtime)
        return runtime

    def test_session_context_and_agent_builder_are_server_bound(self) -> None:
        runtime = self._runtime(Path(tempfile.mkdtemp()))
        self.addCleanup(lambda: shutil.rmtree(runtime.hermes_home.parents[2], ignore_errors=True))

        gateway_calls: list[dict[str, object]] = []
        agui_calls: list[dict[str, object]] = []

        def gateway_setter(**kwargs):
            gateway_calls.append(kwargs)
            return ["gateway-token"]

        def agui_setter(**kwargs):
            agui_calls.append(kwargs)
            return ["agui-token"]

        build_calls: list[dict[str, object]] = []

        def build_run_agent(**kwargs):
            build_calls.append(kwargs)
            return "agent"
        gateway = ModuleType("gateway")
        gateway.session_context = SimpleNamespace(
            set_session_vars=gateway_setter,
            clear_session_vars=MagicMock(),
        )
        agui_server = SimpleNamespace(
            set_session_vars=agui_setter,
            build_run_agent=build_run_agent,
        )
        with patch.dict(sys.modules, {"gateway": gateway}):
            _install_session_context_scope(agui_server)
            _install_tenant_builder(agui_server)
            with tenant_run_scope(
                runtime,
                thread_id="thread-a",
                run_id="run-a",
                home_override=lambda _path: nullcontext(),
                session_scope=lambda _run: nullcontext(),
            ):
                gateway.session_context.set_session_vars(source="caller", profile="wrong")
                agui_server.set_session_vars(source="caller", profile="wrong")
                agui_server.build_run_agent(cwd="/host/wrong")

        expected_session = {
            "source": "newscraft",
            "profile": "newscraft-tenant-a-opaque",
            "thread_id": "thread-a",
            "user_id": "tenant-a-opaque",
            "session_key": "newscraft-tenant-a-opaque",
            "session_id": "thread-a",
            "cwd": "/workspace",
            "ui_session_id": "run-a",
            "async_delivery": False,
        }
        self.assertEqual(gateway_calls, [expected_session])
        self.assertEqual(agui_calls, [expected_session])
        self.assertEqual(build_calls, [{"cwd": "/workspace"}])

    def test_browser_profile_is_local_private_and_persistent_by_task(self) -> None:
        runtime = self._runtime(Path(tempfile.mkdtemp()))
        self.addCleanup(lambda: shutil.rmtree(runtime.hermes_home.parents[2], ignore_errors=True))

        browser_tool = ModuleType("tools.browser_tool")
        browser_tool._build_browser_env = lambda: {
            "PATH": "/bin",
            "BROWSERBASE_API_KEY": "must-not-leak",
            "BROWSER_CDP_URL": "ws://operator-browser",
        }
        browser_tool._create_local_session = lambda _task_id: {
            "session_name": "random-session",
            "bb_session_id": None,
            "cdp_url": None,
            "features": {"local": True},
        }
        browser_tool._socket_safe_tmpdir = lambda: "/a/very/long/private/tmp/path"
        tools_package = ModuleType("tools")
        tools_package.__path__ = []
        tools_package.browser_tool = browser_tool
        with patch.dict(
            sys.modules,
            {"tools": tools_package, "tools.browser_tool": browser_tool},
        ):
            _install_browser_profile_scope()
            with tenant_run_scope(
                runtime,
                thread_id="thread-a",
                run_id="run-a",
                home_override=lambda _path: nullcontext(),
                session_scope=lambda _run: nullcontext(),
            ):
                environment = browser_tool._build_browser_env()
                first = browser_tool._create_local_session("caller-selected-task")
                second = browser_tool._create_local_session("another-task")
                socket_tmpdir = browser_tool._socket_safe_tmpdir()

        self.assertEqual(environment["AGENT_BROWSER_PROFILE"], str(runtime.browser_profile))
        self.assertEqual(environment["HOME"], str(runtime.browser_profile))
        self.assertEqual(environment["XDG_CONFIG_HOME"], str(runtime.browser_profile / "config"))
        self.assertEqual(environment["TMPDIR"], "/tmp")
        self.assertNotIn("BROWSERBASE_API_KEY", environment)
        self.assertNotIn("BROWSER_CDP_URL", environment)
        self.assertEqual(first, second)
        self.assertTrue(first["session_name"].startswith("n"))
        self.assertEqual(len(first["session_name"]), 9)
        self.assertEqual(socket_tmpdir, "/tmp")

    def test_registry_and_agent_hooks_force_the_same_tenant_task(self) -> None:
        runtime = self._runtime(Path(tempfile.mkdtemp()))
        self.addCleanup(lambda: shutil.rmtree(runtime.hermes_home.parents[2], ignore_errors=True))

        class FakeRegistry:
            def dispatch(self, function_name, function_args, **kwargs):
                return function_name, function_args, kwargs

        registry = FakeRegistry()
        registry_module = ModuleType("tools.registry")
        registry_module.registry = registry

        class FakeAIAgent:
            def _invoke_tool(self, function_name, function_args, effective_task_id, *args, **kwargs):
                return function_name, function_args, effective_task_id, args, kwargs

            def run_conversation(
                self,
                user_message,
                system_message=None,
                conversation_history=None,
                task_id=None,
                **kwargs,
            ):
                return user_message, task_id, kwargs

        run_agent = ModuleType("run_agent")
        run_agent.AIAgent = FakeAIAgent
        tools_package = ModuleType("tools")
        tools_package.__path__ = []
        with patch.dict(
            sys.modules,
            {
                "tools": tools_package,
                "tools.registry": registry_module,
                "run_agent": run_agent,
            },
        ):
            _install_registry_scope()
            _install_agent_scope()
            agent = FakeAIAgent()
            with tenant_run_scope(
                runtime,
                thread_id="thread-a",
                run_id="run-a",
                home_override=lambda _path: nullcontext(),
                session_scope=lambda _run: nullcontext(),
            ):
                dispatched = registry.dispatch(
                    "read_file",
                    {"path": "/workspace/notes.txt"},
                    task_id="caller-selected-task",
                )
                invoked = agent._invoke_tool(
                    "read_file",
                    {"path": "/workspace/notes.txt"},
                    "caller-selected-task",
                )
                conversed = agent.run_conversation("hello", task_id="caller-selected-task")

        expected_task = "newscraft-tenant-a-opaque"
        self.assertEqual(dispatched[2]["task_id"], expected_task)
        self.assertEqual(invoked[2], expected_task)
        self.assertEqual(conversed[1], expected_task)

    def test_session_search_and_process_handles_cannot_cross_tenants(self) -> None:
        runtime = self._runtime(Path(tempfile.mkdtemp()))
        self.addCleanup(lambda: shutil.rmtree(runtime.hermes_home.parents[2], ignore_errors=True))

        session_search = ModuleType("tools.session_search_tool")
        located_calls: list[str] = []

        def locate_session_db(session_id):
            located_calls.append(session_id)
            return "foreign-db", "foreign-profile"

        session_search._locate_session_db = locate_session_db

        class Process:
            def __init__(self, task_id):
                self.task_id = task_id

        class FakeProcessRegistry:
            def __init__(self):
                self.sessions = {
                    "own": Process(runtime.task_key),
                    "foreign": Process("newscraft-tenant-b-opaque"),
                }

            def _write_checkpoint(self, *_args, **_kwargs):
                return "shared-checkpoint"

            def recover_from_checkpoint(self):
                return 1

            def get(self, session_id):
                return self.sessions.get(session_id)

            def list_sessions(self, task_id=None, session_key=None):
                return [
                    {
                        "task_id": session.task_id,
                        "session_key": session_key,
                    }
                    for session in self.sessions.values()
                    if (task_id and session.task_id == task_id)
                    or (session_key and session_key == "shared")
                ]

        process_registry = FakeProcessRegistry()
        registry_module = ModuleType("tools.process_registry")
        registry_module.process_registry = process_registry
        tools_package = ModuleType("tools")
        tools_package.__path__ = []
        with patch.dict(
            sys.modules,
            {
                "tools": tools_package,
                "tools.session_search_tool": session_search,
                "tools.process_registry": registry_module,
            },
        ):
            _install_session_search_scope()
            _install_process_scope()
            with tenant_run_scope(
                runtime,
                thread_id="thread-a",
                run_id="run-a",
                home_override=lambda _path: nullcontext(),
                session_scope=lambda _run: nullcontext(),
            ):
                self.assertEqual(session_search._locate_session_db("foreign-session"), (None, None))
                self.assertEqual(process_registry.get("own").task_id, runtime.task_key)
                self.assertIsNone(process_registry.get("foreign"))
                self.assertEqual(
                    process_registry.list_sessions(
                        task_id="caller-task",
                        session_key="shared",
                    ),
                    [{"task_id": runtime.task_key, "session_key": None}],
                )
                self.assertIsNone(process_registry._write_checkpoint())
                self.assertEqual(process_registry.recover_from_checkpoint(), 0)

        self.assertEqual(session_search._locate_session_db("foreign-session"), ("foreign-db", "foreign-profile"))
        self.assertEqual(located_calls, ["foreign-session"])

    def test_tenant_runs_do_not_create_the_shared_prompt_probe_container(self) -> None:
        runtime = self._runtime(Path(tempfile.mkdtemp()))
        self.addCleanup(lambda: shutil.rmtree(runtime.hermes_home.parents[2], ignore_errors=True))

        prompt_builder = ModuleType("agent.prompt_builder")
        probe_calls: list[str] = []

        def probe(env_type: str) -> str:
            probe_calls.append(env_type)
            return "shared-probe-result"

        prompt_builder._probe_remote_backend = probe
        agent_package = ModuleType("agent")
        agent_package.__path__ = []
        with patch.dict(
            sys.modules,
            {"agent": agent_package, "agent.prompt_builder": prompt_builder},
        ):
            _install_prompt_backend_scope()
            with tenant_run_scope(
                runtime,
                thread_id="thread-a",
                run_id="run-a",
                home_override=lambda _path: nullcontext(),
                session_scope=lambda _run: nullcontext(),
            ):
                self.assertIsNone(prompt_builder._probe_remote_backend("docker"))

            self.assertEqual(prompt_builder._probe_remote_backend("docker"), "shared-probe-result")

        self.assertEqual(probe_calls, ["docker"])

    def test_async_delegation_recovery_is_disabled_without_a_tenant(self) -> None:
        import tools.async_delegation as async_delegation

        current = async_delegation.restore_undelivered_completions
        _disable_shared_delegation_recovery()
        self.assertEqual(async_delegation.restore_undelivered_completions(object()), 0)
        self.assertIs(
            getattr(
                async_delegation.restore_undelivered_completions,
                "_newscraft_unscoped_delegation_recovery",
            ),
            getattr(current, "_newscraft_unscoped_delegation_recovery", current),
        )

    def test_async_delegation_state_path_follows_the_active_tenant(self) -> None:
        import tools.async_delegation as async_delegation

        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            isolation = TenantIsolation(root / "home", root / "workspace")
            for key in ("tenant-a-opaque", "tenant-b-opaque"):
                runtime = isolation.resolve(key)
                with tenant_run_scope(runtime, thread_id=f"thread-{key}", run_id=f"run-{key}"):
                    self.assertEqual(async_delegation._db_path(), runtime.hermes_home / "state.db")

    def test_terminal_scope_keeps_each_tenant_on_its_own_persistent_task(self) -> None:
        import tools.terminal_tool as terminal_tool

        before = dict(terminal_tool._task_env_overrides)
        self.addCleanup(
            lambda: (
                terminal_tool._task_env_overrides.clear(),
                terminal_tool._task_env_overrides.update(before),
            )
        )
        runtime_a = self._runtime(Path(tempfile.mkdtemp()))
        base_root = runtime_a.hermes_home.parents[2]
        runtime_b = TenantIsolation(
            base_root / "home",
            base_root / "workspace",
        ).resolve("tenant-b-opaque")

        _bind_tenant_terminal_scope(runtime_a)
        _bind_tenant_terminal_scope(runtime_b)

        self.assertEqual(
            terminal_tool._resolve_container_task_id(runtime_a.task_key),
            runtime_a.task_key,
        )
        self.assertEqual(
            terminal_tool._resolve_container_task_id(runtime_b.task_key),
            runtime_b.task_key,
        )
        self.assertNotEqual(runtime_a.task_key, runtime_b.task_key)
        self.assertEqual(
            terminal_tool.resolve_task_overrides(runtime_a.task_key)["cwd"],
            "/workspace",
        )


def _fake_hermes_constants() -> ModuleType:
    module = ModuleType("hermes_constants")
    home_context = __import__("contextvars").ContextVar("test_hermes_home", default=None)
    module.set_hermes_home_override = lambda path: home_context.set(path)
    module.reset_hermes_home_override = lambda token: home_context.reset(token)
    module.get_hermes_home = lambda: Path(home_context.get())
    return module


def _fake_gateway() -> ModuleType:
    module = ModuleType("gateway")
    session_context = SimpleNamespace()
    session_context.set_session_vars = lambda **_kwargs: ["token"]
    session_context.clear_session_vars = lambda _tokens: None
    module.session_context = session_context
    return module


class _TenantHarness:
    """Exercise the same tenant scope for persistent Hermes-like state surfaces."""

    def __init__(self, isolation: TenantIsolation) -> None:
        self.isolation = isolation
        self.processes: dict[str, subprocess.Popen[str]] = {}

    def seed(self, key: str, marker: str) -> None:
        runtime = self.isolation.resolve(key)
        self.isolation.ensure(runtime)
        with tenant_run_scope(
            runtime,
            thread_id=f"thread-{key}",
            run_id=f"run-{key}",
            home_override=lambda _path: nullcontext(),
            session_scope=lambda _run: nullcontext(),
        ):
            (runtime.hermes_home / "memories" / "MEMORY.md").write_text(
                f"name: {marker}\n", encoding="utf-8"
            )
            (runtime.hermes_home / "memories" / "USER.md").write_text(
                f"memory: {marker}\n", encoding="utf-8"
            )
            (runtime.hermes_home / "state.db").write_text(f"chat: {marker}\n", encoding="utf-8")
            (runtime.workspace / "workspace.txt").write_text(marker, encoding="utf-8")
            (runtime.browser_profile / "cookies.json").write_text(
                json.dumps({"cookie": marker}), encoding="utf-8"
            )
            (runtime.hermes_home / "skills").mkdir(exist_ok=True)
            (runtime.hermes_home / "skills" / "account.md").write_text(marker, encoding="utf-8")
            (runtime.hermes_home / "cron").mkdir(exist_ok=True)
            (runtime.hermes_home / "cron" / "jobs.json").write_text(
                json.dumps({"job": marker}), encoding="utf-8"
            )
            process = subprocess.Popen(
                [sys.executable, "-c", "import time; time.sleep(2)"],
                cwd=runtime.workspace,
                env={"PATH": os.environ.get("PATH", ""), "NEWSCRAFT_TASK_KEY": runtime.task_key},
                text=True,
            )
            self.processes[key] = process
            (runtime.hermes_home / "processes.json").write_text(
                json.dumps({"task_key": runtime.task_key, "pid": process.pid, "marker": marker}),
                encoding="utf-8",
            )

    def visible_state(self, key: str) -> str:
        runtime = self.isolation.resolve(key)
        parts = [
            (runtime.hermes_home / "memories" / "MEMORY.md").read_text(encoding="utf-8"),
            (runtime.hermes_home / "memories" / "USER.md").read_text(encoding="utf-8"),
            (runtime.hermes_home / "state.db").read_text(encoding="utf-8"),
            (runtime.workspace / "workspace.txt").read_text(encoding="utf-8"),
            (runtime.browser_profile / "cookies.json").read_text(encoding="utf-8"),
            (runtime.hermes_home / "skills" / "account.md").read_text(encoding="utf-8"),
            (runtime.hermes_home / "cron" / "jobs.json").read_text(encoding="utf-8"),
            (runtime.hermes_home / "processes.json").read_text(encoding="utf-8"),
        ]
        return "\n".join(parts)

    def close(self) -> None:
        for process in self.processes.values():
            if process.poll() is None:
                process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                pass

    def __del__(self) -> None:
        self.close()
