from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from hermes_chat.contracts import HERMES_TOOLSET
from hermes_chat.service import (
    _install_iteration_limit,
    _install_public_host_alias,
    _runtime_config,
    _set_iteration_limit,
    settings_from_env,
)


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

    def test_contract_uses_the_standard_hermes_toolset(self) -> None:
        self.assertEqual(HERMES_TOOLSET, "hermes-acp")

    def test_runtime_config_keeps_all_model_work_on_one_endpoint(self) -> None:
        config = _runtime_config(
            {
                "browser": {"headed": False},
                "fallback_model": {"provider": "openrouter", "model": "another-model"},
                "auxiliary": {
                    "vision": {"timeout": 90},
                    "plugin_task": {"provider": "openrouter", "model": "another-model"},
                },
            },
            {"vision", "web_extract"},
            "chat_completions",
        )

        self.assertEqual(config["browser"], {"headed": False})
        self.assertEqual(config["fallback_providers"], [])
        self.assertNotIn("fallback_model", config)
        self.assertEqual(config["agui"]["toolsets"], ["hermes-acp"])
        for task_name in ("vision", "web_extract", "plugin_task"):
            task = config["auxiliary"][task_name]
            self.assertEqual(task["provider"], "custom")
            self.assertEqual(task["model"], "${env:NEWSCRAFT_HERMES_MODEL}")
            self.assertEqual(task["base_url"], "${env:NEWSCRAFT_HERMES_MODEL_BASE_URL}")
            self.assertEqual(task["api_key"], "${env:NEWSCRAFT_HERMES_MODEL_API_KEY}")
            self.assertEqual(task["fallback_chain"], [])


if __name__ == "__main__":
    unittest.main()
