"""Pure validator contracts: no Docker, public network, credential or model use."""
import copy
import csv
import os
import hashlib
import importlib.util
import json
import struct
import tempfile
import unittest
import zlib
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from hermes_chat.browser_evidence import _issue_browser_receipt
from hermes_chat.browser_network import BrowserNetworkError
from hermes_chat.isolation import TenantIsolation
from hermes_chat.live_validation_fixture import (
    ALLOWED_URLS, ARTICLE_HTML, IMAGE_URL, SCRIPT_MARKER, SCRIPT_URL, SOURCE_DATE,
    SOURCE_SENTENCE, SOURCE_TITLE, SOURCE_URL, FixtureResearchTools, SyntheticFixture,
)
from hermes_chat.runtime import OwnedAgentRunner
from hermes_chat.sandbox import ComputerSandbox

script = Path(__file__).resolve().parents[1] / "scripts" / "live-validate-agent.py"
spec = importlib.util.spec_from_file_location("live_validation_contract", script)
validator = importlib.util.module_from_spec(spec)
spec.loader.exec_module(validator)


def sealed_receipt(*, tenant="validation-contract", thread="validation-contract", run="validation-contract",
                   synthetic=True, text=None):
    return _issue_browser_receipt(
        receipt_id="fixture-receipt", tenant_key=tenant, conversation_id=thread, run_id=run,
        final_url=SOURCE_URL, rendered_text=text or SOURCE_TITLE + "\n" + SOURCE_SENTENCE + "\n" +
        "This invented observatory supplies a controlled article for validating browser reads and research citations. "
        "Its words describe a software fixture and no real people or events. The synthetic article has enough "
        "readable text to verify a supporting excerpt without any public Internet request.",
        title=SOURCE_TITLE, main_document_url=SOURCE_URL,
        main_document_sha256=hashlib.sha256(ARTICLE_HTML.encode()).hexdigest(),
        main_document_html=ARTICLE_HTML, response_headers=(("content-type", "text/html; charset=utf-8"),),
        fetched_at=SOURCE_DATE, validated_request_count=4, navigation_id="fixture-navigation",
        javascript_enabled=True, synthetic_fixture=synthetic, public_network_validated=not synthetic,
    )


def preconfigured_layout(directory):
    directory = Path(directory).resolve()
    state, workspace, output = [directory / name for name in ("state", "workspace", "report")]
    for path in (state, workspace, output):
        path.mkdir(mode=0o700)
    identity = "validation-contract"
    runtime = TenantIsolation(state, workspace).resolve(identity, identity)
    for path in (runtime.hermes_home, runtime.workspace, runtime.workspace / ".tmp",
                 runtime.workspace / "browser-screenshots", runtime.workspace / "outputs"):
        path.mkdir(parents=True, exist_ok=True, mode=0o700)
        path.chmod(0o700)
    return SimpleNamespace(confirm_paid_call=True, validation_id=identity, state_dir=str(state),
        workspace_dir=str(workspace), output_dir=str(output), max_cost_usd=2,
        image="fixture-image:operator-provisioned", credential_file="never-read", docker_socket="/private/tmp/fixture.sock"), runtime


def inline_specs():
    sources = [{"id": "1", "url": SOURCE_URL, "label": SOURCE_TITLE}]
    return [
        {"kind": "markdown", "markdown": SOURCE_SENTENCE + " [1]", "sources": sources},
        {"kind": "table", "columns": [{"id": "finding", "label": "Finding"}, {"id": "source", "label": "Sources"}],
         "rows": [{"finding": SOURCE_SENTENCE, "source": SOURCE_URL}], "sources": sources},
    ]


class ScriptedComputer:
    """Offline command responses; never evidence that Chromium was executed."""

    def __init__(self, runtime, identity, **options):
        self.runtime, self.identity, self.options = runtime, identity, options
        self.actions = []
        self.closed = False
        self.tainted = False
        self.reset_ok = True
        self.script_ok = True
        self.bounds_proof = {"byte_exhaustion": True, "inode_exhaustion": True}
        self.navigation = 0
        self.screenshots = 0

    schemas = staticmethod(ComputerSandbox.schemas)

    async def prepare(self):
        self.actions.append("prepare")

    async def execute(self, name, args):
        self.actions.append(name if name != "browser" else args["action"])
        if name == "terminal":
            return {"exit_code": 0, "stdout": "NewsCraft synthetic fixture", "network_enabled": False}
        if name == "write_file":
            path = self.runtime.workspace / args["path"].removeprefix("/workspace/")
            path.write_text(args["content"])
            return {"written": True}
        action = args["action"]
        if action == "reset":
            self.tainted = not self.reset_ok
            return {"reset": self.reset_ok, "storage_cleared": self.reset_ok, "input_tainted": self.tainted}
        if action == "navigate":
            self.navigation += 1
            for url in ALLOWED_URLS:
                await self.options["resource_fetcher"](url)
        result = {"url": SOURCE_URL, "title": SOURCE_TITLE, "scripts_enabled": True,
                  "navigation_id": f"navigation-{self.navigation}",
                  "text": SOURCE_SENTENCE + "\n" + (SCRIPT_MARKER if self.script_ok else "Script absent.")}
        if action in {"fill", "type", "key"}:
            self.tainted = True
            result["text"] += "\n" + {"fill": "Fill verified: fixture fill", "type": "Type verified: fixture type",
                                      "key": "Enter key verified."}[action]
        if action == "click":
            result["text"] += "\nClick verified."
        if action == "screenshot":
            self.screenshots += 1
            content = b"\x89PNG\r\n\x1a\n" + str(self.screenshots).encode()
            path = self.runtime.workspace / "browser-screenshots" / f"capture-{self.screenshots}.png"
            path.write_bytes(content)
            result.update(screenshot_path="/workspace/browser-screenshots/" + path.name,
                          screenshot_sha256=hashlib.sha256(content).hexdigest(), screenshot_bytes=len(content))
        if not self.tainted:
            result["receipt_id"] = "fixture-receipt"
        return result

    def browser_receipt(self, identity):
        if identity != "fixture-receipt" or self.tainted:
            return None
        return sealed_receipt(tenant=self.runtime.key, thread=self.identity, run=self.identity)

    async def close(self):
        self.closed = True


class ScriptedModel:
    """Deterministic model outputs; no provider request or real API credential."""

    def __init__(self):
        self.calls = 0
        self.actions = [
            ("plan", {"steps": [{"id": "read", "label": "Read synthetic fixture", "status": "running"}]}),
            ("browser", {"action": "navigate", "url": SOURCE_URL, "selector": None, "text": None, "key": None, "delta_y": None}),
            ("record_newscraft_source", {"source": {"citationNumber": 1, "title": SOURCE_TITLE, "url": SOURCE_URL,
                "publicationDate": SOURCE_DATE, "sourceType": "primary", "supportingExcerpt": SOURCE_SENTENCE}}),
            ("decision", {"id": "fixture", "summary": "Use only the sealed synthetic source.", "stepId": "read"}),
            ("publish_markdown", {"title": "Synthetic brief", "markdown": SOURCE_SENTENCE + " [1]"}),
            ("publish_csv", {"title": "Synthetic finding", "columns": ["Finding"], "rows": [[SOURCE_SENTENCE]], "row_citations": [[1]]}),
        ]

    async def complete(self, payload):
        self.calls += 1
        research = {tool["name"] for tool in payload["tools"]}
        if {"web_search", "web_extract", "verify_this_lead"} & research:
            raise AssertionError("Public research tool leaked into validation model request")
        if self.calls <= len(self.actions):
            name, args = self.actions[self.calls - 1]
            output = [{"type": "function_call", "name": name, "call_id": f"fixture-call-{self.calls}", "arguments": json.dumps(args)}]
        else:
            output = [{"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": SOURCE_SENTENCE + " [1]"}]}]
        return {"output": output, "usage": {"input_tokens": 10, "output_tokens": 10}}


class LiveValidationContractTests(unittest.IsolatedAsyncioTestCase):
    async def test_synthetic_renewal_and_idempotent_callback_keep_binding(self):
        job = SimpleNamespace(run_id="synthetic", account_id="account", tenant_key="tenant",
                              lease_owner="worker", lease_token="token")
        control = validator.SyntheticControlPlane(job, verified_sources=lambda: [{
            "citationNumber": 1, "url": SOURCE_URL, "supportingExcerpt": SOURCE_SENTENCE}])
        binding = vars(job)
        await control("POST", "/renew", binding)
        callback = {**binding, "worker_cursor": 1, "event_type": "run.started", "data": {"status": "researching"}}
        await control("POST", "/callback", callback)
        await control("POST", "/callback", callback)
        self.assertEqual(control.renewals, 1)
        self.assertEqual(len(control.events), 1)
        revision = await control("POST", "/synthetic/artifacts/revisions", {
            **{k: v for k, v in binding.items() if k != "run_id"}, "spec": inline_specs()[0]})
        self.assertEqual(revision["artifact"]["state"], "ready")
        with self.assertRaisesRegex(RuntimeError, "supported inline"):
            await control("POST", "/synthetic/artifacts/revisions", {
                **{k: v for k, v in binding.items() if k != "run_id"}, "spec": {"kind": "markdown", "markdown": "Invented"}})
        for name in vars(job):
            with self.subTest(binding=name), self.assertRaisesRegex(RuntimeError, "binding"):
                await control("POST", "/renew", {**binding, name: "wrong"})
        with self.assertRaisesRegex(RuntimeError, "identity changed"):
            await control("POST", "/callback", {**callback, "data": {"status": "different"}})
        for cursor in (True, 0, 3, "2"):
            with self.subTest(cursor=cursor), self.assertRaisesRegex(RuntimeError, "cursor"):
                await control("POST", "/callback", {**callback, "worker_cursor": cursor})

    async def test_fixture_gateway_rejects_offlist_urls_and_write_methods_before_network(self):
        fixture = SyntheticFixture()
        with patch("socket.getaddrinfo", side_effect=AssertionError("DNS forbidden")) as dns, \
             patch("httpx.AsyncClient", side_effect=AssertionError("HTTP forbidden")) as http:
            for url in ("https://www.rfc-editor.org/rfc/rfc9110.html", SOURCE_URL + "?q=1", SOURCE_URL + "#fragment",
                        SOURCE_URL.replace("https://", "http://"), SOURCE_URL.replace(".example/", ".example:443/"),
                        "http://127.0.0.1/", "file:///etc/passwd", None):
                with self.subTest(url=url), self.assertRaises(BrowserNetworkError):
                    await fixture.fetch(url)
            for method in ("POST", "PUT", "PATCH", "DELETE", "OPTIONS", "get", None):
                with self.subTest(method=method), self.assertRaises(BrowserNetworkError):
                    await fixture.fetch(SOURCE_URL, method=method)
            self.assertEqual(fixture.requests, [])
            dns.assert_not_called()
            http.assert_not_called()
            for url in ALLOWED_URLS:
                response = await fixture.fetch(url)
                self.assertEqual(response.url, url)
                self.assertEqual(response.status, 200)
                self.assertTrue(response.body)
                self.assertEqual(response.sha256, hashlib.sha256(response.body).hexdigest())
                if url == IMAGE_URL:
                    # Validate the exact embedded PNG; no image/network package.
                    position = 8
                    self.assertEqual(response.body[:8], b"\x89PNG\r\n\x1a\n")
                    while position < len(response.body):
                        length = struct.unpack(">I", response.body[position:position + 4])[0]
                        chunk = response.body[position + 4:position + 8 + length]
                        crc = struct.unpack(">I", response.body[position + 8 + length:position + 12 + length])[0]
                        self.assertEqual(zlib.crc32(chunk), crc)
                        position += length + 12
            head = await fixture.fetch(SOURCE_URL, method="HEAD")
            self.assertEqual(head.body, b"")
            self.assertEqual(head.sha256, hashlib.sha256(b"").hexdigest())
            dns.assert_not_called()
            http.assert_not_called()

    async def test_research_exposes_record_only_and_has_no_fetch_search_archive_fallback(self):
        research = FixtureResearchTools()
        self.assertEqual([tool["name"] for tool in research.tool_definitions], ["record_newscraft_source"])
        self.assertFalse(research.config.archive_fallback)
        with patch.object(research.provider, "fetcher", side_effect=AssertionError("Fetch forbidden")) as fetch, \
             patch.object(research, "searcher", side_effect=AssertionError("Search forbidden")) as search:
            for name in ("web_search", "web_extract", "verify_this_lead", "unknown"):
                with self.subTest(name=name), self.assertRaisesRegex(ValueError, "only record"):
                    await research.execute(name, {"url": SOURCE_URL})
            for url in (SOURCE_URL + "?q=1", SCRIPT_URL, "https://public.example/article"):
                with self.subTest(url=url), self.assertRaisesRegex(ValueError, "exact source"):
                    await research.execute("record_newscraft_source", {"source": {"url": url}})
            fetch.assert_not_called()
            search.assert_not_called()
        with self.assertRaisesRegex(RuntimeError, "disabled"):
            research.provider.fetcher(SOURCE_URL, 1)
        with self.assertRaisesRegex(RuntimeError, "disabled"):
            research.searcher("synthetic", 1, 1)

    async def test_recording_requires_host_sealed_synthetic_receipt_for_exact_run(self):
        research = FixtureResearchTools()
        research.bind_run("validation-contract", "validation-contract", "validation-contract")
        source_args = {"source": {"citationNumber": 1, "title": SOURCE_TITLE, "url": SOURCE_URL,
            "publicationDate": SOURCE_DATE, "sourceType": "primary", "supportingExcerpt": SOURCE_SENTENCE}}
        self.assertIn("error", json.loads(await research.execute("record_newscraft_source", source_args)))
        for receipt in (vars(sealed_receipt()), sealed_receipt(synthetic=False), sealed_receipt(run="other"),
                        replace(sealed_receipt(), rendered_text="invented unsupported quote")):
            with self.subTest(receipt=type(receipt).__name__), self.assertRaises(ValueError):
                research.remember_browser_receipt(receipt)
        research.remember_browser_receipt(sealed_receipt())
        source = json.loads(await research.execute("record_newscraft_source", source_args))["source"]
        self.assertEqual(research.verified_sources(), [source])
        self.assertTrue(source["retrieval"]["syntheticFixture"])
        self.assertFalse(source["retrieval"]["publicNetworkValidated"])
        self.assertEqual(source["retrieval"]["evidenceOrigin"], "synthetic_fixture")
        invalid = copy.deepcopy(source_args)
        invalid["source"]["supportingExcerpt"] = "The observatory recorded ninety lanterns."
        self.assertIn("error", json.loads(await research.execute("record_newscraft_source", invalid)))

    async def test_validation_configuration_never_provisions_or_reads_key_on_rejection(self):
        with tempfile.TemporaryDirectory() as directory:
            args, runtime = preconfigured_layout(directory)
            identity, isolation, resolved, output = validator.validation_layout(args)
            self.assertEqual(identity, args.validation_id)
            self.assertEqual(resolved, runtime)
            self.assertEqual(output, Path(args.output_dir))
            with patch("hermes_chat.isolation._ensure_private_directory", side_effect=AssertionError("No provisioning")):
                self.assertEqual(isolation.ensure(resolved), resolved)
            with patch.object(validator, "computer_preflight", new_callable=AsyncMock) as preflight, \
                 patch.object(validator, "_credential_from_file") as credential:
                for budget in (0, -1, 3, float("inf"), float("nan"), True):
                    args.max_cost_usd = budget
                    with self.subTest(budget=budget), self.assertRaisesRegex(ValueError, "at most"):
                        await validator.validate(args)
                args.max_cost_usd = 2
                original = args.state_dir
                args.state_dir = str(Path(directory).resolve() / "missing")
                with self.assertRaisesRegex(ValueError, "preconfigure"):
                    await validator.validate(args)
                args.state_dir = original
                args.validation_id = "random-or-implicit-id"
                with self.assertRaisesRegex(ValueError, "fixed"):
                    await validator.validate(args)
                self.assertFalse((Path(directory).resolve() / "missing").exists())
                preflight.assert_not_awaited()
                credential.assert_not_called()

    async def test_layout_rejects_symlinks_overlap_wrong_permissions_and_existing_outputs(self):
        with tempfile.TemporaryDirectory() as directory:
            args, runtime = preconfigured_layout(directory)
            report = Path(args.output_dir)
            report.chmod(0o755)
            with self.assertRaisesRegex(ValueError, "private"):
                validator.validation_layout(args)
            report.chmod(0o700)
            link = report.parent / "report-link"
            link.symlink_to(report)
            args.output_dir = str(link)
            with self.assertRaisesRegex(ValueError, "symlinks"):
                validator.validation_layout(args)
            args.output_dir = args.workspace_dir
            with self.assertRaisesRegex(ValueError, "separate"):
                validator.validation_layout(args)
            args.output_dir = str(report)
            (report / "previous.json").write_text("{}")
            with self.assertRaisesRegex(ValueError, "fresh"):
                validator.validation_layout(args)
            (report / "previous.json").unlink()
            (runtime.workspace / "unexpected.txt").write_text("old")
            with self.assertRaisesRegex(ValueError, "unexpected"):
                validator.validation_layout(args)

    async def test_disposable_preflight_failures_keep_key_and_model_unread(self):
        with tempfile.TemporaryDirectory() as directory:
            args, runtime = preconfigured_layout(directory)
            with patch.object(validator, "computer_preflight", new_callable=AsyncMock) as preflight, \
                 patch.object(validator, "_credential_from_file") as credential, \
                 patch.object(validator, "OwnedAgentRunner") as runner:
                args.docker_socket = None
                with self.assertRaisesRegex(ValueError, "docker-socket"):
                    await validator.validate(args)
                preflight.assert_not_awaited()
                args.docker_socket = "/private/tmp/fixture.sock"
                for error in ("tmpfs bound unproven", "Synthetic DOM interaction failed"):
                    preflight.side_effect = RuntimeError(error)
                    with self.assertRaisesRegex(RuntimeError, error):
                        await validator.validate(args)
                preflight.side_effect = None
                preflight.return_value = {"passed": False}
                with self.assertRaisesRegex(RuntimeError, "Interactive sandbox"):
                    await validator.validate(args)
                credential.assert_not_called()
                runner.assert_not_called()

    async def test_scope_and_agent_locks_reject_concurrent_validation_before_computer_or_key(self):
        with tempfile.TemporaryDirectory() as directory:
            args, runtime = preconfigured_layout(directory)
            lock = validator._exclusive_lock(runtime.hermes_home, directory=True)
            try:
                with patch.object(validator, "computer_preflight", new_callable=AsyncMock) as preflight, \
                     patch.object(validator, "_credential_from_file") as credential:
                    with self.assertRaisesRegex(RuntimeError, "already in use"):
                        await validator.validate(args)
                    preflight.assert_not_awaited()
                    credential.assert_not_called()
            finally:
                os.close(lock)
            agent_lock = validator._exclusive_lock(runtime.hermes_home / "agent.lock")
            try:
                with patch.object(validator, "DisposableValidationSandbox") as computer:
                    with self.assertRaisesRegex(RuntimeError, "already in use"):
                        await validator.computer_preflight(runtime, args.validation_id, SyntheticFixture(), args.image, docker_socket=args.docker_socket)
                    computer.assert_not_called()
            finally:
                os.close(agent_lock)

    async def test_preflight_scripted_actions_reset_before_sealed_read_and_key_is_last(self):
        with tempfile.TemporaryDirectory() as directory:
            args, runtime = preconfigured_layout(directory)
            computers = []

            def computer_factory(*values, **options):
                computer = ScriptedComputer(*values, **options)
                computers.append(computer)
                return computer

            with patch.object(validator, "DisposableValidationSandbox", side_effect=computer_factory) as constructor, \
                 patch.object(validator, "_credential_from_file", side_effect=RuntimeError("Key access sentinel")) as credential, \
                 patch.object(validator, "OwnedAgentRunner") as runner:
                constructor.readiness = AsyncMock(return_value={"ready": True})
                with self.assertRaisesRegex(RuntimeError, "Key access sentinel"):
                    await validator.validate(args)
                credential.assert_called_once_with("never-read")
                runner.assert_not_called()
            computer = computers[0]
            self.assertTrue(computer.closed)
            self.assertEqual(computer.options["allowed_urls"], ALLOWED_URLS)
            self.assertIs(computer.options["synthetic_fixture"], True)
            self.assertEqual(computer.actions, ["prepare", "terminal", "navigate", "snapshot", "fill", "type", "key", "click",
                                                "screenshot", "scroll", "screenshot", "reset", "navigate"])
            self.assertFalse(computer.tainted)

    async def test_preflight_only_never_reads_key_or_constructs_model(self):
        with tempfile.TemporaryDirectory() as directory:
            args, runtime = preconfigured_layout(directory)
            args.preflight_only=True
            args.confirm_paid_call=False
            args.credential_file=None
            with patch.object(validator,'computer_preflight',new_callable=AsyncMock,
                    return_value={'passed':True,'storage_enforcement':{'byte_exhaustion':True,'inode_exhaustion':True}}), \
                 patch.object(validator,'_credential_from_file') as key, \
                 patch.object(validator,'OwnedAgentRunner') as model, patch('builtins.print'):
                self.assertEqual(await validator.validate(args),0)
                key.assert_not_called()
                model.assert_not_called()
            report=json.loads((Path(args.output_dir)/'report.json').read_text())
            self.assertEqual(report['paid_calls'],0)
            self.assertFalse(report['production_computer_backend_verified'])

    async def test_offline_owned_loop_publishes_bound_cited_markdown_csv_and_truthful_report(self):
        with tempfile.TemporaryDirectory() as directory:
            args, runtime = preconfigured_layout(directory)
            model = ScriptedModel()
            computers = []

            def computer_factory(*values, **options):
                computer = ScriptedComputer(*values, **options)
                computers.append(computer)
                return computer

            def runner_factory(settings, isolation, **options):
                return OwnedAgentRunner(settings, isolation, model=model, **options)

            with patch.object(validator, "DisposableValidationSandbox", side_effect=computer_factory) as constructor, \
                 patch.object(validator, "OwnedAgentRunner", side_effect=runner_factory), \
                 patch.object(validator, "_credential_from_file", return_value="offline-fixture-no-real-key") as key, \
                 patch("httpx.AsyncClient.post", side_effect=AssertionError("Paid API forbidden")) as paid, \
                 patch("httpx.AsyncClient.request", side_effect=AssertionError("Public HTTP forbidden")) as network, \
                 patch("builtins.print"):
                constructor.readiness = AsyncMock(return_value={"ready": True})
                self.assertEqual(await validator.validate(args), 0)
                key.assert_called_once_with("never-read")
                paid.assert_not_called()
                network.assert_not_called()
            self.assertEqual(model.calls, 7)
            self.assertEqual(len(computers), 2)
            self.assertTrue(all(computer.closed for computer in computers))
            self.assertTrue(all(computer.options["allowed_urls"] == ALLOWED_URLS
                                and computer.options["synthetic_fixture"] is True for computer in computers))
            report = json.loads((Path(args.output_dir) / "report.json").read_text())
            self.assertTrue(report["passed"])
            self.assertFalse(report["public_network_validated"])
            self.assertFalse(report["production_storage_verified"])
            self.assertFalse(report["provider_hard_cost_limit_enforced"])
            self.assertFalse(report["account_wide_cost_limit_enforced"])
            self.assertEqual(report["quota_scope"], runtime.task_key)
            self.assertEqual({Path(path).suffix for path in report["files"]}, {".md", ".csv"})
            self.assertEqual(sum(event["event_type"] == "artifact.ready" for event in report["public_events"]), 2)

    async def test_preflight_rejects_missing_script_or_failed_reset_and_always_closes(self):
        for failure in ("script_ok", "reset_ok"):
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as directory:
                args, runtime = preconfigured_layout(directory)
                fixture = SyntheticFixture()
                computer = ScriptedComputer(runtime, args.validation_id, resource_fetcher=fixture.fetch,
                                            allowed_urls=ALLOWED_URLS, synthetic_fixture=True)
                setattr(computer, failure, False)
                with patch.object(validator, "DisposableValidationSandbox", return_value=computer), self.assertRaises(RuntimeError):
                    await validator.computer_preflight(runtime, args.validation_id, fixture, args.image, docker_socket=args.docker_socket)
                self.assertTrue(computer.closed)
                if failure == "reset_ok":
                    self.assertEqual(computer.actions[-1], "reset")

    def test_screenshot_proof_rejects_digest_mismatch_and_cross_scope_path(self):
        with tempfile.TemporaryDirectory() as directory:
            args, runtime = preconfigured_layout(directory)
            screenshot = runtime.workspace / "browser-screenshots" / "capture.png"
            content = b"\x89PNG\r\n\x1a\nfixture"
            screenshot.write_bytes(content)
            result = {"screenshot_path": "/workspace/browser-screenshots/capture.png",
                      "screenshot_sha256": hashlib.sha256(content).hexdigest(), "screenshot_bytes": len(content)}
            self.assertEqual(validator._screenshot_proof(result, runtime)["bytes"], len(content))
            with self.assertRaisesRegex(RuntimeError, "digest"):
                validator._screenshot_proof({**result, "screenshot_sha256": "0" * 64}, runtime)
            with self.assertRaisesRegex(RuntimeError, "scoped"):
                validator._screenshot_proof({**result, "screenshot_path": "/other/capture.png"}, runtime)
            with self.assertRaisesRegex(RuntimeError, "escaped"):
                validator._screenshot_proof({**result, "screenshot_path": "/workspace/browser-screenshots/../outputs/file.png"}, runtime)

    async def test_acceptance_requires_sealed_sources_citations_activity_and_sourced_files(self):
        research = FixtureResearchTools()
        research.bind_run("validation-contract", "validation-contract", "validation-contract")
        research.remember_browser_receipt(sealed_receipt())
        source = json.loads(await research.execute("record_newscraft_source", {"source": {
            "citationNumber": 1, "title": SOURCE_TITLE, "url": SOURCE_URL, "publicationDate": SOURCE_DATE,
            "sourceType": "primary", "supportingExcerpt": SOURCE_SENTENCE}}))["source"]
        with tempfile.TemporaryDirectory() as directory:
            table, markdown = Path(directory) / "brief.csv", Path(directory) / "brief.md"
            with table.open("w", newline="") as stream:
                writer = csv.writer(stream)
                writer.writerow(["Finding", "Sources"])
                writer.writerow([SOURCE_SENTENCE, SOURCE_URL])
            markdown.write_text(SOURCE_SENTENCE + " [1]")
            revisions = [{"revision_id": str(index), "spec": spec} for index, spec in enumerate(inline_specs(), 1)]
            events = [
                {"event_type": "response.completed", "data": {}},
                {"event_type": "agent.plan", "data": {"steps": [{"id": "read", "label": "Read fixture", "status": "ok"}]}},
                {"event_type": "agent.decision", "data": {"id": "fixture", "summary": "Use the synthetic source."}},
                {"event_type": "agent.source.read", "data": {"source": {**source, "verified": True, "status": "read"}}},
                {"event_type": "agent.citations", "data": {"citations": [source]}},
                {"event_type": "agent.answer.replace", "data": {"content": SOURCE_SENTENCE + " [1]"}},
            ]
            for revision, path in zip(revisions, (markdown, table)):
                artifact = {**revision["spec"], "id": revision["revision_id"], "state": "ready"}
                events.extend([
                    {"event_type": "artifact.ready", "data": {"artifact_revision_id": revision["revision_id"], "artifact": artifact}},
                    {"event_type": "agent.tool.progress", "data": {
                        "name": "publish_markdown" if path.suffix == ".md" else "publish_csv",
                        "result": {"revision_id": revision["revision_id"], "artifact": artifact,
                                   "workspace_path": "/workspace/outputs/" + path.name}}},
                ])
            accepted = lambda value=events, sources=research.verified_sources(): validator.accepted_evidence(value, revisions, [table, markdown], sources)
            self.assertTrue(accepted())
            self.assertFalse(accepted(sources=[]))
            for name in ("response.completed", "agent.plan", "agent.decision", "agent.source.read", "agent.citations", "artifact.ready", "agent.tool.progress"):
                with self.subTest(missing=name):
                    self.assertFalse(accepted([event for event in events if event["event_type"] != name]))
            self.assertFalse(accepted(events + [{"event_type": "response.failed", "data": {}}]))
            unsupported = copy.deepcopy(events)
            next(event for event in unsupported if event["event_type"] == "agent.answer.replace")["data"]["content"] = "Invented finding [1]"
            self.assertFalse(accepted(unsupported))
            forged = copy.deepcopy(events)
            next(event for event in forged if event["event_type"] == "agent.citations")["data"]["citations"][0]["retrieval"]["publicNetworkValidated"] = True
            self.assertFalse(accepted(forged))
            wrong_path = copy.deepcopy(events)
            next(event for event in wrong_path if event["event_type"] == "agent.tool.progress")["data"]["result"]["workspace_path"] = "/other/file.md"
            self.assertFalse(accepted(wrong_path))
            original = revisions[0]["spec"]["markdown"]
            revisions[0]["spec"]["markdown"] = "Unrelated publication [1]"
            self.assertFalse(accepted())
            revisions[0]["spec"]["markdown"] = original
            table.write_text("Finding,Sources\n")
            self.assertFalse(accepted())
            table.unlink()
            table.symlink_to(markdown)
            self.assertFalse(accepted())

    def test_cost_report_never_claims_account_or_provider_hard_limit(self):
        report = validator.cost_accounting_report(2)
        self.assertEqual(report["local_run_budget_usd"], 2)
        self.assertFalse(report["account_wide_cost_limit_enforced"])
        self.assertFalse(report["provider_hard_cost_limit_enforced"])
        self.assertEqual(report["accounting_rates_usd_per_million"], {"input": 10, "output": 60})
        self.assertNotIn("api_cost_cap_usd", report)


if __name__ == "__main__":
    unittest.main()
