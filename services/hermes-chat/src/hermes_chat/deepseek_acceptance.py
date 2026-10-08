"""One separately approved paid model run; all other boundaries are local fixtures.

The default/check path never reads credentials or opens a network connection.
The fixed output directory is a permanent, one-shot admission boundary: even a
failed or interrupted attempt cannot be repeated by this CLI.
"""
from __future__ import annotations

import argparse
import asyncio
import copy
import csv
import hashlib
import io
import json
import os
import stat
from pathlib import Path
from types import SimpleNamespace

import httpx

from .isolation import TenantIsolation
from .live_validation_fixture import ARTICLE_HTML, SOURCE_DATE, SOURCE_SENTENCE, SOURCE_TITLE, SOURCE_URL
from .model_adapters import DeepSeekMessages, ModelError
from .portable import PortableAgentRunner
from .retrieval import HttpResponse, NewsCraftWebProvider, ResearchTools, RetrievalConfig
from .sandbox_adapter import UnconfiguredSandbox
from .service import _credential_from_file

IDENTITY = "deepseek-acceptance-20261008"
ENDPOINT = "https://api.deepseek.com/anthropic"
LIMITS = {"model": "deepseek-flash", "thinking": "disabled", "max_model_requests": 8,
          "max_input_tokens": 120000, "max_output_tokens_per_request": 2048,
          "max_seconds": 180, "max_cost_usd": "0.06", "input_price_per_million": "0.30",
          "output_price_per_million": "1.20"}
SCOPE = {"research": "synthetic fixture", "checkpoint": "local JSON fixture", "artifacts": "local files",
         "database_verified": False, "application_storage_verified": False,
         "public_retrieval_verified": False, "browser_verified": False, "executor_verified": False}
PROMPT = (
    f"This is a synthetic software acceptance fixture, not real news. Read {SOURCE_URL} with web_extract, "
    "record its exact supporting sentence as citation 1 using record_newscraft_source, then publish a Markdown brief "
    "and a one-row CSV. Use the source's publication date, not today's date. The Markdown must contain the exact "
    "supporting sentence, publication date and [1]. The CSV must have Finding, Source URL and Publication date columns "
    "with the exact sentence, source URL and publication date in its row; use row_citations [[1]]. End with the exact "
    "supporting sentence and [1], identifying it as synthetic. You may batch independent publication calls. "
    "Do not invent another URL, browse, execute code, or call any external service."
)


class AcceptanceError(RuntimeError):
    """Fixed diagnostic text safe for stdout; never include raw provider errors."""


def _paths(root: Path):
    return root / ".data" / IDENTITY, root / "services" / "newsroom-harness" / ".env.local"


def _no_symlinks(path: Path, root: Path):
    if not path.is_relative_to(root) or any(item.is_symlink() for item in (path, *path.parents) if item.is_relative_to(root)):
        raise AcceptanceError("Acceptance paths must remain inside the repository without symlinks.")


def _write_new(path: Path, data: bytes):
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, "wb") as output:
        output.write(data)
        output.flush()
        os.fsync(output.fileno())
    _sync_directory(path.parent)


def _sync_directory(path: Path):
    descriptor = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _write_json(path: Path, value):
    _write_new(path, json.dumps(value, sort_keys=True, indent=2).encode())


def check(root: Path):
    """Inspect path metadata only. The selected key's presence remains unverified."""
    root = root.resolve()
    output, credential = _paths(root)
    _no_symlinks(output, root)
    _no_symlinks(credential, root)
    used = output.exists()
    return {"mode": "check", "eligible_for_separately_approved_attempt": not used and credential.is_file(),
            "alreadyUsed": used, "credential_reference_exists": credential.is_file(),
            "credential_key_presence_verified": False, "network_requests": 0,
            "limits": LIMITS, "scope": SCOPE, "output": str(output.relative_to(root))}


def _admit(root: Path, approved_usd: str | None):
    if approved_usd != "0.06":
        raise AcceptanceError("Execution requires --execute --approved-usd 0.06 after separate explicit user approval.")
    output, credential = _paths(root)
    _no_symlinks(output, root)
    _no_symlinks(credential, root)
    if output.exists():
        raise AcceptanceError("The fixed acceptance scope already exists; a repeat attempt is forbidden.")
    output.parent.mkdir(mode=0o700, exist_ok=True)
    info = output.parent.stat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o022:
        raise AcceptanceError("The acceptance parent must be a service-owned directory without shared write access.")
    try:
        output.mkdir(mode=0o700)
    except FileExistsError:
        raise AcceptanceError("The fixed acceptance scope already exists; a repeat attempt is forbidden.") from None
    _sync_directory(output.parent)
    # Consume the one-shot allowance before credentials or any possible request.
    # A crash before this file completes still leaves the directory blocking reuse.
    _write_json(output / "admission.json", {"identity": IDENTITY, "limits": LIMITS,
                                           "scope": SCOPE, "repeat_allowed": False})
    return output, credential


class LocalCheckpoint:
    """Single-process CAS fixture, explicitly not the application's Postgres store."""

    def __init__(self, output: Path):
        self.path = output / "checkpoint.json"
        self.saved = {"version": 0, "state": {}}
        _write_json(self.path, self.saved)

    async def __call__(self, run_id, update=None):
        if run_id != IDENTITY:
            raise AcceptanceError("The local checkpoint run identity changed.")
        if update is not None:
            if update.get("version") != self.saved["version"]:
                raise AcceptanceError("The local checkpoint version is stale.")
            saved = {"version": self.saved["version"] + 1, "state": copy.deepcopy(update["state"])}
            temporary = self.path.with_suffix(".next.json")
            _write_json(temporary, saved)
            os.replace(temporary, self.path)
            _sync_directory(self.path.parent)
            self.saved = saved
        return copy.deepcopy(self.saved)


class SyntheticResearch:
    def __init__(self):
        self.fetched = []

    def fetch(self, url, timeout):
        if url != SOURCE_URL:
            raise ValueError("Only the exact synthetic fixture source is available.")
        self.fetched.append(url)
        return HttpResponse(200, SOURCE_URL, {"content-type": "text/html; charset=utf-8"}, ARTICLE_HTML.encode())

    def search(self, query, count, timeout):
        return [{"href": SOURCE_URL, "title": SOURCE_TITLE, "body": "Synthetic fixture, not real news."}]

    def factory(self, config):
        class Provider(NewsCraftWebProvider):
            def _metadata(self, *args, **kwargs):
                return {**super()._metadata(*args, **kwargs), "syntheticFixture": True,
                        "publicNetworkValidated": False, "evidenceOrigin": "synthetic_fixture"}
        return ResearchTools(config, provider=Provider(config, fetcher=self.fetch), searcher=self.search)


class GuardedDeepSeek(DeepSeekMessages):
    def __init__(self, settings, output, *, client):
        super().__init__(settings, client=client)
        self.output, self.attempts, self.completed_replies = output, 0, 0

    async def complete(self, **arguments):
        reply = await super().complete(**arguments)
        self.completed_replies += 1
        return reply

    async def post(self, path, headers, payload):
        if (self.settings.model_base_url != ENDPOINT or path != "/v1/messages"
                or payload.get("model") != "deepseek-flash" or payload.get("thinking") != {"type": "disabled"}
                or payload.get("max_tokens") != 2048 or self.attempts >= 8):
            raise ModelError("The acceptance model request exceeded its fixed approved policy.")
        self.attempts += 1
        _write_json(self.output / f"request-{self.attempts}.json", {"attempt": self.attempts, "outcome": "admitted"})
        return await super().post(path, headers, payload)


class LocalPublisher:
    def __init__(self, output, workspace):
        self.output, self.workspace, self.records = output / "artifacts", workspace, []
        self.output.mkdir(mode=0o700)

    async def __call__(self, request, **scope):
        relative = request.get("path", "").removeprefix("/workspace/")
        path = self.workspace / relative
        if (not request.get("path", "").startswith("/workspace/") or Path(relative).name != relative
                or path.is_symlink() or not path.is_file() or path.stat().st_size > 512 * 1024):
            raise AcceptanceError("The local publication path is invalid.")
        data = path.read_bytes()
        digest = hashlib.sha256(data).hexdigest()
        spec = request["spec"]
        if request["checksum_sha256"] != digest or request["size"] != len(data):
            raise AcceptanceError("The local artifact bytes do not match their declared digest and size.")
        if spec.get("kind") not in {"markdown", "table"} or not any(source.get("url") == SOURCE_URL for source in spec.get("sources", [])):
            raise AcceptanceError("The local artifact lacks its synthetic source citation.")
        kind = spec["kind"]
        if any(record["kind"] == kind for record in self.records):
            raise AcceptanceError("Acceptance permits exactly one Markdown brief and one CSV publication.")
        if kind == "markdown":
            valid = (request["mime_type"] == "text/markdown" and spec.get("markdown", "").encode() == data
                     and SOURCE_SENTENCE in data.decode() and "[1]" in data.decode() and SOURCE_URL in data.decode()
                     and SOURCE_DATE[:10] in data.decode())
        else:
            rows = list(csv.reader(io.StringIO(data.decode())))
            # PortableAgentRunner appends its validated row citations as Sources.
            # Require the requested semantic columns and exactly one finding,
            # rather than accepting an arbitrary header or duplicated rows.
            valid = (request["mime_type"] == "text/csv" and len(rows) == 2
                     and rows[0] == ["Finding", "Source URL", "Publication date", "Sources"]
                     and len(rows[1]) == 4 and rows[1][0] == SOURCE_SENTENCE
                     and rows[1][1] == SOURCE_URL and rows[1][2] in {SOURCE_DATE, SOURCE_DATE[:10]}
                     and rows[1][3] == SOURCE_URL)
        if not valid:
            raise AcceptanceError("The generated artifact did not contain the required synthetic finding, date and citation.")
        filename = f"{len(self.records) + 1}-" + ("brief.md" if kind == "markdown" else "evidence.csv")
        _write_new(self.output / filename, data)
        self.records.append({"kind": kind, "file": "artifacts/" + filename, "bytes": len(data), "sha256": digest})
        return {"revision_id": f"local-fixture-{len(self.records)}", "artifact": {"state": "ready"}}


def _settings(key):
    return SimpleNamespace(model_provider="deepseek", model="deepseek-flash", model_base_url=ENDPOINT,
        model_api_key=key, max_seconds=180, max_iterations=8, max_input_tokens=120000,
        max_output_tokens=2048, max_cost_usd=0.06, input_cost_per_million=0.30,
        output_cost_per_million=1.20, image_token_ceiling=32768, web_provider="public",
        max_search_calls=1, search_cost_ceiling_usd=0, executor=None,
        retrieval=RetrievalConfig(enabled=True, archive_fallback=False, max_urls=1))


async def execute(root: Path, approved_usd: str | None, *, transport=None):
    root = root.resolve()
    output, credential = _admit(root, approved_usd)
    model = checkpoint = publisher = None
    report = {"passed": False, "identity": IDENTITY, "scope": SCOPE, "limits": LIMITS,
              "model_requests_admitted": 0, "repeat_allowed": False, "provider_access_verified": False}
    try:
        settings = _settings(_credential_from_file(str(credential), "DEEPSEEK_API_KEY"))
        isolation = TenantIsolation(output / "state", output / "workspace")
        runtime = isolation.ensure(isolation.resolve(IDENTITY, IDENTITY))
        checkpoint = LocalCheckpoint(output)
        publisher = LocalPublisher(output, runtime.workspace)
        research = SyntheticResearch()
        async with httpx.AsyncClient(timeout=60, trust_env=False, follow_redirects=False, transport=transport) as client:
            model = GuardedDeepSeek(settings, output, client=client)
            runner = PortableAgentRunner(settings, isolation, model=model, research_factory=research.factory,
                                         sandbox_factory=UnconfiguredSandbox)
            runner.checkpoint, runner.publisher = checkpoint, publisher
            events = []
            async with asyncio.timeout(180):
                async for event in runner.run({"threadId": IDENTITY, "messages": [{"role": "user", "content": PROMPT}]}, runtime, IDENTITY):
                    events.append(event)
            state = checkpoint.saved["state"]
            source = next((item for item in state.get("sources", []) if item.get("citationNumber") == 1), {})
            answer = state.get("answer", "")
            passed = (state.get("phase") == "finished" and events and events[-1].get("type") == "RUN_FINISHED"
                and SOURCE_SENTENCE in answer and "[1]" in answer and "synthetic" in answer.lower()
                and source.get("url") == SOURCE_URL and source.get("publicationDate") == SOURCE_DATE
                and source.get("supportingExcerpt") == SOURCE_SENTENCE
                and source.get("retrieval", {}).get("syntheticFixture") is True
                and source.get("retrieval", {}).get("publicNetworkValidated") is False
                and {item["kind"] for item in publisher.records} == {"markdown", "table"}
                and bool(research.fetched) and set(research.fetched) == {SOURCE_URL})
            report.update(passed=bool(passed),
                          outcome="accepted" if passed else "acceptance_assertions_failed",
                          answer=answer, source=source, synthetic_fetches=len(research.fetched))
    except asyncio.CancelledError:
        report["outcome"] = "interrupted_no_repeat"
        raise
    except Exception:
        # Exceptions, settings and raw provider responses may contain credentials.
        report["outcome"] = "failed_no_repeat"
    finally:
        report["model_requests_admitted"] = model.attempts if model else 0
        report["completed_model_replies"] = model.completed_replies if model else 0
        report["provider_access_verified"] = bool(report["completed_model_replies"])
        report["budget"] = copy.deepcopy(checkpoint.saved["state"].get("budget", {})) if checkpoint else {}
        report["artifacts"] = publisher.records if publisher else []
        _write_json(output / "report.json", report)
    return report


def main(argv=None, *, root=None):
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--check", action="store_true")
    mode.add_argument("--execute", action="store_true")
    parser.add_argument("--approved-usd")
    args = parser.parse_args(argv)
    root = Path(root) if root is not None else Path(__file__).resolve().parents[4]
    try:
        if not args.execute:
            if args.approved_usd is not None:
                raise AcceptanceError("--approved-usd is only valid with --execute.")
            report = check(root)
            print(json.dumps(report, sort_keys=True))
            return 0 if report["eligible_for_separately_approved_attempt"] else 2
        report = asyncio.run(execute(root, args.approved_usd))
        print(json.dumps({key: report[key] for key in ("passed", "outcome", "model_requests_admitted", "budget", "scope")}, sort_keys=True))
        return 0 if report["passed"] else 1
    except AcceptanceError as exc:
        print(json.dumps({"passed": False, "error": str(exc)}))
        return 2
    except KeyboardInterrupt:
        print(json.dumps({"passed": False, "error": "Interrupted; the one-shot allowance remains consumed."}))
        return 130
    except Exception:
        print(json.dumps({"passed": False, "error": "Acceptance failed safely; do not repeat an admitted attempt."}))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
