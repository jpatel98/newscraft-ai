from __future__ import annotations

import io
import os
import unittest
from contextlib import redirect_stdout
from unittest.mock import patch

from live_production_smoke import (
    LiveFailure,
    _browser_cookie_matrix,
    _browser_cookie_restart_check,
    _browser_provider,
    _finish_live_run,
)


class LiveProductionSmokeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tenants = {"a": "opaque-a", "b": "opaque-b"}
        self.markers = {
            "a": {"cookie": "NC_LIVE_A_COOKIE_TEST"},
            "b": {"cookie": "NC_LIVE_B_COOKIE_TEST"},
        }

    def test_local_provider_checks_cookie_across_requests_and_after_restart(self) -> None:
        calls: list[tuple[str, str]] = []

        def run(_token: str, tenant: str, prompt: str, gate: str) -> str:
            calls.append((gate, prompt))
            if gate in {"browser-cookie-set-a", "browser-cookie-read-a"}:
                return f"success {self.markers['a']['cookie']}"
            return "success document.cookie"

        def run_after_restart(_token: str, tenant: str, prompt: str, gate: str) -> str:
            calls.append((gate, prompt))
            if gate.startswith("restart-browser-navigate"):
                return "success navigation"
            if gate == "restart-browser-a":
                return self.markers["a"]["cookie"]
            return "document.cookie"

        output = io.StringIO()
        with redirect_stdout(output):
            _browser_cookie_matrix(
                "token",
                self.tenants,
                self.markers,
                "local",
                run=run,
            )
            _browser_cookie_restart_check(
                "token",
                self.tenants,
                self.markers,
                "local",
                run_after_restart=run_after_restart,
            )

        self.assertIn("browser_cookie_persistence=PASS (local durable profile)", output.getvalue())
        gates = [gate for gate, _prompt in calls]
        self.assertEqual(
            gates,
            [
                "browser-navigate-a",
                "browser-navigate-b",
                "browser-cookie-set-a",
                "browser-cookie-read-b",
                "browser-cookie-read-a",
                "restart-browser-navigate-a",
                "restart-browser-navigate-b",
                "restart-browser-a",
                "restart-browser-b",
            ],
        )
        self.assertNotEqual(calls[2][1], calls[4][1])

    def test_browser_use_checks_set_and_read_in_one_request_and_isolates_account_b(self) -> None:
        calls: list[tuple[str, str]] = []

        def run(_token: str, tenant: str, prompt: str, gate: str) -> str:
            calls.append((gate, prompt))
            if gate == "browser-use-cookie-a":
                return f"navigation success; cookie={self.markers['a']['cookie']}"
            return "navigation success; document.cookie="

        output = io.StringIO()
        with redirect_stdout(output):
            _browser_cookie_matrix(
                "token",
                self.tenants,
                self.markers,
                "browser-use",
                run=run,
            )
            _browser_cookie_restart_check(
                "token",
                self.tenants,
                self.markers,
                "browser-use",
                run_after_restart=run,
            )

        self.assertIn("browser_cookie_persistence=NOT_APPLICABLE", output.getvalue())
        self.assertIn("browser-use sessions are ephemeral", output.getvalue())
        self.assertEqual([gate for gate, _prompt in calls], ["browser-use-cookie-a", "browser-use-cookie-b"])
        account_a_prompt = calls[0][1]
        self.assertIn("browser_navigate", account_a_prompt)
        self.assertIn("document.cookie =", account_a_prompt)
        self.assertIn('expression "document.cookie"', account_a_prompt)
        self.assertNotIn(self.markers["a"]["cookie"], calls[1][1])

    def test_provider_selection_is_explicit_and_fails_closed(self) -> None:
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(_browser_provider(), "local")
        with patch.dict(os.environ, {"NEWSCRAFT_HERMES_BROWSER_PROVIDER": " Browser-Use "}, clear=True):
            self.assertEqual(_browser_provider(), "browser-use")
        with patch.dict(os.environ, {"NEWSCRAFT_HERMES_BROWSER_PROVIDER": "browserbase"}, clear=True):
            with self.assertRaisesRegex(LiveFailure, "unsupported browser provider"):
                _browser_provider()

    def test_cleanup_failure_is_reported_with_a_primary_gate_failure(self) -> None:
        primary = LiveFailure("primary gate failed")
        with self.assertRaisesRegex(
            LiveFailure,
            r"^primary gate failed; account a cleanup failed \(PermissionError\)$",
        ) as raised:
            _finish_live_run(primary, [("a", PermissionError("tenant path must not be logged"))])

        self.assertIs(raised.exception.__cause__, primary)
        self.assertNotIn("tenant path must not be logged", str(raised.exception))


if __name__ == "__main__":
    unittest.main()
