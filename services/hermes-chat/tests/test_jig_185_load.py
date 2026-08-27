from __future__ import annotations

import asyncio
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parent))

from hermes_chat.durable import DurableConcurrencyLimits, DurableRunError
from hermes_chat.contracts import NEWSCRAFT_RUN_CLAIM_PATH, NEWSCRAFT_RUN_FAIL_PATH
from hermes_chat.isolation import TenantIsolation
from jig_185_load import (
    BASE_SHA,
    EXPECTED_BRANCH,
    LocalLoadWorker,
    _payload,
    _settings,
    _wait_for_idle,
    build_record,
    main,
    REQUIRED_LOCAL_CASES,
    validate_expected_revision,
    validate_checkout_identity,
)


class Jig185LoadTests(unittest.IsolatedAsyncioTestCase):
    def _worker(self, root: str, **limits: int) -> LocalLoadWorker:
        return LocalLoadWorker(
            _settings(**limits),
            TenantIsolation(Path(root) / "home", Path(root) / "workspace"),
            provider_delay=0.1,
        )

    async def test_waiting_runs_hold_no_lease_and_overload_is_stable(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            worker = self._worker(root, active=1, active_per_tenant=1, queued=1, queued_per_tenant=1)
            try:
                await worker.start(_payload(1, "tenant-a"))
                await worker.start(_payload(2, "tenant-b"))
                self.assertFalse(worker.jobs["local-run-2"].lease_acquired)
                self.assertEqual(worker.claim_count, 1)

                with self.assertRaises(DurableRunError) as context:
                    await worker.start(_payload(3, "tenant-c"))
                self.assertEqual(context.exception.status_code, 429)
                self.assertEqual(context.exception.code, "overloaded")
                self.assertEqual(worker.capacity_snapshot()["rejected_runs"], 1)
                self.assertNotIn("tenant-a", json.dumps(worker.capacity_snapshot()))
                self.assertNotIn("local-account", json.dumps(worker.capacity_snapshot()))

                self.assertEqual(
                    (await worker.cancel("local-run-2", "local-account-2", "tenant-b"))["state"],
                    "not_running",
                )
                self.assertEqual(
                    (await worker.cancel("local-run-1", "local-account-1", "tenant-a"))["state"],
                    "cancel_requested",
                )
                self.assertEqual(
                    (await worker.cancel("local-run-1", "local-account-1", "tenant-a"))["state"],
                    "not_running",
                )
                await _wait_for_idle(worker)
                self.assertEqual(worker.capacity_snapshot()["active_runs"], 0)
                self.assertEqual(worker.capacity_snapshot()["queued_runs"], 0)
            finally:
                await worker.close()

    async def test_round_robin_admits_a_quiet_tenant_before_noisy_tail(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            worker = self._worker(root, active=1, active_per_tenant=1, queued=4, queued_per_tenant=4)
            try:
                await worker.start(_payload(10, "tenant-a"))
                await worker.start(_payload(11, "tenant-a"))
                await worker.start(_payload(12, "tenant-a"))
                await worker.start(_payload(13, "tenant-b"))
                await _wait_for_idle(worker)

                self.assertEqual(worker.started_tenants[0], "tenant-a")
                self.assertLess(worker.started_tenants.index("tenant-b"), worker.started_tenants.index("tenant-a", 2))
            finally:
                await worker.close()

    async def test_per_tenant_queue_boundary_rejects_only_that_tenant(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            worker = self._worker(root, active=1, active_per_tenant=1, queued=3, queued_per_tenant=1)
            try:
                await worker.start(_payload(14, "tenant-a"))
                await worker.start(_payload(15, "tenant-a"))
                with self.assertRaises(DurableRunError) as context:
                    await worker.start(_payload(16, "tenant-a"))
                self.assertEqual(context.exception.code, "overloaded")
                self.assertEqual(worker.capacity_snapshot()["queued_runs"], 1)
                await worker.cancel("local-run-14", "local-account-14", "tenant-a")
                await worker.cancel("local-run-15", "local-account-15", "tenant-a")
                await _wait_for_idle(worker)
            finally:
                await worker.close()

    async def test_recovered_run_releases_its_slot_after_completion(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            worker = self._worker(root, active=1, active_per_tenant=1, queued=1, queued_per_tenant=1)
            try:
                result = await worker.start_recovered({
                    **_payload(20, "tenant-a"),
                    "lease_owner": "recovery-owner",
                    "lease_token": "recovery-token",
                    "worker_cursor": 3,
                })
                self.assertEqual(result["state"], "recovered")
                await _wait_for_idle(worker)
                self.assertEqual(worker.invocation_count, 1)
                self.assertEqual(worker.capacity_snapshot()["active_runs"], 0)
            finally:
                await worker.close()

    async def test_provider_failure_releases_capacity_without_a_stuck_queue(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            worker = self._worker(root, active=1, active_per_tenant=1, queued=1, queued_per_tenant=1)

            async def fail_provider(_job: object) -> None:
                raise RuntimeError("local provider failure")

            worker._run = fail_provider  # type: ignore[method-assign]
            try:
                await worker.start(_payload(25, "tenant-a"))
                await _wait_for_idle(worker)
                self.assertEqual(worker.capacity_snapshot()["active_runs"], 0)
                self.assertEqual(worker.capacity_snapshot()["queued_runs"], 0)
                self.assertEqual(worker.release_count, 0)
            finally:
                await worker.close()

    async def test_recovery_does_not_replace_a_waiting_job_or_hold_its_lease(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            worker = self._worker(root, active=1, active_per_tenant=1, queued=2, queued_per_tenant=2)
            try:
                await worker.start(_payload(26, "tenant-a"))
                await worker.start(_payload(27, "tenant-b"))
                recovered = await worker.start_recovered({
                    **_payload(27, "tenant-b"),
                    "lease_owner": "recovery-owner",
                    "lease_token": "recovery-token",
                })
                self.assertEqual(recovered, {
                    "accepted": True,
                    "duplicate": True,
                    "run_id": "local-run-27",
                    "state": "queued",
                })
                self.assertEqual(worker.release_count, 1)
                await worker.cancel("local-run-26", "local-account-26", "tenant-a")
                await worker.cancel("local-run-27", "local-account-27", "tenant-b")
                await _wait_for_idle(worker)
            finally:
                await worker.close()

    async def test_duplicate_start_has_one_claim_and_one_invocation(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            worker = self._worker(root, active=1, active_per_tenant=1, queued=1, queued_per_tenant=1)
            try:
                payload = _payload(30, "tenant-a")
                results = await asyncio.gather(worker.start(payload), worker.start(payload))
                await _wait_for_idle(worker)
                self.assertEqual(worker.claim_count, 1)
                self.assertEqual(worker.invocation_count, 1)
                self.assertEqual(sum(bool(result["duplicate"]) for result in results), 1)
            finally:
                await worker.close()

    async def test_deferred_claim_failure_persists_once_and_removes_local_ownership(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            worker = self._worker(root, active=1, active_per_tenant=1, queued=2, queued_per_tenant=2)
            failure_calls: list[dict[str, object]] = []
            original_newscraft = worker._newscraft

            async def deferred_failure(method: str, path: str, body: dict[str, object] | None = None) -> dict[str, object]:
                if path == NEWSCRAFT_RUN_CLAIM_PATH and (body or {}).get("run_id") == "local-run-41":
                    raise DurableRunError("network", 503, "network")
                if path == NEWSCRAFT_RUN_FAIL_PATH:
                    failure_calls.append(dict(body or {}))
                    return {"state": "failed"}
                return await original_newscraft(method, path, body)

            worker._newscraft = deferred_failure  # type: ignore[method-assign]
            try:
                await worker.start(_payload(40, "tenant-a"))
                queued = await worker.start(_payload(41, "tenant-b"))
                self.assertEqual(queued["state"], "queued")
                await _wait_for_idle(worker)

                self.assertEqual(len(failure_calls), 1)
                self.assertEqual(failure_calls[0]["run_id"], "local-run-41")
                self.assertNotIn("local-run-41", worker.jobs)
                self.assertEqual(worker.invocation_count, 1)
                self.assertEqual(worker.capacity_snapshot()["queued_runs"], 0)
            finally:
                await worker.close()

    async def test_deferred_terminal_and_lease_conflict_settle_without_invocation(self) -> None:
        outcomes = (
            DurableRunError("lease conflict", 409, "lease_conflict"),
            {"terminal": True, "duplicate": True, "run_id": "local-run-51", "state": "complete"},
        )
        for outcome in outcomes:
            with self.subTest(outcome=outcome), tempfile.TemporaryDirectory() as root:
                worker = self._worker(root, active=1, active_per_tenant=1, queued=2, queued_per_tenant=2)
                original_newscraft = worker._newscraft

                async def deferred_outcome(
                    method: str, path: str, body: dict[str, object] | None = None
                ) -> dict[str, object]:
                    if path == NEWSCRAFT_RUN_CLAIM_PATH and (body or {}).get("run_id") == "local-run-51":
                        worker.claim_count += 1
                        if isinstance(outcome, DurableRunError):
                            raise outcome
                        return dict(outcome)
                    return await original_newscraft(method, path, body)

                worker._newscraft = deferred_outcome  # type: ignore[method-assign]
                try:
                    await worker.start(_payload(50, "tenant-a"))
                    queued = await worker.start(_payload(51, "tenant-b"))
                    self.assertEqual(queued["state"], "queued")
                    await _wait_for_idle(worker)
                    self.assertNotIn("local-run-51", worker.jobs)
                    self.assertEqual(worker.invocation_count, 1)
                    self.assertEqual(worker.claim_count, 2)
                finally:
                    await worker.close()

    async def test_deferred_claim_failure_settles_after_start_disconnect(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            worker = self._worker(root, active=1, active_per_tenant=1, queued=1, queued_per_tenant=1)
            claim_started = asyncio.Event()
            release_claim = asyncio.Event()
            failure_calls: list[dict[str, object]] = []

            async def delayed_failure(method: str, path: str, body: dict[str, object] | None = None) -> dict[str, object]:
                if path == NEWSCRAFT_RUN_CLAIM_PATH:
                    claim_started.set()
                    await release_claim.wait()
                    raise DurableRunError("network", 503, "network")
                if path == NEWSCRAFT_RUN_FAIL_PATH:
                    failure_calls.append(dict(body or {}))
                    return {"state": "failed"}
                return {}

            worker._newscraft = delayed_failure  # type: ignore[method-assign]
            try:
                start_task = asyncio.create_task(worker.start(_payload(60, "tenant-a")))
                await claim_started.wait()
                start_task.cancel()
                with self.assertRaises(asyncio.CancelledError):
                    await start_task
                release_claim.set()
                await _wait_for_idle(worker)
                self.assertEqual(len(failure_calls), 1)
                self.assertNotIn("local-run-60", worker.jobs)
                self.assertEqual(worker.invocation_count, 0)
            finally:
                release_claim.set()
                await worker.close()

    async def test_recovery_refills_capacity_past_a_noisy_tenant(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            payloads = [
                _payload(70, "tenant-noisy"),
                _payload(71, "tenant-noisy"),
                _payload(72, "tenant-noisy"),
                _payload(73, "tenant-quiet"),
                _payload(74, "tenant-noisy"),
                _payload(75, "tenant-noisy"),
            ]
            worker = LocalLoadWorker(
                _settings(active=4, active_per_tenant=2, queued=4, queued_per_tenant=4),
                TenantIsolation(Path(root) / "home", Path(root) / "workspace"),
                provider_delay=0.01,
                recovery_payloads=payloads,
            )
            try:
                await worker.recover()
                for _ in range(1_000):
                    if (
                        worker.invocation_count == len(payloads)
                        and worker.capacity_snapshot()["active_runs"] == 0
                        and not worker.recovery_queue
                        and (worker._recovery_task is None or worker._recovery_task.done())
                    ):
                        break
                    await asyncio.sleep(0.002)
                else:
                    self.fail("recovery backlog did not drain")
                self.assertEqual(worker.invocation_count, len(payloads))
                self.assertGreaterEqual(worker.recovery_call_count, 2)
                self.assertTrue(worker.recovery_released_run_ids)
                self.assertEqual(
                    len(worker.recovery_released_lease_tokens),
                    len(set(worker.recovery_released_lease_tokens)),
                )
                self.assertEqual(set(worker.recovery_release_states), {"queued"})
                self.assertLessEqual(worker.peak_active, 4)
                self.assertLessEqual(worker.peak_active_per_tenant, 2)
            finally:
                await worker.close()

    async def test_repeated_active_cancellation_publishes_one_terminal_event(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            worker = self._worker(root, active=1, active_per_tenant=1, queued=1, queued_per_tenant=1)
            try:
                await worker.start(_payload(31, "tenant-a"))
                job = worker.jobs["local-run-31"]
                job.stop_reason = "cancelled"
                await asyncio.gather(worker._publish_cancelled(job), worker._publish_cancelled(job))
                self.assertEqual(worker.cancelled_callback_count, 1)
            finally:
                await worker.close()


class Jig185ConfigurationTests(unittest.TestCase):
    def test_empty_local_matrix_cannot_produce_a_pass_record(self) -> None:
        record = build_record(
            [],
            {"local_only": True},
            {
                "branch": EXPECTED_BRANCH,
                "source_sha": "a" * 40,
                "base_sha": BASE_SHA,
                "base_present": True,
                "base_is_ancestor": True,
                "clean": True,
            },
        )
        self.assertEqual(record["local_result"], "FAIL")
        self.assertGreater(record["case_counts"]["fail"], 0)

    def test_local_record_requires_the_complete_unique_case_matrix(self) -> None:
        identity = {
            "branch": EXPECTED_BRANCH,
            "source_sha": "a" * 40,
            "base_sha": BASE_SHA,
            "base_present": True,
            "base_is_ancestor": True,
            "clean": True,
        }
        partial = [{"name": REQUIRED_LOCAL_CASES[0], "state": "PASS"}]
        record = build_record(partial, {"local_only": True}, identity)
        self.assertEqual(record["local_result"], "FAIL")
        self.assertGreater(record["case_counts"]["fail"], 0)
        duplicate = [{"name": name, "state": "PASS"} for name in REQUIRED_LOCAL_CASES]
        duplicate.append({"name": REQUIRED_LOCAL_CASES[0], "state": "PASS"})
        record = build_record(duplicate, {"local_only": True}, identity)
        self.assertEqual(record["local_result"], "FAIL")
        self.assertGreater(record["case_counts"]["fail"], 0)

        unknown = [{"name": name, "state": "PASS"} for name in REQUIRED_LOCAL_CASES]
        unknown[-1] = {"name": "unlisted-gate", "state": "PASS"}
        record = build_record(unknown, {"local_only": True}, identity)
        self.assertEqual(record["local_result"], "FAIL")
        self.assertGreater(record["case_counts"]["fail"], 0)

    def test_local_record_accepts_candidate_or_main_and_rejects_unrelated_branch(self) -> None:
        import jig_185_load

        for branch in (EXPECTED_BRANCH, "main"):
            valid = {
                "branch": branch,
                "source_sha": "a" * 40,
                "base_sha": BASE_SHA,
                "base_present": True,
                "base_is_ancestor": True,
                "clean": True,
            }
            with self.subTest(branch=branch), patch.object(jig_185_load, "checkout_identity", return_value=valid):
                validate_checkout_identity(valid)

        valid = {
            "branch": EXPECTED_BRANCH,
            "source_sha": "a" * 40,
            "base_sha": BASE_SHA,
            "base_present": True,
            "base_is_ancestor": True,
            "clean": True,
        }
        with patch.object(jig_185_load, "checkout_identity", return_value=valid):
            for field, value in (
                ("branch", "unrelated-branch"),
                ("clean", False),
                ("base_present", False),
                ("base_is_ancestor", False),
                ("source_sha", "forged"),
            ):
                with self.subTest(field=field, value=value):
                    with self.assertRaises(RuntimeError):
                        validate_checkout_identity({**valid, field: value})

    def test_candidate_and_main_revision_arguments_must_match_actual_source(self) -> None:
        valid = {
            "branch": EXPECTED_BRANCH,
            "source_sha": "a" * 40,
            "base_sha": BASE_SHA,
            "base_present": True,
            "base_is_ancestor": True,
            "clean": True,
        }
        validate_expected_revision(valid, expected_source_sha="a" * 40, expected_candidate_sha="a" * 40)
        with self.assertRaises(RuntimeError):
            validate_expected_revision(valid, expected_source_sha="b" * 40)
        with self.assertRaises(RuntimeError):
            validate_expected_revision(valid, expected_candidate_sha="b" * 40)
        with self.assertRaises(RuntimeError):
            validate_expected_revision(valid, expected_source_sha="a" * 40, expected_candidate_sha="b" * 40)

    def test_public_command_uses_locked_hermes_project_environment(self) -> None:
        package = json.loads((Path(__file__).parents[3] / "package.json").read_text())
        self.assertEqual(
            package["scripts"]["canary:jig185"],
            "uv run --locked --project services/hermes-chat python services/hermes-chat/tests/jig_185_load.py",
        )

    def test_public_runner_passes_revisions_and_blocks_release_for_unrun_gates(self) -> None:
        identity = {
            "branch": EXPECTED_BRANCH,
            "source_sha": "a" * 40,
            "base_sha": BASE_SHA,
            "base_present": True,
            "base_is_ancestor": True,
            "clean": True,
        }
        record = build_record(
            [{"name": name, "state": "PASS"} for name in REQUIRED_LOCAL_CASES],
            {"local_only": True},
            identity,
        )
        observed: dict[str, str | None] = {}

        async def fake_matrix(**kwargs: str | None) -> dict[str, object]:
            observed.update(kwargs)
            return record

        with tempfile.TemporaryDirectory() as root, patch(
            "jig_185_load.run_local_matrix",
            side_effect=fake_matrix,
        ):
            output = Path(root) / "result.json"
            self.assertEqual(
                main([
                    "--output",
                    str(output),
                    "--source-sha",
                    "a" * 40,
                    "--candidate-sha",
                    "a" * 40,
                ]),
                1,
            )
            self.assertEqual(observed, {
                "expected_source_sha": "a" * 40,
                "expected_candidate_sha": "a" * 40,
            })
            self.assertEqual(json.loads(output.read_text())["release_decision"], "BLOCK RELEASE")

    def test_concurrency_limits_fail_closed_for_invalid_values(self) -> None:
        base = {
            "max_active_runs": 4,
            "max_active_runs_per_tenant": 2,
            "max_queued_runs": 16,
            "max_queued_runs_per_tenant": 4,
        }
        for name, value in (
            ("max_active_runs", 0),
            ("max_active_runs_per_tenant", 5),
            ("max_queued_runs", 0),
            ("max_queued_runs_per_tenant", 17),
            ("max_active_runs", True),
        ):
            with self.subTest(name=name, value=value):
                values = {**base, name: value}
                with self.assertRaises(RuntimeError):
                    DurableConcurrencyLimits.from_settings(SimpleNamespace(**values))

    def test_environment_limits_are_validated_before_service_start(self) -> None:
        from hermes_chat.service import settings_from_env

        with tempfile.TemporaryDirectory() as root:
            environment = {
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
            for name, value in (
                ("NEWSCRAFT_HERMES_MAX_ACTIVE_RUNS", "0"),
                ("NEWSCRAFT_HERMES_MAX_ACTIVE_RUNS_PER_TENANT", "5"),
                ("NEWSCRAFT_HERMES_MAX_QUEUED_RUNS", "0"),
                ("NEWSCRAFT_HERMES_MAX_QUEUED_RUNS_PER_TENANT", "17"),
            ):
                with self.subTest(name=name, value=value), patch.dict(
                    os.environ, {**environment, name: value}, clear=True
                ):
                    with self.assertRaises(RuntimeError):
                        settings_from_env()


if __name__ == "__main__":
    unittest.main()
