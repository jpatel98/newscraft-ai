from __future__ import annotations

import os
import sys
import asyncio
import threading
import tempfile
import unittest
from pathlib import Path
from types import ModuleType, SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

from hermes_chat.contracts import CRON_TOOLSET, HERMES_TOOLSET
from hermes_chat.service import (
    _browser_capability_ready,
    _enable_tenant_cron_tool,
    _install_iteration_limit,
    _install_public_host_alias,
    _runtime_config,
    _set_iteration_limit,
    _startup_tool_names,
    create_app,
    prepare_runtime,
    settings_from_env,
)
from hermes_chat.durable import DurableJob, DurableRunError, DurableRunWorker, normalized_events
from hermes_chat.isolation import TenantIsolation


class HermesChatServiceTests(unittest.TestCase):
    def _environment(self, root: str) -> dict[str, str]:
        return {
            "HERMES_AGUI_HOST": "127.0.0.1",
            "HERMES_AGUI_PORT": "8768",
            "HERMES_AGUI_SESSION_TOKEN": "a" * 32,
            "NEWSCRAFT_HERMES_HOME": str(Path(root) / "home"),
            "NEWSCRAFT_HERMES_WORKSPACE": str(Path(root) / "workspace"),
            "NEWSCRAFT_HERMES_MODEL_PROVIDER": "local-test",
            "NEWSCRAFT_HERMES_MODEL": "test-model",
            "NEWSCRAFT_HERMES_MODEL_BASE_URL": "http://127.0.0.1:8767/v1",
            "NEWSCRAFT_HERMES_MODEL_API_KEY": "local-test-key",
        }

    def test_requires_one_explicit_model_endpoint(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir, patch.dict(
            os.environ, self._environment(temp_dir), clear=True
        ):
            settings = settings_from_env()

        self.assertEqual(settings.model_provider, "local-test")
        self.assertEqual(settings.model, "test-model")
        self.assertEqual(settings.model_base_url, "http://127.0.0.1:8767/v1")
        self.assertEqual(settings.max_iterations, 25)

    def test_accepts_a_bounded_iteration_setting(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            environment = self._environment(temp_dir)
            environment["NEWSCRAFT_HERMES_MAX_ITERATIONS"] = "12"
            with patch.dict(os.environ, environment, clear=True):
                settings = settings_from_env()

        self.assertEqual(settings.max_iterations, 12)

    def test_accepts_one_explicit_public_proxy_host(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            environment = self._environment(temp_dir)
            environment["NEWSCRAFT_HERMES_PUBLIC_HOST"] = "hermes.example.com"
            with patch.dict(os.environ, environment, clear=True):
                settings = settings_from_env()

        self.assertEqual(settings.public_host, "hermes.example.com")

    def test_rejects_a_public_proxy_url(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            environment = self._environment(temp_dir)
            environment["NEWSCRAFT_HERMES_PUBLIC_HOST"] = "https://hermes.example.com"
            with patch.dict(os.environ, environment, clear=True):
                with self.assertRaisesRegex(RuntimeError, "must be one hostname"):
                    settings_from_env()

    def test_public_host_alias_keeps_the_exact_host_guard(self) -> None:
        from fastapi import FastAPI, Request
        from fastapi.responses import JSONResponse
        from fastapi.testclient import TestClient
        from agui_adapter.auth import host_accepted

        app = FastAPI()

        @app.middleware("http")
        async def loopback_host_guard(request: Request, call_next):
            if not host_accepted(request.headers.get("host", ""), "127.0.0.1"):
                return JSONResponse(status_code=400, content={"detail": "Invalid Host header."})
            return await call_next(request)

        @app.get("/")
        async def root():
            return {"ok": True}

        _install_public_host_alias(app, "127.0.0.1", "hermes.example.com")

        with TestClient(app) as client:
            self.assertEqual(
                client.get("/", headers={"host": "hermes.example.com"}).status_code,
                200,
            )
            self.assertEqual(
                client.get("/", headers={"host": "attacker.example"}).status_code,
                400,
            )

    def test_durable_routes_accept_http_requests_and_forward_bindings(self) -> None:
        from fastapi import FastAPI
        from fastapi.testclient import TestClient
        from hermes_chat import service as service_module

        with tempfile.TemporaryDirectory() as root:
            settings = SimpleNamespace(
                host="127.0.0.1",
                port=8768,
                session_token="s" * 32,
                public_host=None,
                hermes_home=Path(root) / "home",
                workspace=Path(root) / "workspace",
                model_provider="test-provider",
                model="test-model",
                model_base_url="http://127.0.0.1:8767/v1",
                model_api_key="test-key",
                model_api_mode=None,
                max_iterations=25,
                retrieval=SimpleNamespace(),
                run_api_url="https://newscraft.test/api/internal/hermes/runs",
                run_api_token="run-token",
                internal_agui_url="http://127.0.0.1:8768/",
            )
            worker = SimpleNamespace(
                start=AsyncMock(return_value={"accepted": True, "run_id": "run-1", "state": "queued"}),
                cancel=AsyncMock(return_value={"accepted": True, "run_id": "run-1", "state": "cancel_requested"}),
                recover=AsyncMock(),
                close=AsyncMock(),
            )
            import agui_adapter.server as agui_server
            import hermes_cli.plugins as hermes_plugins
            import model_tools

            with patch.object(service_module, "prepare_runtime"), \
                patch.object(service_module, "_disable_shared_delegation_recovery"), \
                patch.object(service_module, "_standard_auxiliary_tasks", return_value=set()), \
                patch.object(service_module, "_write_runtime_config", return_value={}), \
                patch.object(service_module, "_enable_tenant_cron_tool"), \
                patch.object(service_module, "_install_tenant_runtime"), \
                patch.object(service_module, "_install_iteration_limit"), \
                patch.object(service_module, "_install_public_host_alias"), \
                patch.object(service_module, "_startup_tool_names", return_value=["web_extract", "cronjob"]), \
                patch.object(service_module, "_browser_capability_ready", return_value=True), \
                patch.object(service_module, "retrieval_readiness", return_value={"configured": True}), \
                patch.object(service_module, "DurableRunWorker", return_value=worker), \
                patch.object(hermes_plugins, "discover_plugins"), \
                patch.object(hermes_plugins, "get_plugin_auxiliary_tasks", return_value=[]), \
                patch.object(agui_server, "create_app", return_value=FastAPI()), \
                patch.object(model_tools, "get_tool_definitions", return_value=[]):
                app = create_app(settings)

            headers = {
                "authorization": f"Bearer {settings.session_token}",
                "x-newscraft-tenant-key": "tenant-key-1",
            }
            with TestClient(app) as client:
                start = client.post(
                    "/v1/runs/start",
                    headers=headers,
                    json={
                        "run_id": "run-1",
                        "account_id": "account-1",
                        "tenant_key": "tenant-key-1",
                        "input": {"runId": "run-1"},
                    },
                )
                cancel = client.post(
                    "/v1/runs/run-1/cancel",
                    headers=headers,
                    json={
                        "run_id": "run-1",
                        "account_id": "account-1",
                        "tenant_key": "tenant-key-1",
                    },
                )

            self.assertEqual(start.status_code, 202)
            self.assertEqual(cancel.status_code, 202)
            worker.start.assert_awaited_once()
            worker.cancel.assert_awaited_once_with("run-1", "account-1", "tenant-key-1")

    def test_rejects_an_unbounded_iteration_setting(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            environment = self._environment(temp_dir)
            environment["NEWSCRAFT_HERMES_MAX_ITERATIONS"] = "500"
            with patch.dict(os.environ, environment, clear=True):
                with self.assertRaisesRegex(RuntimeError, "must be between 4 and 90"):
                    settings_from_env()

    def test_sets_the_native_agent_iteration_limit_before_the_run(self) -> None:
        agent = SimpleNamespace(max_iterations=90, iteration_budget=object())
        original_budget = agent.iteration_budget

        result = _set_iteration_limit(agent, 25)

        self.assertIs(result, agent)
        self.assertEqual(agent.max_iterations, 25)
        self.assertIs(agent.iteration_budget, original_budget)

    def test_installs_one_non_stacking_agui_builder_wrapper(self) -> None:
        created: list[SimpleNamespace] = []

        def original_builder(*_args, **_kwargs):
            agent = SimpleNamespace(max_iterations=90, iteration_budget=object())
            created.append(agent)
            return agent

        module = SimpleNamespace(build_run_agent=original_builder)
        _install_iteration_limit(module, 25)
        first_wrapper = module.build_run_agent
        _install_iteration_limit(module, 12)
        bounded = module.build_run_agent()

        self.assertIsNot(module.build_run_agent, first_wrapper)
        self.assertEqual(len(created), 1)
        self.assertEqual(bounded.max_iterations, 12)

    def test_rejects_a_remote_plain_http_model_endpoint(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            environment = self._environment(temp_dir)
            environment["NEWSCRAFT_HERMES_MODEL_BASE_URL"] = "http://model.example/v1"
            with patch.dict(os.environ, environment, clear=True):
                with self.assertRaisesRegex(RuntimeError, "must use HTTPS"):
                    settings_from_env()

    def test_rejects_shared_home_and_workspace(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            environment = self._environment(temp_dir)
            environment["NEWSCRAFT_HERMES_WORKSPACE"] = environment["NEWSCRAFT_HERMES_HOME"]
            with patch.dict(os.environ, environment, clear=True):
                with self.assertRaisesRegex(RuntimeError, "must be separate"):
                    settings_from_env()

    def test_rejects_a_symlinked_private_home(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            real_home = root / "real-home"
            real_home.mkdir()
            environment = self._environment(temp_dir)
            environment["NEWSCRAFT_HERMES_HOME"] = str(root / "home-alias")
            (root / "home-alias").symlink_to(real_home, target_is_directory=True)
            with patch.dict(os.environ, environment, clear=True):
                with self.assertRaisesRegex(RuntimeError, "must not be a symlink"):
                    settings_from_env()

    def test_contract_uses_the_standard_hermes_toolset(self) -> None:
        self.assertEqual(HERMES_TOOLSET, "hermes-acp")
        self.assertEqual(CRON_TOOLSET, "cronjob_tools")

    def test_browser_capability_requires_the_real_local_runtime(self) -> None:
        browser_tool = ModuleType("tools.browser_tool")
        browser_tool.check_browser_requirements = lambda: False
        with patch.dict(sys.modules, {"tools.browser_tool": browser_tool}):
            self.assertFalse(
                _browser_capability_ready({"browser_navigate", "browser_snapshot"})
            )

        browser_tool.check_browser_requirements = lambda: True
        with patch.dict(sys.modules, {"tools.browser_tool": browser_tool}):
            self.assertTrue(
                _browser_capability_ready({"browser_navigate", "browser_snapshot"})
            )

    def test_retries_terminal_and_file_tools_after_a_transient_probe_failure(self) -> None:
        initial = [{"function": {"name": "memory"}}]
        complete = [
            {"function": {"name": "memory"}},
            {"function": {"name": "terminal"}},
            {"function": {"name": "read_file"}},
            {"function": {"name": "write_file"}},
            {"function": {"name": "patch"}},
        ]
        get_definitions = Mock(side_effect=[initial, complete])
        config = SimpleNamespace(enabled_toolsets=[HERMES_TOOLSET, CRON_TOOLSET])

        with patch("tools.terminal_tool.check_terminal_requirements", return_value=True), \
             patch("tools.registry.invalidate_check_fn_cache") as invalidate, \
             patch("model_tools._clear_tool_defs_cache") as clear:
            names = _startup_tool_names(get_definitions, config)

        self.assertEqual(
            names,
            ["memory", "patch", "read_file", "terminal", "write_file"],
        )
        self.assertEqual(get_definitions.call_count, 2)
        invalidate.assert_called_once_with()
        clear.assert_called_once_with()

    def test_agui_enables_cron_without_gateway_environment_flags(self) -> None:
        entry = SimpleNamespace(check_fn=lambda: False)
        registry = SimpleNamespace(
            get_entry=lambda name: entry if name == "cronjob" else None,
            _lock=threading.RLock(),
            _generation=4,
        )
        registry_module = ModuleType("tools.registry")
        registry_module.registry = registry
        with patch.dict(sys.modules, {"tools.registry": registry_module}):
            _enable_tenant_cron_tool()

        self.assertIsNone(entry.check_fn)
        self.assertEqual(registry._generation, 5)

    def test_runtime_config_keeps_all_model_work_on_one_endpoint(self) -> None:
        config = _runtime_config(
            {
                "browser": {"headed": False},
                "memory": {
                    "enabled": True,
                    "provider": "shared-external-provider",
                    "max_tokens": 2048,
                },
                "skills": {"disabled": ["operator-only"], "external_dirs": ["/Users/jigar/skills"]},
                "plugins": {"enabled": ["operator-plugin"]},
                "terminal": {
                    "credential_files": ["provider.json"],
                    "sandbox_dir": "/Users/jigar/shared-host-sandboxes",
                },
                "fallback_model": {"provider": "openrouter", "model": "another-model"},
                "auxiliary": {
                    "vision": {"timeout": 90},
                    "plugin_task": {"provider": "openrouter", "model": "another-model"},
                },
            },
            {"vision", "web_extract"},
            "chat_completions",
        )

        self.assertEqual(config["browser"], {"headed": False, "cloud_provider": "local"})
        self.assertEqual(config["memory"], {"enabled": True, "max_tokens": 2048})
        self.assertEqual(config["skills"], {"disabled": ["operator-only"], "external_dirs": []})
        self.assertEqual(config["plugins"], {"enabled": ["newscraft-web"]})
        self.assertEqual(config["fallback_providers"], [])
        self.assertNotIn("fallback_model", config)
        self.assertEqual(config["agui"]["toolsets"], ["hermes-acp", "cronjob_tools"])
        for task_name in ("vision", "web_extract", "plugin_task"):
            task = config["auxiliary"][task_name]
            self.assertEqual(task["provider"], "custom")
            self.assertEqual(task["model"], "${env:NEWSCRAFT_HERMES_MODEL}")
            self.assertEqual(task["base_url"], "${env:NEWSCRAFT_HERMES_MODEL_BASE_URL}")
            self.assertEqual(task["api_key"], "${env:NEWSCRAFT_HERMES_MODEL_API_KEY}")
            self.assertEqual(task["fallback_chain"], [])

    def test_runtime_config_uses_one_persistent_docker_workspace_without_host_mounts(self) -> None:
        config = _runtime_config({}, {"vision"}, "chat_completions")

        self.assertEqual(config["terminal"]["backend"], "docker")
        self.assertEqual(config["terminal"]["cwd"], "/workspace")
        self.assertTrue(config["terminal"]["container_persistent"])
        self.assertTrue(config["terminal"]["docker_persist_across_processes"])
        self.assertFalse(config["terminal"]["docker_mount_cwd_to_workspace"])
        self.assertTrue(config["terminal"]["docker_network"])
        self.assertEqual(config["terminal"]["docker_volumes"], [])
        self.assertEqual(config["terminal"]["docker_forward_env"], [])
        self.assertEqual(config["terminal"]["docker_env"], {})
        self.assertEqual(config["terminal"]["credential_files"], [])
        self.assertEqual(config["terminal"]["docker_extra_args"], [])
        self.assertTrue(config["terminal"]["docker_run_as_host_user"])
        self.assertNotIn("sandbox_dir", config["terminal"])
        self.assertEqual(config["browser"]["cloud_provider"], "local")
        self.assertNotIn("cdp_url", config["browser"])

    def test_prepare_runtime_clears_inherited_docker_escape_hatches(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            environment = self._environment(temp_dir)
            settings = None
            with patch.dict(os.environ, environment, clear=True):
                settings = settings_from_env()
                old_cwd = Path.cwd()
                try:
                    os.environ.update(
                        {
                            "TERMINAL_CWD": "/Users/jigar/shared-host-workspace",
                            "TERMINAL_SANDBOX_DIR": "/Users/jigar/shared-host-sandboxes",
                            "TERMINAL_DOCKER_FORWARD_ENV": "[\"SECRET\"]",
                            "TERMINAL_DOCKER_VOLUMES": "[\"/host:/container\"]",
                            "TERMINAL_DOCKER_ENV": "{\"SECRET\":\"value\"}",
                            "TERMINAL_DOCKER_EXTRA_ARGS": "[\"--privileged\"]",
                            "TERMINAL_DOCKER_MOUNT_CWD_TO_WORKSPACE": "true",
                            "TERMINAL_DOCKER_RUN_AS_HOST_USER": "true",
                        }
                    )
                    prepare_runtime(settings)
                    self.assertEqual(os.environ["TERMINAL_ENV"], "docker")
                    self.assertEqual(os.environ["TERMINAL_CWD"], "/workspace")
                    self.assertNotIn("TERMINAL_SANDBOX_DIR", os.environ)
                    self.assertEqual(os.environ["TERMINAL_DOCKER_FORWARD_ENV"], "[]")
                    self.assertEqual(os.environ["TERMINAL_DOCKER_VOLUMES"], "[]")
                    self.assertEqual(os.environ["TERMINAL_DOCKER_ENV"], "{}")
                    self.assertEqual(os.environ["TERMINAL_DOCKER_EXTRA_ARGS"], "[]")
                    self.assertEqual(os.environ["TERMINAL_DOCKER_MOUNT_CWD_TO_WORKSPACE"], "false")
                    self.assertEqual(os.environ["TERMINAL_DOCKER_RUN_AS_HOST_USER"], "true")
                finally:
                    os.chdir(old_cwd)


class DurableHermesWorkerTests(unittest.IsolatedAsyncioTestCase):
    def _worker(self, root: str) -> DurableRunWorker:
        settings = SimpleNamespace(
            run_api_url="http://newscraft.test/api/internal/hermes/runs",
            run_api_token="run-token",
            session_token="session-token",
            internal_agui_url="http://127.0.0.1:8768/",
        )
        isolation = TenantIsolation(Path(root) / "home", Path(root) / "workspace")
        return DurableRunWorker(settings, isolation)

    def _payload(self) -> dict:
        return {
            "run_id": "run-1",
            "account_id": "account-1",
            "tenant_key": "tenant_key_1",
            "input": {"runId": "run-1", "threadId": "thread-1", "messages": []},
            "seeded_citations": [],
        }

    async def test_disconnect_does_not_cancel_worker_task(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            worker = self._worker(root)
            worker._newscraft = AsyncMock(return_value={
                "terminal": False,
                "lease_owner": "owner-1",
                "lease_token": "lease-1",
                "worker_cursor": 0,
            })
            finished = asyncio.Event()

            async def long_run(_job):
                await finished.wait()

            worker._run = long_run
            result = await worker.start(self._payload())
            await asyncio.sleep(0)
            self.assertTrue(result["accepted"])
            self.assertFalse(worker.jobs["run-1"].task.done())
            finished.set()
            await asyncio.sleep(0)
            await worker.close()

    async def test_duplicate_start_does_not_create_a_second_task(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            worker = self._worker(root)
            worker._newscraft = AsyncMock(return_value={
                "terminal": False,
                "lease_owner": "owner-1",
                "lease_token": "lease-1",
                "worker_cursor": 0,
            })
            gate = asyncio.Event()

            async def long_run(_job):
                await gate.wait()

            worker._run = long_run
            first = await worker.start(self._payload())
            second = await worker.start(self._payload())
            self.assertFalse(first["duplicate"])
            self.assertTrue(second["duplicate"])
            self.assertEqual(worker._newscraft.await_count, 1)
            gate.set()
            await worker.close()

    async def test_duplicate_start_rejects_a_different_account_or_tenant(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            worker = self._worker(root)
            worker._newscraft = AsyncMock(return_value={
                "terminal": False,
                "lease_owner": "owner-1",
                "lease_token": "lease-1",
                "worker_cursor": 0,
            })
            gate = asyncio.Event()

            async def long_run(_job):
                await gate.wait()

            worker._run = long_run
            await worker.start(self._payload())
            wrong = {**self._payload(), "account_id": "account-2", "tenant_key": "tenant_key_2"}
            with self.assertRaisesRegex(DurableRunError, "account binding"):
                await worker.start(wrong)
            self.assertEqual(worker._newscraft.await_count, 1)
            gate.set()
            await worker.close()

    async def test_duplicate_start_with_held_lease_returns_same_job_state(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            worker = self._worker(root)
            worker._newscraft = AsyncMock(side_effect=DurableRunError("lease held", 409))
            result = await worker.start(self._payload())
            self.assertEqual(result, {
                "accepted": True,
                "duplicate": True,
                "run_id": "run-1",
                "state": "running",
            })
            self.assertEqual(worker.jobs, {})
            worker._newscraft.assert_awaited_once()

    async def test_cancel_requested_callback_reaches_terminal_cancel_path(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            worker = self._worker(root)
            job = worker.jobs["run-1"] = DurableJob(
                run_id="run-1",
                account_id="account-1",
                tenant_key="tenant_key_1",
                input={},
                seeded_citations=[],
                lease_owner="owner-1",
                lease_token="lease-1",
                worker_cursor=4,
            )
            worker._newscraft = AsyncMock(
                side_effect=DurableRunError("cancel requested", 409, "stale_callback")
            )
            with self.assertRaises(asyncio.CancelledError):
                await worker._callback(job, "response.output_text.delta", {"delta": "late"})
            self.assertEqual(job.worker_cursor, 4)
            self.assertEqual(job.stop_reason, "cancelled")

    async def test_cancel_stops_the_same_task(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            worker = self._worker(root)
            worker._newscraft = AsyncMock(return_value={
                "terminal": False,
                "lease_owner": "owner-1",
                "lease_token": "lease-1",
                "worker_cursor": 0,
            })
            gate = asyncio.Event()

            async def long_run(_job):
                await gate.wait()

            worker._run = long_run
            await worker.start(self._payload())
            result = await worker.cancel("run-1")
            self.assertEqual(result["state"], "cancel_requested")
            self.assertTrue(worker.jobs["run-1"].task.done())

    async def test_recovery_uses_saved_run_id_and_input(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            worker = self._worker(root)
            recovered = {
                "runs": [{
                    **self._payload(),
                    "lease_owner": "owner-recovered",
                    "lease_token": "lease-recovered",
                    "worker_cursor": 4,
                }]
            }
            worker._newscraft = AsyncMock(return_value=recovered)
            gate = asyncio.Event()
            seen = []

            async def long_run(job):
                seen.append((job.run_id, job.worker_cursor, job.lease_token))
                await gate.wait()

            worker._run = long_run
            await worker.recover()
            await asyncio.sleep(0)
            self.assertEqual(seen, [("run-1", 4, "lease-recovered")])
            gate.set()
            await worker.close()

    def test_normalizes_ordered_agui_events_without_fallback(self) -> None:
        args: dict[str, str] = {}
        names: dict[str, str] = {}
        text: list[str] = []
        events = normalized_events("message", {"type": "TEXT_MESSAGE_CONTENT", "delta": "Hello"}, args, names, text)
        events += normalized_events("message", {"type": "RUN_FINISHED"}, args, names, text)
        self.assertEqual([item["event_type"] for item in events], ["response.output_text.delta", "agent.answer.replace", "response.completed"])


if __name__ == "__main__":
    unittest.main()
