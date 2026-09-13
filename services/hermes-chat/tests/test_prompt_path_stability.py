from __future__ import annotations

import contextlib
import sys
import tempfile
import unittest
from pathlib import Path
from types import ModuleType

from hermes_chat.isolation import TenantIsolation, tenant_run_scope
from hermes_chat.service import _install_prompt_path_stability, _tenant_stable_home_display


def _runtime(root: Path, key: str):
    isolation = TenantIsolation(root / "home", root / "workspace")
    return isolation.resolve(key)


class PromptPathStabilityTests(unittest.TestCase):
    """The standard scaffold must not carry tenant-identifying paths."""

    def test_stable_display_is_identical_across_tenants(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            runtime_a = _runtime(root, "tenantKeyA" + "a" * 32)
            runtime_b = _runtime(root, "tenantKeyB" + "b" * 32)

            display_a = _tenant_stable_home_display(runtime_a.hermes_home)
            display_b = _tenant_stable_home_display(runtime_b.hermes_home)

            self.assertEqual(display_a, display_b)
            self.assertNotIn(runtime_a.key, display_a)
            self.assertNotIn(runtime_b.key, display_b)

            hint_a = "Other profiles (if any) live under " + display_a + "/profiles/<name>/."
            hint_b = "Other profiles (if any) live under " + display_b + "/profiles/<name>/."
            self.assertEqual(hint_a, hint_b)

    def test_installer_redacts_only_inside_a_tenant_run(self) -> None:
        canned_home = Path("/runtime/tenants/real-tenant-key")
        module = ModuleType("agent.system_prompt")
        module.get_hermes_home = lambda: canned_home
        previous = sys.modules.get("agent.system_prompt")
        sys.modules["agent.system_prompt"] = module
        try:
            with tempfile.TemporaryDirectory() as temp_dir:
                runtime = _runtime(Path(temp_dir), "tenantKeyC" + "c" * 32)

                _install_prompt_path_stability()
                _install_prompt_path_stability()  # re-install stays safe

                self.assertEqual(module.get_hermes_home(), canned_home)
                with tenant_run_scope(
                    runtime,
                    thread_id="thread",
                    run_id="run",
                    home_override=contextlib.nullcontext(),
                    session_scope=contextlib.nullcontext(),
                ):
                    scoped = module.get_hermes_home()
                    self.assertIsInstance(scoped, str)
                    self.assertNotIn(runtime.key, scoped)
                    self.assertEqual(scoped, _tenant_stable_home_display(runtime.hermes_home))
                self.assertEqual(module.get_hermes_home(), canned_home)
        finally:
            if previous is None:
                sys.modules.pop("agent.system_prompt", None)
            else:
                sys.modules["agent.system_prompt"] = previous


if __name__ == "__main__":
    unittest.main()
