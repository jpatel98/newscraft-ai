"""Local JIG-183 release-matrix orchestration.

This runner deliberately does not implement a NewsCraft durable-run server.
The NewsCraft route and repository path require an isolated test database, and
this command is not allowed to create or use one. Instead it runs the existing
Hermes worker/fixture and repository contract tests as supporting evidence,
then records the actual route, browser, persistence, and restart acceptance
gates as BLOCKED with their exact limits.

The result is a local-only, redacted release record. It never calls a remote
endpoint, uses production data, restarts a real service, or stores prompts,
answers, accounts, tenants, credentials, or URLs.
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Mapping, Sequence
from unittest.mock import patch


TICKET = "JIG-183"
VERIFIED_BASE_SHA = "a14a36ba767eb476e99e1134d934649e059b163c"
ALLOWED_BRANCHES = ("codex/jig-183-canary", "main")
SHA_RE = re.compile(r"^[0-9a-f]{40}$")
ANSI_RE = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")
LOCAL_GATE_NAMES = (
    "refresh_replay",
    "two_tabs",
    "duplicate_submission",
    "cancellation",
    "tenant_isolation",
    "fixture_process_restart_recovery",
    "persistence_after_reload",
)
LIVE_GATE_NAMES = (
    "real_browser_checks",
    "readiness_response",
    "service_pid_and_unit",
    "vercel_deployment_identity",
    "hermes_source_and_pinned_runtime",
    "database_migration_boundary",
    "authorized_live_production_smoke",
)
GATE_STATES = {"PASS", "FAIL", "BLOCKED", "SKIPPED"}


class CanaryFailure(RuntimeError):
    """A release-matrix assertion or integrity check failed."""


@dataclass(frozen=True)
class CheckoutIdentity:
    source_revision: str
    base_revision: str
    candidate_revision: str
    branch: str
    verified: bool = False


@dataclass(frozen=True)
class CommandEvidence:
    name: str
    command: tuple[str, ...]
    state: str
    exit_code: int | None
    passed: int
    failed: int
    skipped: int
    blocked: int
    output_sha256: str
    reason: str | None = None

    def as_dict(self) -> dict[str, Any]:
        value: dict[str, Any] = {
            "name": self.name,
            "command": list(self.command),
            "state": self.state,
            "exit_code": self.exit_code,
            "passed": self.passed,
            "failed": self.failed,
            "skipped": self.skipped,
            "blocked": self.blocked,
            "output_sha256": self.output_sha256,
        }
        if self.reason:
            value["reason"] = self.reason
        return value


@dataclass(frozen=True)
class MatrixResult:
    local_gates: list[dict[str, Any]]
    supporting_evidence: list[dict[str, Any]]
    forbidden_values: tuple[str, ...]


GitRunner = Callable[[Path, Sequence[str]], str]


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _fingerprint(value: Any) -> str:
    encoded = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def _safe_sha(value: str, label: str) -> str:
    if not SHA_RE.fullmatch(value):
        raise CanaryFailure(f"{label} must be a full Git SHA")
    return value


def _run_git(repo_root: Path, args: Sequence[str]) -> str:
    try:
        result = subprocess.run(
            ["git", *args],
            cwd=repo_root,
            capture_output=True,
            text=True,
            check=False,
        )
    except OSError as error:
        raise CanaryFailure("Git identity verification was unavailable") from error
    if result.returncode != 0:
        raise CanaryFailure("Git identity verification failed")
    return result.stdout.strip()


def verify_checkout_identity(
    repo_root: Path,
    *,
    source_revision: str,
    base_revision: str,
    candidate_revision: str,
    allowed_branches: Sequence[str] = ALLOWED_BRANCHES,
    git_runner: GitRunner | None = None,
) -> CheckoutIdentity:
    """Verify that every recorded revision describes this clean checkout."""
    run_git = git_runner or _run_git
    source = _safe_sha(source_revision, "source revision")
    base = _safe_sha(base_revision, "base revision")
    candidate = _safe_sha(candidate_revision, "candidate revision")
    branch = run_git(repo_root, ("branch", "--show-current"))
    if branch not in allowed_branches:
        raise CanaryFailure("checkout branch is not an allowed JIG-183 branch")
    if run_git(repo_root, ("status", "--porcelain", "--untracked-files=all")):
        raise CanaryFailure("checkout is not clean")
    actual_head = run_git(repo_root, ("rev-parse", "--verify", "HEAD"))
    if actual_head != candidate:
        raise CanaryFailure("candidate revision does not match checkout HEAD")
    if source != candidate:
        raise CanaryFailure("source revision does not match checkout HEAD")
    if base != VERIFIED_BASE_SHA:
        raise CanaryFailure("base revision is not the verified JIG-183 base")
    for revision, label in ((source, "source"), (base, "base"), (candidate, "candidate")):
        run_git(repo_root, ("cat-file", "-e", f"{revision}^{{commit}}"))
    run_git(repo_root, ("merge-base", "--is-ancestor", base, candidate))
    return CheckoutIdentity(source, base, candidate, branch, verified=True)


def _safe_environment(extra: Mapping[str, str] | None = None) -> dict[str, str]:
    """Pass only benign process settings to local child checks."""
    names = (
        "PATH",
        "HOME",
        "TMPDIR",
        "LANG",
        "LC_ALL",
        "LC_CTYPE",
        "CI",
        "TERM",
        "XDG_CACHE_HOME",
        "UV_CACHE_DIR",
        "PNPM_HOME",
    )
    environment = {name: os.environ[name] for name in names if os.environ.get(name)}
    environment["PYTHONUNBUFFERED"] = "1"
    if extra:
        environment.update(extra)
    return environment


def _count(output: str, pattern: str) -> int:
    matches = re.findall(pattern, output, re.IGNORECASE)
    return int(matches[-1]) if matches else 0


def _test_counts(output: str, command: Sequence[str]) -> tuple[int, int, int]:
    output = ANSI_RE.sub("", output)
    joined = " ".join(command)
    if "unittest" in joined:
        total = _count(output, r"Ran\s+(\d+)\s+tests?")
        skipped = _count(output, r"skipped=(\d+)")
        failed = _count(output, r"failures=(\d+)")
        failed += _count(output, r"errors=(\d+)")
        return max(total - skipped - failed, 0), failed, skipped
    passed = _count(output, r"Tests\s+(\d+)\s+passed")
    failed = _count(output, r"Tests\s+(\d+)\s+failed")
    skipped = _count(output, r"\b(\d+)\s+skipped\b")
    return passed, failed, skipped


def _blocked_command(name: str, command: Sequence[str], reason: str) -> CommandEvidence:
    return CommandEvidence(
        name=name,
        command=tuple(command),
        state="BLOCKED",
        exit_code=None,
        passed=0,
        failed=0,
        skipped=0,
        blocked=1,
        output_sha256=_fingerprint({"name": name, "reason": reason}),
        reason=reason,
    )


def _run_command(
    *,
    name: str,
    command: Sequence[str],
    cwd: Path,
    environment: Mapping[str, str],
    timeout: float = 180,
) -> CommandEvidence:
    try:
        result = subprocess.run(
            list(command),
            cwd=cwd,
            env=dict(environment),
            capture_output=True,
            text=True,
            check=False,
            timeout=timeout,
        )
    except FileNotFoundError:
        return _blocked_command(name, command, "required local test command is unavailable")
    except subprocess.TimeoutExpired as error:
        output = f"{error.stdout or ''}{error.stderr or ''}"
        return CommandEvidence(
            name=name,
            command=tuple(command),
            state="FAIL",
            exit_code=None,
            passed=0,
            failed=1,
            skipped=0,
            blocked=0,
            output_sha256=hashlib.sha256(output.encode("utf-8", errors="replace")).hexdigest(),
            reason="local test command timed out",
        )
    output = f"{result.stdout}{result.stderr}"
    passed, failed, skipped = _test_counts(output, command)
    state = "PASS" if result.returncode == 0 else "FAIL"
    reason: str | None = None
    if state == "PASS" and passed + failed + skipped == 0:
        state = "BLOCKED"
        reason = "local test command returned no parseable test count"
    return CommandEvidence(
        name=name,
        command=tuple(command),
        state=state,
        exit_code=result.returncode,
        passed=passed,
        failed=failed,
        skipped=skipped,
        blocked=1 if state == "BLOCKED" else 0,
        output_sha256=hashlib.sha256(output.encode("utf-8", errors="replace")).hexdigest(),
        reason=reason,
    )


def _fixture_evidence(repo_root: Path) -> tuple[dict[str, Any], tuple[str, ...]]:
    """Exercise the existing deterministic FixtureWorker without a fake route."""
    fixture_path = repo_root / "services" / "hermes-chat" / "tests" / "durable_fixture_server.py"
    source_path = repo_root / "services" / "hermes-chat" / "src"
    if not fixture_path.is_file():
        raise CanaryFailure("existing durable fixture is missing")
    suffix = uuid.uuid4().hex
    run_id = f"fixture-{suffix}"
    account_id = f"fixture-account-{suffix}"
    tenant_key = f"fixture-tenant-{suffix}"
    trace_id = f"fixture-trace-{suffix}"
    with tempfile.TemporaryDirectory(prefix="jig183-fixture-") as temporary:
        root = Path(temporary)
        home = root / "hermes-home"
        workspace = root / "workspace"
        stats_path = root / "stats.json"
        safe_env = _safe_environment(
            {
                "PYTHONPATH": str(source_path),
                "FIXTURE_NEWSCRAFT_RUN_API_URL": "http://127.0.0.1:1/unused",
                "FIXTURE_NEWSCRAFT_RUN_API_TOKEN": f"fixture-run-{suffix}",
                "FIXTURE_SERVICE_TOKEN": f"fixture-session-{suffix}",
                "FIXTURE_HERMES_HOME": str(home),
                "FIXTURE_HERMES_WORKSPACE": str(workspace),
                "FIXTURE_STATS_PATH": str(stats_path),
                "FIXTURE_PORT": "1",
                "FIXTURE_DELAY_SCALE": "1",
            }
        )
        module_name = f"jig183_durable_fixture_{suffix}"
        old_sys_path = list(sys.path)
        sys.path.insert(0, str(source_path))
        try:
            with patch.dict(os.environ, safe_env, clear=True):
                spec = importlib.util.spec_from_file_location(module_name, fixture_path)
                if spec is None or spec.loader is None:
                    raise CanaryFailure("existing durable fixture could not be loaded")
                module = importlib.util.module_from_spec(spec)
                sys.modules[module_name] = module
                spec.loader.exec_module(module)
                settings = module.FixtureSettings(
                    run_api_url="http://127.0.0.1:1/unused",
                    run_api_token=f"fixture-run-{suffix}",
                    session_token=f"fixture-session-{suffix}",
                    hermes_home=home,
                    workspace=workspace,
                )
                isolation = module.TenantIsolation(home, workspace)
                worker = module.FixtureWorker(settings, isolation, stats_path)
                worker.delay_scale = 0.001

                async def fake_newscraft(
                    _worker: Any,
                    _method: str,
                    _path: str,
                    _body: dict[str, Any] | None = None,
                ) -> dict[str, Any]:
                    return {
                        "terminal": False,
                        "lease_owner": "fixture-owner",
                        "lease_token": "fixture-lease",
                        "worker_cursor": 0,
                    }

                payload = {
                    "run_id": run_id,
                    "account_id": account_id,
                    "tenant_key": tenant_key,
                    "trace_id": trace_id,
                    "input": {
                        "runId": run_id,
                        "threadId": f"fixture-thread-{suffix}",
                        "trace_id": trace_id,
                        "messages": [],
                    },
                    "seeded_citations": [],
                }

                async def exercise() -> dict[str, Any]:
                    first = await worker.start(payload)
                    job = worker.jobs.get(run_id)
                    if not job or not job.task:
                        raise CanaryFailure("existing fixture did not create a worker task")
                    await job.task
                    duplicate = await worker.start(payload)
                    stats = await worker._read_stats()
                    await worker.close()
                    return {"first": first, "duplicate": duplicate, "stats": stats}

                with patch.object(module.DurableRunWorker, "_newscraft", new=fake_newscraft):
                    result = asyncio.run(exercise())
        finally:
            sys.path[:] = old_sys_path
            sys.modules.pop(module_name, None)

    stats = result["stats"]
    events = stats.get("events") if isinstance(stats.get("events"), list) else []
    callbacks = stats.get("callbacks") if isinstance(stats.get("callbacks"), list) else []
    event_types = [item.get("event_type") for item in events if isinstance(item, dict)]
    first = result["first"]
    duplicate = result["duplicate"]
    logical_starts = int((stats.get("logical_starts") or {}).get(run_id) or 0)
    invocations = int((stats.get("run_invocations") or {}).get(run_id) or 0)
    if first.get("accepted") is not True or first.get("duplicate") is not False:
        raise CanaryFailure("existing fixture rejected its deterministic first start")
    if duplicate.get("duplicate") is not True or logical_starts != 1 or invocations != 1:
        raise CanaryFailure("existing fixture did not preserve one logical invocation")
    if not events or not callbacks:
        raise CanaryFailure("existing fixture produced no bounded event or callback evidence")
    evidence = {
        "name": "existing_durable_fixture_worker",
        "state": "PASS",
        "scope": "deterministic-hermes-fixture",
        "event_count": len(events),
        "callback_count": len(callbacks),
        "source_event_count": event_types.count("agent.source.read"),
        "citation_event_count": event_types.count("agent.citations"),
        "answer_delta_event_count": event_types.count("response.output_text.delta"),
        "logical_starts": logical_starts,
        "run_invocations": invocations,
        "stats_sha256": _fingerprint(stats),
    }
    return evidence, (run_id, account_id, tenant_key, trace_id)


def _repository_supporting_evidence(repo_root: Path) -> tuple[list[dict[str, Any]], tuple[str, ...]]:
    evidence: list[dict[str, Any]] = []
    forbidden: set[str] = set()
    try:
        fixture, fixture_values = _fixture_evidence(repo_root)
        evidence.append(fixture)
        forbidden.update(fixture_values)
    except Exception as error:
        evidence.append(
            {
                "name": "existing_durable_fixture_worker",
                "state": "BLOCKED",
                "scope": "deterministic-hermes-fixture",
                "reason": (
                    "existing deterministic Hermes fixture evidence was unavailable; "
                    f"loader failure type: {type(error).__name__}"
                ),
            }
        )

    python_env = _safe_environment(
        {
            "PYTHONPATH": os.pathsep.join(
                [
                    str(repo_root / "services" / "hermes-chat" / "src"),
                    str(repo_root / "services" / "hermes-chat" / "tests"),
                ]
            )
        }
    )
    for name, target in (
        ("existing_hermes_worker_tests", "test_service.DurableHermesWorkerTests"),
        ("existing_hermes_isolation_tests", "test_isolation.HermesIsolationTests"),
    ):
        evidence.append(
            _run_command(
                name=name,
                command=(sys.executable, "-m", "unittest", target),
                cwd=repo_root / "services" / "hermes-chat" / "tests",
                environment=python_env,
            ).as_dict()
        )

    pnpm = shutil.which("pnpm")
    vitest_command = (
        "pnpm",
        "exec",
        "vitest",
        "run",
        "src/routes/c/[id]/chat-failure-retry.test.ts",
        "src/routes/c/[id]/page-server.test.ts",
        "src/lib/client/stream.test.ts",
        "src/routes/api/internal/hermes/runs/runs-routes.test.ts",
        "src/lib/server/db/hermes-runs.integration.test.ts",
        "src/lib/server/agent/transport.test.ts",
    )
    if pnpm is None:
        evidence.append(_blocked_command("existing_newscraft_route_client_tests", vitest_command, "pnpm is unavailable"))
    else:
        evidence.append(
            _run_command(
                name="existing_newscraft_route_client_tests",
                command=(pnpm, *vitest_command[1:]),
                cwd=repo_root,
                environment=_safe_environment(),
            ).as_dict()
        )
    return evidence, tuple(sorted(forbidden))


_LOCAL_GATE_REASONS = {
    "refresh_replay": (
        "BLOCKED: the actual SvelteKit refresh/replay path requires the NewsCraft durable route and persistent repository; "
        "this local-only turn cannot provision or use an isolated database."
    ),
    "two_tabs": (
        "BLOCKED: real browser contexts against the actual authenticated NewsCraft route were not run; "
        "a protocol analogue would be misleading."
    ),
    "duplicate_submission": (
        "BLOCKED: the actual idempotent durable-turn repository path requires persistent NewsCraft state; "
        "existing contract tests are supporting evidence only."
    ),
    "cancellation": (
        "BLOCKED: the actual NewsCraft cancellation and late-callback repository path was not exercised; "
        "existing Hermes worker tests are supporting evidence only."
    ),
    "tenant_isolation": (
        "BLOCKED: account A/B behavior through the actual NewsCraft repository and browser boundary was not exercised; "
        "Hermes isolation and mocked route tests do not prove the end-to-end boundary."
    ),
    "fixture_process_restart_recovery": (
        "BLOCKED: same-run recovery with persisted NewsCraft state and a service process boundary was not exercised; "
        "the existing fixture was run in-process and no real service was restarted."
    ),
    "persistence_after_reload": (
        "BLOCKED: final answer, citation, and source reload through the actual browser and persistent NewsCraft route "
        "was not exercised without a database."
    ),
}


def _gate(name: str, state: str, scope: str, details: Mapping[str, Any]) -> dict[str, Any]:
    if state not in GATE_STATES:
        raise CanaryFailure("invalid release gate state")
    detail_copy = dict(details)
    return {
        "gate": name,
        "state": state,
        "scope": scope,
        "evidence_id": f"jig183-{name}-{_fingerprint(detail_copy)[:16]}",
        "details": detail_copy,
    }


def _blocked_local_gates(supporting_evidence: Sequence[Mapping[str, Any]]) -> list[dict[str, Any]]:
    names = [str(item.get("name")) for item in supporting_evidence]
    return [
        _gate(
            name,
            "BLOCKED",
            "local-deterministic",
            {
                "reason": _LOCAL_GATE_REASONS[name],
                "actual_path_exercised": False,
                "protocol_only": True,
                "supporting_evidence": names,
            },
        )
        for name in LOCAL_GATE_NAMES
    ]


def required_live_gates() -> list[dict[str, Any]]:
    return [
        _gate(
            name,
            "BLOCKED",
            "live-production",
            {"reason": "not authorized by the local-only JIG-183 repair"},
        )
        for name in LIVE_GATE_NAMES
    ]


def _gate_integrity(gates: Sequence[Mapping[str, Any]], required: Sequence[str]) -> tuple[bool, str]:
    expected = set(required)
    seen: dict[str, int] = {}
    unknown: list[str] = []
    for gate in gates:
        name = str(gate.get("gate") or "")
        seen[name] = seen.get(name, 0) + 1
        if name not in expected:
            unknown.append(name)
    duplicate = sorted(name for name, count in seen.items() if count > 1)
    missing = sorted(expected - set(seen))
    if unknown:
        return False, f"unknown required-gate names: {','.join(unknown)}"
    if duplicate:
        return False, f"duplicate required-gate names: {','.join(duplicate)}"
    if missing:
        return False, f"missing required-gate names: {','.join(missing)}"
    return True, "all required-gate names are present exactly once"


def local_exit_code(gates: Sequence[Mapping[str, Any]]) -> int:
    """Return nonzero for any missing, duplicate, unknown, or non-PASS local gate."""
    valid, _reason = _gate_integrity(gates, LOCAL_GATE_NAMES)
    if not valid or any(gate.get("state") != "PASS" for gate in gates):
        return 1
    return 0


def release_decision(gates: Sequence[Mapping[str, Any]]) -> str:
    required = (*LOCAL_GATE_NAMES, *LIVE_GATE_NAMES)
    valid, _reason = _gate_integrity(gates, required)
    return "RELEASE" if valid and all(gate.get("state") == "PASS" for gate in gates) else "BLOCK RELEASE"


_FORBIDDEN_KEY_PARTS = (
    "token",
    "tenant_key",
    "account_id",
    "prompt",
    "answer_body",
    "url",
    "secret",
)


def assert_release_record_redacted(record: Mapping[str, Any], forbidden_values: Sequence[str] = ()) -> None:
    raw = json.dumps(record, sort_keys=True, ensure_ascii=False)
    if re.search(r"(?:https?|postgres(?:ql)?|file)://", raw, re.IGNORECASE):
        raise CanaryFailure("release record contains a URL")
    for value in forbidden_values:
        if value and value in raw:
            raise CanaryFailure("release record contains a forbidden dynamic value")

    def visit(value: Any) -> None:
        if isinstance(value, dict):
            for key, child in value.items():
                lowered = str(key).lower()
                if any(part in lowered for part in _FORBIDDEN_KEY_PARTS):
                    raise CanaryFailure("release record contains a forbidden field")
                visit(child)
        elif isinstance(value, list):
            for child in value:
                visit(child)

    visit(record)


def _identity_for_record(identity: CheckoutIdentity) -> None:
    if not identity.verified:
        raise CanaryFailure("release record requires a verified checkout identity")
    _safe_sha(identity.source_revision, "source revision")
    _safe_sha(identity.base_revision, "base revision")
    _safe_sha(identity.candidate_revision, "candidate revision")
    if identity.base_revision != VERIFIED_BASE_SHA:
        raise CanaryFailure("release record base is not the verified JIG-183 base")
    if identity.source_revision != identity.candidate_revision:
        raise CanaryFailure("release record source does not match candidate")
    if identity.branch not in ALLOWED_BRANCHES:
        raise CanaryFailure("release record branch is not an allowed JIG-183 branch")


def build_release_record(
    *,
    repo_root: Path,
    identity: CheckoutIdentity,
    started_at: str,
    completed_at: str,
    local_gates: Sequence[Mapping[str, Any]],
    supporting_evidence: Sequence[Mapping[str, Any]],
    _git_runner: GitRunner | None = None,
) -> dict[str, Any]:
    if identity.branch not in ALLOWED_BRANCHES:
        raise CanaryFailure("release record branch is not an allowed JIG-183 branch")
    verified_identity = verify_checkout_identity(
        repo_root,
        source_revision=identity.source_revision,
        base_revision=identity.base_revision,
        candidate_revision=identity.candidate_revision,
        allowed_branches=ALLOWED_BRANCHES,
        git_runner=_git_runner,
    )
    _identity_for_record(verified_identity)
    gates = [dict(gate) for gate in local_gates] + required_live_gates()
    counts = {
        scope: {
            state: sum(1 for gate in gates if gate.get("scope") == scope and gate.get("state") == state)
            for state in ("PASS", "FAIL", "BLOCKED", "SKIPPED")
        }
        for scope in ("local-deterministic", "live-production")
    }
    local_integrity, local_reason = _gate_integrity(local_gates, LOCAL_GATE_NAMES)
    full_integrity, full_reason = _gate_integrity(gates, (*LOCAL_GATE_NAMES, *LIVE_GATE_NAMES))
    return {
        "schema_version": 2,
        "ticket": TICKET,
        "verification": {
            "mode": "local-deterministic-canary",
            "started_at": started_at,
            "completed_at": completed_at,
            "branch": verified_identity.branch,
            "clean_checkout": True,
            "ancestry_verified": True,
            "loopback_only": True,
            "production_data_used": False,
            "actual_newscraft_path_exercised": False,
        },
        "candidate": {
            "source_revision": verified_identity.source_revision,
            "base_revision": verified_identity.base_revision,
            "candidate_revision": verified_identity.candidate_revision,
        },
        "release_decision": release_decision(gates),
        "local_exit_code": local_exit_code(local_gates),
        "matrix_integrity": {
            "local_state": "PASS" if local_integrity else "FAIL",
            "local_reason": local_reason,
            "full_state": "PASS" if full_integrity else "FAIL",
            "full_reason": full_reason,
        },
        "gate_counts": counts,
        "gates": gates,
        "supporting_evidence": [dict(item) for item in supporting_evidence],
        "rollback": {
            "state": "BLOCKED",
            "reason": "no production release or rollback authorization in local-only scope",
        },
        "redaction": {
            "dynamic_identifiers": "sha256 fingerprints only",
            "content": "answer text, source references, accounts, tenants, prompts, and credentials omitted",
        },
        "limits": [
            "Actual NewsCraft route and persistent repository gates remain BLOCKED because no isolated database was provisioned or used.",
            "Browser and two-tab gates remain BLOCKED because protocol-only analogues are not release evidence.",
            "Fixture evidence uses the existing deterministic Hermes worker in-process; no real service restart was performed.",
            "Live readiness, deployment, runtime, database, and production smoke gates remain BLOCKED.",
        ],
    }


def _git_revision(repo_root: Path) -> str:
    return _run_git(repo_root, ("rev-parse", "--verify", "HEAD"))


def _run_local_matrix(repo_root: Path) -> MatrixResult:
    supporting, forbidden = _repository_supporting_evidence(repo_root)
    return MatrixResult(
        local_gates=_blocked_local_gates(supporting),
        supporting_evidence=supporting,
        forbidden_values=forbidden,
    )


def _default_output(repo_root: Path) -> Path:
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    return repo_root / ".tmp" / "jig-183" / f"release-result-{stamp}-{uuid.uuid4().hex[:8]}.json"


def _parse_args(argv: list[str] | None, repo_root: Path) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run the local JIG-183 release matrix")
    parser.add_argument("--base-sha", default=VERIFIED_BASE_SHA)
    parser.add_argument("--candidate-sha", default=None)
    parser.add_argument("--source-sha", default=None)
    parser.add_argument("--output", type=Path, default=_default_output(repo_root))
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    repo_root = Path(__file__).resolve().parents[3]
    args = _parse_args(argv, repo_root)
    started_at = _now()
    try:
        candidate = args.candidate_sha or _git_revision(repo_root)
        source = args.source_sha or candidate
        identity = verify_checkout_identity(
            repo_root,
            source_revision=source,
            base_revision=args.base_sha,
            candidate_revision=candidate,
        )
    except CanaryFailure as error:
        print(f"JIG-183_LOCAL_CANARY identity=REJECTED reason={str(error)[:240]}")
        return 2

    try:
        matrix = _run_local_matrix(repo_root)
        record = build_release_record(
            repo_root=repo_root,
            identity=identity,
            started_at=started_at,
            completed_at=_now(),
            local_gates=matrix.local_gates,
            supporting_evidence=matrix.supporting_evidence,
        )
        assert_release_record_redacted(record, matrix.forbidden_values)
        output = args.output if args.output.is_absolute() else repo_root / args.output
        output = output.resolve()
        if output.exists():
            raise CanaryFailure("release output already exists; choose a new path")
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps(record, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    except (CanaryFailure, OSError) as error:
        print(f"JIG-183_LOCAL_CANARY record=REJECTED reason={str(error)[:240]}")
        return 2

    local_counts = record["gate_counts"]["local-deterministic"]
    print(
        f"JIG-183_LOCAL_CANARY release_decision={record['release_decision']} "
        f"local_pass={local_counts['PASS']} local_fail={local_counts['FAIL']} "
        f"local_blocked={local_counts['BLOCKED']} local_exit={record['local_exit_code']} output={output}"
    )
    return int(record["local_exit_code"])


if __name__ == "__main__":
    raise SystemExit(main())
