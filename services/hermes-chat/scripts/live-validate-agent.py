"""RETIRED: owned Responses/Docker validation, retained for historical fixtures.

Exercises the real model/computer loop against exact synthetic browser
resources and an in-memory control plane. No public research network, production
database or storage is contacted. The model endpoint is the only paid network.
"""
from __future__ import annotations

import argparse
import asyncio
import csv
import fcntl
import json
import hashlib
import math
import os
import re
import stat
from pathlib import Path
from types import SimpleNamespace
from uuid import uuid4

from hermes_chat.durable import DurableJob, DurableRunWorker
from hermes_chat.isolation import TenantIsolation, tenant_run_scope
from hermes_chat.live_validation_fixture import (
    ALLOWED_URLS, SOURCE_DATE, SOURCE_SENTENCE, SOURCE_TITLE, SOURCE_URL,
    SCRIPT_MARKER, FixtureResearchTools, SyntheticFixture,
)
from hermes_chat.retrieval import RetrievalConfig
from hermes_chat.runtime import OwnedAgentRunner
from hermes_chat.validation_sandbox import DisposableValidationSandbox
from hermes_chat.service import _credential_from_file


_VALIDATION_ID = re.compile(r"^validation-[A-Za-z0-9_-]{8,96}$")


def _existing_private_directory(raw, *, name):
    candidate = Path(raw)
    if (not candidate.is_absolute() or ".." in candidate.parts or candidate == Path("/")
            or any(path.is_symlink() for path in (candidate, *candidate.parents))):
        raise ValueError(f"{name} must be an absolute preconfigured directory without symlinks or traversal")
    try:
        info = candidate.stat()
    except OSError:
        raise ValueError(f"Operator must preconfigure {name} before validation") from None
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise ValueError(f"{name} must be a private directory owned by the service user")
    return candidate


class PreconfiguredIsolation(TenantIsolation):
    """Use operator-created scope directories without creating or chmoding them."""

    def ensure(self, runtime, *, computer_state=True):
        if runtime != self.resolve(runtime.key, runtime.conversation_id):
            raise ValueError("Validation runtime does not match its fixed scope")
        paths = [runtime.hermes_home, runtime.workspace]
        if computer_state:
            paths += [runtime.workspace / ".tmp"]
        for path in paths:
            _existing_private_directory(path, name="validation scope directory")
        return runtime


def validation_layout(args):
    """Resolve fresh private report/state directories; none is model-mounted."""
    identity = getattr(args, "validation_id", None)
    if not isinstance(identity, str) or not _VALIDATION_ID.fullmatch(identity):
        raise ValueError("A fixed --validation-id beginning validation- is required")
    state = _existing_private_directory(args.state_dir, name="state root")
    workspace = _existing_private_directory(args.workspace_dir, name="workspace root")
    output = _existing_private_directory(args.output_dir, name="output directory")
    paths = (state, workspace, output)
    if any(a.is_relative_to(b) or b.is_relative_to(a) for index, a in enumerate(paths) for b in paths[index + 1:]):
        raise ValueError("State, workspace and output directories must be separate")
    isolation = PreconfiguredIsolation(state, workspace)
    runtime = isolation.ensure(isolation.resolve(identity, identity))
    outputs = _existing_private_directory(runtime.workspace / "outputs", name="artifact output directory")
    screenshots = _existing_private_directory(runtime.workspace / "browser-screenshots", name="browser screenshot directory")
    if (list(runtime.hermes_home.iterdir()) or list(screenshots.iterdir())
            or list((runtime.workspace / ".tmp").iterdir()) or list(outputs.iterdir()) or list(output.iterdir())):
        raise ValueError("Validation requires a fresh fixed scope and empty output directories")
    if {path.name for path in runtime.workspace.iterdir()} != {".tmp", "browser-screenshots", "outputs"}:
        raise ValueError("Validation workspace contains unexpected pre-existing files")
    return identity, isolation, runtime, output


def _screenshot_proof(result, runtime):
    path = result.get("screenshot_path")
    if not isinstance(path, str) or not path.startswith("/workspace/browser-screenshots/"):
        raise RuntimeError("Browser screenshot did not identify its scoped file")
    target = runtime.workspace / path.removeprefix("/workspace/")
    if (".." in target.parts or any(item.is_symlink() for item in (target, *target.parents))
            or not target.is_file() or not target.is_relative_to(runtime.workspace / "browser-screenshots")):
        raise RuntimeError("Browser screenshot escaped its scope")
    if target.stat().st_size > 1024 * 1024:
        raise RuntimeError("Browser screenshot exceeded its bound")
    content = target.read_bytes()
    digest = hashlib.sha256(content).hexdigest()
    if (not content.startswith(b"\x89PNG\r\n\x1a\n") or result.get("screenshot_sha256") != digest
            or result.get("screenshot_bytes") != len(content)):
        raise RuntimeError("Browser screenshot file does not match its host digest")
    return {"path": str(target.relative_to(runtime.workspace)), "sha256": digest, "bytes": len(content)}


def _exclusive_lock(path, *, directory=False):
    flags = os.O_RDONLY | os.O_DIRECTORY if directory else os.O_CREAT | os.O_RDWR
    descriptor = os.open(path, flags | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    try:
        info = os.fstat(descriptor)
        if info.st_uid != os.getuid() or info.st_mode & 0o077 or (not directory and not stat.S_ISREG(info.st_mode)):
            raise ValueError("Validation lock must remain private and service-owned")
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
        return descriptor
    except BlockingIOError:
        os.close(descriptor)
        raise RuntimeError("The fixed validation scope is already in use; no paid call was made") from None
    except BaseException:
        os.close(descriptor)
        raise


async def computer_preflight(runtime, identity, fixture, image, *, docker_socket):
    """Real computer interactions and source verification; no model or key access."""
    research = FixtureResearchTools()
    research.bind_run(runtime.key, identity, identity)
    # This is the same lock used by OwnedAgentRunner.run(). The validator's
    # outer directory lock remains held when this lock is handed to the runner.
    lock = _exclusive_lock(runtime.hermes_home / "agent.lock")
    computer = None
    try:
        with tenant_run_scope(runtime, thread_id=identity, run_id=identity):
            computer = DisposableValidationSandbox(runtime, identity, docker_socket=docker_socket,
                image=image, resource_fetcher=fixture.fetch, allowed_urls=ALLOWED_URLS, synthetic_fixture=True)
            await computer.prepare()
            terminal = await computer.execute("terminal", {"command": "python3 -c 'print(\"NewsCraft synthetic fixture\")'"})
            if terminal.get("exit_code") != 0 or "NewsCraft synthetic fixture" not in terminal.get("stdout", "") or terminal.get("network_enabled") is not False:
                raise RuntimeError("Isolated terminal preflight failed")
            if not computer.bounds_proof or computer.bounds_proof.get('byte_exhaustion') is not True or computer.bounds_proof.get('inode_exhaustion') is not True:
                raise RuntimeError('Disposable kernel storage preflight failed')

            async def browser(action, **values):
                result = await computer.execute("browser", {"action": action, **values})
                if (not isinstance(result, dict) or result.get("error") or result.get("url") != SOURCE_URL
                        or result.get("scripts_enabled") is not True or not result.get("navigation_id")):
                    raise RuntimeError("Interactive browser preflight failed")
                return result

            await browser("navigate", url=SOURCE_URL)
            initial = await browser("snapshot")
            if SCRIPT_MARKER not in initial.get("text", ""):
                raise RuntimeError("Fixture JavaScript did not render")
            filled = await browser("fill", selector="#fill-check", text="fixture fill")
            typed = await browser("type", selector="#type-check", text="fixture type")
            keyed = await browser("key", key="Enter")
            clicked = await browser("click", selector="#click-check")
            for result, marker in ((filled, "Fill verified: fixture fill"), (typed, "Type verified: fixture type"),
                                   (keyed, "Enter key verified."), (clicked, "Click verified.")):
                if marker not in result.get("text", ""):
                    raise RuntimeError("Fixture browser interaction did not change the DOM")
            top = _screenshot_proof(await browser("screenshot"), runtime)
            await browser("scroll", delta_y=800)
            scrolled = _screenshot_proof(await browser("screenshot"), runtime)
            if top["sha256"] == scrolled["sha256"]:
                raise RuntimeError("Fixture scroll did not change the captured viewport")
            # Origin/context input taint survives navigation and future runs.
            # Explicitly reset private storage before the clean source read.
            reset = await computer.execute("browser", {"action": "reset"})
            if reset.get("reset") is not True or reset.get("storage_cleared") is not True or reset.get("input_tainted") is not False:
                raise RuntimeError("Browser private storage/input taint reset failed")
            clean = await browser("navigate", url=SOURCE_URL)
            receipt = computer.browser_receipt(clean.get("receipt_id"))
            research.remember_browser_receipt(receipt)
            source = json.loads(await research.execute("record_newscraft_source", {"source": {
                "citationNumber": 1, "title": SOURCE_TITLE, "url": SOURCE_URL,
                "publicationDate": SOURCE_DATE, "sourceType": "primary", "supportingExcerpt": SOURCE_SENTENCE,
            }}))
            if source.get("error") or not research.verified_sources():
                raise RuntimeError("Sealed synthetic browser source verification failed")
            if {url for url, method in fixture.requests if method == "GET"} != ALLOWED_URLS:
                raise RuntimeError("Fixture HTML, JavaScript, stylesheet and image were not all loaded")
            return {"passed": True, "synthetic_fixture": True, "public_network_validated": False,
                    "storage_enforcement": computer.bounds_proof,
                    "actions": ["terminal", "navigate", "snapshot", "fill", "type", "key", "click", "scroll", "screenshot", "reset"],
                    "resources": sorted(ALLOWED_URLS), "screenshots": [top, scrolled],
                    "source": research.verified_sources()[0]}
    finally:
        try:
            if computer is not None:
                await computer.close()
        finally:
            os.close(lock)


class SyntheticControlPlane:
    """A validation fixture, not evidence for the production database/storage."""
    def __init__(self, job, *, verified_sources=lambda: []):
        self.binding = {name: getattr(job, name) for name in
                        ("run_id", "account_id", "tenant_key", "lease_owner", "lease_token")}
        self.events = []
        self.revisions = []
        self.receipts = {}
        self.renewals = 0
        self.verified_sources = verified_sources

    async def __call__(self, method, path, body=None):
        revision_path = f"/{self.binding['run_id']}/artifacts/revisions"
        binding = {k: v for k, v in self.binding.items() if path != revision_path or k != "run_id"}
        if method != "POST" or not isinstance(body, dict) or any(body.get(k) != v for k, v in binding.items()):
            raise RuntimeError("Synthetic control-plane binding mismatch")
        if path == "/renew":
            self.renewals += 1
            return {"renewed": True}
        if path == revision_path:
            spec = body.get("spec")
            if not valid_inline_spec(spec, self.verified_sources()):
                raise RuntimeError("Validation permits only supported inline Markdown/table revisions")
            revision = uuid4().hex
            self.revisions.append({"revision_id": revision, "spec": spec})
            return {"revision_id": revision, "artifact": {**spec, "id": revision, "state": "ready"}}
        if path == "/callback":
            events = body.get("events") or [{k: body[k] for k in ("worker_cursor", "event_type", "data")}]
            for event in events:
                cursor = event.get("worker_cursor")
                if isinstance(cursor, bool) or not isinstance(cursor, int) or cursor < 1:
                    raise RuntimeError("Validation callback cursor is invalid")
                receipt = {k: event[k] for k in ("event_type", "data")}
                if cursor in self.receipts:
                    if self.receipts[cursor] != receipt:
                        raise RuntimeError("Validation callback identity changed")
                    continue
                if cursor != len(self.receipts) + 1:
                    raise RuntimeError("Validation callback cursor is not contiguous")
                self.receipts[cursor] = receipt
                self.events.append(receipt)
            return {"accepted": True}
        raise RuntimeError("Validation attempted an unexpected control-plane operation")


def valid_inline_spec(spec, verified_sources):
    """Require the requested finding and citation support in the published spec."""
    if not isinstance(spec, dict) or spec.get("kind") not in {"markdown", "table"}:
        return False
    supported = {source["citationNumber"] for source in verified_sources
                 if source.get("url") == SOURCE_URL and source.get("supportingExcerpt") == SOURCE_SENTENCE}
    sources = spec.get("sources")
    if (not supported or not isinstance(sources, list) or not sources
            or any(not isinstance(source, dict) or source.get("url") != SOURCE_URL
                   or str(source.get("id")) not in {str(number) for number in supported} for source in sources)):
        return False
    if spec["kind"] == "markdown":
        markdown = spec.get("markdown")
        if not isinstance(markdown, str) or SOURCE_SENTENCE not in markdown:
            return False
        refs = {int(n) for n in re.findall(r"\[(\d+)\]", markdown)}
        return bool(refs and refs <= supported)
    columns, rows = spec.get("columns"), spec.get("rows")
    if not isinstance(columns, list) or not columns or not isinstance(rows, list) or not rows:
        return False
    ids = [column.get("id") if isinstance(column, dict) else None for column in columns]
    if (any(not isinstance(key, str) or not key for key in ids) or len(set(ids)) != len(ids)
            or any(not isinstance(column.get("label"), str) or not column["label"] for column in columns)):
        return False
    return all(isinstance(row, dict) and set(row) == set(ids) and SOURCE_SENTENCE in row.values()
               and SOURCE_URL in row.values() for row in rows)


def accepted_evidence(events, revisions, files, verified_sources):
    if any(path.is_symlink() or not path.is_file() for path in files):
        return False
    supported = {source["citationNumber"]: source for source in verified_sources
                 if source.get("url") == SOURCE_URL and source.get("supportingExcerpt") == SOURCE_SENTENCE
                 and source.get("retrieval", {}).get("syntheticFixture") is True
                 and source.get("retrieval", {}).get("publicNetworkValidated") is False
                 and source.get("retrieval", {}).get("evidenceOrigin") == "synthetic_fixture"}
    kinds = {revision["spec"].get("kind") for revision in revisions}
    event_types = {event["event_type"] for event in events}
    citations = {source["citationNumber"]: source for event in events if event["event_type"] == "agent.citations"
                 for source in event["data"].get("citations", [])
                 if source.get("citationNumber") in supported and source == supported[source["citationNumber"]]}
    read = any(event["event_type"] == "agent.source.read" and
               all(event["data"].get("source", {}).get(key) == source.get(key)
                   for key in ("citationNumber", "url", "supportingExcerpt", "retrieval"))
               for event in events for source in supported.values())
    answers = [event["data"].get("content", "") for event in events if event["event_type"] == "agent.answer.replace"]
    answer_refs = {int(n) for n in re.findall(r"\[(\d+)\]", answers[-1])} if answers else set()
    cited_answer = bool(answers and SOURCE_SENTENCE in answers[-1] and answer_refs
                        and answer_refs <= citations.keys())
    csv_rows = [list(csv.reader(path.read_text().splitlines())) for path in files if path.suffix == ".csv"]
    csv_ok = any(len(rows) > 1 and all(SOURCE_URL in row and SOURCE_SENTENCE in row for row in rows[1:]) for rows in csv_rows)
    markdown_ok = False
    for path in files:
        if path.suffix != ".md":
            continue
        markdown = path.read_text()
        refs = {int(n) for n in re.findall(r"\[(\d+)\]", markdown)}
        if SOURCE_SENTENCE in markdown and refs and refs <= citations.keys():
            markdown_ok = True
    published = set()
    for revision in revisions:
        revision_id, spec = revision.get("revision_id"), revision.get("spec")
        if not isinstance(revision_id, str) or not valid_inline_spec(spec, verified_sources):
            return False
        expected_artifact = {**spec, "id": revision_id, "state": "ready"}
        ready = any(event["event_type"] == "artifact.ready"
                    and event["data"].get("artifact_revision_id") == revision_id
                    and event["data"].get("artifact") == expected_artifact for event in events)
        results = [event["data"].get("result", {}) for event in events if event["event_type"] == "agent.tool.progress"
                   and event["data"].get("name") == ("publish_markdown" if spec["kind"] == "markdown" else "publish_csv")]
        paths = {result.get("workspace_path") for result in results if isinstance(result, dict)
                 and result.get("revision_id") == revision_id and result.get("artifact") == expected_artifact}
        matched = False
        for path in files:
            if f"/workspace/outputs/{path.name}" not in paths:
                continue
            if spec["kind"] == "markdown":
                matched = path.suffix == ".md" and path.read_text() == spec["markdown"]
            else:
                rows = list(csv.reader(path.read_text().splitlines()))
                expected_rows = [[column["label"] for column in spec["columns"]]] + [
                    ["" if row[column["id"]] is None else str(row[column["id"]]) for column in spec["columns"]]
                    for row in spec["rows"]]
                matched = path.suffix == ".csv" and rows == expected_rows
            if matched:
                published.add(spec["kind"])
                break
        if not ready or not matched:
            return False
    return bool({"response.completed", "agent.source.read", "agent.plan", "agent.decision"} <= event_types
                and not {"response.failed", "run.failed", "run.cancelled"}.intersection(event_types)
                and {"markdown", "table"} <= kinds and {"markdown", "table"} <= published
                and read and cited_answer and csv_ok and markdown_ok)


def cost_accounting_report(budget):
    return {"local_run_budget_usd": budget,
            "account_wide_cost_limit_enforced": False, "provider_hard_cost_limit_enforced": False,
            "accounting_rates_usd_per_million": {"input": 10, "output": 60},
            "cost_claim": "Conservative local model-loop accounting only; not an account-wide or provider-enforced USD limit."}


async def validate(args: argparse.Namespace) -> int:
    if not args.confirm_paid_call and not getattr(args, 'preflight_only', False):
        raise ValueError("Explicit paid-call approval is required")
    if not getattr(args, 'preflight_only', False) and not args.credential_file:
        raise ValueError('Paid validation requires an approved credential-file reference')
    if isinstance(args.max_cost_usd, bool) or not math.isfinite(args.max_cost_usd) or not 0 < args.max_cost_usd <= 2:
        raise ValueError("This validation permits a local run budget of at most USD 2")
    _, _, runtime, _ = validation_layout(args)
    # Lock the pre-existing directory itself; do not create a provisioning file.
    # Recheck freshness after locking so concurrent admission cannot race.
    lock = _exclusive_lock(runtime.hermes_home, directory=True)
    try:
        return await _validate_locked(args, validation_layout(args))
    finally:
        os.close(lock)


async def _validate_locked(args, layout):
    identity, isolation, runtime, output = layout
    # This test backend has no host mount and does not need production XFS.
    # Its real container inspection and kernel exhaustion proofs precede key access.
    if not getattr(args, 'docker_socket', None):
        raise ValueError('Explicit --docker-socket is required; no paid call was made')
    fixture = SyntheticFixture()
    preflight = await computer_preflight(runtime, identity, fixture, args.image, docker_socket=args.docker_socket)
    if preflight.get("passed") is not True:
        raise RuntimeError("Interactive sandbox preflight failed; no paid call was made")
    if getattr(args, 'preflight_only', False):
        report = {'passed': True, 'preflight_only': True, 'paid_calls': 0,
            'disposable_storage': True, 'production_computer_backend_verified': False,
            'computer_preflight': preflight}
        with (output/'report.json').open('x') as report_file:
            report_file.write(json.dumps(report, indent=2))
        print(json.dumps({'passed': True, 'preflight_only': True, 'paid_calls': 0}))
        return 0
    research_instances = []

    def research_factory(config):
        research = FixtureResearchTools(config)
        research_instances.append(research)
        return research

    def sandbox_factory(scoped_runtime, thread_id):
        return DisposableValidationSandbox(scoped_runtime, thread_id, docker_socket=args.docker_socket,
                               image=args.image, resource_fetcher=fixture.fetch,
                               allowed_urls=ALLOWED_URLS, synthetic_fixture=True)

    # Key access is last: the fixed quota, browser resources, interactions,
    # screenshot files and host-sealed source receipt have all passed above.
    settings = SimpleNamespace(
        model="gpt-5.5", model_base_url="https://api.openai.com/v1",
        model_api_key=_credential_from_file(args.credential_file), retrieval=RetrievalConfig(archive_fallback=False),
        max_seconds=180, max_iterations=12, max_input_tokens=120000, max_output_tokens=4096,
        max_cost_usd=args.max_cost_usd, input_cost_per_million=10, output_cost_per_million=60,
        run_api_url="https://in-memory.invalid", run_api_token="synthetic-control-plane",
    )
    runner = OwnedAgentRunner(settings, isolation, research_factory=research_factory, sandbox_factory=sandbox_factory)
    worker = DurableRunWorker(settings, isolation, runner=runner)
    runner.publisher = worker.publish_artifact_from_tool
    payload = {"threadId": identity, "runId": identity, "messages": [{"role": "user", "content":
        f"Read only the synthetic fixture at {SOURCE_URL} using the browser. Find its exact sentence about the lantern count. "
        "Record that full sentence as the supporting excerpt. Quote the same exact full sentence in your final answer "
        "and Markdown brief, with its recorded citation. Publish that Markdown and a CSV with the exact sentence "
        "in every row, source URL, and recorded row_citations. Use a short visible plan and one brief decision. "
        "This is invented fixture evidence, not public Internet validation. The only available research action is "
        "record_newscraft_source after the browser has read the source. Do not type into the browser, search, fetch other URLs, "
        "access accounts or send messages."}]}
    job = DurableJob(identity, "synthetic-account", identity, payload, [], "synthetic-owner", "synthetic-lease",
                     thread_id=identity, task=asyncio.current_task(), lease_acquired=True)
    control = SyntheticControlPlane(job, verified_sources=lambda: [
        source for research in research_instances for source in research.verified_sources()])
    worker._newscraft = control
    worker.jobs[identity] = job
    try:
        await worker._run(job)
    finally:
        await worker.close()
    outputs = runtime.workspace / "outputs"
    files = list(outputs.glob("*")) if not outputs.is_symlink() else []
    verified_sources = [source for research in research_instances for source in research.verified_sources()]
    report = {"passed": accepted_evidence(control.events, control.revisions, files, verified_sources),
              "validation_id": identity, "quota_scope": runtime.task_key, "model": settings.model,
              **cost_accounting_report(args.max_cost_usd),
              "control_plane": "synthetic in memory", "production_storage_verified": False,
              "synthetic_fixture": True, "public_network_validated": False,
              "computer_preflight": preflight, "disposable_storage": True,
              "production_computer_backend_verified": False,
              "workspace_storage": {"backend": "container_tmpfs", "host_bind_mounts": False,
                  "bytes": 67108864, "inodes": 4096},
              "synthetic_lease_renewals": control.renewals, "public_events": control.events,
              "files": [str(path.relative_to(runtime.workspace)) for path in files]}
    with (output / "report.json").open("x") as report_file:
        report_file.write(json.dumps(report, indent=2))
    print(json.dumps({key: report[key] for key in ("passed", "local_run_budget_usd", "control_plane", "production_storage_verified", "public_network_validated")}))
    print("Saved public validation evidence:", output / "report.json")
    return 0 if report["passed"] else 1


def main() -> int:
    print("Retired validator: the active NewsCraft-owned portable runtime has a separate acceptance plan. "
          "See docs/agent-live-validation-approval.md. No credentials, paid calls or Docker operations were performed.")
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
