from __future__ import annotations

import asyncio
import json
import logging
import os
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from types import ModuleType, SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

from fastapi.testclient import TestClient
import httpx

from hermes_chat import service as service_module
from hermes_chat.service import Settings, create_app, prepare_runtime, settings_from_env, _durable_recovery_loop
from hermes_chat.durable import (
    TEXT_BATCH_FLUSH_INTERVAL_SECONDS,
    TEXT_BATCH_MAX_CHARS,
    DurableJob,
    DurableRunError,
    DurableRunWorker,
    normalized_events,
)
from hermes_chat.isolation import TenantIsolation, TenantRun


class OwnedAgentServiceTests(unittest.TestCase):
    def _environment(self, root: str) -> dict[str, str]:
        return {
            "NEWSCRAFT_AGENT_HOST": "127.0.0.1",
            "NEWSCRAFT_AGENT_PORT": "8768",
            "NEWSCRAFT_AGENT_SESSION_TOKEN": "a" * 32,
            "NEWSCRAFT_AGENT_STATE_HOME": str(Path(root) / "state"),
            "NEWSCRAFT_AGENT_WORKSPACE": str(Path(root) / "workspace"),
            "NEWSCRAFT_AGENT_MODEL": "fixture-model",
            "NEWSCRAFT_AGENT_INPUT_PRICE_CEILING": "10",
            "NEWSCRAFT_AGENT_OUTPUT_PRICE_CEILING": "60",
            "OPENAI_BASE_URL": "http://127.0.0.1:8767/v1",
            "OPENAI_API_KEY": "fixture-key",
            "NEWSCRAFT_AGENT_RUN_API_URL": "https://newscraft.test/api/internal/hermes/runs",
            "NEWSCRAFT_AGENT_RUN_API_TOKEN": "fixture-run-token",
        }

    def _settings(self, root: str, **environment: str) -> Settings:
        with patch.dict(os.environ, {**self._environment(root), **environment}, clear=True):
            return settings_from_env()

    def test_executor_requires_an_explicit_immutable_image_and_socket(self):
        with tempfile.TemporaryDirectory() as root:
            self.assertIsNone(self._settings(root).executor)
            image = "sha256:" + "a" * 64
            settings = self._settings(root, NEWSCRAFT_EXECUTOR_IMAGE=image, NEWSCRAFT_EXECUTOR_SOCKET="/fixture/private/docker.sock")
            self.assertEqual(settings.executor.image, image)
            self.assertEqual(settings.executor.state_root, settings.hermes_home / "computer")
            with self.assertRaises((ValueError, RuntimeError)):
                self._settings(root, NEWSCRAFT_EXECUTOR_IMAGE="python:latest", NEWSCRAFT_EXECUTOR_SOCKET="/fixture/private/docker.sock")
            with self.assertRaises(RuntimeError):
                self._settings(root, NEWSCRAFT_EXECUTOR_IMAGE=image)
            with self.assertRaises(RuntimeError):
                self._settings(root, NEWSCRAFT_EXECUTOR_SOCKET="/fixture/private/docker.sock")

    def _app(self, root: str, configured: bool = True, capability_ready: bool = True, **environment: str):
        settings = self._settings(root, **environment)
        worker = SimpleNamespace(
            configured=configured,
            start=AsyncMock(return_value={"accepted": True, "run_id": "run-1", "state": "queued"}),
            cancel=AsyncMock(return_value={"accepted": True, "run_id": "run-1", "state": "cancel_requested"}),
            recover=AsyncMock(), close=AsyncMock(), publish_artifact_from_tool=AsyncMock(), runtime_checkpoint=AsyncMock(),
            capacity_snapshot=lambda: {"active_runs": 0, "queued_runs": 0, "limits": {}},
        )
        runner = SimpleNamespace(readiness=AsyncMock(return_value={
            "configured": capability_ready, "tools": ["plan", "decision", "publish_markdown", "publish_csv", "web_search", "verify_this_lead", "web_extract", "record_newscraft_source"],
            "terminal": False, "files": capability_ready, "browser": False, "sandbox": "unconfigured",
        }))
        runtime_module = ModuleType("hermes_chat.portable")
        runtime_module.PortableAgentRunner = Mock(return_value=runner)
        with patch.dict(sys.modules, {"hermes_chat.portable": runtime_module}), \
            patch.object(service_module, "DurableRunWorker", return_value=worker), \
            patch.object(service_module, "retrieval_readiness", return_value={"configured": True}):
            app = create_app(settings)
        return app, worker, runner, settings

    def test_browser_configuration_requires_immutable_image_and_reviewed_profile_together(self):
        with tempfile.TemporaryDirectory() as root:
            env = {"NEWSCRAFT_EXECUTOR_IMAGE": "sha256:" + "a" * 64,
                "NEWSCRAFT_EXECUTOR_SOCKET": "/fixture/docker.sock",
                "NEWSCRAFT_BROWSER_IMAGE": "sha256:" + "b" * 64,
                "NEWSCRAFT_BROWSER_SECCOMP_PROFILE": "/fixture/reviewed.json",
                "NEWSCRAFT_BROWSER_SECCOMP_SHA256": "c" * 64}
            settings = self._settings(root, **env)
            self.assertEqual(settings.browser_provider, "rootless-oci")
            for name in env:
                partial = dict(env)
                partial.pop(name)
                with self.subTest(name=name), self.assertRaises((ValueError, RuntimeError)):
                    self._settings(root, **partial)

    def test_authenticated_readiness_reports_configured_browser_without_claiming_live_verification(self):
        with tempfile.TemporaryDirectory() as root:
            app, _, runner, _ = self._app(root)
            runner.readiness.return_value.update(browser=True, terminal=True, workspaceFiles=True)
            with TestClient(app, base_url="http://127.0.0.1:8768") as client:
                private = client.get("/ready", headers=self._headers()).json()
                public = client.get("/ready").json()
            self.assertEqual(private["toolProviders"]["browser"], {"configured": True, "verified": False})
            self.assertTrue(private["capabilities"]["browser"])
            self.assertFalse(private["runtime"]["accessVerified"])
            self.assertNotIn("toolProviders", public)

    def _headers(self, tenant: str = "tenant-key-123") -> dict[str, str]:
        return {"host": "127.0.0.1:8768", "authorization": f"Bearer {'a' * 32}", "x-newscraft-tenant-key": tenant}

    def test_explicit_owned_openai_endpoint_and_budgets(self):
        with tempfile.TemporaryDirectory() as root:
            settings = self._settings(root)
        self.assertEqual(settings.model_provider, "openai")
        self.assertEqual(settings.model_api_mode, "responses")
        self.assertEqual(settings.model, "fixture-model")
        self.assertEqual(settings.max_iterations, 12)
        self.assertEqual(settings.max_seconds, 180)
        self.assertEqual(settings.max_input_tokens, 120000)
        self.assertEqual(settings.max_output_tokens, 4096)
        self.assertEqual(settings.max_cost_usd, 2)
        self.assertEqual(settings.browser_provider, "disabled")

    def test_secret_fields_are_not_in_settings_repr(self):
        with tempfile.TemporaryDirectory() as root:
            settings = self._settings(root)
        self.assertNotIn("fixture-key", repr(settings))
        self.assertNotIn("fixture-run-token", repr(settings))
        self.assertNotIn("a" * 32, repr(settings))

    def test_reads_only_selected_openai_key_from_existing_file_without_copy(self):
        with tempfile.TemporaryDirectory() as root:
            source = Path(root) / ".env.local"
            content = 'UNRELATED_SECRET=do-not-load\nDEEPSEEK_API_KEY=ignored-one\nDEEPSEEK_API_KEY=ignored-two\nexport OPENAI_API_KEY="fixture-existing-key"\n'
            source.write_text(content)
            settings = self._settings(root, OPENAI_API_KEY="", NEWSCRAFT_AGENT_CREDENTIAL_FILE=str(source))
            self.assertEqual(settings.model_api_key, "fixture-existing-key")
            self.assertEqual(source.read_text(), content)
            self.assertFalse(settings.hermes_home.exists())
            self.assertFalse(settings.workspace.exists())
            self.assertNotIn("UNRELATED_SECRET", os.environ)

    def test_credential_file_rejects_symlink_duplicates_and_missing_key(self):
        with tempfile.TemporaryDirectory() as root:
            source = Path(root) / ".env.local"
            source.write_text("OPENAI_API_KEY=one\nOPENAI_API_KEY=two\n")
            with self.assertRaisesRegex(RuntimeError, "exactly one"):
                self._settings(root, OPENAI_API_KEY="", NEWSCRAFT_AGENT_CREDENTIAL_FILE=str(source))
            link = Path(root) / "link"
            link.symlink_to(source)
            with self.assertRaisesRegex(RuntimeError, "regular absolute"):
                self._settings(root, OPENAI_API_KEY="", NEWSCRAFT_AGENT_CREDENTIAL_FILE=str(link))
            source.write_text("OTHER_KEY=fixture-value\n")
            with self.assertRaisesRegex(RuntimeError, "exactly one"):
                self._settings(root, OPENAI_API_KEY="", NEWSCRAFT_AGENT_CREDENTIAL_FILE=str(source))

    def test_defaults_to_documented_direct_model_and_explicit_adapter(self):
        with tempfile.TemporaryDirectory() as root:
            settings = self._settings(root, NEWSCRAFT_AGENT_MODEL="")
            self.assertEqual(settings.model, "gpt-6-astra")
            settings = self._settings(root, NEWSCRAFT_AGENT_MODEL="fixture-model")
            self.assertEqual(settings.model, "fixture-model")

    def test_deepseek_defaults_to_current_model_and_messages_endpoint(self):
        with tempfile.TemporaryDirectory() as root:
            settings = self._settings(root, NEWSCRAFT_AGENT_MODEL_PROVIDER="deepseek", NEWSCRAFT_AGENT_MODEL="",
                DEEPSEEK_API_KEY="fixture-deepseek", ANTHROPIC_API_KEY="unrelated-anthropic",
                ANTHROPIC_BASE_URL="https://unrelated.example/v1")
            self.assertEqual(settings.model_provider, "deepseek")
            self.assertEqual(settings.model, "deepseek-flash")
            self.assertEqual(settings.model_api_mode, "messages")
            self.assertEqual(settings.model_base_url, "https://api.deepseek.com/anthropic")
            self.assertEqual(settings.model_api_key, "fixture-deepseek")
            self.assertEqual(settings.search_api_key, "")
            self.assertNotIn("fixture-deepseek", repr(settings))
            explicit = self._settings(root, NEWSCRAFT_AGENT_MODEL_PROVIDER="deepseek", NEWSCRAFT_AGENT_MODEL="deepseek-v4-pro",
                DEEPSEEK_API_KEY="fixture-deepseek", DEEPSEEK_BASE_URL="http://127.0.0.1:8767/anthropic/")
            self.assertEqual(explicit.model, "deepseek-v4-pro")
            self.assertEqual(explicit.model_base_url, "http://127.0.0.1:8767/anthropic")

    def test_deepseek_readiness_reports_selected_adapter_without_claiming_provider_access(self):
        with tempfile.TemporaryDirectory() as root:
            app, _, _, _ = self._app(root, NEWSCRAFT_AGENT_MODEL_PROVIDER="deepseek", NEWSCRAFT_AGENT_MODEL="deepseek-flash",
                DEEPSEEK_API_KEY="fixture-deepseek")
            with TestClient(app, base_url="http://127.0.0.1:8768") as client:
                response = client.get("/ready", headers=self._headers())
                public = client.get("/ready").json()
            self.assertEqual(response.status_code, 200)
            runtime = response.json()["runtime"]
            self.assertEqual(runtime["provider"], "deepseek")
            self.assertEqual(runtime["model"], "deepseek-flash")
            self.assertEqual(runtime["apiMode"], "messages")
            self.assertFalse(runtime["accessVerified"])
            self.assertNotIn("fixture-deepseek", response.text)
            self.assertNotIn("runtime", public)

    def test_deepseek_rejects_legacy_aliases_and_unknown_models_before_reading_credentials(self):
        with tempfile.TemporaryDirectory() as root, \
            patch.object(service_module, "_credential_from_file", side_effect=AssertionError("must not read")):
            for model in ("deepseek-chat", "deepseek-reasoner", "claude-sonnet", "deepseek-v4-flash", "typo-model"):
                with self.subTest(model=model), self.assertRaisesRegex(RuntimeError, "must be deepseek-flash or deepseek-v4-pro"):
                    self._settings(root, NEWSCRAFT_AGENT_MODEL_PROVIDER="deepseek", NEWSCRAFT_AGENT_MODEL=model,
                        NEWSCRAFT_AGENT_CREDENTIAL_FILE="/must-not-read")

    def test_deepseek_reads_only_selected_key_from_existing_file_without_copy(self):
        with tempfile.TemporaryDirectory() as root:
            source = Path(root) / ".env.local"
            content = 'UNRELATED_SECRET=do-not-load\nOPENAI_API_KEY=unrelated-one\nOPENAI_API_KEY=unrelated-two\nexport DEEPSEEK_API_KEY="fixture-deepseek-file"\n'
            source.write_text(content)
            settings = self._settings(root, NEWSCRAFT_AGENT_MODEL_PROVIDER="deepseek", NEWSCRAFT_AGENT_MODEL="deepseek-flash",
                OPENAI_API_KEY="", DEEPSEEK_API_KEY="", NEWSCRAFT_AGENT_CREDENTIAL_FILE=str(source))
            self.assertEqual(settings.model_api_key, "fixture-deepseek-file")
            self.assertEqual(settings.search_api_key, "")
            self.assertEqual(source.read_text(), content)
            self.assertFalse(settings.hermes_home.exists())
            self.assertFalse(settings.workspace.exists())
            self.assertNotIn("DEEPSEEK_API_KEY", os.environ)
            self.assertNotIn("UNRELATED_SECRET", os.environ)

    def test_deepseek_credential_file_rejects_missing_duplicate_and_malformed_selected_key_safely(self):
        with tempfile.TemporaryDirectory() as root:
            source = Path(root) / "synthetic.env"
            for content in (
                "OPENAI_API_KEY=unrelated-secret\n",
                "DEEPSEEK_API_KEY=fixture-one\nDEEPSEEK_API_KEY=fixture-two\n",
                "DEEPSEEK_API_KEY=fixture-one\nDEEPSEEK_API_KEY=\n",
                "DEEPSEEK_API_KEY=fixture-one\nDEEPSEEK_API_KEY\n",
                "DEEPSEEK_API_KEY=\n",
                'DEEPSEEK_API_KEY="fixture-unclosed\n',
                "DEEPSEEK_API_KEY=fixture-invalid'\n",
                'DEEPSEEK_API_KEY="fixture with whitespace"\n',
            ):
                source.write_text(content)
                with self.subTest(content=content), self.assertRaises(RuntimeError) as caught:
                    self._settings(root, NEWSCRAFT_AGENT_MODEL_PROVIDER="deepseek", NEWSCRAFT_AGENT_MODEL="deepseek-flash",
                        DEEPSEEK_API_KEY="", NEWSCRAFT_AGENT_CREDENTIAL_FILE=str(source))
                self.assertEqual(str(caught.exception),
                    "NEWSCRAFT_AGENT_CREDENTIAL_FILE must contain exactly one usable DEEPSEEK_API_KEY")

    def test_deepseek_environment_key_has_priority_and_public_search_needs_no_other_key(self):
        with tempfile.TemporaryDirectory() as root, \
            patch.object(service_module, "_credential_from_file", side_effect=AssertionError("must not read")):
            settings = self._settings(root, NEWSCRAFT_AGENT_MODEL_PROVIDER="deepseek", NEWSCRAFT_AGENT_MODEL="deepseek-flash",
                DEEPSEEK_API_KEY="fixture-deepseek", OPENAI_API_KEY="", NEWSCRAFT_AGENT_CREDENTIAL_FILE="/not-used",
                NEWSCRAFT_AGENT_WEB_PROVIDER="public")
            self.assertEqual(settings.model_api_key, "fixture-deepseek")
            self.assertEqual(settings.search_api_key, "")

    def test_deepseek_missing_key_does_not_fall_back_to_another_provider(self):
        with tempfile.TemporaryDirectory() as root:
            with self.assertRaisesRegex(RuntimeError, "DEEPSEEK_API_KEY is required"):
                self._settings(root, NEWSCRAFT_AGENT_MODEL_PROVIDER="deepseek", NEWSCRAFT_AGENT_MODEL="deepseek-flash",
                    DEEPSEEK_API_KEY="", ANTHROPIC_API_KEY="unrelated-anthropic")

    def test_deepseek_optional_openai_search_selects_a_separate_file_key(self):
        with tempfile.TemporaryDirectory() as root:
            source = Path(root) / "synthetic.env"
            source.write_text("OPENAI_API_KEY=fixture-search\nDEEPSEEK_API_KEY=fixture-model-key\nUNRELATED_KEY=ignored\n")
            settings = self._settings(root, NEWSCRAFT_AGENT_MODEL_PROVIDER="deepseek", NEWSCRAFT_AGENT_MODEL="deepseek-flash",
                OPENAI_API_KEY="", DEEPSEEK_API_KEY="", NEWSCRAFT_AGENT_CREDENTIAL_FILE=str(source),
                NEWSCRAFT_AGENT_WEB_PROVIDER="openai", NEWSCRAFT_AGENT_SEARCH_CALL_PRICE_CEILING="0.25")
            self.assertEqual(settings.model_api_key, "fixture-model-key")
            self.assertEqual(settings.search_api_key, "fixture-search")
            self.assertEqual(settings.search_cost_ceiling_usd, 0.25)
            self.assertNotIn("fixture-search", repr(settings))
            source.write_text("DEEPSEEK_API_KEY=fixture-model-key\n")
            with self.assertRaisesRegex(RuntimeError, "exactly one usable OPENAI_API_KEY"):
                self._settings(root, NEWSCRAFT_AGENT_MODEL_PROVIDER="deepseek", NEWSCRAFT_AGENT_MODEL="deepseek-flash",
                    OPENAI_API_KEY="", DEEPSEEK_API_KEY="", NEWSCRAFT_AGENT_CREDENTIAL_FILE=str(source),
                    NEWSCRAFT_AGENT_WEB_PROVIDER="openai")

    def test_deepseek_rejects_unsafe_endpoint_without_exposing_its_contents(self):
        with tempfile.TemporaryDirectory() as root:
            for base_url in ("http://remote.example/anthropic", "https://user:fixture-secret@remote.example/anthropic",
                             "https://api.deepseek.com/anthropic?key=fixture-secret"):
                with self.subTest(base_url=base_url), self.assertRaises(RuntimeError) as caught:
                    self._settings(root, NEWSCRAFT_AGENT_MODEL_PROVIDER="deepseek", NEWSCRAFT_AGENT_MODEL="deepseek-flash",
                        DEEPSEEK_API_KEY="fixture-deepseek", DEEPSEEK_BASE_URL=base_url)
                self.assertNotIn("fixture-secret", str(caught.exception))

    def test_anthropic_public_search_needs_no_openai_credential(self):
        with tempfile.TemporaryDirectory() as root:
            with patch.object(service_module, "_credential_from_file", side_effect=AssertionError("must not read")):
                settings = self._settings(root, NEWSCRAFT_AGENT_MODEL_PROVIDER="anthropic", ANTHROPIC_API_KEY="fixture-anthropic",
                    OPENAI_API_KEY="", NEWSCRAFT_AGENT_CREDENTIAL_FILE="/not-used", NEWSCRAFT_AGENT_WEB_PROVIDER="public")
            self.assertEqual(settings.model_api_key, "fixture-anthropic")
            self.assertEqual(settings.model_api_mode, "messages")
            self.assertEqual(settings.search_api_key, "")

    def test_anthropic_optional_openai_search_reads_only_the_approved_reference(self):
        with tempfile.TemporaryDirectory() as root:
            source = Path(root) / "synthetic.env"
            source.write_text("OPENAI_API_KEY=fixture-search\nUNRELATED_KEY=ignored\n")
            settings = self._settings(root, NEWSCRAFT_AGENT_MODEL_PROVIDER="anthropic", ANTHROPIC_API_KEY="fixture-anthropic",
                OPENAI_API_KEY="", NEWSCRAFT_AGENT_CREDENTIAL_FILE=str(source), NEWSCRAFT_AGENT_WEB_PROVIDER="openai",
                NEWSCRAFT_AGENT_SEARCH_CALL_PRICE_CEILING="0.25")
            self.assertEqual(settings.model_api_key, "fixture-anthropic")
            self.assertEqual(settings.search_api_key, "fixture-search")
            self.assertEqual(settings.search_cost_ceiling_usd, 0.25)

    def test_environment_key_has_priority_without_reading_file(self):
        with tempfile.TemporaryDirectory() as root:
            settings = self._settings(root, NEWSCRAFT_AGENT_CREDENTIAL_FILE="/missing/file")
        self.assertEqual(settings.model_api_key, "fixture-key")

    def test_duplicate_authorization_is_rejected(self):
        with tempfile.TemporaryDirectory() as root:
            app, worker, *_ = self._app(root)
            headers = [*self._headers().items(), ("authorization", "Bearer " + "a" * 32)]
            with TestClient(app, base_url="http://127.0.0.1:8768") as client:
                self.assertEqual(client.post("/v1/runs/start", json={"tenant_key": "tenant-key-123"}, headers=headers).status_code, 401)
            worker.start.assert_not_awaited()

    def test_legacy_model_key_does_not_silently_select_upstream_provider(self):
        with tempfile.TemporaryDirectory() as root:
            with self.assertRaisesRegex(RuntimeError, "OPENAI_API_KEY"):
                self._settings(root, OPENAI_API_KEY="", NEWSCRAFT_HERMES_MODEL_API_KEY="legacy-key")

    def test_rejects_unsafe_endpoint_and_unbounded_budget(self):
        with tempfile.TemporaryDirectory() as root:
            for environment in (
                {"OPENAI_BASE_URL": "http://remote.example/v1"},
                {"OPENAI_BASE_URL": "https://user:secret@remote.example/v1"},
                {"NEWSCRAFT_AGENT_MAX_STEPS": "0"},
                {"NEWSCRAFT_AGENT_MAX_COST_USD": "NaN"},
                {"NEWSCRAFT_AGENT_MAX_SECONDS": "99999"},
                {"NEWSCRAFT_AGENT_MODEL_PROVIDER": "other"},
                {"NEWSCRAFT_AGENT_BROWSER_PROVIDER": "browser-use"},
            ):
                with self.subTest(environment=environment), self.assertRaises(RuntimeError):
                    self._settings(root, **environment)

    def test_rejects_overlapping_roots_and_symlink(self):
        with tempfile.TemporaryDirectory() as root:
            with self.assertRaisesRegex(RuntimeError, "separate"):
                self._settings(root, NEWSCRAFT_AGENT_STATE_HOME=str(Path(root) / "workspace"))
            target = Path(root) / "real"
            target.mkdir()
            link = Path(root) / "link"
            link.symlink_to(target, target_is_directory=True)
            with self.assertRaisesRegex(RuntimeError, "symlink"):
                self._settings(root, NEWSCRAFT_AGENT_STATE_HOME=str(link))

    def test_prepare_runtime_preserves_process_environment_and_cwd(self):
        with tempfile.TemporaryDirectory() as root:
            settings = self._settings(root)
            before = dict(os.environ)
            cwd = Path.cwd()
            prepare_runtime(settings)
            self.assertEqual(dict(os.environ), before)
            self.assertEqual(Path.cwd(), cwd)
            self.assertEqual(settings.hermes_home.stat().st_mode & 0o777, 0o700)
            self.assertEqual(settings.workspace.stat().st_mode & 0o777, 0o700)

    def test_routes_require_bearer_and_exact_host(self):
        with tempfile.TemporaryDirectory() as root:
            app, worker, runner, settings = self._app(root)
            with TestClient(app, base_url="http://127.0.0.1:8768") as client:
                self.assertEqual(client.get("/ready", headers={"host": "attacker.example"}).status_code, 400)
                result = client.post("/v1/runs/start", json={}, headers={"host": "127.0.0.1"})
                self.assertEqual(result.status_code, 401)
                result = client.post("/v1/runs/start", json={}, headers={"host": "127.0.0.1", "x-hermes-session-token": "a" * 32})
                self.assertEqual(result.status_code, 401)
            worker.start.assert_not_awaited()
            self.assertIs(runner.publisher, worker.publish_artifact_from_tool)

    def test_direct_model_execution_is_removed(self):
        with tempfile.TemporaryDirectory() as root:
            app, worker, runner, _ = self._app(root)
            runner.run = Mock(side_effect=AssertionError("direct model call is forbidden"))
            with TestClient(app, base_url="http://127.0.0.1:8768") as client:
                response = client.post("/", json={"threadId": "thread-1", "runId": "run-1"}, headers=self._headers())
            self.assertEqual(response.status_code, 410)
            runner.run.assert_not_called()
            worker.start.assert_not_awaited()

    def test_shutdown_cancels_and_awaits_periodic_recovery(self):
        reached_sleep = threading.Event()

        async def stopped_sleep(seconds):
            self.assertEqual(seconds, 15)
            reached_sleep.set()
            await asyncio.Event().wait()

        original = _durable_recovery_loop
        with tempfile.TemporaryDirectory() as root:
            app, worker, *_ = self._app(root)
            with patch.object(service_module, "_durable_recovery_loop", new=lambda active: original(active, sleep=stopped_sleep)):
                with TestClient(app, base_url="http://127.0.0.1:8768"):
                    self.assertTrue(reached_sleep.wait(timeout=1))
                    task = app.state.recovery_task
                    self.assertFalse(task.done())
                self.assertTrue(task.done())
                self.assertTrue(task.cancelled())
            worker.recover.assert_awaited_once()
            worker.close.assert_awaited_once()

    def test_durable_start_forwards_authenticated_bindings(self):
        with tempfile.TemporaryDirectory() as root:
            app, worker, *_ = self._app(root)
            payload = {"run_id": "run-1", "account_id": "account-1", "tenant_key": "tenant-key-123", "input": {"runId": "run-1", "threadId": "thread-1"}}
            with TestClient(app, base_url="http://127.0.0.1:8768") as client:
                response = client.post("/v1/runs/start", json=payload, headers=self._headers())
            self.assertEqual(response.status_code, 202)
            worker.start.assert_awaited_once_with(payload)
            worker.recover.assert_awaited_once()
            worker.close.assert_awaited_once()

    def test_start_failure_does_not_log_transport_exception_details(self):
        with tempfile.TemporaryDirectory() as root:
            app, worker, *_ = self._app(root)
            worker.start.side_effect = RuntimeError("fixture-secret-request-detail")
            with TestClient(app, base_url="http://127.0.0.1:8768") as client:
                with self.assertLogs("hermes_chat.service", level="ERROR") as logs:
                    response = client.post("/v1/runs/start", json={"tenant_key": "tenant-key-123"}, headers=self._headers())
            self.assertEqual(response.status_code, 503)
            self.assertNotIn("fixture-secret-request-detail", response.text + "\n".join(logs.output))
            self.assertTrue(all(record.exc_info is None for record in logs.records))

    def test_info_logging_never_records_signed_transport_urls(self):
        levels = {name: logging.getLogger(name).level for name in ("httpx", "httpcore")}
        try:
            for name in levels:
                logging.getLogger(name).setLevel(logging.DEBUG)
            with tempfile.TemporaryDirectory() as root, self.assertLogs(level="INFO") as logs:
                self._app(root)
                service_module.logger.info("Fixture service configured")
                with httpx.Client(transport=httpx.MockTransport(lambda request: httpx.Response(200))) as client:
                    client.put("https://storage.example.test/object?token=fixture-signed-secret", content=b"fixture")
            self.assertNotIn("fixture-signed-secret", "\n".join(logs.output))
            self.assertNotIn("HTTP Request", "\n".join(logs.output))
            self.assertTrue(all(logging.getLogger(name).getEffectiveLevel() >= logging.WARNING for name in levels))
        finally:
            for name, level in levels.items():
                logging.getLogger(name).setLevel(level)

    def test_start_rejects_missing_duplicate_and_mismatched_tenant(self):
        with tempfile.TemporaryDirectory() as root:
            app, worker, *_ = self._app(root)
            payload = {"tenant_key": "tenant-key-123"}
            with TestClient(app, base_url="http://127.0.0.1:8768") as client:
                headers = self._headers()
                headers.pop("x-newscraft-tenant-key")
                self.assertEqual(client.post("/v1/runs/start", json=payload, headers=headers).status_code, 409)
                duplicate = [*self._headers().items(), ("x-newscraft-tenant-key", "tenant-key-123")]
                self.assertEqual(client.post("/v1/runs/start", json=payload, headers=duplicate).status_code, 409)
                self.assertEqual(client.post("/v1/runs/start", json=payload, headers=self._headers("other-tenant-key")).status_code, 409)
            worker.start.assert_not_awaited()

    def test_start_rejects_invalid_json_objects(self):
        with tempfile.TemporaryDirectory() as root:
            app, worker, *_ = self._app(root)
            with TestClient(app, base_url="http://127.0.0.1:8768") as client:
                self.assertEqual(client.post("/v1/runs/start", json=[], headers=self._headers()).status_code, 400)
                self.assertEqual(client.post("/v1/runs/start", content="{bad", headers=self._headers()).status_code, 400)
            worker.start.assert_not_awaited()

    def test_overload_keeps_stable_rejected_response(self):
        with tempfile.TemporaryDirectory() as root:
            app, worker, *_ = self._app(root)
            worker.start.side_effect = DurableRunError("queue full", 429, "overloaded")
            with TestClient(app, base_url="http://127.0.0.1:8768") as client:
                response = client.post("/v1/runs/start", json={"tenant_key": "tenant-key-123"}, headers=self._headers())
            self.assertEqual(response.status_code, 429)
            self.assertEqual(response.json()["state"], "rejected")
            self.assertEqual(response.json()["code"], "overloaded")

    def test_cancel_requires_all_original_bindings(self):
        with tempfile.TemporaryDirectory() as root:
            app, worker, *_ = self._app(root)
            payload = {"run_id": "run-1", "account_id": "account-1", "tenant_key": "tenant-key-123"}
            with TestClient(app, base_url="http://127.0.0.1:8768") as client:
                self.assertEqual(client.post("/v1/runs/run-2/cancel", json=payload, headers=self._headers()).status_code, 409)
                self.assertEqual(client.post("/v1/runs/run-1/cancel", json=payload, headers=self._headers()).status_code, 202)
            worker.cancel.assert_awaited_once_with("run-1", "account-1", "tenant-key-123")

    def test_readiness_requires_owned_runtime_and_durable_callbacks(self):
        with tempfile.TemporaryDirectory() as root:
            for durable, runtime in ((False, True), (True, False)):
                app, *_ = self._app(root, configured=durable, capability_ready=runtime)
                with TestClient(app, base_url="http://127.0.0.1:8768") as client:
                    response = client.get("/ready", headers=self._headers())
                self.assertEqual(response.status_code, 503)
                self.assertFalse(response.json()["ok"])

    def test_public_readiness_redacts_model_and_private_capabilities(self):
        with tempfile.TemporaryDirectory() as root:
            app, *_ = self._app(root)
            with TestClient(app, base_url="http://127.0.0.1:8768") as client:
                public = client.get("/ready").json()
                private = client.get("/ready", headers=self._headers()).json()
            self.assertEqual(set(public), {"ok", "state", "service"})
            self.assertEqual(private["service"], "newscraft-agent")
            self.assertEqual(private["runtime"]["apiMode"], "responses")
            self.assertEqual(private["runtime"]["orchestration"], "newscraft")
            self.assertTrue(private["capabilities"]["boundedLoop"]["costBudget"])
            self.assertFalse(private["capabilities"]["browser"])
            self.assertNotIn("hermesCommit", private)
            self.assertNotIn("delegation", private["capabilities"])
            self.assertNotIn("fixture-key", str(private))
            fixture = json.loads((Path(__file__).resolve().parents[3] / "src/lib/server/agent/fixtures/owned-readiness.json").read_text())
            for key in ("tools", "runtime", "toolProviders", "capabilities"):
                self.assertEqual(private[key], fixture[key])


class PeriodicRecoveryTests(unittest.IsolatedAsyncioTestCase):
    async def test_poll_recovers_lease_that_was_not_expired_on_startup(self):
        expired = False
        recovered = []
        checks = []
        sleeps = []

        async def recover():
            checks.append(expired)
            if expired:
                recovered.append("saved-run")

        async def advance_lease_time(seconds):
            nonlocal expired
            sleeps.append(seconds)
            if len(sleeps) == 2:
                raise asyncio.CancelledError
            expired = True

        worker = SimpleNamespace(recover=recover)
        with self.assertRaises(asyncio.CancelledError):
            await _durable_recovery_loop(worker, sleep=advance_lease_time)
        self.assertEqual(checks, [False, True])
        self.assertEqual(recovered, ["saved-run"])
        self.assertEqual(sleeps, [15, 15])

    async def test_failed_poll_retries_without_logging_request_details(self):
        worker = SimpleNamespace(recover=AsyncMock(side_effect=[RuntimeError("fixture-secret-request-detail"), None]))
        intervals = []

        async def advance(seconds):
            intervals.append(seconds)
            if len(intervals) == 2:
                raise asyncio.CancelledError

        with self.assertLogs("hermes_chat.service", level="WARNING") as logs:
            with self.assertRaises(asyncio.CancelledError):
                await _durable_recovery_loop(worker, sleep=advance)
        self.assertEqual(worker.recover.await_count, 2)
        self.assertEqual(intervals, [15, 15])
        self.assertNotIn("fixture-secret-request-detail", "\n".join(logs.output))
        self.assertIn("retrying on the next interval", "\n".join(logs.output))


class DurableHermesWorkerTests(unittest.IsolatedAsyncioTestCase):
    def _worker(self, root: str) -> DurableRunWorker:
        root = str(Path(root).resolve())
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
            "trace_id": "trace_12345678",
            "input": {"runId": "run-1", "threadId": "thread-1", "trace_id": "trace_12345678", "messages": []},
            "seeded_citations": [],
        }

    async def test_trace_is_bound_to_the_saved_input_and_forwarded_to_callbacks(self) -> None:
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
            payload = self._payload()
            result = await worker.start(payload)
            job = worker.jobs["run-1"]

            self.assertEqual(result["accepted"], True)
            self.assertEqual(job.trace_id, "trace_12345678")
            self.assertEqual(worker._headers(job.trace_id)["x-trace-id"], "trace_12345678")
            claim_body = worker._newscraft.await_args_list[0].args[2]
            self.assertEqual(claim_body["trace_id"], "trace_12345678")

            await worker._callback(job, "run.started", {"status": "researching"})
            callback_body = worker._newscraft.await_args_list[1].args[2]
            self.assertEqual(callback_body["trace_id"], "trace_12345678")

            gate.set()
            await worker.close()

    async def test_trace_mismatch_is_rejected_before_claiming_a_run(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            worker = self._worker(root)
            payload = self._payload()
            payload["trace_id"] = "trace_87654321"

            with self.assertRaisesRegex(DurableRunError, "trace binding"):
                await worker.start(payload)

            worker._newscraft = AsyncMock()
            self.assertFalse(worker._newscraft.await_args_list)

    async def test_non_string_trace_is_rejected_before_claiming_a_run(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            worker = self._worker(root)
            payload = self._payload()
            payload["trace_id"] = 12345678

            with self.assertRaisesRegex(DurableRunError, "trace_id is invalid"):
                await worker.start(payload)

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
            worker._newscraft = AsyncMock(side_effect=DurableRunError("lease held", 409, "lease_conflict"))
            result = await worker.start(self._payload())
            self.assertEqual(result, {
                "accepted": True,
                "duplicate": True,
                "run_id": "run-1",
                "state": "running",
            })
            self.assertEqual(worker.jobs, {})
            worker._newscraft.assert_awaited_once()

    async def test_trace_binding_409_is_not_reported_as_an_accepted_duplicate(self) -> None:
        for rejection in ("missing", "malformed", "mismatched"):
            with self.subTest(rejection=rejection), tempfile.TemporaryDirectory() as root:
                worker = self._worker(root)
                worker._newscraft = AsyncMock(
                    side_effect=DurableRunError(f"{rejection} trace binding rejected", 409, "trace_binding")
                )

                with self.assertRaises(DurableRunError) as context:
                    await worker.start(self._payload())

                self.assertEqual(context.exception.status_code, 409)
                self.assertEqual(context.exception.code, "trace_binding")
                self.assertNotIn("trace_12345678", str(context.exception))
                self.assertEqual(worker.jobs, {})
                worker._newscraft.assert_awaited_once()

    async def test_unclassified_claim_409_is_propagated_without_state_mutation(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            worker = self._worker(root)
            worker._newscraft = AsyncMock(side_effect=DurableRunError("claim rejected", 409))

            with self.assertRaises(DurableRunError) as context:
                await worker.start(self._payload())

            self.assertEqual(context.exception.status_code, 409)
            self.assertIsNone(context.exception.code)
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
            await worker._callback(job, "response.output_text.delta", {"delta": "late"})
            with self.assertRaises(asyncio.CancelledError):
                await worker._flush_text(job)
            self.assertEqual(job.worker_cursor, 4)
            self.assertEqual(job.stop_reason, "cancelled")

    async def test_text_batches_at_the_size_threshold_and_preserves_one_cursor_per_batch(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            worker = self._worker(root)
            calls = []

            async def callback(*args, **kwargs):
                calls.append(args[2])
                return {}

            worker._newscraft = callback
            job = DurableJob("run-1", "account-1", "tenant_key_1", {}, [], "owner-1", "lease-1")
            await worker._callback(job, "response.output_text.delta", {"delta": "a" * (TEXT_BATCH_MAX_CHARS - 1)})
            self.assertEqual(calls, [])
            await worker._callback(job, "response.output_text.delta", {"delta": "b"})

            self.assertEqual(len(calls), 1)
            self.assertEqual(calls[0]["event_type"], "response.output_text.delta")
            self.assertEqual(calls[0]["data"]["delta"], "a" * (TEXT_BATCH_MAX_CHARS - 1) + "b")
            self.assertEqual(calls[0]["worker_cursor"], 1)
            await worker._stop_text_flush(job)

    async def test_text_batches_flush_on_a_timer_before_the_next_hermes_event(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            worker = self._worker(root)
            calls = []

            async def callback(*args, **kwargs):
                calls.append(args[2])
                return {}

            worker._newscraft = callback
            job = DurableJob("run-1", "account-1", "tenant_key_1", {}, [], "owner-1", "lease-1")
            await worker._callback(job, "response.output_text.delta", {"delta": "timed"})
            self.assertEqual(calls, [])
            await asyncio.sleep(TEXT_BATCH_FLUSH_INTERVAL_SECONDS * 2.5)

            self.assertEqual([item["data"]["delta"] for item in calls], ["timed"])
            self.assertEqual(job.worker_cursor, 1)
            await worker._stop_text_flush(job)

    async def test_structural_and_terminal_events_flush_text_in_order(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            worker = self._worker(root)
            calls = []

            async def callback(*args, **kwargs):
                calls.append(args[2])
                return {}

            worker._newscraft = callback
            job = DurableJob("run-1", "account-1", "tenant_key_1", {}, [], "owner-1", "lease-1")
            await worker._callback(job, "response.output_text.delta", {"delta": "first"})
            await worker._callback(job, "agent.citations", {"citations": []})
            await worker._callback(job, "response.output_text.delta", {"delta": "second"})
            await worker._callback(job, "response.completed", {"model": "hermes"})

            self.assertEqual([item["event_type"] for item in calls], [
                "response.output_text.delta",
                "agent.citations",
                "response.output_text.delta",
                "response.completed",
            ])
            self.assertEqual([item["data"].get("delta") for item in calls if "delta" in item["data"]], ["first", "second"])
            self.assertEqual([item["worker_cursor"] for item in calls], [1, 2, 3, 4])
            await worker._stop_text_flush(job)

    async def test_cancellation_and_failure_flush_text_before_terminal_events(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            worker = self._worker(root)
            calls = []

            async def callback(*args, **kwargs):
                calls.append(args[2])
                return {}

            worker._newscraft = callback
            for terminal_event, terminal_data in (
                ("run.cancelled", {"status": "cancelled"}),
                ("run.failed", {"error": {"message": "failed"}}),
            ):
                calls.clear()
                job = DurableJob("run-1", "account-1", "tenant_key_1", {}, [], "owner-1", "lease-1")
                await worker._callback(job, "response.output_text.delta", {"delta": "buffered"})
                await worker._callback(job, terminal_event, terminal_data)

                self.assertEqual([item["event_type"] for item in calls], [
                    "response.output_text.delta",
                    terminal_event,
                ])
                self.assertEqual(calls[0]["data"]["delta"], "buffered")
                await worker._stop_text_flush(job)

    async def test_large_text_is_split_into_bounded_batches_without_loss_or_duplicate_suffixes(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            worker = self._worker(root)
            calls = []

            async def callback(*args, **kwargs):
                calls.append(args[2])
                return {}

            worker._newscraft = callback
            job = DurableJob("run-1", "account-1", "tenant_key_1", {}, [], "owner-1", "lease-1")
            text = "x" * (TEXT_BATCH_MAX_CHARS * 2 + 7)
            await worker._callback(job, "response.output_text.delta", {"delta": text})
            await worker._callback(job, "response.completed", {"model": "hermes"})

            deltas = [item["data"]["delta"] for item in calls if item["event_type"] == "response.output_text.delta"]
            self.assertEqual("".join(deltas), text)
            self.assertTrue(all(len(delta) <= TEXT_BATCH_MAX_CHARS for delta in deltas))
            self.assertEqual(len(calls), 4)
            self.assertEqual([item["worker_cursor"] for item in calls], [1, 2, 3, 4])
            await worker._stop_text_flush(job)

    async def test_failed_text_callback_drops_only_the_unaccepted_bounded_tail(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            worker = self._worker(root)
            calls = []

            async def callback(*args, **kwargs):
                calls.append(args[2])
                if len(calls) == 1:
                    raise DurableRunError("callback unavailable", 503)
                return {}

            worker._newscraft = callback
            job = DurableJob("run-1", "account-1", "tenant_key_1", {}, [], "owner-1", "lease-1")
            await worker._callback(job, "response.output_text.delta", {"delta": "tail"})
            with self.assertRaisesRegex(DurableRunError, "callback unavailable"):
                await worker._flush_text(job)
            self.assertEqual(job.text_buffer_chars, 0)
            await worker._callback(job, "run.failed", {"error": {"message": "stopped"}})
            self.assertEqual([item["event_type"] for item in calls], ["response.output_text.delta", "run.failed"])
            self.assertEqual([item["worker_cursor"] for item in calls], [1, 1])
            await worker._stop_text_flush(job)

    async def test_stale_lease_drops_the_buffered_tail_without_advancing_the_cursor(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            worker = self._worker(root)
            worker._newscraft = AsyncMock(
                side_effect=DurableRunError("lease expired", 409, "stale_lease")
            )
            job = DurableJob("run-1", "account-1", "tenant_key_1", {}, [], "owner-1", "lease-1", worker_cursor=7)
            await worker._callback(job, "response.output_text.delta", {"delta": "tail"})

            with self.assertRaisesRegex(DurableRunError, "lease expired"):
                await worker._flush_text(job)
            self.assertEqual(job.worker_cursor, 7)
            self.assertTrue(job.stale_lease)
            self.assertEqual(job.stop_reason, "stale_lease")
            self.assertEqual(job.text_buffer_chars, 0)
            await worker._stop_text_flush(job)

    async def test_shutdown_flushes_text_before_canceling_the_worker_task(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            worker = self._worker(root)
            calls = []
            gate = asyncio.Event()

            async def callback(*args, **kwargs):
                if args[1].endswith("/callback"):
                    calls.append(args[2])
                return {
                    "terminal": False,
                    "lease_owner": "owner-1",
                    "lease_token": "lease-1",
                    "worker_cursor": 0,
                }

            async def long_run(_job):
                await gate.wait()

            worker._newscraft = callback
            worker._run = long_run
            await worker.start(self._payload())
            await asyncio.sleep(0)
            await worker._callback(worker.jobs["run-1"], "response.output_text.delta", {"delta": "before shutdown"})

            await worker.close()

            self.assertEqual([item["event_type"] for item in calls], ["response.output_text.delta"])
            self.assertEqual(calls[0]["data"]["delta"], "before shutdown")

    async def test_concurrent_text_callbacks_are_serialized_and_bounded(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            worker = self._worker(root)
            calls = []

            async def callback(*args, **kwargs):
                await asyncio.sleep(0.001)
                calls.append(args[2])
                return {}

            worker._newscraft = callback
            job = DurableJob("run-1", "account-1", "tenant_key_1", {}, [], "owner-1", "lease-1")
            pieces = [f"piece-{index};" for index in range(100)]
            await asyncio.gather(*[
                worker._callback(job, "response.output_text.delta", {"delta": piece})
                for piece in pieces
            ])
            await worker._callback(job, "response.completed", {"model": "hermes"})

            text_calls = [item for item in calls if item["event_type"] == "response.output_text.delta"]
            self.assertEqual("".join(item["data"]["delta"] for item in text_calls), "".join(pieces))
            self.assertEqual([item["worker_cursor"] for item in calls], list(range(1, len(calls) + 1)))
            self.assertLess(len(text_calls), len(pieces))
            self.assertLessEqual(max(len(item["data"]["delta"]) for item in text_calls), TEXT_BATCH_MAX_CHARS)
            await worker._stop_text_flush(job)

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

    async def test_cancel_discards_the_unaccepted_text_tail_before_terminal_callback(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            worker = self._worker(root)
            calls = []

            async def callback(*args, **kwargs):
                payload = args[2]
                calls.append(payload)
                return {}

            worker._newscraft = callback
            job = DurableJob("run-1", "account-1", "tenant_key_1", {}, [], "owner-1", "lease-1")
            job.stop_reason = "cancelled"
            job.text_buffer = ["unaccepted narration"]
            job.text_buffer_chars = len(job.text_buffer[0])

            await worker._publish_cancelled(job)

            self.assertNotIn("response.output_text.delta", [item["event_type"] for item in calls])
            self.assertEqual(calls[-1]["event_type"], "run.cancelled")
            self.assertEqual(job.text_buffer, [])

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

    def test_discards_process_narration_when_a_later_tool_starts(self) -> None:
        args: dict[str, str] = {}
        names: dict[str, str] = {}
        text: list[str] = []
        events = normalized_events("message", {"type": "TEXT_MESSAGE_CONTENT", "delta": "I will search."}, args, names, text)
        events += normalized_events("message", {"type": "TOOL_CALL_START", "toolCallId": "tool-1", "toolCallName": "web_search"}, args, names, text)
        events += normalized_events("message", {"type": "TEXT_MESSAGE_CONTENT", "delta": "Final answer."}, args, names, text)
        events += normalized_events("message", {"type": "RUN_FINISHED"}, args, names, text)

        self.assertEqual(events[1], {"event_type": "agent.answer.replace", "data": {"content": ""}})
        self.assertEqual(events[-2], {"event_type": "agent.answer.replace", "data": {"content": "Final answer."}})

    def test_fails_instead_of_completing_when_no_answer_follows_the_last_tool(self) -> None:
        args: dict[str, str] = {}
        names: dict[str, str] = {}
        text: list[str] = []
        normalized_events("message", {"type": "TEXT_MESSAGE_CONTENT", "delta": "I will search."}, args, names, text)
        normalized_events("message", {"type": "TOOL_CALL_START", "toolCallId": "tool-1", "toolCallName": "web_search"}, args, names, text)
        events = normalized_events("message", {"type": "RUN_FINISHED"}, args, names, text)

        self.assertEqual([item["event_type"] for item in events], ["response.failed"])
        self.assertNotIn("response.completed", [item["event_type"] for item in events])


if __name__ == "__main__":
    unittest.main()
