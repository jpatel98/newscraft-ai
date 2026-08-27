"""Deterministic local JIG-185 capacity evidence.

The cases below exercise the production ``DurableRunWorker``. Only its
NewsCraft control-plane calls and Hermes provider stream are replaced with
in-process deterministic doubles. No browser, database, remote endpoint,
provider, or real service process is used. The emitted record is intentionally
aggregate and redacted; it is scheduler evidence, not production capacity.
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import subprocess
import tempfile
import time
from collections import deque
from pathlib import Path
from types import SimpleNamespace
from typing import Any
from urllib.parse import parse_qs, urlsplit

from hermes_chat.contracts import (
    NEWSCRAFT_RUN_CALLBACK_PATH,
    NEWSCRAFT_RUN_CLAIM_PATH,
    NEWSCRAFT_RUN_FAIL_PATH,
    NEWSCRAFT_RUN_RECOVER_PATH,
    NEWSCRAFT_RUN_RELEASE_PATH,
)
from hermes_chat.durable import (
    DEFAULT_MAX_ACTIVE_RUNS,
    DEFAULT_MAX_ACTIVE_RUNS_PER_TENANT,
    DEFAULT_MAX_QUEUED_RUNS,
    DEFAULT_MAX_QUEUED_RUNS_PER_TENANT,
    OVERLOAD_ERROR_CODE,
    DurableRunError,
    DurableRunWorker,
)
from hermes_chat.isolation import TenantIsolation


BASE_SHA = "efed3efde2b02463d9a188cdabfbc227ee8b29ce"
EXPECTED_BRANCH = "codex/jig-185-overload"
EXPECTED_BRANCHES = (EXPECTED_BRANCH, "main")
LOCAL_FAILURE = "local_case_failed"
REQUIRED_LOCAL_CASES = (
    "capacity_measurement",
    "simultaneous_tenants",
    "provider_slowness_and_callback_delay",
    "fair_round_robin",
    "bounded_overload_rejection",
    "waiting_and_active_cancellation",
    "duplicate_start_idempotency",
    "worker_reconstruction_recovery",
    "recovery_backlog_fairness",
)
SINGLE_HOST_LIVE_THRESHOLDS = {
    "p95_admission_wait_ms_greater_than": 30_000,
    "capacity_rejection_rate_greater_than": 0.01,
    "duplicate_invocation_or_answer": False,
    "cross_tenant_result": False,
    "lease_or_cancellation_correctness_failure": False,
}


def _git(*args: str) -> str:
    result = subprocess.run(
        ["git", *args],
        cwd=Path(__file__).resolve().parents[3],
        check=True,
        capture_output=True,
        text=True,
    )
    return result.stdout.strip()


def checkout_identity() -> dict[str, Any]:
    status = _git("status", "--porcelain=v1", "--untracked-files=all")
    source_sha = _git("rev-parse", "HEAD")
    base_present = subprocess.run(
        ["git", "cat-file", "-e", f"{BASE_SHA}^{{commit}}"],
        cwd=Path(__file__).resolve().parents[3],
        capture_output=True,
    ).returncode == 0
    ancestor = False
    if base_present:
        ancestor = subprocess.run(
            ["git", "merge-base", "--is-ancestor", BASE_SHA, source_sha],
            cwd=Path(__file__).resolve().parents[3],
            capture_output=True,
        ).returncode == 0
    return {
        "branch": _git("branch", "--show-current"),
        "source_sha": source_sha,
        "base_sha": BASE_SHA,
        "base_present": base_present,
        "base_is_ancestor": ancestor,
        "clean": not status,
    }


def validate_checkout_identity(identity: dict[str, Any]) -> None:
    actual = checkout_identity()
    if any(identity.get(key) != actual.get(key) for key in (
        "branch",
        "source_sha",
        "base_sha",
        "base_present",
        "base_is_ancestor",
        "clean",
    )):
        raise RuntimeError("JIG-185 local evidence checkout identity changed during validation")
    if identity.get("branch") not in EXPECTED_BRANCHES:
        raise RuntimeError("JIG-185 local evidence requires the candidate branch or canonical main")
    if not identity.get("clean"):
        raise RuntimeError("JIG-185 local evidence requires a clean checkout")
    if not identity.get("base_present") or not identity.get("base_is_ancestor"):
        raise RuntimeError("JIG-185 local evidence requires the verified base ancestry")
    source_sha = identity.get("source_sha")
    if not isinstance(source_sha, str) or len(source_sha) != 40:
        raise RuntimeError("JIG-185 local evidence requires a real checkout source")


def validate_expected_revision(
    identity: dict[str, Any],
    *,
    expected_source_sha: str | None = None,
    expected_candidate_sha: str | None = None,
) -> None:
    expected = expected_candidate_sha or expected_source_sha
    if expected_source_sha and expected_candidate_sha and expected_source_sha != expected_candidate_sha:
        raise RuntimeError("JIG-185 source and candidate revisions must match")
    if expected and expected != identity.get("source_sha"):
        raise RuntimeError("JIG-185 expected revision does not match the clean checkout")


class LocalLoadWorker(DurableRunWorker):
    """Production worker with local control-plane/provider behavior doubles."""

    def __init__(
        self,
        settings: Any,
        isolation: TenantIsolation,
        provider_delay: float = 0.0,
        callback_delay: float = 0.0,
        recovery_payloads: list[dict[str, Any]] | None = None,
    ) -> None:
        super().__init__(settings, isolation)
        self.provider_delay = provider_delay
        self.callback_delay = callback_delay
        self.recovery_queue = deque(dict(payload) for payload in recovery_payloads or [])
        self.recovery_payloads_by_id: dict[str, dict[str, Any]] = {}
        self.recovery_call_count = 0
        self.recovery_release_states: list[str] = []
        self.recovery_released_run_ids: list[str] = []
        self.recovery_claim_tokens: list[str] = []
        self.recovery_released_lease_tokens: list[str] = []
        self.claim_count = 0
        self.invocation_count = 0
        self.completed_count = 0
        self.cancelled_count = 0
        self.cancelled_callback_count = 0
        self.callback_count = 0
        self.release_count = 0
        self.started_tenants: list[str] = []
        self.peak_active = 0
        self.peak_active_per_tenant = 0

    async def _newscraft(
        self,
        method: str,
        path: str,
        body: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        if path == NEWSCRAFT_RUN_CLAIM_PATH:
            self.claim_count += 1
            run_id = str((body or {}).get("run_id") or "")
            return {
                "terminal": False,
                "lease_owner": "local-owner",
                "lease_token": f"local-lease-{self.claim_count}",
                "worker_cursor": 0,
                "state": "researching",
                "run_id": run_id,
            }
        if path == NEWSCRAFT_RUN_CALLBACK_PATH:
            self.callback_count += 1
            if (body or {}).get("event_type") == "run.cancelled":
                self.cancelled_callback_count += 1
            if self.callback_delay:
                await asyncio.sleep(self.callback_delay)
            return {}
        if path.startswith(NEWSCRAFT_RUN_RECOVER_PATH):
            self.recovery_call_count += 1
            query = parse_qs(urlsplit(path).query)
            limit = int(query.get("limit", ["1"])[0])
            runs: list[dict[str, Any]] = []
            for _ in range(min(max(limit, 1), len(self.recovery_queue))):
                payload = dict(self.recovery_queue.popleft())
                run_id = str(payload["run_id"])
                self.recovery_payloads_by_id[run_id] = dict(payload)
                payload["lease_owner"] = f"recovery-owner-{run_id}"
                payload["lease_token"] = f"recovery-token-{self.recovery_call_count}-{run_id}-{len(runs)}"
                self.recovery_claim_tokens.append(payload["lease_token"])
                payload["state"] = "researching"
                runs.append(payload)
            return {"runs": runs}
        if path == NEWSCRAFT_RUN_RELEASE_PATH:
            self.release_count += 1
            payload = body or {}
            run_id = str(payload.get("run_id") or "")
            self.recovery_released_run_ids.append(run_id)
            self.recovery_release_states.append("queued")
            lease_token = str(payload.get("lease_token") or "")
            self.recovery_released_lease_tokens.append(lease_token)
            saved = self.recovery_payloads_by_id.get(run_id)
            if saved is not None and not any(
                str(item.get("run_id") or "") == run_id for item in self.recovery_queue
            ):
                self.recovery_queue.append(dict(saved))
            return {"state": "queued"}
        if path == NEWSCRAFT_RUN_FAIL_PATH:
            return {"state": "failed"}
        return {}

    async def _run(self, job: Any) -> None:
        self.invocation_count += 1
        self.started_tenants.append(job.tenant_key)
        self.peak_active = max(self.peak_active, self.capacity_snapshot()["active_runs"])
        self.peak_active_per_tenant = max(
            self.peak_active_per_tenant,
            max(self._active_by_tenant.values(), default=0),
        )
        try:
            await asyncio.sleep(self.provider_delay)
            if job.stop_reason:
                raise asyncio.CancelledError
            await self._callback(job, "run.started", {"status": "researching"})
            await self._callback(job, "response.output_text.delta", {"delta": "local"})
            await self._callback(job, "response.completed", {"model": "local-fixture"})
            self.completed_count += 1
        except asyncio.CancelledError:
            if job.stop_reason == "cancelled":
                try:
                    await self._publish_cancelled(job)
                    self.cancelled_count += 1
                except Exception:
                    pass
            return


def _settings(
    *,
    active: int = DEFAULT_MAX_ACTIVE_RUNS,
    active_per_tenant: int = DEFAULT_MAX_ACTIVE_RUNS_PER_TENANT,
    queued: int = DEFAULT_MAX_QUEUED_RUNS,
    queued_per_tenant: int = DEFAULT_MAX_QUEUED_RUNS_PER_TENANT,
) -> SimpleNamespace:
    return SimpleNamespace(
        run_api_url="http://127.0.0.1:9/local-only",
        run_api_token="local-run-token",
        session_token="local-service-token",
        internal_agui_url="http://127.0.0.1:9/local-only",
        max_active_runs=active,
        max_active_runs_per_tenant=active_per_tenant,
        max_queued_runs=queued,
        max_queued_runs_per_tenant=queued_per_tenant,
    )


def _payload(index: int, tenant: str) -> dict[str, Any]:
    run_id = f"local-run-{index}"
    return {
        "run_id": run_id,
        "account_id": f"local-account-{index}",
        "tenant_key": tenant,
        "input": {"runId": run_id, "messages": []},
        "seeded_citations": [],
    }


async def _wait_for_idle(worker: DurableRunWorker) -> None:
    for _ in range(1_000):
        snapshot = worker.capacity_snapshot()
        if snapshot["active_runs"] == 0 and snapshot["queued_runs"] == 0:
            return
        await asyncio.sleep(0.002)
    raise AssertionError(LOCAL_FAILURE)


async def _wait_for_recovery_idle(worker: LocalLoadWorker, expected_invocations: int) -> None:
    for _ in range(1_000):
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
        await asyncio.sleep(0.002)
    raise AssertionError(LOCAL_FAILURE)


def _case(name: str, **metrics: Any) -> dict[str, Any]:
    return {"name": name, "state": "PASS", "metrics": metrics}


async def _run_cases(root: Path) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    cases: list[dict[str, Any]] = []

    capacity = LocalLoadWorker(
        _settings(), TenantIsolation(root / "capacity-home", root / "capacity-workspace"), provider_delay=0.02
    )
    await asyncio.gather(*[
        capacity.start(_payload(index, f"tenant-{index % 4}"))
        for index in range(8)
    ])
    await _wait_for_idle(capacity)
    cases.append(_case(
        "capacity_measurement",
        submitted=8,
        invocations=capacity.invocation_count,
        observed_peak_active=capacity.peak_active,
        observed_peak_active_per_tenant=capacity.peak_active_per_tenant,
        configured_global_limit=capacity.limits.max_active_runs,
        configured_per_tenant_limit=capacity.limits.max_active_runs_per_tenant,
    ))
    if (
        capacity.peak_active > DEFAULT_MAX_ACTIVE_RUNS
        or capacity.peak_active_per_tenant > DEFAULT_MAX_ACTIVE_RUNS_PER_TENANT
        or capacity.invocation_count != 8
    ):
        raise AssertionError(LOCAL_FAILURE)
    await capacity.close()

    simultaneous = LocalLoadWorker(
        _settings(active=2, active_per_tenant=1, queued=6, queued_per_tenant=2),
        TenantIsolation(root / "simultaneous-home", root / "simultaneous-workspace"),
        provider_delay=0.015,
    )
    await asyncio.gather(*[
        simultaneous.start(_payload(100 + index, f"tenant-{index % 4}"))
        for index in range(8)
    ])
    peak_queue = simultaneous.capacity_snapshot()["queued_runs"]
    await _wait_for_idle(simultaneous)
    cases.append(_case(
        "simultaneous_tenants",
        submitted=8,
        invocations=simultaneous.invocation_count,
        observed_peak_active=simultaneous.peak_active,
        observed_peak_active_per_tenant=simultaneous.peak_active_per_tenant,
        configured_global_limit=2,
        configured_per_tenant_limit=1,
        peak_queued=peak_queue,
    ))
    if (
        simultaneous.peak_active > 2
        or simultaneous.peak_active_per_tenant > 1
        or simultaneous.invocation_count != 8
    ):
        raise AssertionError(LOCAL_FAILURE)
    await simultaneous.close()

    slow = LocalLoadWorker(
        _settings(active=2, active_per_tenant=1, queued=4, queued_per_tenant=2),
        TenantIsolation(root / "slow-home", root / "slow-workspace"),
        provider_delay=0.03,
        callback_delay=0.01,
    )
    await asyncio.gather(*[
        slow.start(_payload(200 + index, f"tenant-{index}"))
        for index in range(6)
    ])
    slow_peak_queue = slow.capacity_snapshot()["queued_runs"]
    await _wait_for_idle(slow)
    cases.append(_case(
        "provider_slowness_and_callback_delay",
        submitted=6,
        invocations=slow.invocation_count,
        completed=slow.completed_count,
        observed_peak_active=slow.peak_active,
        observed_peak_active_per_tenant=slow.peak_active_per_tenant,
        peak_queued=slow_peak_queue,
        callback_delay_ms=10,
        provider_delay_ms=30,
    ))
    if slow.peak_active > 2 or slow.completed_count != 6:
        raise AssertionError(LOCAL_FAILURE)
    await slow.close()

    fair = LocalLoadWorker(
        _settings(active=1, active_per_tenant=1, queued=4, queued_per_tenant=4),
        TenantIsolation(root / "fair-home", root / "fair-workspace"),
        provider_delay=0.01,
    )
    await fair.start(_payload(300, "tenant-a"))
    await fair.start(_payload(301, "tenant-a"))
    await fair.start(_payload(302, "tenant-a"))
    await fair.start(_payload(303, "tenant-b"))
    await _wait_for_idle(fair)
    fair_order = fair.started_tenants
    cases.append(_case(
        "fair_round_robin",
        submitted=4,
        invocations=fair.invocation_count,
        other_tenant_progressed_before_noisy_tail=("tenant-b" in fair_order and fair_order.index("tenant-b") < fair_order.index("tenant-a", 2)),
        observed_peak_active=fair.peak_active,
        observed_peak_active_per_tenant=fair.peak_active_per_tenant,
    ))
    if "tenant-b" not in fair_order or fair_order.index("tenant-b") > fair_order.index("tenant-a", 2):
        raise AssertionError(LOCAL_FAILURE)
    await fair.close()

    overload = LocalLoadWorker(
        _settings(active=1, active_per_tenant=1, queued=1, queued_per_tenant=1),
        TenantIsolation(root / "overload-home", root / "overload-workspace"),
        provider_delay=0.05,
    )
    await overload.start(_payload(400, "tenant-a"))
    await overload.start(_payload(401, "tenant-b"))
    overload_rejected = False
    try:
        await overload.start(_payload(402, "tenant-c"))
    except DurableRunError as exc:
        overload_rejected = exc.status_code == 429 and exc.code == OVERLOAD_ERROR_CODE
    cases.append(_case(
        "bounded_overload_rejection",
        rejected=overload_rejected,
        observed_active=overload.capacity_snapshot()["active_runs"],
        observed_queued=overload.capacity_snapshot()["queued_runs"],
        configured_queue_limit=1,
    ))
    if not overload_rejected:
        raise AssertionError(LOCAL_FAILURE)
    await overload.close()

    cancellation = LocalLoadWorker(
        _settings(active=1, active_per_tenant=1, queued=2, queued_per_tenant=2),
        TenantIsolation(root / "cancel-home", root / "cancel-workspace"),
        provider_delay=1.0,
    )
    await cancellation.start(_payload(500, "tenant-a"))
    await cancellation.start(_payload(501, "tenant-b"))
    waiting_cancel = await cancellation.cancel("local-run-501", "local-account-501", "tenant-b")
    active_cancel = await cancellation.cancel("local-run-500", "local-account-500", "tenant-a")
    await _wait_for_idle(cancellation)
    cases.append(_case(
        "waiting_and_active_cancellation",
        waiting_state=waiting_cancel["state"],
        active_state=active_cancel["state"],
        cancelled_callbacks=cancellation.cancelled_count,
        cancellation_callback_requests=cancellation.cancelled_callback_count,
        final_active=cancellation.capacity_snapshot()["active_runs"],
        final_queued=cancellation.capacity_snapshot()["queued_runs"],
    ))
    if (
        waiting_cancel["state"] != "not_running"
        or active_cancel["state"] != "cancel_requested"
        or cancellation.cancelled_count != 1
        or cancellation.cancelled_callback_count != 1
    ):
        raise AssertionError(LOCAL_FAILURE)
    await cancellation.close()

    duplicate = LocalLoadWorker(
        _settings(active=1, active_per_tenant=1, queued=2, queued_per_tenant=2),
        TenantIsolation(root / "duplicate-home", root / "duplicate-workspace"),
        provider_delay=0.02,
    )
    duplicate_payload = _payload(600, "tenant-a")
    results = await asyncio.gather(
        duplicate.start(duplicate_payload),
        duplicate.start(duplicate_payload),
    )
    await _wait_for_idle(duplicate)
    duplicate_results = sum(1 for result in results if result.get("duplicate"))
    cases.append(_case(
        "duplicate_start_idempotency",
        start_requests=2,
        duplicate_acknowledgements=duplicate_results,
        claim_requests=duplicate.claim_count,
        invocations=duplicate.invocation_count,
    ))
    if duplicate.claim_count != 1 or duplicate.invocation_count != 1 or duplicate_results != 1:
        raise AssertionError(LOCAL_FAILURE)
    await duplicate.close()

    first = LocalLoadWorker(
        _settings(active=1, active_per_tenant=1, queued=1, queued_per_tenant=1),
        TenantIsolation(root / "restart-one-home", root / "restart-one-workspace"),
        provider_delay=0.2,
    )
    restart_payload = _payload(700, "tenant-a")
    await first.start(restart_payload)
    await asyncio.sleep(0.005)
    saved = first.jobs[restart_payload["run_id"]]
    recovered_payload = {
        **restart_payload,
        "lease_owner": saved.lease_owner,
        "lease_token": saved.lease_token,
        "worker_cursor": saved.worker_cursor,
        "resume_snapshot": {"answer_text": "", "sources": [], "citations": []},
    }
    await first.close()
    second = LocalLoadWorker(
        _settings(active=1, active_per_tenant=1, queued=1, queued_per_tenant=1),
        TenantIsolation(root / "restart-two-home", root / "restart-two-workspace"),
        provider_delay=0.01,
    )
    await second.start_recovered(recovered_payload)
    await _wait_for_idle(second)
    cases.append(_case(
        "worker_reconstruction_recovery",
        same_run_id=True,
        saved_input_reused=recovered_payload["input"] == restart_payload["input"],
        recovered_invocations=second.invocation_count,
        observed_peak_active=second.peak_active,
    ))
    if second.invocation_count != 1:
        raise AssertionError(LOCAL_FAILURE)
    await second.close()

    recovery_payloads = [
        _payload(800, "tenant-noisy"),
        _payload(801, "tenant-noisy"),
        _payload(802, "tenant-noisy"),
        _payload(803, "tenant-quiet"),
        _payload(804, "tenant-noisy"),
        _payload(805, "tenant-noisy"),
    ]
    recovery = LocalLoadWorker(
        _settings(active=4, active_per_tenant=2, queued=4, queued_per_tenant=4),
        TenantIsolation(root / "recovery-home", root / "recovery-workspace"),
        provider_delay=0.01,
        recovery_payloads=recovery_payloads,
    )
    await recovery.recover()
    await _wait_for_recovery_idle(recovery, expected_invocations=len(recovery_payloads))
    returned_ids = recovery.recovery_released_run_ids
    quiet_indices = [
        index for index, tenant in enumerate(recovery.started_tenants) if tenant == "tenant-quiet"
    ]
    noisy_indices = [
        index for index, tenant in enumerate(recovery.started_tenants) if tenant == "tenant-noisy"
    ]
    quiet_tenant_progressed = bool(quiet_indices and len(noisy_indices) >= 3 and quiet_indices[0] < noisy_indices[2])
    recovery_evidence = _case(
        "recovery_backlog_fairness",
        submitted=len(recovery_payloads),
        recovered_invocations=recovery.invocation_count,
        recovery_requests=recovery.recovery_call_count,
        unadmitted_lease_returns=len(returned_ids),
        returned_lease_states=sorted(set(recovery.recovery_release_states)),
        unique_lease_returns=(
            len(recovery.recovery_released_lease_tokens)
            == len(set(recovery.recovery_released_lease_tokens))
        ),
        quiet_tenant_progressed=quiet_tenant_progressed,
        observed_peak_active=recovery.peak_active,
        observed_peak_active_per_tenant=recovery.peak_active_per_tenant,
    )
    cases.append(recovery_evidence)
    if (
        recovery.invocation_count != len(recovery_payloads)
        or recovery.peak_active > 4
        or recovery.peak_active_per_tenant > 2
        or not returned_ids
        or not quiet_tenant_progressed
        or len(recovery.recovery_released_lease_tokens)
        != len(set(recovery.recovery_released_lease_tokens))
        or recovery.recovery_release_states != ["queued"] * len(returned_ids)
    ):
        raise AssertionError(LOCAL_FAILURE)
    await recovery.close()

    return cases, {
        "safe_concurrent_runs_observed": capacity.peak_active,
        "method": "production DurableRunWorker with deterministic in-process provider and callback doubles",
        "thresholds": {
            "max_active_runs": DEFAULT_MAX_ACTIVE_RUNS,
            "max_active_runs_per_tenant": DEFAULT_MAX_ACTIVE_RUNS_PER_TENANT,
            "max_queued_runs": DEFAULT_MAX_QUEUED_RUNS,
            "max_queued_runs_per_tenant": DEFAULT_MAX_QUEUED_RUNS_PER_TENANT,
        },
        "local_only": True,
        "production_capacity_proven": False,
    }


def build_record(cases: list[dict[str, Any]], measurement: dict[str, Any], identity: dict[str, Any]) -> dict[str, Any]:
    passed = sum(case.get("state") == "PASS" for case in cases)
    names = [case.get("name") for case in cases]
    missing = [name for name in REQUIRED_LOCAL_CASES if name not in names]
    duplicate_count = sum(max(0, names.count(name) - 1) for name in set(names))
    failed = sum(case.get("state") != "PASS" for case in cases)
    matrix_failures = failed + len(missing) + duplicate_count
    local_passed = (
        len(cases) == len(REQUIRED_LOCAL_CASES)
        and not missing
        and duplicate_count == 0
        and failed == 0
    )
    return {
        "ticket": "JIG-185",
        "scope": "local_deterministic_scheduler_evidence",
        "checkout": identity,
        "candidate_sha": identity.get("source_sha"),
        "local_result": "PASS" if local_passed else "FAIL",
        "case_counts": {"pass": passed, "fail": matrix_failures, "skip": 0, "blocked": 0},
        "cases": cases,
        "capacity_measurement": measurement,
        "single_host_live_thresholds": SINGLE_HOST_LIVE_THRESHOLDS,
        "release_decision": "BLOCK RELEASE",
        "blocked_gates": [
            "live_single_host_capacity",
            "real_browser_and_persistent_repository_load",
            "real_provider_slowness_and_callback_delay",
            "real_process_restart_recovery",
        ],
        "blocked_reason": "requires separately authorized production or persistent integration evidence",
        "second_host_decision": "retain_single_host_until_an_authorized_live_threshold_miss",
    }


def _write_record(path: Path, record: dict[str, Any]) -> str:
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    encoded = json.dumps(record, indent=2, sort_keys=True) + "\n"
    path.write_text(encoded)
    path.chmod(0o600)
    return hashlib.sha256(encoded.encode()).hexdigest()


async def run_local_matrix(
    *,
    expected_source_sha: str | None = None,
    expected_candidate_sha: str | None = None,
) -> dict[str, Any]:
    identity = checkout_identity()
    validate_checkout_identity(identity)
    validate_expected_revision(
        identity,
        expected_source_sha=expected_source_sha,
        expected_candidate_sha=expected_candidate_sha,
    )
    with tempfile.TemporaryDirectory(prefix="newscraft-jig185-") as temp_dir:
        cases, measurement = await _run_cases(Path(temp_dir))
    return build_record(cases, measurement, identity)


def default_output_path(repo_root: Path) -> Path:
    stamp = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
    return repo_root / ".tmp" / "jig-185" / f"load-result-{stamp}.json"


def main(argv: list[str] | None = None) -> int:
    repo_root = Path(__file__).resolve().parents[3]
    parser = argparse.ArgumentParser(description="Run the local JIG-185 capacity matrix")
    parser.add_argument("--output", type=Path, default=None, help="redacted local result path")
    parser.add_argument("--source-sha", default=None, help="expected clean checkout source SHA")
    parser.add_argument("--candidate-sha", default=None, help="expected clean checkout candidate SHA")
    args = parser.parse_args(argv)
    output = args.output or default_output_path(repo_root)
    try:
        record = asyncio.run(
            run_local_matrix(
                expected_source_sha=args.source_sha,
                expected_candidate_sha=args.candidate_sha,
            )
        )
        digest = _write_record(output, record)
        print(
            f"JIG-185_LOCAL_LOAD local_result={record['local_result']} "
            f"release_decision={record['release_decision']} record_sha256={digest}"
        )
        print(f"record_path={output}")
        return 0 if record["local_result"] == "PASS" and record["release_decision"] == "RELEASE" else 1
    except Exception:
        identity: dict[str, Any] | None = None
        try:
            identity = checkout_identity()
        except Exception:
            pass
        failure = {
            "ticket": "JIG-185",
            "scope": "local_deterministic_scheduler_evidence",
            **({"checkout": identity} if identity is not None else {}),
            **({"candidate_sha": identity.get("source_sha")} if identity is not None else {}),
            "local_result": "FAIL",
            "case_counts": {"pass": 0, "fail": 1, "skip": 0, "blocked": 0},
            "failure": LOCAL_FAILURE,
            "single_host_live_thresholds": SINGLE_HOST_LIVE_THRESHOLDS,
            "release_decision": "BLOCK RELEASE",
        }
        digest = _write_record(output, failure)
        print(f"JIG-185_LOCAL_LOAD local_result=FAIL record_sha256={digest}")
        print(f"record_path={output}")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
