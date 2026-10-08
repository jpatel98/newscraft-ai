from __future__ import annotations

import asyncio
import csv
import hashlib
import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import httpx

from hermes_chat import deepseek_acceptance as acceptance


def tool(name, args, identity=None):
    return {"type": "tool_use", "id": identity or name, "name": name, "input": args}


def reply(*blocks):
    return {"stop_reason": "tool_use" if any(part["type"] == "tool_use" for part in blocks) else "end_turn",
            "content": [{"type": "thinking", "thinking": "PRIVATE_PROVIDER_REASONING"}, *blocks],
            "usage": {"input_tokens": 1, "output_tokens": 1}}


def good_replies():
    return [
        reply(tool("web_search", {"query": "synthetic acceptance"})),
        reply(tool("web_extract", {"urls": [acceptance.SOURCE_URL]})),
        reply(tool("record_newscraft_source", {"source": {"citationNumber": 1,
            "title": acceptance.SOURCE_TITLE, "url": acceptance.SOURCE_URL,
            "publicationDate": acceptance.SOURCE_DATE, "sourceType": "primary",
            "supportingExcerpt": acceptance.SOURCE_SENTENCE}})),
        reply(tool("publish_markdown", {"title": "Synthetic brief", "markdown":
                f"Synthetic fixture, published {acceptance.SOURCE_DATE[:10]}.\n\n{acceptance.SOURCE_SENTENCE} [1]"}),
              tool("publish_csv", {"title": "Synthetic evidence", "columns": ["Finding", "Source URL", "Publication date"],
                "rows": [[acceptance.SOURCE_SENTENCE, acceptance.SOURCE_URL, acceptance.SOURCE_DATE[:10]]], "row_citations": [[1]]})),
        reply({"type": "text", "text": f"Synthetic fixture: {acceptance.SOURCE_SENTENCE} [1]"}),
    ]


class DeepSeekAcceptanceTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name).resolve()
        self.output, credential = acceptance._paths(self.root)
        credential.parent.mkdir(parents=True)
        credential.write_text("DEEPSEEK_API_KEY=synthetic-dedicated-key\nOPENAI_API_KEY=unrelated-key\n")
        self.requests = []

    def tearDown(self):
        self.directory.cleanup()

    def transport(self, replies):
        queue = list(replies)

        def handle(request):
            self.requests.append(request)
            self.assertEqual(str(request.url), "https://api.deepseek.com/anthropic/v1/messages")
            self.assertEqual(request.method, "POST")
            self.assertEqual(request.headers["x-api-key"], "synthetic-dedicated-key")
            self.assertNotIn("unrelated-key", str(request.headers))
            body = json.loads(request.content)
            self.assertEqual(body["model"], "deepseek-flash")
            self.assertEqual(body["thinking"], {"type": "disabled"})
            self.assertEqual(body["max_tokens"], 2048)
            value = queue.pop(0)
            if isinstance(value, Exception):
                raise value
            return value if isinstance(value, httpx.Response) else httpx.Response(200, json=value)

        return httpx.MockTransport(handle)

    def test_default_and_check_do_not_read_credentials_create_state_or_use_network(self):
        with patch.object(acceptance, "_credential_from_file", side_effect=AssertionError("no credentials")), \
             patch.object(httpx, "AsyncClient", side_effect=AssertionError("no client")), \
             patch("sys.stdout", new_callable=io.StringIO) as stdout:
            self.assertEqual(acceptance.main([], root=self.root), 0)
            self.assertEqual(acceptance.main(["--check"], root=self.root), 0)
        self.assertFalse(self.output.exists())
        self.assertNotIn("synthetic-dedicated-key", stdout.getvalue())
        self.assertFalse(json.loads(stdout.getvalue().splitlines()[0])["credential_key_presence_verified"])

    def test_check_without_credential_reference_exits_nonzero_without_creating_state(self):
        missing_root = self.root / "empty-repository"
        missing_root.mkdir()
        with patch("sys.stdout", new_callable=io.StringIO) as stdout:
            self.assertEqual(acceptance.main(["--check"], root=missing_root), 2)
        self.assertFalse(json.loads(stdout.getvalue())["eligible_for_separately_approved_attempt"])
        self.assertFalse((missing_root / ".data").exists())

    async def test_exact_execution_gate_precedes_credentials_and_admission(self):
        with patch.object(acceptance, "_credential_from_file", side_effect=AssertionError("no credentials")):
            for allowance in (None, "0.05", "0.060", "1", "NaN"):
                with self.subTest(allowance=allowance), self.assertRaises(acceptance.AcceptanceError):
                    await acceptance.execute(self.root, allowance)
        self.assertFalse(self.output.exists())

    async def test_paid_adapter_owned_loop_local_citations_and_files_with_synthetic_transports(self):
        with patch("socket.socket.connect", side_effect=AssertionError("real sockets forbidden")), \
             patch("socket.getaddrinfo", side_effect=AssertionError("real DNS forbidden")):
            report = await acceptance.execute(self.root, "0.06", transport=self.transport(good_replies()))
        self.assertTrue(report["passed"], report)
        self.assertTrue(report["provider_access_verified"])
        self.assertEqual(report["completed_model_replies"], 5)
        self.assertEqual(report["model_requests_admitted"], 5)
        self.assertEqual(report["budget"]["output_tokens"], 5 * 2048)
        self.assertLessEqual(report["budget"]["input_tokens"], 120000)
        self.assertLessEqual(report["budget"]["cost_microusd"], 60000)
        self.assertEqual(report["source"]["publicationDate"], acceptance.SOURCE_DATE)
        self.assertTrue(report["source"]["retrieval"]["syntheticFixture"])
        self.assertFalse(report["scope"]["application_storage_verified"])
        self.assertFalse(report["scope"]["database_verified"])
        self.assertEqual({item["kind"] for item in report["artifacts"]}, {"markdown", "table"})
        for artifact in report["artifacts"]:
            data = (self.output / artifact["file"]).read_bytes()
            self.assertEqual(len(data), artifact["bytes"])
            self.assertEqual(hashlib.sha256(data).hexdigest(), artifact["sha256"])
            self.assertIn(acceptance.SOURCE_URL.encode(), data)
        for path in self.output.rglob("*.json"):
            content = path.read_text()
            self.assertNotIn("PRIVATE_PROVIDER_REASONING", content)
            self.assertNotIn("synthetic-dedicated-key", content)
            self.assertNotIn("unrelated-key", content)
        self.assertEqual(self.output.stat().st_mode & 0o777, 0o700)
        self.assertTrue(acceptance.check(self.root)["alreadyUsed"])
        with patch.object(acceptance, "_credential_from_file", side_effect=AssertionError("no repeated read")), \
             self.assertRaisesRegex(acceptance.AcceptanceError, "repeat attempt"):
            await acceptance.execute(self.root, "0.06", transport=self.transport([]))
        self.assertEqual(len(self.requests), 5)

    async def test_uncertain_request_is_reserved_once_and_repeat_is_blocked(self):
        report = await acceptance.execute(self.root, "0.06", transport=self.transport([httpx.ReadTimeout("PRIVATE_RAW_DIAGNOSTIC")]))
        self.assertFalse(report["passed"])
        self.assertFalse(report["provider_access_verified"])
        self.assertEqual(report["model_requests_admitted"], 1)
        self.assertEqual(report["budget"]["output_tokens"], 2048)
        self.assertGreater(report["budget"]["cost_microusd"], 0)
        checkpoint = json.loads((self.output / "checkpoint.json").read_text())
        self.assertEqual(checkpoint["state"]["phase"], "failed")
        self.assertNotIn("PRIVATE_RAW_DIAGNOSTIC", (self.output / "report.json").read_text())
        with self.assertRaises(acceptance.AcceptanceError):
            await acceptance.execute(self.root, "0.06", transport=self.transport([]))
        self.assertEqual(len(self.requests), 1)

    async def test_http_credential_rejection_does_not_claim_provider_access(self):
        report = await acceptance.execute(self.root, "0.06", transport=self.transport([
            httpx.Response(401, text="PRIVATE_AUTH_DIAGNOSTIC")]))
        self.assertFalse(report["passed"])
        self.assertFalse(report["provider_access_verified"])
        self.assertEqual(report["completed_model_replies"], 0)
        self.assertEqual(len(self.requests), 1)
        self.assertNotIn("PRIVATE_AUTH_DIAGNOSTIC", (self.output / "report.json").read_text())

    async def test_execution_deadline_does_not_retry_or_claim_provider_access(self):
        original_timeout = asyncio.timeout
        timeouts = []

        def controlled_timeout(seconds):
            context = original_timeout(None)
            timeouts.append((seconds, context))
            return context

        async def stalled_response(request):
            self.requests.append(request)
            # Expire the outer execution deadline only once dispatch is known
            # to have happened. Admission/checkpoint fsync speed cannot affect
            # the number of requests observed by this deadline regression.
            timeouts[0][1].reschedule(asyncio.get_running_loop().time())
            await asyncio.Event().wait()

        with patch.object(acceptance.asyncio, "timeout", side_effect=controlled_timeout):
            report = await acceptance.execute(self.root, "0.06", transport=httpx.MockTransport(stalled_response))
        self.assertEqual(timeouts[0][0], 180)
        self.assertEqual(len({id(context) for _, context in timeouts}), len(timeouts))
        self.assertFalse(report["passed"])
        self.assertFalse(report["provider_access_verified"])
        self.assertEqual(report["model_requests_admitted"], 1)
        self.assertEqual(report["budget"]["output_tokens"], 2048)
        self.assertTrue(acceptance.check(self.root)["alreadyUsed"])

    async def test_cumulative_input_reservation_stops_before_the_request_allowance_is_exhausted(self):
        replies = [reply(tool("plan", {"steps": [{"id": f"step-{index}", "label": "Synthetic planning", "status": "running"}]}, f"plan-{index}"))
                   for index in range(8)]
        report = await acceptance.execute(self.root, "0.06", transport=self.transport(replies))
        self.assertFalse(report["passed"])
        # This fixture's growing history reaches the cumulative input boundary
        # before its eighth request. Neither unused steps nor cheap cache usage
        # permits one extra paid request after that bound.
        self.assertEqual(report["model_requests_admitted"], 7)
        self.assertEqual(len(self.requests), 7)
        self.assertLessEqual(report["budget"]["input_tokens"], 120000)
        self.assertLessEqual(report["budget"]["cost_microusd"], 60000)

    async def test_independent_outbound_guard_forbids_a_ninth_request(self):
        self.output.mkdir(parents=True)
        async with httpx.AsyncClient(transport=self.transport([reply({"type": "text", "text": "Synthetic"})] * 8)) as client:
            adapter = acceptance.GuardedDeepSeek(acceptance._settings("synthetic-dedicated-key"), self.output, client=client)
            for _ in range(8):
                await adapter.complete(model="deepseek-flash", instructions="Synthetic", messages=[
                    {"role": "user", "content": [{"type": "text", "text": "Synthetic"}]}],
                    tools=[], max_output=2048, private={})
            with self.assertRaisesRegex(acceptance.ModelError, "fixed approved policy"):
                await adapter.complete(model="deepseek-flash", instructions="Synthetic", messages=[],
                                       tools=[], max_output=2048, private={})
        self.assertEqual(adapter.attempts, 8)
        self.assertEqual(len(self.requests), 8)

    async def test_outbound_guard_rejects_changed_endpoint_before_sending(self):
        self.output.mkdir(parents=True)
        settings = acceptance._settings("synthetic-dedicated-key")
        settings.model_base_url = "https://unapproved.example/anthropic"
        async with httpx.AsyncClient(transport=self.transport([])) as client:
            adapter = acceptance.GuardedDeepSeek(settings, self.output, client=client)
            with self.assertRaisesRegex(acceptance.ModelError, "fixed approved policy"):
                await adapter.complete(model="deepseek-flash", instructions="Synthetic", messages=[],
                                       tools=[], max_output=2048, private={})
        self.assertEqual(self.requests, [])
        self.assertEqual(list(self.output.iterdir()), [])

    async def test_artifact_digest_mismatch_is_rejected_without_a_published_file(self):
        workspace = self.root / "synthetic-workspace"
        workspace.mkdir()
        self.output.mkdir(parents=True)
        publisher = acceptance.LocalPublisher(self.output, workspace)
        path = workspace / "artifact-fixture.md"
        data = b"Synthetic fixture [1]"
        path.write_bytes(data)
        with self.assertRaisesRegex(acceptance.AcceptanceError, "digest and size"):
            await publisher({"path": "/workspace/artifact-fixture.md", "spec": {"kind": "markdown"},
                             "checksum_sha256": "0" * 64, "size": len(data), "mime_type": "text/markdown"})
        self.assertEqual(list(publisher.output.iterdir()), [])

    async def test_csv_wrong_header_duplicate_rows_and_misplaced_date_are_rejected(self):
        workspace = self.root / "synthetic-workspace"
        workspace.mkdir()
        self.output.mkdir(parents=True)
        publisher = acceptance.LocalPublisher(self.output, workspace)
        header = ["Finding", "Source URL", "Publication date", "Sources"]
        row = [acceptance.SOURCE_SENTENCE, acceptance.SOURCE_URL, acceptance.SOURCE_DATE[:10], acceptance.SOURCE_URL]
        invalid = [
            [["Wrong finding header", *header[1:]], row],
            [header, row, row],
            [header, [row[0], row[1], "", row[3] + " " + acceptance.SOURCE_DATE[:10]]],
        ]
        for rows in invalid:
            with self.subTest(rows=rows):
                stream = io.StringIO()
                csv.writer(stream).writerows(rows)
                data = stream.getvalue().encode()
                (workspace / "artifact-fixture.csv").write_bytes(data)
                with self.assertRaisesRegex(acceptance.AcceptanceError, "required synthetic finding, date and citation"):
                    await publisher({"path": "/workspace/artifact-fixture.csv",
                        "spec": {"kind": "table", "sources": [{"id": "1", "url": acceptance.SOURCE_URL}]},
                        "checksum_sha256": hashlib.sha256(data).hexdigest(), "size": len(data), "mime_type": "text/csv"})
                self.assertEqual(list(publisher.output.iterdir()), [])

    async def test_a_second_publication_of_the_same_kind_is_rejected(self):
        workspace = self.root / "synthetic-workspace"
        workspace.mkdir()
        self.output.mkdir(parents=True)
        publisher = acceptance.LocalPublisher(self.output, workspace)
        for kind in ("markdown", "table"):
            with self.subTest(kind=kind):
                if kind == "markdown":
                    text = f"{acceptance.SOURCE_SENTENCE} [1]\n{acceptance.SOURCE_DATE[:10]}\n\n[1]: {acceptance.SOURCE_URL}\n"
                    data, mime, filename = text.encode(), "text/markdown", "artifact-fixture.md"
                    spec = {"kind": kind, "markdown": text}
                else:
                    stream = io.StringIO()
                    csv.writer(stream).writerows([
                        ["Finding", "Source URL", "Publication date", "Sources"],
                        [acceptance.SOURCE_SENTENCE, acceptance.SOURCE_URL, acceptance.SOURCE_DATE, acceptance.SOURCE_URL]])
                    data, mime, filename = stream.getvalue().encode(), "text/csv", "artifact-fixture.csv"
                    spec = {"kind": kind}
                spec["sources"] = [{"id": "1", "url": acceptance.SOURCE_URL}]
                (workspace / filename).write_bytes(data)
                request = {"path": "/workspace/" + filename, "spec": spec, "checksum_sha256": hashlib.sha256(data).hexdigest(),
                           "size": len(data), "mime_type": mime}
                await publisher(request)
                before = len(publisher.records)
                with self.assertRaisesRegex(acceptance.AcceptanceError, "exactly one Markdown brief and one CSV"):
                    await publisher(request)
                self.assertEqual(len(publisher.records), before)
                self.assertEqual(len(list(publisher.output.iterdir())), before)

    async def test_missing_key_consumes_admission_without_provider_request(self):
        _, credential = acceptance._paths(self.root)
        credential.write_text("OPENAI_API_KEY=unrelated-key\n")
        report = await acceptance.execute(self.root, "0.06", transport=self.transport([]))
        self.assertFalse(report["passed"])
        self.assertEqual(report["model_requests_admitted"], 0)
        self.assertTrue((self.output / "admission.json").is_file())
        self.assertTrue(acceptance.check(self.root)["alreadyUsed"])
        self.assertEqual(self.requests, [])

    async def test_existing_or_symlinked_scope_never_reads_credentials(self):
        target = self.root / "target"
        target.mkdir()
        self.output.parent.mkdir()
        self.output.symlink_to(target, target_is_directory=True)
        with patch.object(acceptance, "_credential_from_file", side_effect=AssertionError("no read")), \
             self.assertRaisesRegex(acceptance.AcceptanceError, "symlinks"):
            await acceptance.execute(self.root, "0.06")
        self.assertEqual(list(target.iterdir()), [])

    def test_synthetic_fetch_has_no_external_fallback(self):
        fixture = acceptance.SyntheticResearch()
        for url in ("https://example.com", acceptance.SOURCE_URL + "?changed=1", "http://127.0.0.1", "file:///etc/passwd"):
            with self.subTest(url=url), self.assertRaises(ValueError):
                fixture.fetch(url, 10)
        self.assertEqual(fixture.fetched, [])
        self.assertEqual(fixture.fetch(acceptance.SOURCE_URL, 10).url, acceptance.SOURCE_URL)

    async def test_checkpoint_rejects_stale_version_and_wrong_run(self):
        self.output.mkdir(parents=True)
        checkpoint = acceptance.LocalCheckpoint(self.output)
        await checkpoint(acceptance.IDENTITY, {"version": 0, "state": {"phase": "running"}})
        with self.assertRaises(acceptance.AcceptanceError):
            await checkpoint(acceptance.IDENTITY, {"version": 0, "state": {"phase": "finished"}})
        with self.assertRaises(acceptance.AcceptanceError):
            await checkpoint("other-run")
        self.assertEqual(json.loads((self.output / "checkpoint.json").read_text())["version"], 1)

    async def test_cancelled_attempt_retains_marker_and_no_repeat(self):
        entered = asyncio.Event()

        async def wait_response(request):
            entered.set()
            await asyncio.Event().wait()

        task = asyncio.create_task(acceptance.execute(self.root, "0.06", transport=httpx.MockTransport(wait_response)))
        await asyncio.wait_for(entered.wait(), timeout=1)
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        report = json.loads((self.output / "report.json").read_text())
        self.assertEqual(report["outcome"], "interrupted_no_repeat")
        self.assertEqual(report["model_requests_admitted"], 1)
        self.assertTrue(acceptance.check(self.root)["alreadyUsed"])
        self.assertEqual(report["budget"]["output_tokens"], 2048)
