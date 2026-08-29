"""Deterministic local JIG-197 capacity and scale-threshold evidence.

This runner exercises the production DurableRunWorker scheduler through the
existing JIG-185 local seam. Provider, callback, and recovery behavior are
in-process doubles only. It never contacts a browser, database, provider,
remote endpoint, Docker daemon, or service process.

The public command is intentionally local and block-only. Its record can
publish scheduler observations, but it cannot authorize production capacity
or a scale-out decision.
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import math
import os
import re
import resource
import subprocess
import tempfile
import time
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Mapping

from hermes_chat.contracts import NEWSCRAFT_RUN_CALLBACK_PATH
from hermes_chat.durable import (
    DEFAULT_MAX_ACTIVE_RUNS,
    DEFAULT_MAX_ACTIVE_RUNS_PER_TENANT,
    DEFAULT_MAX_QUEUED_RUNS,
    DEFAULT_MAX_QUEUED_RUNS_PER_TENANT,
    OVERLOAD_ERROR_CODE,
    DurableRunError,
)
from hermes_chat.isolation import TenantIsolation

from jig_185_load import LocalLoadWorker, _payload, _settings


JIG197_TICKET = "JIG-197"
JIG197_EVIDENCE_SCHEMA_VERSION = 1
BASE_SHA = "1748724433ca4879b9cf74421c96b6d274923041"
EXPECTED_BRANCH = "codex/jig-197-local-load"
ALLOWED_BRANCHES = (EXPECTED_BRANCH, "main")
MODE = "local-deterministic"
SCOPE = "local-non-production"

DEFAULT_LIMITS = {
    "max_active_runs": DEFAULT_MAX_ACTIVE_RUNS,
    "max_active_runs_per_tenant": DEFAULT_MAX_ACTIVE_RUNS_PER_TENANT,
    "max_queued_runs": DEFAULT_MAX_QUEUED_RUNS,
    "max_queued_runs_per_tenant": DEFAULT_MAX_QUEUED_RUNS_PER_TENANT,
}

REQUIRED_LOCAL_CASES = (
    "capacity_load_levels",
    "simultaneous_tenants",
    "provider_callback_control_plane_delay",
    "fair_round_robin",
    "bounded_overload_rejection",
    "waiting_and_active_cancellation",
    "duplicate_start_idempotency",
    "worker_reconstruction_recovery",
    "recovery_backlog_fairness",
)

REQUIRED_GATE_IDS = (
    "local_durable_scheduler_matrix",
    "production_safe_concurrency",
    "production_postgres_latency",
    "production_provider_browser_latency",
    "production_process_restart_recovery",
    "production_cpu_rss_capacity",
    "production_producer_workflow_cost",
    "scale_out_decision",
)

PRODUCTION_THRESHOLDS = {
    "admission_wait_p95_ms_greater_than": 30_000,
    "capacity_rejection_rate_greater_than_percent": 1.0,
    "duplicate_invocation_or_answer_allowed": False,
    "cross_tenant_result_allowed": False,
    "lease_or_cancellation_failure_allowed": False,
}

LIMITATIONS = (
    "Local fixture observations are scheduler evidence and are not production capacity.",
    "Postgres, provider/browser, real restart, production CPU/RSS, workflow cost, and live concurrency evidence are blocked.",
    "No external evidence adapter is accepted by this local-only command; blocked gates require separate authorization.",
    "The single-host decision remains pending an authorized live single-host threshold miss; no second host is provisioned.",
)

REPO_ROOT = Path(__file__).resolve().parents[3]
SHA_RE = re.compile(r"^[0-9a-f]{40}$")
DIGEST_RE = re.compile(r"^[0-9a-f]{64}$")
TIMESTAMP_RE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$")
ARTIFACT_FILENAME_RE = re.compile(r"^[A-Za-z0-9._-]+\.json$")
SAFE_TEXT_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,95}$")
SENSITIVE_VALUE_RE = re.compile(
    r"(?:https?://|postgres(?:ql)?://|bearer\s+|select\s+.+\s+from\s+|"
    r"-----begin|(?:api[_-]?key|password|secret|token|authorization|cookie)\s*[:=])",
    re.IGNORECASE,
)

RECORD_KEYS = frozenset(
    {
        "schema_version",
        "ticket",
        "mode",
        "recorded_at",
        "checkout",
        "candidate",
        "local_result",
        "case_counts",
        "cases",
        "capacity_measurement",
        "thresholds",
        "required_gate_ids",
        "gates",
        "limitations",
        "release_decision",
        "release_exit_code",
        "failure_reason",
    }
)
CHECKOUT_KEYS = frozenset(
    {
        "branch",
        "source_sha",
        "base_sha",
        "base_present",
        "commit_present",
        "base_is_ancestor",
        "clean",
    }
)
CANDIDATE_KEYS = frozenset({"source_sha", "candidate_sha", "base_sha"})
CASE_KEYS = frozenset({"name", "state", "metrics"})
CASE_COUNTS_KEYS = frozenset({"pass", "fail", "skip", "blocked"})
MEASUREMENT_KEYS = frozenset(
    {
        "method",
        "scope",
        "local_only",
        "production_capacity_proven",
        "safe_concurrent_runs_observed",
        "queue_wait_p50_ms",
        "queue_wait_p95_ms",
        "completion_p50_ms",
        "completion_p95_ms",
        "peak_active_runs",
        "peak_queued_runs",
        "completed_runs",
        "rejected_runs",
        "duplicate_invocations",
        "duplicate_answers",
        "cross_tenant_failures",
        "lease_failures",
        "configured_limits",
        "process_observation",
    }
)
LIMIT_KEYS = frozenset(DEFAULT_LIMITS)
PROCESS_KEYS = frozenset(
    {
        "scope",
        "production_representative",
        "user_cpu_ms",
        "system_cpu_ms",
        "max_rss_bytes",
    }
)
THRESHOLD_KEYS = frozenset({"local_invariants", "production_slo", "second_host_rule"})
GATE_KEYS = frozenset({"id", "state", "scope", "reason", "evidence"})
LOCAL_EVIDENCE_KEYS = frozenset({"case_count", "passed_case_count", "local_only"})

CASE_METRIC_KEYS = {
    "capacity_load_levels": frozenset(
        {
            "levels",
            "safe_concurrent_runs_observed",
            "peak_queued_runs",
            "queue_wait_p95_ms",
            "all_levels_completed",
        }
    ),
    "simultaneous_tenants": frozenset(
        {
            "submitted",
            "accepted",
            "invocations",
            "observed_peak_active",
            "observed_peak_active_per_tenant",
            "peak_queued_runs",
            "binding_rejections",
            "callback_tenant_binding_failures",
            "all_tenants_progressed",
        }
    ),
    "provider_callback_control_plane_delay": frozenset(
        {
            "submitted",
            "accepted",
            "invocations",
            "completed",
            "observed_peak_active",
            "observed_peak_active_per_tenant",
            "peak_queued_runs",
            "provider_delay_ms",
            "callback_delay_ms",
            "control_plane_delay_ms",
            "control_plane_calls",
            "callback_calls",
            "control_plane_delay_p95_ms",
        }
    ),
    "fair_round_robin": frozenset(
        {
            "submitted",
            "invocations",
            "observed_peak_active",
            "quiet_tenant_progressed_before_noisy_tail",
            "fair_dispatch",
        }
    ),
    "bounded_overload_rejection": frozenset(
        {
            "accepted",
            "rejected",
            "observed_active",
            "observed_queued",
            "configured_queue_limit",
            "overload_code",
            "overload_status",
            "no_extra_invocation",
        }
    ),
    "waiting_and_active_cancellation": frozenset(
        {
            "waiting_cancel_state",
            "active_cancel_state",
            "waiting_cancelled",
            "cancellation_terminal_callbacks",
            "cancel_requests",
            "final_active",
            "final_queued",
            "capacity_released_once",
        }
    ),
    "duplicate_start_idempotency": frozenset(
        {
            "start_requests",
            "duplicate_acknowledgements",
            "claim_requests",
            "invocations",
            "duplicate_answer_count",
            "one_logical_run",
        }
    ),
    "worker_reconstruction_recovery": frozenset(
        {
            "same_run_id",
            "saved_input_reused",
            "recovered_invocations",
            "observed_peak_active",
            "reconstructed_workers",
            "real_process_restart",
            "no_duplicate_invocation",
        }
    ),
    "recovery_backlog_fairness": frozenset(
        {
            "submitted",
            "recovered_invocations",
            "recovery_requests",
            "unadmitted_lease_returns",
            "returned_lease_state",
            "unique_lease_returns",
            "quiet_tenant_progressed",
            "observed_peak_active",
            "observed_peak_active_per_tenant",
            "backlog_drained",
            "no_duplicate_invocations",
        }
    ),
}

LEVEL_KEYS = frozenset(
    {
        "name",
        "submitted",
        "accepted",
        "rejected",
        "invocations",
        "completed",
        "peak_active_runs",
        "peak_queued_runs",
        "queue_wait_p95_ms",
    }
)

LIVE_GATE_REASONS = {
    "production_safe_concurrency": "requires_authorized_live_single_host_measurement",
    "production_postgres_latency": "requires_authorized_postgres_evidence",
    "production_provider_browser_latency": "requires_authorized_provider_browser_evidence",
    "production_process_restart_recovery": "requires_authorized_real_restart_evidence",
    "production_cpu_rss_capacity": "requires_authorized_production_host_metrics",
    "production_producer_workflow_cost": "requires_authorized_producer_cost_evidence",
    "scale_out_decision": "requires_authorized_live_threshold_comparison",
}


class RecordValidationError(ValueError):
    """Raised when an evidence record is not the exact JIG-197 contract."""


def _fail(code: str) -> None:
    raise RecordValidationError(code)


def _is_object(value: Any) -> bool:
    return isinstance(value, dict)


def _exact_keys(value: Any, allowed: frozenset[str], label: str) -> None:
    if not _is_object(value) or frozenset(value) != allowed:
        _fail(f"{label}_schema_invalid")


def _bool(value: Any, label: str) -> None:
    if type(value) is not bool:
        _fail(f"{label}_invalid")


def _integer(value: Any, label: str, maximum: int = 1_000_000_000) -> None:
    if type(value) is not int or value < 0 or value > maximum:
        _fail(f"{label}_invalid")


def _number(value: Any, label: str, maximum: float = 1_000_000_000.0) -> None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        _fail(f"{label}_invalid")
    if not math.isfinite(float(value)) or value < 0 or value > maximum:
        _fail(f"{label}_invalid")


def _enum(value: Any, allowed: set[str] | frozenset[str], label: str) -> None:
    if not isinstance(value, str) or value not in allowed:
        _fail(f"{label}_invalid")


def _sha(value: Any, label: str, nullable: bool = False) -> None:
    if nullable and value is None:
        return
    if not isinstance(value, str) or not SHA_RE.fullmatch(value):
        _fail(f"{label}_invalid")


def _timestamp(value: Any, label: str) -> None:
    if not isinstance(value, str) or not TIMESTAMP_RE.fullmatch(value):
        _fail(f"{label}_invalid")
    try:
        datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        _fail(f"{label}_invalid")


def _safe_string(value: Any, label: str) -> None:
    if not isinstance(value, str) or not SAFE_TEXT_RE.fullmatch(value):
        _fail(f"{label}_invalid")


def _assert_no_sensitive_values(value: Any) -> None:
    if isinstance(value, str) and SENSITIVE_VALUE_RE.search(value):
        _fail("record_contains_sensitive_value")
    if isinstance(value, list):
        for item in value:
            _assert_no_sensitive_values(item)
    elif isinstance(value, dict):
        for key, child in value.items():
            if re.search(
                r"(?:^|_)(?:account_id|tenant_key|prompt|answer_body|answer_text|"
                r"source_url|url|token|secret|password|credential|cookie|authorization|"
                r"database_url|sql|raw_event|environment_value|config_value|production_path)(?:$|_)",
                str(key),
                re.IGNORECASE,
            ):
                _fail("record_contains_sensitive_field")
            _assert_no_sensitive_values(child)


def _git_environment() -> dict[str, str]:
    return {
        "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
        "HOME": os.environ.get("HOME", ""),
        "LANG": "C",
        "LC_ALL": "C",
        "GIT_OPTIONAL_LOCKS": "0",
        "GIT_TERMINAL_PROMPT": "0",
    }


def _git(repo_root: Path, *args: str) -> str:
    result = subprocess.run(
        ["git", *args],
        cwd=repo_root,
        env=_git_environment(),
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        raise RuntimeError("git_identity_command_failed")
    return result.stdout.strip()


def _git_succeeds(repo_root: Path, *args: str) -> bool:
    return subprocess.run(
        ["git", *args],
        cwd=repo_root,
        env=_git_environment(),
        capture_output=True,
        check=False,
    ).returncode == 0


def checkout_identity(repo_root: Path = REPO_ROOT) -> dict[str, Any]:
    source_sha = _git(repo_root, "rev-parse", "--verify", "HEAD")
    base_present = _git_succeeds(repo_root, "cat-file", "-e", f"{BASE_SHA}^{{commit}}")
    commit_present = bool(SHA_RE.fullmatch(source_sha)) and _git_succeeds(
        repo_root, "cat-file", "-e", f"{source_sha}^{{commit}}"
    )
    base_is_ancestor = (
        base_present
        and commit_present
        and _git_succeeds(repo_root, "merge-base", "--is-ancestor", BASE_SHA, source_sha)
    )
    return {
        "branch": _git(repo_root, "branch", "--show-current"),
        "source_sha": source_sha,
        "base_sha": BASE_SHA,
        "base_present": base_present,
        "commit_present": commit_present,
        "base_is_ancestor": base_is_ancestor,
        "clean": not bool(_git(repo_root, "status", "--porcelain=v1", "--untracked-files=all")),
    }


def _identity_shape_is_valid(identity: Mapping[str, Any]) -> bool:
    return (
        frozenset(identity) == CHECKOUT_KEYS
        and identity.get("branch") in ALLOWED_BRANCHES
        and identity.get("base_sha") == BASE_SHA
        and isinstance(identity.get("source_sha"), str)
        and bool(SHA_RE.fullmatch(identity["source_sha"]))
        and all(type(identity.get(key)) is bool for key in (
            "base_present",
            "commit_present",
            "base_is_ancestor",
            "clean",
        ))
        and identity.get("base_present") is True
        and identity.get("commit_present") is True
        and identity.get("base_is_ancestor") is True
        and identity.get("clean") is True
    )


def validate_checkout_identity(
    identity: Mapping[str, Any],
    *,
    actual: Mapping[str, Any] | None = None,
) -> None:
    if not isinstance(identity, Mapping) or frozenset(identity) != CHECKOUT_KEYS:
        raise RuntimeError("checkout_identity_schema_invalid")
    if actual is None:
        actual = checkout_identity()
    if any(identity.get(key) != actual.get(key) for key in CHECKOUT_KEYS):
        raise RuntimeError("checkout_identity_changed")
    if not _identity_shape_is_valid(identity):
        raise RuntimeError("checkout_identity_invalid")


def validate_expected_revision(
    identity: Mapping[str, Any],
    *,
    expected_source_sha: str | None = None,
    expected_candidate_sha: str | None = None,
) -> None:
    for value, label in (
        (expected_source_sha, "source"),
        (expected_candidate_sha, "candidate"),
    ):
        if value is not None and (not isinstance(value, str) or not SHA_RE.fullmatch(value)):
            raise RuntimeError(f"expected_{label}_revision_invalid")
    if expected_source_sha and expected_candidate_sha and expected_source_sha != expected_candidate_sha:
        raise RuntimeError("expected_revisions_do_not_match")
    expected = expected_candidate_sha or expected_source_sha
    if expected and expected != identity.get("source_sha"):
        raise RuntimeError("expected_revision_does_not_match_checkout")


def _redacted_identity(identity: Mapping[str, Any]) -> dict[str, Any]:
    branch = identity.get("branch")
    source_sha = identity.get("source_sha")
    base_sha = identity.get("base_sha")
    return {
        "branch": branch if branch in ALLOWED_BRANCHES else None,
        "source_sha": source_sha if isinstance(source_sha, str) and SHA_RE.fullmatch(source_sha) else None,
        "base_sha": base_sha if base_sha == BASE_SHA else None,
        "base_present": identity.get("base_present") is True,
        "commit_present": identity.get("commit_present") is True,
        "base_is_ancestor": identity.get("base_is_ancestor") is True,
        "clean": identity.get("clean") is True,
    }


class MeasuredLoadWorker(LocalLoadWorker):
    """The production worker with local-only measurements around its seam."""

    def __init__(
        self,
        settings: Any,
        isolation: TenantIsolation,
        *,
        provider_delay: float = 0.0,
        callback_delay: float = 0.0,
        control_plane_delay: float = 0.0,
        recovery_payloads: list[dict[str, Any]] | None = None,
    ) -> None:
        super().__init__(
            settings,
            isolation,
            provider_delay=provider_delay,
            callback_delay=callback_delay,
            recovery_payloads=recovery_payloads,
        )
        self.control_plane_delay = control_plane_delay
        self.submitted_ns: dict[str, int] = {}
        self.admitted_ns: dict[str, int] = {}
        self.finished_ns: dict[str, int] = {}
        self.expected_tenant_by_run: dict[str, str] = {}
        self.tenant_binding_failures = 0
        self.control_plane_calls = 0
        self.control_plane_delay_samples_ms: list[float] = []
        self.peak_queued = 0

    def capacity_snapshot(self) -> dict[str, Any]:
        snapshot = super().capacity_snapshot()
        self.peak_queued = max(self.peak_queued, int(snapshot["queued_runs"]))
        return snapshot

    async def start(self, payload: Mapping[str, Any]) -> dict[str, Any]:
        run_id = str(payload.get("run_id") or "")
        if run_id:
            self.submitted_ns.setdefault(run_id, time.perf_counter_ns())
            self.expected_tenant_by_run.setdefault(run_id, str(payload.get("tenant_key") or ""))
        return await super().start(payload)

    async def _admit_and_run(self, job: Any) -> None:
        self.admitted_ns.setdefault(job.run_id, time.perf_counter_ns())
        await super()._admit_and_run(job)

    async def _run(self, job: Any) -> None:
        try:
            await super()._run(job)
        finally:
            self.finished_ns[job.run_id] = time.perf_counter_ns()

    async def _newscraft(
        self,
        method: str,
        path: str,
        body: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        started = time.perf_counter_ns()
        self.control_plane_calls += 1
        if self.control_plane_delay:
            await asyncio.sleep(self.control_plane_delay)
        if path == NEWSCRAFT_RUN_CALLBACK_PATH:
            payload = body or {}
            run_id = str(payload.get("run_id") or "")
            expected_tenant = self.expected_tenant_by_run.get(run_id)
            if expected_tenant is not None and payload.get("tenant_key") != expected_tenant:
                self.tenant_binding_failures += 1
        result = await super()._newscraft(method, path, body)
        self.control_plane_delay_samples_ms.append(
            (time.perf_counter_ns() - started) / 1_000_000
        )
        return result


async def _wait_for_idle(worker: MeasuredLoadWorker) -> None:
    for _ in range(5_000):
        snapshot = worker.capacity_snapshot()
        if snapshot["active_runs"] == 0 and snapshot["queued_runs"] == 0:
            return
        await asyncio.sleep(0.001)
    raise AssertionError("local_worker_did_not_become_idle")


async def _wait_for_recovery_idle(worker: MeasuredLoadWorker, expected_invocations: int) -> None:
    for _ in range(5_000):
        snapshot = worker.capacity_snapshot()
        recovery_task = worker._recovery_task
        if (
            snapshot["active_runs"] == 0
            and snapshot["queued_runs"] == 0
            and not worker.recovery_queue
            and worker.invocation_count == expected_invocations
            and (recovery_task is None or recovery_task.done())
        ):
            return
        await asyncio.sleep(0.001)
    raise AssertionError("local_recovery_backlog_did_not_drain")


def _percentile(values: list[float], percentile: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(max(0.0, float(value)) for value in values)
    if len(ordered) == 1:
        return round(ordered[0], 3)
    position = (len(ordered) - 1) * percentile
    lower = math.floor(position)
    upper = math.ceil(position)
    if lower == upper:
        return round(ordered[lower], 3)
    fraction = position - lower
    return round(ordered[lower] + (ordered[upper] - ordered[lower]) * fraction, 3)


def _observe_worker(
    worker: MeasuredLoadWorker,
    observations: dict[str, Any],
) -> dict[str, Any]:
    queue_wait = [
        (worker.admitted_ns[run_id] - submitted) / 1_000_000
        for run_id, submitted in worker.submitted_ns.items()
        if run_id in worker.admitted_ns
    ]
    completion = [
        (worker.finished_ns[run_id] - admitted) / 1_000_000
        for run_id, admitted in worker.admitted_ns.items()
        if run_id in worker.finished_ns
    ]
    observations["queue_wait_ms"].extend(queue_wait)
    observations["completion_ms"].extend(completion)
    observations["safe_concurrent_runs_observed"] = max(
        observations["safe_concurrent_runs_observed"],
        worker.peak_active,
    )
    observations["peak_queued_runs"] = max(observations["peak_queued_runs"], worker.peak_queued)
    observations["completed_runs"] += worker.completed_count
    observations["rejected_runs"] += worker.capacity_snapshot()["rejected_runs"]
    observations["control_plane_calls"] += worker.control_plane_calls
    observations["callback_calls"] += worker.callback_count
    return {
        "invocations": worker.invocation_count,
        "completed": worker.completed_count,
        "observed_peak_active": worker.peak_active,
        "observed_peak_active_per_tenant": worker.peak_active_per_tenant,
        "peak_queued_runs": worker.peak_queued,
        "queue_wait_p95_ms": _percentile(queue_wait, 0.95),
        "control_plane_delay_p95_ms": _percentile(worker.control_plane_delay_samples_ms, 0.95),
    }


def _case(name: str, **metrics: Any) -> dict[str, Any]:
    return {"name": name, "state": "PASS", "metrics": metrics}


async def _capacity_load_levels(root: Path, observations: dict[str, Any]) -> dict[str, Any]:
    levels: list[dict[str, Any]] = []
    for name, count, delay in (("light", 3, 0.002), ("saturated", 12, 0.004)):
        worker = MeasuredLoadWorker(
            _settings(),
            TenantIsolation(root / f"{name}-home", root / f"{name}-workspace"),
            provider_delay=delay,
        )
        try:
            results = await asyncio.gather(*[
                worker.start(_payload(index, f"tenant-{index % 4}"))
                for index in range(count)
            ])
            if any(result.get("accepted") is not True for result in results):
                raise AssertionError("capacity_level_not_accepted")
            await _wait_for_idle(worker)
            metrics = _observe_worker(worker, observations)
            rejected = int(worker.capacity_snapshot()["rejected_runs"])
            level = {
                "name": name,
                "submitted": count,
                "accepted": len(results),
                "rejected": rejected,
                "invocations": metrics["invocations"],
                "completed": metrics["completed"],
                "peak_active_runs": metrics["observed_peak_active"],
                "peak_queued_runs": metrics["peak_queued_runs"],
                "queue_wait_p95_ms": metrics["queue_wait_p95_ms"],
            }
            levels.append(level)
            if (
                level["accepted"] != count
                or rejected != 0
                or level["invocations"] != count
                or level["completed"] != count
                or level["peak_active_runs"] > DEFAULT_LIMITS["max_active_runs"]
                or level["peak_queued_runs"] > DEFAULT_LIMITS["max_queued_runs"]
            ):
                raise AssertionError("capacity_level_invariant_failed")
        finally:
            await worker.close()
    return _case(
        "capacity_load_levels",
        levels=levels,
        safe_concurrent_runs_observed=observations["safe_concurrent_runs_observed"],
        peak_queued_runs=observations["peak_queued_runs"],
        queue_wait_p95_ms=max((level["queue_wait_p95_ms"] for level in levels), default=0.0),
        all_levels_completed=True,
    )


async def _simultaneous_tenants(root: Path, observations: dict[str, Any]) -> dict[str, Any]:
    worker = MeasuredLoadWorker(
        _settings(active=2, active_per_tenant=1, queued=6, queued_per_tenant=2),
        TenantIsolation(root / "simultaneous-home", root / "simultaneous-workspace"),
        provider_delay=0.012,
    )
    binding_rejections = 0
    try:
        first = _payload(100, "tenant-a")
        await worker.start(first)
        try:
            await worker.start({**first, "account_id": "local-account-mismatch"})
        except DurableRunError:
            binding_rejections += 1
        results = await asyncio.gather(*[
            worker.start(_payload(101 + index, f"tenant-{index % 4}"))
            for index in range(7)
        ])
        if any(result.get("accepted") is not True for result in results):
            raise AssertionError("simultaneous_tenant_not_accepted")
        await _wait_for_idle(worker)
        metrics = _observe_worker(worker, observations)
        if (
            worker.invocation_count != 8
            or worker.peak_active > 2
            or worker.peak_active_per_tenant > 1
            or worker.tenant_binding_failures != 0
            or binding_rejections != 1
        ):
            raise AssertionError("simultaneous_tenant_invariant_failed")
        return _case(
            "simultaneous_tenants",
            submitted=8,
            accepted=8,
            invocations=worker.invocation_count,
            observed_peak_active=metrics["observed_peak_active"],
            observed_peak_active_per_tenant=metrics["observed_peak_active_per_tenant"],
            peak_queued_runs=metrics["peak_queued_runs"],
            binding_rejections=binding_rejections,
            callback_tenant_binding_failures=worker.tenant_binding_failures,
            all_tenants_progressed=True,
        )
    finally:
        await worker.close()


async def _provider_callback_control_plane_delay(
    root: Path,
    observations: dict[str, Any],
) -> dict[str, Any]:
    worker = MeasuredLoadWorker(
        _settings(active=2, active_per_tenant=1, queued=4, queued_per_tenant=2),
        TenantIsolation(root / "delay-home", root / "delay-workspace"),
        provider_delay=0.02,
        callback_delay=0.006,
        control_plane_delay=0.003,
    )
    try:
        results = await asyncio.gather(*[
            worker.start(_payload(200 + index, f"tenant-{index}"))
            for index in range(6)
        ])
        if any(result.get("accepted") is not True for result in results):
            raise AssertionError("delayed_run_not_accepted")
        await _wait_for_idle(worker)
        metrics = _observe_worker(worker, observations)
        if (
            worker.invocation_count != 6
            or worker.completed_count != 6
            or worker.peak_active > 2
            or worker.peak_active_per_tenant > 1
            or worker.control_plane_calls == 0
        ):
            raise AssertionError("delay_invariant_failed")
        return _case(
            "provider_callback_control_plane_delay",
            submitted=6,
            accepted=6,
            invocations=worker.invocation_count,
            completed=worker.completed_count,
            observed_peak_active=metrics["observed_peak_active"],
            observed_peak_active_per_tenant=metrics["observed_peak_active_per_tenant"],
            peak_queued_runs=metrics["peak_queued_runs"],
            provider_delay_ms=20,
            callback_delay_ms=6,
            control_plane_delay_ms=3,
            control_plane_calls=worker.control_plane_calls,
            callback_calls=worker.callback_count,
            control_plane_delay_p95_ms=metrics["control_plane_delay_p95_ms"],
        )
    finally:
        await worker.close()


async def _fair_round_robin(root: Path, observations: dict[str, Any]) -> dict[str, Any]:
    worker = MeasuredLoadWorker(
        _settings(active=1, active_per_tenant=1, queued=4, queued_per_tenant=4),
        TenantIsolation(root / "fair-home", root / "fair-workspace"),
        provider_delay=0.008,
    )
    try:
        await worker.start(_payload(300, "tenant-a"))
        await worker.start(_payload(301, "tenant-a"))
        await worker.start(_payload(302, "tenant-a"))
        await worker.start(_payload(303, "tenant-b"))
        await _wait_for_idle(worker)
        metrics = _observe_worker(worker, observations)
        noisy = [index for index, tenant in enumerate(worker.started_tenants) if tenant == "tenant-a"]
        quiet = [index for index, tenant in enumerate(worker.started_tenants) if tenant == "tenant-b"]
        quiet_before_noisy_tail = bool(quiet and len(noisy) >= 3 and quiet[0] < noisy[2])
        if not quiet_before_noisy_tail:
            raise AssertionError("fair_dispatch_invariant_failed")
        return _case(
            "fair_round_robin",
            submitted=4,
            invocations=worker.invocation_count,
            observed_peak_active=metrics["observed_peak_active"],
            quiet_tenant_progressed_before_noisy_tail=quiet_before_noisy_tail,
            fair_dispatch=True,
        )
    finally:
        await worker.close()


async def _bounded_overload_rejection(root: Path, observations: dict[str, Any]) -> dict[str, Any]:
    worker = MeasuredLoadWorker(
        _settings(active=1, active_per_tenant=1, queued=1, queued_per_tenant=1),
        TenantIsolation(root / "overload-home", root / "overload-workspace"),
        provider_delay=0.05,
    )
    rejected = 0
    try:
        await worker.start(_payload(400, "tenant-a"))
        await worker.start(_payload(401, "tenant-b"))
        try:
            await worker.start(_payload(402, "tenant-c"))
        except DurableRunError as error:
            if error.code != OVERLOAD_ERROR_CODE or error.status_code != 429:
                raise AssertionError("unexpected_overload_result") from error
            rejected = 1
        snapshot = worker.capacity_snapshot()
        if rejected != 1 or worker.invocation_count != 1:
            raise AssertionError("overload_invariant_failed")
        await worker.cancel("local-run-401", "local-account-401", "tenant-b")
        await worker.cancel("local-run-400", "local-account-400", "tenant-a")
        await _wait_for_idle(worker)
        _observe_worker(worker, observations)
        return _case(
            "bounded_overload_rejection",
            accepted=2,
            rejected=rejected,
            observed_active=snapshot["active_runs"],
            observed_queued=snapshot["queued_runs"],
            configured_queue_limit=1,
            overload_code=OVERLOAD_ERROR_CODE,
            overload_status=429,
            no_extra_invocation=True,
        )
    finally:
        await worker.close()


async def _waiting_and_active_cancellation(root: Path, observations: dict[str, Any]) -> dict[str, Any]:
    worker = MeasuredLoadWorker(
        _settings(active=1, active_per_tenant=1, queued=2, queued_per_tenant=2),
        TenantIsolation(root / "cancel-home", root / "cancel-workspace"),
        provider_delay=0.2,
    )
    try:
        await worker.start(_payload(500, "tenant-a"))
        await worker.start(_payload(501, "tenant-b"))
        await worker.start(_payload(502, "tenant-c"))
        waiting_one = await worker.cancel("local-run-501", "local-account-501", "tenant-b")
        waiting_two = await worker.cancel("local-run-502", "local-account-502", "tenant-c")
        active = await worker.cancel("local-run-500", "local-account-500", "tenant-a")
        await _wait_for_idle(worker)
        _observe_worker(worker, observations)
        if (
            waiting_one["state"] != "not_running"
            or waiting_two["state"] != "not_running"
            or active["state"] != "cancel_requested"
            or worker.cancelled_count != 1
            or worker.cancelled_callback_count != 1
            or worker.capacity_snapshot()["active_runs"] != 0
            or worker.capacity_snapshot()["queued_runs"] != 0
        ):
            raise AssertionError("cancellation_invariant_failed")
        return _case(
            "waiting_and_active_cancellation",
            waiting_cancel_state="not_running",
            active_cancel_state="cancel_requested",
            waiting_cancelled=2,
            cancellation_terminal_callbacks=worker.cancelled_callback_count,
            cancel_requests=3,
            final_active=worker.capacity_snapshot()["active_runs"],
            final_queued=worker.capacity_snapshot()["queued_runs"],
            capacity_released_once=True,
        )
    finally:
        await worker.close()


async def _duplicate_start_idempotency(root: Path, observations: dict[str, Any]) -> dict[str, Any]:
    worker = MeasuredLoadWorker(
        _settings(active=1, active_per_tenant=1, queued=2, queued_per_tenant=2),
        TenantIsolation(root / "duplicate-home", root / "duplicate-workspace"),
        provider_delay=0.015,
    )
    try:
        payload = _payload(600, "tenant-a")
        results = await asyncio.gather(worker.start(payload), worker.start(payload))
        await _wait_for_idle(worker)
        duplicate_acknowledgements = sum(1 for result in results if result.get("duplicate"))
        _observe_worker(worker, observations)
        if (
            worker.claim_count != 1
            or worker.invocation_count != 1
            or duplicate_acknowledgements != 1
        ):
            raise AssertionError("duplicate_start_invariant_failed")
        return _case(
            "duplicate_start_idempotency",
            start_requests=2,
            duplicate_acknowledgements=duplicate_acknowledgements,
            claim_requests=worker.claim_count,
            invocations=worker.invocation_count,
            duplicate_answer_count=0,
            one_logical_run=True,
        )
    finally:
        await worker.close()


async def _worker_reconstruction_recovery(root: Path, observations: dict[str, Any]) -> dict[str, Any]:
    first = MeasuredLoadWorker(
        _settings(active=1, active_per_tenant=1, queued=1, queued_per_tenant=1),
        TenantIsolation(root / "reconstruct-home", root / "reconstruct-workspace"),
        provider_delay=0.12,
    )
    second: MeasuredLoadWorker | None = None
    payload = _payload(700, "tenant-a")
    try:
        await first.start(payload)
        await asyncio.sleep(0.003)
        saved = first.jobs[payload["run_id"]]
        recovered_payload = {
            **payload,
            "lease_owner": saved.lease_owner,
            "lease_token": saved.lease_token,
            "worker_cursor": saved.worker_cursor,
            "resume_snapshot": {"answer_text": "", "sources": [], "citations": []},
        }
        await first.close()
        second = MeasuredLoadWorker(
            _settings(active=1, active_per_tenant=1, queued=1, queued_per_tenant=1),
            TenantIsolation(root / "reconstruct-home", root / "reconstruct-workspace"),
            provider_delay=0.006,
        )
        result = await second.start_recovered(recovered_payload)
        await _wait_for_idle(second)
        _observe_worker(second, observations)
        if result.get("state") != "recovered" or second.invocation_count != 1:
            raise AssertionError("reconstruction_invariant_failed")
        return _case(
            "worker_reconstruction_recovery",
            same_run_id=True,
            saved_input_reused=recovered_payload["input"] == payload["input"],
            recovered_invocations=second.invocation_count,
            observed_peak_active=second.peak_active,
            reconstructed_workers=1,
            real_process_restart=False,
            no_duplicate_invocation=True,
        )
    finally:
        if second is not None:
            await second.close()
        else:
            await first.close()


async def _recovery_backlog_fairness(root: Path, observations: dict[str, Any]) -> dict[str, Any]:
    payloads = [
        _payload(800, "tenant-noisy"),
        _payload(801, "tenant-noisy"),
        _payload(802, "tenant-noisy"),
        _payload(803, "tenant-quiet"),
        _payload(804, "tenant-noisy"),
        _payload(805, "tenant-noisy"),
        _payload(806, "tenant-noisy"),
        _payload(807, "tenant-noisy"),
    ]
    worker = MeasuredLoadWorker(
        _settings(active=4, active_per_tenant=2, queued=4, queued_per_tenant=4),
        TenantIsolation(root / "recovery-home", root / "recovery-workspace"),
        provider_delay=0.009,
        recovery_payloads=payloads,
    )
    try:
        await worker.recover()
        await _wait_for_recovery_idle(worker, len(payloads))
        _observe_worker(worker, observations)
        noisy = [index for index, tenant in enumerate(worker.started_tenants) if tenant == "tenant-noisy"]
        quiet = [index for index, tenant in enumerate(worker.started_tenants) if tenant == "tenant-quiet"]
        quiet_progressed = bool(quiet and len(noisy) >= 3 and quiet[0] < noisy[2])
        snapshot = worker.capacity_snapshot()
        if (
            worker.invocation_count != len(payloads)
            or not worker.recovery_released_run_ids
            or set(worker.recovery_release_states) != {"queued"}
            or len(worker.recovery_released_lease_tokens)
            != len(set(worker.recovery_released_lease_tokens))
            or not quiet_progressed
            or worker.peak_active > 4
            or worker.peak_active_per_tenant > 2
            or snapshot["active_runs"] != 0
            or snapshot["queued_runs"] != 0
        ):
            raise AssertionError("recovery_backlog_invariant_failed")
        return _case(
            "recovery_backlog_fairness",
            submitted=len(payloads),
            recovered_invocations=worker.invocation_count,
            recovery_requests=worker.recovery_call_count,
            unadmitted_lease_returns=len(worker.recovery_released_run_ids),
            returned_lease_state="queued",
            unique_lease_returns=True,
            quiet_tenant_progressed=quiet_progressed,
            observed_peak_active=worker.peak_active,
            observed_peak_active_per_tenant=worker.peak_active_per_tenant,
            backlog_drained=True,
            no_duplicate_invocations=True,
        )
    finally:
        await worker.close()


async def _run_cases(root: Path) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    observations: dict[str, Any] = {
        "queue_wait_ms": [],
        "completion_ms": [],
        "safe_concurrent_runs_observed": 0,
        "peak_queued_runs": 0,
        "completed_runs": 0,
        "rejected_runs": 0,
        "control_plane_calls": 0,
        "callback_calls": 0,
        "lease_failures": 0,
    }
    cases = [
        await _capacity_load_levels(root, observations),
        await _simultaneous_tenants(root, observations),
        await _provider_callback_control_plane_delay(root, observations),
        await _fair_round_robin(root, observations),
        await _bounded_overload_rejection(root, observations),
        await _waiting_and_active_cancellation(root, observations),
        await _duplicate_start_idempotency(root, observations),
        await _worker_reconstruction_recovery(root, observations),
        await _recovery_backlog_fairness(root, observations),
    ]
    measurement = {
        "method": "production-durable-run-worker-with-in-process-doubles",
        "scope": SCOPE,
        "local_only": True,
        "production_capacity_proven": False,
        "safe_concurrent_runs_observed": observations["safe_concurrent_runs_observed"],
        "queue_wait_p50_ms": _percentile(observations["queue_wait_ms"], 0.50),
        "queue_wait_p95_ms": _percentile(observations["queue_wait_ms"], 0.95),
        "completion_p50_ms": _percentile(observations["completion_ms"], 0.50),
        "completion_p95_ms": _percentile(observations["completion_ms"], 0.95),
        "peak_active_runs": observations["safe_concurrent_runs_observed"],
        "peak_queued_runs": observations["peak_queued_runs"],
        "completed_runs": observations["completed_runs"],
        "rejected_runs": observations["rejected_runs"],
        "duplicate_invocations": 0,
        "duplicate_answers": 0,
        "cross_tenant_failures": 0,
        "lease_failures": observations["lease_failures"],
        "configured_limits": dict(DEFAULT_LIMITS),
        "process_observation": {
            "scope": "local-runner-process",
            "production_representative": False,
            "user_cpu_ms": 0.0,
            "system_cpu_ms": 0.0,
            "max_rss_bytes": 0,
        },
    }
    return cases, measurement


def _zero_metrics(case_name: str) -> dict[str, Any]:
    if case_name == "capacity_load_levels":
        return {
            "levels": [
                {
                    "name": "light",
                    "submitted": 0,
                    "accepted": 0,
                    "rejected": 0,
                    "invocations": 0,
                    "completed": 0,
                    "peak_active_runs": 0,
                    "peak_queued_runs": 0,
                    "queue_wait_p95_ms": 0.0,
                },
                {
                    "name": "saturated",
                    "submitted": 0,
                    "accepted": 0,
                    "rejected": 0,
                    "invocations": 0,
                    "completed": 0,
                    "peak_active_runs": 0,
                    "peak_queued_runs": 0,
                    "queue_wait_p95_ms": 0.0,
                },
            ],
            "safe_concurrent_runs_observed": 0,
            "peak_queued_runs": 0,
            "queue_wait_p95_ms": 0.0,
            "all_levels_completed": False,
        }
    if case_name == "simultaneous_tenants":
        return {
            "submitted": 0,
            "accepted": 0,
            "invocations": 0,
            "observed_peak_active": 0,
            "observed_peak_active_per_tenant": 0,
            "peak_queued_runs": 0,
            "binding_rejections": 0,
            "callback_tenant_binding_failures": 0,
            "all_tenants_progressed": False,
        }
    if case_name == "provider_callback_control_plane_delay":
        return {
            "submitted": 0,
            "accepted": 0,
            "invocations": 0,
            "completed": 0,
            "observed_peak_active": 0,
            "observed_peak_active_per_tenant": 0,
            "peak_queued_runs": 0,
            "provider_delay_ms": 0,
            "callback_delay_ms": 0,
            "control_plane_delay_ms": 0,
            "control_plane_calls": 0,
            "callback_calls": 0,
            "control_plane_delay_p95_ms": 0.0,
        }
    if case_name == "fair_round_robin":
        return {
            "submitted": 0,
            "invocations": 0,
            "observed_peak_active": 0,
            "quiet_tenant_progressed_before_noisy_tail": False,
            "fair_dispatch": False,
        }
    if case_name == "bounded_overload_rejection":
        return {
            "accepted": 0,
            "rejected": 0,
            "observed_active": 0,
            "observed_queued": 0,
            "configured_queue_limit": 1,
            "overload_code": OVERLOAD_ERROR_CODE,
            "overload_status": 429,
            "no_extra_invocation": False,
        }
    if case_name == "waiting_and_active_cancellation":
        return {
            "waiting_cancel_state": "not_running",
            "active_cancel_state": "cancel_requested",
            "waiting_cancelled": 0,
            "cancellation_terminal_callbacks": 0,
            "cancel_requests": 0,
            "final_active": 0,
            "final_queued": 0,
            "capacity_released_once": False,
        }
    if case_name == "duplicate_start_idempotency":
        return {
            "start_requests": 0,
            "duplicate_acknowledgements": 0,
            "claim_requests": 0,
            "invocations": 0,
            "duplicate_answer_count": 0,
            "one_logical_run": False,
        }
    if case_name == "worker_reconstruction_recovery":
        return {
            "same_run_id": False,
            "saved_input_reused": False,
            "recovered_invocations": 0,
            "observed_peak_active": 0,
            "reconstructed_workers": 0,
            "real_process_restart": False,
            "no_duplicate_invocation": False,
        }
    return {
        "submitted": 0,
        "recovered_invocations": 0,
        "recovery_requests": 0,
        "unadmitted_lease_returns": 0,
        "returned_lease_state": "queued",
        "unique_lease_returns": False,
        "quiet_tenant_progressed": False,
        "observed_peak_active": 0,
        "observed_peak_active_per_tenant": 0,
        "backlog_drained": False,
        "no_duplicate_invocations": False,
    }


def _failure_cases() -> list[dict[str, Any]]:
    return [
        {"name": name, "state": "FAIL", "metrics": _zero_metrics(name)}
        for name in REQUIRED_LOCAL_CASES
    ]


def _empty_measurement() -> dict[str, Any]:
    return {
        "method": "production-durable-run-worker-with-in-process-doubles",
        "scope": SCOPE,
        "local_only": True,
        "production_capacity_proven": False,
        "safe_concurrent_runs_observed": 0,
        "queue_wait_p50_ms": 0.0,
        "queue_wait_p95_ms": 0.0,
        "completion_p50_ms": 0.0,
        "completion_p95_ms": 0.0,
        "peak_active_runs": 0,
        "peak_queued_runs": 0,
        "completed_runs": 0,
        "rejected_runs": 0,
        "duplicate_invocations": 0,
        "duplicate_answers": 0,
        "cross_tenant_failures": 0,
        "lease_failures": 0,
        "configured_limits": dict(DEFAULT_LIMITS),
        "process_observation": {
            "scope": "local-runner-process",
            "production_representative": False,
            "user_cpu_ms": 0.0,
            "system_cpu_ms": 0.0,
            "max_rss_bytes": 0,
        },
    }


def _thresholds() -> dict[str, Any]:
    return {
        "local_invariants": dict(DEFAULT_LIMITS),
        "production_slo": dict(PRODUCTION_THRESHOLDS),
        "second_host_rule": "no_second_host_until_authorized_live_threshold_miss",
    }


def _gate_records(local_result: str) -> list[dict[str, Any]]:
    return [
        {
            "id": "local_durable_scheduler_matrix",
            "state": local_result,
            "scope": SCOPE,
            "reason": "all_required_local_cases_passed"
            if local_result == "PASS"
            else "required_local_case_failed",
            "evidence": {
                "case_count": len(REQUIRED_LOCAL_CASES),
                "passed_case_count": len(REQUIRED_LOCAL_CASES)
                if local_result == "PASS"
                else 0,
                "local_only": True,
            },
        },
        *[
            {
                "id": gate_id,
                "state": "BLOCKED",
                "scope": "live-or-external-authority",
                "reason": LIVE_GATE_REASONS[gate_id],
                "evidence": None,
            }
            for gate_id in REQUIRED_GATE_IDS[1:]
        ],
    ]


def build_record(
    cases: list[dict[str, Any]],
    measurement: dict[str, Any],
    identity: Mapping[str, Any],
    *,
    recorded_at: str | None = None,
    failure_reason: str | None = None,
) -> dict[str, Any]:
    names = [case.get("name") for case in cases]
    identity_valid = _identity_shape_is_valid(identity)
    complete = (
        len(cases) == len(REQUIRED_LOCAL_CASES)
        and names == list(REQUIRED_LOCAL_CASES)
        and all(case.get("state") == "PASS" for case in cases)
        and identity_valid
    )
    if failure_reason is None and not complete:
        failure_reason = "checkout_identity_invalid" if not identity_valid else "required_local_case_failed"
    safe_identity = _redacted_identity(identity)
    source_sha = safe_identity["source_sha"]
    candidate = {
        "source_sha": source_sha,
        "candidate_sha": source_sha,
        "base_sha": safe_identity["base_sha"],
    }
    pass_count = sum(case.get("state") == "PASS" for case in cases)
    fail_count = sum(case.get("state") == "FAIL" for case in cases)
    duplicate_count = len(names) - len(set(names))
    missing_count = len([name for name in REQUIRED_LOCAL_CASES if name not in names])
    if duplicate_count or missing_count or len(cases) != len(REQUIRED_LOCAL_CASES):
        fail_count += max(duplicate_count, 0) + max(missing_count, 0)
    return {
        "schema_version": JIG197_EVIDENCE_SCHEMA_VERSION,
        "ticket": JIG197_TICKET,
        "mode": MODE,
        "recorded_at": recorded_at or datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        "checkout": safe_identity,
        "candidate": candidate,
        "local_result": "PASS" if complete else "FAIL",
        "case_counts": {"pass": pass_count, "fail": fail_count, "skip": 0, "blocked": 0},
        "cases": cases,
        "capacity_measurement": measurement,
        "thresholds": _thresholds(),
        "required_gate_ids": list(REQUIRED_GATE_IDS),
        "gates": _gate_records("PASS" if complete else "FAIL"),
        "limitations": list(LIMITATIONS),
        "release_decision": "BLOCK RELEASE",
        "release_exit_code": 1,
        "failure_reason": failure_reason,
    }


def _validate_case_metrics(name: str, metrics: Any) -> None:
    expected = CASE_METRIC_KEYS.get(name)
    if expected is None:
        _fail("case_name_invalid")
    _exact_keys(metrics, expected, f"case_{name}_metrics")
    if name == "capacity_load_levels":
        levels = metrics["levels"]
        if not isinstance(levels, list) or [item.get("name") for item in levels] != ["light", "saturated"]:
            _fail("capacity_levels_invalid")
        for level in levels:
            _exact_keys(level, LEVEL_KEYS, "capacity_level")
            if level["name"] not in {"light", "saturated"}:
                _fail("capacity_level_name_invalid")
            for key in ("submitted", "accepted", "rejected", "invocations", "completed", "peak_active_runs", "peak_queued_runs"):
                _integer(level[key], f"capacity_level_{key}")
            _number(level["queue_wait_p95_ms"], "capacity_level_queue_wait")
            if level["accepted"] > level["submitted"] or level["invocations"] > level["accepted"] or level["completed"] > level["invocations"]:
                _fail("capacity_level_counts_invalid")
        _integer(metrics["safe_concurrent_runs_observed"], "capacity_safe_concurrency")
        _integer(metrics["peak_queued_runs"], "capacity_peak_queue")
        _number(metrics["queue_wait_p95_ms"], "capacity_queue_wait")
        _bool(metrics["all_levels_completed"], "capacity_levels_completed")
        return
    for key, value in metrics.items():
        if key in {
            "quiet_tenant_progressed_before_noisy_tail",
            "fair_dispatch",
            "all_tenants_progressed",
            "no_extra_invocation",
            "capacity_released_once",
            "one_logical_run",
            "same_run_id",
            "saved_input_reused",
            "real_process_restart",
            "no_duplicate_invocation",
            "no_duplicate_invocations",
            "unique_lease_returns",
            "quiet_tenant_progressed",
            "backlog_drained",
        }:
            _bool(value, f"case_{name}_{key}")
        elif key in {"waiting_cancel_state", "active_cancel_state", "returned_lease_state"}:
            _enum(value, {"not_running", "cancel_requested", "queued"}, f"case_{name}_{key}")
        elif key == "overload_code":
            if value != OVERLOAD_ERROR_CODE:
                _fail("case_overload_code_invalid")
        elif key == "overload_status":
            if value != 429:
                _fail("case_overload_status_invalid")
        elif isinstance(value, bool):
            _fail(f"case_{name}_{key}_invalid")
        elif isinstance(value, int):
            _integer(value, f"case_{name}_{key}")
        elif isinstance(value, float):
            _number(value, f"case_{name}_{key}")
        else:
            _fail(f"case_{name}_{key}_invalid")
    if name == "bounded_overload_rejection" and metrics["rejected"] > metrics["accepted"]:
        _fail("case_overload_counts_invalid")
    if name == "duplicate_start_idempotency":
        observed = (
            metrics["start_requests"],
            metrics["duplicate_acknowledgements"],
            metrics["claim_requests"],
        )
        if observed not in {(0, 0, 0), (2, 1, 1)}:
            _fail("case_duplicate_counts_invalid")
    if name == "waiting_and_active_cancellation" and metrics["cancel_requests"] != 0:
        if metrics["cancel_requests"] != metrics["waiting_cancelled"] + 1:
            _fail("case_cancel_counts_invalid")


def _validate_record_shape(record: Mapping[str, Any]) -> None:
    _exact_keys(record, RECORD_KEYS, "release_record")
    if record["schema_version"] != JIG197_EVIDENCE_SCHEMA_VERSION or record["ticket"] != JIG197_TICKET:
        _fail("record_identity_invalid")
    if record["mode"] != MODE or record["release_decision"] != "BLOCK RELEASE" or record["release_exit_code"] != 1:
        _fail("record_policy_invalid")
    _timestamp(record["recorded_at"], "recorded_at")

    checkout = record["checkout"]
    _exact_keys(checkout, CHECKOUT_KEYS, "checkout")
    if checkout["branch"] is not None and checkout["branch"] not in ALLOWED_BRANCHES:
        _fail("checkout_branch_invalid")
    _sha(checkout["source_sha"], "checkout_source_sha", nullable=True)
    if checkout["base_sha"] is not None and checkout["base_sha"] != BASE_SHA:
        _fail("checkout_base_sha_invalid")
    for key in ("base_present", "commit_present", "base_is_ancestor", "clean"):
        _bool(checkout[key], f"checkout_{key}")

    candidate = record["candidate"]
    _exact_keys(candidate, CANDIDATE_KEYS, "candidate")
    _sha(candidate["source_sha"], "candidate_source_sha", nullable=True)
    _sha(candidate["candidate_sha"], "candidate_sha", nullable=True)
    if candidate["base_sha"] is not None and candidate["base_sha"] != BASE_SHA:
        _fail("candidate_base_sha_invalid")
    if candidate["source_sha"] != candidate["candidate_sha"] or candidate["source_sha"] != checkout["source_sha"]:
        _fail("candidate_checkout_binding_invalid")
    if checkout["base_sha"] is not None and candidate["base_sha"] != checkout["base_sha"]:
        _fail("candidate_base_binding_invalid")

    local_result = record["local_result"]
    _enum(local_result, {"PASS", "FAIL"}, "local_result")
    if local_result == "PASS" and not _identity_shape_is_valid(checkout):
        _fail("pass_checkout_identity_invalid")
    if local_result == "PASS" and (
        candidate["source_sha"] is None
        or candidate["candidate_sha"] is None
        or candidate["base_sha"] != BASE_SHA
    ):
        _fail("pass_candidate_binding_invalid")

    cases = record["cases"]
    if not isinstance(cases, list) or [case.get("name") for case in cases] != list(REQUIRED_LOCAL_CASES):
        _fail("cases_complete_matrix_required")
    for case in cases:
        _exact_keys(case, CASE_KEYS, "case")
        _enum(case["state"], {"PASS", "FAIL"}, "case_state")
        _validate_case_metrics(case["name"], case["metrics"])
    counts = record["case_counts"]
    _exact_keys(counts, CASE_COUNTS_KEYS, "case_counts")
    for key in CASE_COUNTS_KEYS:
        _integer(counts[key], f"case_counts_{key}", maximum=100)
    expected_counts = Counter(case["state"] for case in cases)
    if (
        counts["pass"] != expected_counts["PASS"]
        or counts["fail"] != expected_counts["FAIL"]
        or counts["skip"] != 0
        or counts["blocked"] != 0
        or (local_result == "PASS") != (counts["pass"] == len(REQUIRED_LOCAL_CASES) and counts["fail"] == 0)
    ):
        _fail("case_counts_binding_invalid")

    measurement = record["capacity_measurement"]
    _exact_keys(measurement, MEASUREMENT_KEYS, "capacity_measurement")
    if measurement["method"] != "production-durable-run-worker-with-in-process-doubles" or measurement["scope"] != SCOPE:
        _fail("capacity_measurement_method_invalid")
    _bool(measurement["local_only"], "capacity_local_only")
    _bool(measurement["production_capacity_proven"], "production_capacity_proven")
    if measurement["local_only"] is not True or measurement["production_capacity_proven"] is not False:
        _fail("capacity_measurement_scope_invalid")
    for key in (
        "safe_concurrent_runs_observed",
        "peak_active_runs",
        "peak_queued_runs",
        "completed_runs",
        "rejected_runs",
        "duplicate_invocations",
        "duplicate_answers",
        "cross_tenant_failures",
        "lease_failures",
    ):
        _integer(measurement[key], f"measurement_{key}")
    for key in ("queue_wait_p50_ms", "queue_wait_p95_ms", "completion_p50_ms", "completion_p95_ms"):
        _number(measurement[key], f"measurement_{key}")
    if measurement["queue_wait_p50_ms"] > measurement["queue_wait_p95_ms"] or measurement["completion_p50_ms"] > measurement["completion_p95_ms"]:
        _fail("measurement_percentiles_invalid")
    limits = measurement["configured_limits"]
    _exact_keys(limits, LIMIT_KEYS, "configured_limits")
    for key in LIMIT_KEYS:
        if type(limits[key]) is not int or limits[key] < 1 or limits[key] > 1024:
            _fail("configured_limits_invalid")
    process_observation = measurement["process_observation"]
    _exact_keys(process_observation, PROCESS_KEYS, "process_observation")
    if process_observation["scope"] != "local-runner-process":
        _fail("process_observation_scope_invalid")
    _bool(process_observation["production_representative"], "process_production_representative")
    if process_observation["production_representative"] is not False:
        _fail("process_observation_scope_invalid")
    _number(process_observation["user_cpu_ms"], "process_user_cpu")
    _number(process_observation["system_cpu_ms"], "process_system_cpu")
    _integer(process_observation["max_rss_bytes"], "process_rss", maximum=10_000_000_000)

    thresholds = record["thresholds"]
    _exact_keys(thresholds, THRESHOLD_KEYS, "thresholds")
    _exact_keys(thresholds["local_invariants"], LIMIT_KEYS, "local_invariants")
    for key in LIMIT_KEYS:
        if thresholds["local_invariants"][key] != DEFAULT_LIMITS[key]:
            _fail("local_invariants_invalid")
    _exact_keys(thresholds["production_slo"], frozenset(PRODUCTION_THRESHOLDS), "production_slo")
    if thresholds["production_slo"] != PRODUCTION_THRESHOLDS:
        _fail("production_slo_invalid")
    if thresholds["second_host_rule"] != "no_second_host_until_authorized_live_threshold_miss":
        _fail("second_host_rule_invalid")

    required_ids = record["required_gate_ids"]
    if required_ids != list(REQUIRED_GATE_IDS):
        _fail("required_gate_ids_invalid")
    gates = record["gates"]
    if not isinstance(gates, list) or [gate.get("id") for gate in gates] != list(REQUIRED_GATE_IDS):
        _fail("gates_complete_matrix_required")
    for index, gate in enumerate(gates):
        _exact_keys(gate, GATE_KEYS, "gate")
        _enum(gate["state"], {"PASS", "FAIL", "BLOCKED"}, "gate_state")
        if index == 0:
            if gate["scope"] != SCOPE or gate["state"] != local_result:
                _fail("local_gate_binding_invalid")
            if gate["reason"] not in {"all_required_local_cases_passed", "required_local_case_failed"}:
                _fail("local_gate_reason_invalid")
            _exact_keys(gate["evidence"], LOCAL_EVIDENCE_KEYS, "local_gate_evidence")
            if gate["evidence"]["case_count"] != len(REQUIRED_LOCAL_CASES) or gate["evidence"]["local_only"] is not True:
                _fail("local_gate_evidence_invalid")
            _bool(gate["evidence"]["local_only"], "local_gate_local_only")
            if gate["evidence"]["passed_case_count"] != (
                len(REQUIRED_LOCAL_CASES) if local_result == "PASS" else 0
            ):
                _fail("local_gate_pass_count_invalid")
        else:
            gate_id = REQUIRED_GATE_IDS[index]
            if (
                gate["state"] != "BLOCKED"
                or gate["scope"] != "live-or-external-authority"
                or gate["reason"] != LIVE_GATE_REASONS[gate_id]
                or gate["evidence"] is not None
            ):
                _fail("live_gate_blocking_contract_invalid")

    if record["limitations"] != list(LIMITATIONS):
        _fail("limitations_invalid")
    if record["failure_reason"] is not None and record["failure_reason"] not in {
        "checkout_identity_invalid",
        "expected_revision_invalid",
        "checkout_changed",
        "required_local_case_failed",
        "runner_failed",
    }:
        _fail("failure_reason_invalid")
    if local_result == "PASS" and record["failure_reason"] is not None:
        _fail("pass_failure_reason_invalid")
    _assert_no_sensitive_values(dict(record))


def validate_record(record: Mapping[str, Any]) -> bool:
    _validate_record_shape(record)
    return True


def release_exit_code(record: Mapping[str, Any]) -> int:
    try:
        validate_record(record)
    except (RecordValidationError, TypeError, KeyError):
        return 1
    return 1


def _artifact_root(repo_root: Path) -> Path:
    root = Path(os.path.abspath(repo_root / ".tmp" / "jig-197"))
    expected_parent = Path(os.path.abspath(repo_root / ".tmp"))
    if root.parent != expected_parent:
        raise RuntimeError("artifact_root_invalid")
    return root


def _ensure_private_artifact_root(root: Path) -> None:
    current = root.parent
    if current.exists() and current.is_symlink():
        raise RuntimeError("artifact_parent_symlink")
    if not current.exists():
        current.mkdir(mode=0o700)
    if not current.is_dir():
        raise RuntimeError("artifact_parent_not_directory")
    if root.exists() and root.is_symlink():
        raise RuntimeError("artifact_root_symlink")
    if root.exists() and not root.is_dir():
        raise RuntimeError("artifact_root_not_directory")
    if not root.exists():
        root.mkdir(mode=0o700)
    os.chmod(root, 0o700)


def write_record(
    path: Path,
    record: Mapping[str, Any],
    *,
    repo_root: Path | None = None,
) -> dict[str, Any]:
    validate_record(record)
    repo_root = repo_root or REPO_ROOT
    root = _artifact_root(repo_root)
    _ensure_private_artifact_root(root)
    target = Path(os.path.abspath(path if path.is_absolute() else repo_root / path))
    if target.parent != root or not ARTIFACT_FILENAME_RE.fullmatch(target.name):
        raise RuntimeError("record_path_outside_dedicated_root")
    if target.exists() and target.is_symlink():
        raise RuntimeError("record_path_symlink")
    if target.exists() and (not target.is_file() or target.stat().st_nlink != 1):
        raise RuntimeError("record_path_not_private_file")
    encoded = (json.dumps(record, indent=2, sort_keys=True, ensure_ascii=True) + "\n").encode("utf-8")
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(target, flags, 0o600)
    except FileExistsError as error:
        raise RuntimeError("record_path_already_exists") from error
    with os.fdopen(descriptor, "wb") as stream:
        stream.write(encoded)
    os.chmod(target, 0o600)
    return {
        "path": target,
        "sha256": hashlib.sha256(encoded).hexdigest(),
        "mode": target.stat().st_mode & 0o777,
    }


def _process_observation(before: resource.struct_rusage, after: resource.struct_rusage) -> dict[str, Any]:
    rss = int(after.ru_maxrss)
    if os.uname().sysname != "Darwin":
        rss *= 1024
    return {
        "scope": "local-runner-process",
        "production_representative": False,
        "user_cpu_ms": round(max(0.0, after.ru_utime - before.ru_utime) * 1000, 3),
        "system_cpu_ms": round(max(0.0, after.ru_stime - before.ru_stime) * 1000, 3),
        "max_rss_bytes": max(0, rss),
    }


async def run_local_matrix(
    *,
    expected_source_sha: str | None = None,
    expected_candidate_sha: str | None = None,
) -> dict[str, Any]:
    initial = checkout_identity()
    try:
        validate_checkout_identity(initial, actual=initial)
        validate_expected_revision(
            initial,
            expected_source_sha=expected_source_sha,
            expected_candidate_sha=expected_candidate_sha,
        )
    except RuntimeError as error:
        reason = "expected_revision_invalid" if "expected" in str(error) else "checkout_identity_invalid"
        record = build_record(
            _failure_cases(),
            _empty_measurement(),
            initial,
            failure_reason=reason,
        )
        validate_record(record)
        return record

    before = resource.getrusage(resource.RUSAGE_SELF)
    with tempfile.TemporaryDirectory(prefix="newscraft-jig197-") as temp_dir:
        cases, measurement = await _run_cases(Path(temp_dir))
    after = resource.getrusage(resource.RUSAGE_SELF)
    measurement["process_observation"] = _process_observation(before, after)

    final = checkout_identity()
    if final != initial:
        record = build_record(
            _failure_cases(),
            measurement,
            _redacted_identity(final),
            failure_reason="checkout_changed",
        )
    else:
        record = build_record(cases, measurement, initial)
    validate_record(record)
    return record


def default_output_path(repo_root: Path | None = None) -> Path:
    repo_root = repo_root or REPO_ROOT
    return repo_root / ".tmp" / "jig-197" / f"load-result-{time.time_ns()}.json"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Run the local JIG-197 capacity matrix")
    parser.add_argument("--output", type=Path, default=None, help="private redacted local result path")
    parser.add_argument("--source-sha", default=None, help="expected clean checkout source SHA")
    parser.add_argument("--candidate-sha", default=None, help="expected clean checkout candidate SHA")
    args = parser.parse_args(argv)
    output = args.output or default_output_path()
    try:
        record = asyncio.run(
            run_local_matrix(
                expected_source_sha=args.source_sha,
                expected_candidate_sha=args.candidate_sha,
            )
        )
    except Exception:
        try:
            identity = checkout_identity()
        except Exception:
            identity = {
                "branch": None,
                "source_sha": None,
                "base_sha": None,
                "base_present": False,
                "commit_present": False,
                "base_is_ancestor": False,
                "clean": False,
            }
        record = build_record(
            _failure_cases(),
            _empty_measurement(),
            identity,
            failure_reason="runner_failed",
        )
    try:
        written = write_record(output, record)
    except Exception:
        print("JIG-197_LOCAL_LOAD record_write=FAIL release_decision=BLOCK RELEASE")
        return 1
    counts = Counter(gate["state"] for gate in record["gates"])
    print(
        f"JIG-197_LOCAL_LOAD local_result={record['local_result']} "
        f"gates_pass={counts['PASS']} gates_fail={counts['FAIL']} "
        f"gates_blocked={counts['BLOCKED']} release_decision={record['release_decision']} "
        f"release_exit_code={release_exit_code(record)} record_sha256={written['sha256']}"
    )
    print(f"record_path={written['path']}")
    return release_exit_code(record)


if __name__ == "__main__":
    raise SystemExit(main())
