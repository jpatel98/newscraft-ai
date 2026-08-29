from __future__ import annotations

import asyncio
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parent))

import jig_197_load
from jig_197_load import (
    ALLOWED_BRANCHES,
    BASE_SHA,
    EXPECTED_BRANCH,
    REQUIRED_LOCAL_CASES,
    _empty_measurement,
    _failure_cases,
    _percentile,
    build_record,
    main,
    release_exit_code,
    validate_checkout_identity,
    validate_record,
    write_record,
)


def valid_identity(branch: str = EXPECTED_BRANCH) -> dict[str, object]:
    return {
        "branch": branch,
        "source_sha": "a" * 40,
        "base_sha": BASE_SHA,
        "base_present": True,
        "commit_present": True,
        "base_is_ancestor": True,
        "clean": True,
    }


def passing_cases() -> list[dict[str, object]]:
    cases: list[dict[str, object]] = []
    for case in jig_197_load._failure_cases():
        case["state"] = "PASS"
        metrics = case["metrics"]
        if case["name"] == "capacity_load_levels":
            for level in metrics["levels"]:
                level.update({
                    "submitted": 1,
                    "accepted": 1,
                    "invocations": 1,
                    "completed": 1,
                })
            metrics.update({
                "safe_concurrent_runs_observed": 1,
                "all_levels_completed": True,
            })
        elif case["name"] == "simultaneous_tenants":
            metrics.update({
                "submitted": 1,
                "accepted": 1,
                "invocations": 1,
                "binding_rejections": 1,
                "all_tenants_progressed": True,
            })
        elif case["name"] == "provider_callback_control_plane_delay":
            metrics.update({
                "submitted": 1,
                "accepted": 1,
                "invocations": 1,
                "completed": 1,
                "control_plane_calls": 1,
                "callback_calls": 1,
            })
        elif case["name"] == "fair_round_robin":
            metrics.update({
                "submitted": 1,
                "invocations": 1,
                "quiet_tenant_progressed_before_noisy_tail": True,
                "fair_dispatch": True,
            })
        elif case["name"] == "bounded_overload_rejection":
            metrics.update({
                "accepted": 1,
                "rejected": 0,
                "no_extra_invocation": True,
            })
        elif case["name"] == "waiting_and_active_cancellation":
            metrics.update({
                "waiting_cancelled": 1,
                "cancellation_terminal_callbacks": 1,
                "cancel_requests": 2,
                "capacity_released_once": True,
            })
        elif case["name"] == "duplicate_start_idempotency":
            metrics.update({
                "start_requests": 2,
                "duplicate_acknowledgements": 1,
                "claim_requests": 1,
                "invocations": 1,
                "one_logical_run": True,
            })
        elif case["name"] == "worker_reconstruction_recovery":
            metrics.update({
                "same_run_id": True,
                "saved_input_reused": True,
                "recovered_invocations": 1,
                "reconstructed_workers": 1,
                "no_duplicate_invocation": True,
            })
        else:
            metrics.update({
                "submitted": 1,
                "recovered_invocations": 1,
                "recovery_requests": 1,
                "unadmitted_lease_returns": 1,
                "returned_lease_state": "queued",
                "unique_lease_returns": True,
                "quiet_tenant_progressed": True,
                "backlog_drained": True,
                "no_duplicate_invocations": True,
            })
        cases.append(case)
    return cases


class Jig197RunnerTests(unittest.TestCase):
    def test_percentile_is_bounded_and_interpolated(self) -> None:
        self.assertEqual(_percentile([], 0.95), 0.0)
        self.assertEqual(_percentile([4.0], 0.95), 4.0)
        self.assertEqual(_percentile([0.0, 10.0], 0.95), 9.5)
        self.assertEqual(_percentile([-1.0, 3.0], 0.5), 1.5)

    def test_complete_matrix_and_unknown_case_fail_closed(self) -> None:
        record = build_record(passing_cases(), _empty_measurement(), valid_identity())
        self.assertEqual(record["local_result"], "PASS")
        self.assertTrue(validate_record(record))
        unknown = passing_cases()
        unknown[0] = {"name": "unknown_case", "state": "PASS", "metrics": {}}
        forged = build_record(unknown, _empty_measurement(), valid_identity())
        self.assertEqual(forged["local_result"], "FAIL")
        with self.assertRaises(jig_197_load.RecordValidationError):
            validate_record(forged)

    def test_revision_branch_and_clean_identity_guards(self) -> None:
        for branch in ALLOWED_BRANCHES:
            identity = valid_identity(branch)
            validate_checkout_identity(identity, actual=identity)
        for field, value in (
            ("branch", "unrelated-branch"),
            ("source_sha", "forged"),
            ("base_sha", "b" * 40),
            ("base_present", False),
            ("commit_present", False),
            ("base_is_ancestor", False),
            ("clean", False),
        ):
            with self.subTest(field=field):
                identity = {**valid_identity(), field: value}
                with self.assertRaises(RuntimeError):
                    validate_checkout_identity(identity, actual=identity)

    def test_record_revision_binding_and_blocked_release(self) -> None:
        record = build_record(passing_cases(), _empty_measurement(), valid_identity())
        self.assertEqual(record["local_result"], "PASS")
        self.assertEqual(record["release_decision"], "BLOCK RELEASE")
        self.assertEqual(release_exit_code(record), 1)
        forged = json.loads(json.dumps(record))
        forged["candidate"]["candidate_sha"] = "b" * 40
        with self.assertRaises(jig_197_load.RecordValidationError):
            validate_record(forged)

    def test_record_redaction_and_exact_schema(self) -> None:
        record = build_record(passing_cases(), _empty_measurement(), valid_identity())
        for forbidden in ("local-account", "tenant-", "fixture-answer", "http://", "Bearer"):
            self.assertNotIn(forbidden, json.dumps(record))
        for location, value in (
            (record, {"extra": 1}),
            (record["capacity_measurement"], {"extra": 1}),
            (record["gates"][0], {"extra": 1}),
        ):
            mutated = json.loads(json.dumps(record))
            if location is record:
                target = mutated
            elif location is record["capacity_measurement"]:
                target = mutated["capacity_measurement"]
            else:
                target = mutated["gates"][0]
            target.update(value)
            with self.subTest(location=location):
                with self.assertRaises(jig_197_load.RecordValidationError):
                    validate_record(mutated)
        for value in ("/private/prod/snapshot.sql", "SELECT * FROM accounts", "Bearer super-secret-value"):
            mutated = json.loads(json.dumps(record))
            mutated["extra"] = value
            with self.subTest(value=value):
                with self.assertRaises(jig_197_load.RecordValidationError):
                    validate_record(mutated)

    def test_safe_failure_record_preserves_blocked_gate_semantics(self) -> None:
        record = build_record(
            _failure_cases(),
            _empty_measurement(),
            valid_identity(),
            failure_reason="required_local_case_failed",
        )
        self.assertEqual(record["local_result"], "FAIL")
        self.assertEqual(record["case_counts"], {"pass": 0, "fail": 9, "skip": 0, "blocked": 0})
        self.assertEqual(release_exit_code(record), 1)
        self.assertTrue(validate_record(record))

    def test_checkout_drift_is_rechecked_before_record_construction(self) -> None:
        initial = valid_identity()
        drifted = {**initial, "clean": False}

        async def fake_cases(_root: Path) -> tuple[list[dict[str, object]], dict[str, object]]:
            return passing_cases(), _empty_measurement()

        with patch.object(jig_197_load, "checkout_identity", side_effect=[initial, drifted]), patch.object(
            jig_197_load, "_run_cases", side_effect=fake_cases
        ):
            record = asyncio.run(jig_197_load.run_local_matrix())
        self.assertEqual(record["local_result"], "FAIL")
        self.assertEqual(record["failure_reason"], "checkout_changed")
        self.assertEqual(record["checkout"]["clean"], False)
        self.assertEqual(release_exit_code(record), 1)

    def test_private_record_writer_uses_private_mode(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            repo_root = Path(root)
            target = repo_root / ".tmp" / "jig-197" / "result.json"
            record = build_record(passing_cases(), _empty_measurement(), valid_identity())
            written = write_record(target, record, repo_root=repo_root)
            self.assertEqual(written["mode"], 0o600)
            self.assertEqual(target.parent.stat().st_mode & 0o777, 0o700)
            self.assertTrue(validate_record(json.loads(target.read_text())))

    def test_public_package_command_is_locked_and_local(self) -> None:
        package = json.loads((Path(__file__).parents[3] / "package.json").read_text())
        self.assertEqual(
            package["scripts"]["canary:jig197"],
            "uv run --locked --project services/hermes-chat python services/hermes-chat/tests/jig_197_load.py",
        )

    def test_main_writes_blocked_record_and_returns_nonzero(self) -> None:
        with tempfile.TemporaryDirectory() as root, patch.object(
            jig_197_load,
            "run_local_matrix",
            return_value=build_record(passing_cases(), _empty_measurement(), valid_identity()),
        ), patch.object(jig_197_load, "REPO_ROOT", Path(root)):
            output = Path(root) / ".tmp" / "jig-197" / "result.json"
            self.assertEqual(
                main(["--output", str(output), "--source-sha", "a" * 40, "--candidate-sha", "a" * 40]),
                1,
            )
            self.assertEqual(json.loads(output.read_text())["release_decision"], "BLOCK RELEASE")


class Jig197LocalMatrixTests(unittest.IsolatedAsyncioTestCase):
    async def test_local_matrix_exercises_all_required_cases(self) -> None:
        with tempfile.TemporaryDirectory(prefix="jig197-test-") as root:
            cases, measurement = await jig_197_load._run_cases(Path(root))
        self.assertEqual([case["name"] for case in cases], list(REQUIRED_LOCAL_CASES))
        self.assertTrue(all(case["state"] == "PASS" for case in cases))
        self.assertLessEqual(measurement["safe_concurrent_runs_observed"], 4)
        self.assertLessEqual(measurement["peak_queued_runs"], 16)
        self.assertEqual(measurement["duplicate_invocations"], 0)
        self.assertEqual(measurement["duplicate_answers"], 0)
        self.assertEqual(measurement["cross_tenant_failures"], 0)
        self.assertFalse(measurement["production_capacity_proven"])


if __name__ == "__main__":
    unittest.main()
