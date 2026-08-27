from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from jig_183_canary import (
    ALLOWED_BRANCHES,
    GATE_STATES,
    LOCAL_GATE_NAMES,
    LIVE_GATE_NAMES,
    VERIFIED_BASE_SHA,
    CanaryFailure,
    CheckoutIdentity,
    assert_release_record_redacted,
    build_release_record,
    local_exit_code,
    release_decision,
    required_live_gates,
    verify_checkout_identity,
)
from jig_183_canary import _test_counts


CANDIDATE_SHA = "b14a36ba767eb476e99e1134d934649e059b163c"
REPO_ROOT = Path(__file__).resolve().parents[3]


class FakeGit:
    def __init__(
        self,
        *,
        head: str = CANDIDATE_SHA,
        branch: str = ALLOWED_BRANCHES[0],
        status: str = "",
        non_ancestor: bool = False,
        missing_commits: tuple[str, ...] = (),
    ) -> None:
        self.head = head
        self.branch = branch
        self.status = status
        self.non_ancestor = non_ancestor
        self.missing_commits = set(missing_commits)

    def __call__(self, _repo_root: Path, args: tuple[str, ...]) -> str:
        if args == ("branch", "--show-current"):
            return self.branch
        if args == ("status", "--porcelain", "--untracked-files=all"):
            return self.status
        if args == ("rev-parse", "--verify", "HEAD"):
            return self.head
        if args[0] == "cat-file":
            revision = args[2].split("^{", 1)[0]
            if revision in self.missing_commits:
                raise CanaryFailure("Git identity verification failed")
            return ""
        if args[0] == "merge-base" and self.non_ancestor:
            raise CanaryFailure("Git identity verification failed")
        if args[0] == "merge-base":
            return ""
        raise AssertionError(f"unexpected Git query: {args}")


def _local_gates(state: str = "PASS") -> list[dict[str, str]]:
    return [
        {"gate": name, "state": state, "scope": "local-deterministic"}
        for name in LOCAL_GATE_NAMES
    ]


def _all_pass_gates() -> list[dict[str, str]]:
    return _local_gates() + [
        {"gate": name, "state": "PASS", "scope": "live-production"}
        for name in LIVE_GATE_NAMES
    ]


class JIG183CanaryTests(unittest.TestCase):
    def test_vitest_ansi_output_is_counted(self) -> None:
        output = "\x1b[2m Tests \x1b[22m \x1b[1m\x1b[32m75 passed\x1b[39m\x1b[22m | \x1b[33m13 skipped\x1b[39m"
        self.assertEqual(_test_counts(output, ("pnpm", "exec", "vitest")), (75, 0, 13))

    def test_public_command_uses_locked_hermes_project_environment(self) -> None:
        package = json.loads((REPO_ROOT / "package.json").read_text(encoding="utf-8"))
        self.assertEqual(
            package["scripts"]["canary:jig183"],
            "uv run --locked --project services/hermes-chat python services/hermes-chat/tests/jig_183_canary.py",
        )

    def test_local_exit_code_fails_closed_for_missing_duplicate_unknown_and_nonpass_gates(self) -> None:
        self.assertEqual(local_exit_code([]), 1)
        self.assertEqual(local_exit_code(_local_gates()[:-1]), 1)
        self.assertEqual(local_exit_code(_local_gates() + [_local_gates()[0]]), 1)
        self.assertEqual(local_exit_code(_local_gates() + [{"gate": "not_required", "state": "PASS"}]), 1)
        self.assertEqual(local_exit_code(_local_gates("BLOCKED")), 1)
        self.assertEqual(local_exit_code(_local_gates()), 0)

    def test_release_decision_fails_closed_for_incomplete_or_invalid_matrix(self) -> None:
        self.assertEqual(release_decision([]), "BLOCK RELEASE")
        self.assertEqual(release_decision(_all_pass_gates()[:-1]), "BLOCK RELEASE")
        self.assertEqual(release_decision(_all_pass_gates() + [_all_pass_gates()[0]]), "BLOCK RELEASE")
        self.assertEqual(release_decision(_all_pass_gates() + [{"gate": "unknown", "state": "PASS"}]), "BLOCK RELEASE")
        blocked = _all_pass_gates()
        blocked[-1] = {**blocked[-1], "state": "BLOCKED"}
        self.assertEqual(release_decision(blocked), "BLOCK RELEASE")
        self.assertEqual(release_decision(_all_pass_gates()), "RELEASE")

    def test_live_gates_are_blocked_in_local_only_mode(self) -> None:
        gates = required_live_gates()
        self.assertEqual([gate["gate"] for gate in gates], list(LIVE_GATE_NAMES))
        self.assertTrue(all(gate["state"] == "BLOCKED" for gate in gates))
        self.assertTrue(all(gate["scope"] == "live-production" for gate in gates))

    def test_verified_identity_accepts_candidate_branch_and_main(self) -> None:
        with tempfile.TemporaryDirectory(prefix="jig183-test-") as temporary:
            for branch in ALLOWED_BRANCHES:
                identity = verify_checkout_identity(
                    Path(temporary),
                    source_revision=CANDIDATE_SHA,
                    base_revision=VERIFIED_BASE_SHA,
                    candidate_revision=CANDIDATE_SHA,
                    git_runner=FakeGit(branch=branch),
                )
                self.assertEqual(identity.branch, branch)
                self.assertTrue(identity.verified)

    def test_verified_identity_rejects_unrelated_branch(self) -> None:
        with self.assertRaisesRegex(CanaryFailure, "allowed JIG-183 branch"):
            verify_checkout_identity(
                Path("/tmp/jig183-test"),
                source_revision=CANDIDATE_SHA,
                base_revision=VERIFIED_BASE_SHA,
                candidate_revision=CANDIDATE_SHA,
                git_runner=FakeGit(branch="feature/unrelated"),
            )

    def test_forged_commit_cannot_be_accepted(self) -> None:
        forged = "c" * 40
        with self.assertRaisesRegex(CanaryFailure, "candidate revision"):
            verify_checkout_identity(
                Path("/tmp/jig183-test"),
                source_revision=forged,
                base_revision=VERIFIED_BASE_SHA,
                candidate_revision=forged,
                git_runner=FakeGit(),
            )

        with self.assertRaises(CanaryFailure):
            verify_checkout_identity(
                Path("/tmp/jig183-test"),
                source_revision=CANDIDATE_SHA,
                base_revision=VERIFIED_BASE_SHA,
                candidate_revision=CANDIDATE_SHA,
                git_runner=FakeGit(missing_commits=(CANDIDATE_SHA,)),
            )

    def test_mismatched_source_or_branch_cannot_be_accepted(self) -> None:
        with self.assertRaisesRegex(CanaryFailure, "source revision"):
            verify_checkout_identity(
                Path("/tmp/jig183-test"),
                source_revision="d" * 40,
                base_revision=VERIFIED_BASE_SHA,
                candidate_revision=CANDIDATE_SHA,
                git_runner=FakeGit(),
            )

    def test_non_ancestor_base_cannot_be_accepted(self) -> None:
        with self.assertRaises(CanaryFailure):
            verify_checkout_identity(
                Path("/tmp/jig183-test"),
                source_revision=CANDIDATE_SHA,
                base_revision=VERIFIED_BASE_SHA,
                candidate_revision=CANDIDATE_SHA,
                git_runner=FakeGit(non_ancestor=True),
            )

    def test_dirty_checkout_cannot_be_accepted(self) -> None:
        with self.assertRaisesRegex(CanaryFailure, "not clean"):
            verify_checkout_identity(
                Path("/tmp/jig183-test"),
                source_revision=CANDIDATE_SHA,
                base_revision=VERIFIED_BASE_SHA,
                candidate_revision=CANDIDATE_SHA,
                git_runner=FakeGit(status=" M services/hermes-chat/tests/jig_183_canary.py"),
            )

    def test_record_reverifies_identity_and_keeps_identifiers_redacted(self) -> None:
        identity = CheckoutIdentity(
            source_revision=CANDIDATE_SHA,
            base_revision=VERIFIED_BASE_SHA,
            candidate_revision=CANDIDATE_SHA,
            branch=ALLOWED_BRANCHES[0],
            verified=True,
        )
        with tempfile.TemporaryDirectory(prefix="jig183-record-") as temporary:
            record = build_release_record(
                repo_root=Path(temporary),
                identity=identity,
                started_at="2026-08-27T00:00:00.000Z",
                completed_at="2026-08-27T00:00:01.000Z",
                local_gates=_local_gates("BLOCKED"),
                supporting_evidence=[{"name": "existing-test", "state": "PASS", "passed": 1, "failed": 0, "skipped": 0}],
                _git_runner=FakeGit(),
            )
        self.assertEqual(record["candidate"]["candidate_revision"], CANDIDATE_SHA)
        self.assertEqual(record["local_exit_code"], 1)
        self.assertEqual(record["release_decision"], "BLOCK RELEASE")
        assert_release_record_redacted(record)
        with tempfile.TemporaryDirectory(prefix="jig183-record-") as temporary:
            with self.assertRaisesRegex(CanaryFailure, "candidate revision"):
                build_release_record(
                    repo_root=Path(temporary),
                    identity=CheckoutIdentity(
                        source_revision="c" * 40,
                        base_revision=VERIFIED_BASE_SHA,
                        candidate_revision="c" * 40,
                        branch=ALLOWED_BRANCHES[0],
                        verified=True,
                    ),
                    started_at="2026-08-27T00:00:00.000Z",
                    completed_at="2026-08-27T00:00:01.000Z",
                    local_gates=_local_gates("BLOCKED"),
                    supporting_evidence=[],
                    _git_runner=FakeGit(),
                )

    def test_record_preserves_main_checkout_branch(self) -> None:
        identity = CheckoutIdentity(
            source_revision=CANDIDATE_SHA,
            base_revision=VERIFIED_BASE_SHA,
            candidate_revision=CANDIDATE_SHA,
            branch="main",
            verified=True,
        )
        with tempfile.TemporaryDirectory(prefix="jig183-record-") as temporary:
            record = build_release_record(
                repo_root=Path(temporary),
                identity=identity,
                started_at="2026-08-27T00:00:00.000Z",
                completed_at="2026-08-27T00:00:01.000Z",
                local_gates=_local_gates("BLOCKED"),
                supporting_evidence=[],
                _git_runner=FakeGit(branch="main"),
            )
        self.assertEqual(record["verification"]["branch"], "main")

    def test_record_rejects_a_mismatched_verified_identity(self) -> None:
        with tempfile.TemporaryDirectory(prefix="jig183-record-") as temporary:
            with self.assertRaisesRegex(CanaryFailure, "branch"):
                build_release_record(
                    repo_root=Path(temporary),
                    identity=CheckoutIdentity(
                        source_revision=CANDIDATE_SHA,
                        base_revision=VERIFIED_BASE_SHA,
                        candidate_revision=CANDIDATE_SHA,
                        branch="feature/unrelated",
                        verified=True,
                    ),
                    started_at="2026-08-27T00:00:00.000Z",
                    completed_at="2026-08-27T00:00:01.000Z",
                    local_gates=_local_gates("BLOCKED"),
                    supporting_evidence=[],
                    _git_runner=FakeGit(),
                )

    def test_redaction_rejects_url_forbidden_values_and_forbidden_fields(self) -> None:
        with self.assertRaises(CanaryFailure):
            assert_release_record_redacted({"source_url": "https://fixture.invalid/source"})
        with self.assertRaises(CanaryFailure):
            assert_release_record_redacted({"evidence": "temporary-secret"}, ("temporary-secret",))
        with self.assertRaises(CanaryFailure):
            assert_release_record_redacted({"account_id": "account-a"})


if __name__ == "__main__":
    unittest.main()
