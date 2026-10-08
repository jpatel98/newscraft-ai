from __future__ import annotations

import json
import os
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path

from hermes_chat.browser_state import (
    MAX_STATE_BYTES,
    STATE_FILE,
    BrowserStateError,
    load_browser_state,
    save_browser_state,
)
from hermes_chat.isolation import TenantIsolation


class PrivateBrowserStateTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.isolation = TenantIsolation(self.root / "state", self.root / "workspaces")
        self.runtime = self.isolation.ensure(
            self.isolation.resolve("tenant-a-opaque", "conversation-a")
        )

    def state(self, *, tainted=False, value="saved café note"):
        return {
            "storage": {
                "cookies": [{
                    "name": "research-session",
                    "value": "fixture-session-value",
                    "domain": "public.example",
                    "path": "/",
                    "expires": -1,
                    "httpOnly": True,
                    "secure": True,
                    "sameSite": "Lax",
                }],
                "origins": [{
                    "origin": "https://public.example",
                    "localStorage": [{"name": "notes", "value": value}],
                }],
            },
            "input_tainted": tainted,
            "last_url": "https://public.example/research?q=caf%C3%A9",
        }

    def write_fixture(self, raw, *, mode=0o600):
        path = self.runtime.hermes_home / STATE_FILE
        path.write_bytes(raw)
        path.chmod(mode)
        return path

    def test_missing_state_has_clean_default_without_creating_a_file(self):
        self.assertEqual(load_browser_state(self.runtime), {
            "storage": {"cookies": [], "origins": []},
            "input_tainted": False,
            "last_url": "",
        })
        self.assertFalse((self.runtime.hermes_home / STATE_FILE).exists())
        self.assertFalse((self.runtime.workspace / STATE_FILE).exists())

    def test_roundtrip_is_private_owned_and_persists_taint_after_restart(self):
        state = self.state(tainted=True)
        save_browser_state(self.runtime, state)
        path = self.runtime.hermes_home / STATE_FILE
        self.assertEqual(path.stat().st_uid, os.getuid())
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        self.assertFalse(path.is_relative_to(self.runtime.workspace))
        self.assertFalse((self.runtime.workspace / STATE_FILE).exists())
        self.assertEqual(list(self.runtime.hermes_home.glob("browser-state-*")), [])
        restarted = TenantIsolation(self.root / "state", self.root / "workspaces")
        runtime = restarted.ensure(restarted.resolve("tenant-a-opaque", "conversation-a"))
        self.assertEqual(load_browser_state(runtime), state)
        self.assertTrue(load_browser_state(runtime)["input_tainted"])

    def test_state_and_taint_are_isolated_by_tenant_and_conversation(self):
        other_conversation = self.isolation.ensure(
            self.isolation.resolve("tenant-a-opaque", "conversation-b")
        )
        other_tenant = self.isolation.ensure(
            self.isolation.resolve("tenant-b-opaque", "conversation-a")
        )
        save_browser_state(self.runtime, self.state(tainted=True, value="conversation A"))
        for runtime in (other_conversation, other_tenant):
            with self.subTest(scope=runtime.task_key):
                self.assertEqual(load_browser_state(runtime)["storage"], {"cookies": [], "origins": []})
                self.assertFalse(load_browser_state(runtime)["input_tainted"])
        save_browser_state(other_conversation, self.state(value="conversation B"))
        self.assertEqual(load_browser_state(self.runtime), self.state(tainted=True, value="conversation A"))
        self.assertEqual(load_browser_state(other_conversation), self.state(value="conversation B"))

    def test_rejects_state_root_equal_to_inside_or_containing_workspace(self):
        for home, workspace in (
            (self.runtime.workspace, self.runtime.workspace),
            (self.runtime.workspace / ".private", self.runtime.workspace),
            (self.runtime.hermes_home, self.runtime.hermes_home / "workspace"),
        ):
            runtime = replace(self.runtime, hermes_home=home, workspace=workspace)
            with self.subTest(home=home, workspace=workspace):
                with self.assertRaisesRegex(BrowserStateError, "outside the model workspace"):
                    load_browser_state(runtime)
                with self.assertRaisesRegex(BrowserStateError, "outside the model workspace"):
                    save_browser_state(runtime, self.state())
        self.assertFalse((self.runtime.workspace / ".private").exists())

    def test_rejects_symlink_root_and_never_writes_its_target(self):
        outside = self.root / "outside-state"
        outside.mkdir()
        alias = self.root / "state-alias"
        alias.symlink_to(outside, target_is_directory=True)
        runtime = replace(self.runtime, hermes_home=alias)
        with self.assertRaises(BrowserStateError):
            load_browser_state(runtime)
        with self.assertRaises(BrowserStateError):
            save_browser_state(runtime, self.state())
        self.assertEqual(list(outside.iterdir()), [])

    def test_symlink_file_cannot_read_or_overwrite_another_scope(self):
        outside = self.root / "foreign-state.json"
        original = b"foreign conversation state"
        outside.write_bytes(original)
        target = self.runtime.hermes_home / STATE_FILE
        target.symlink_to(outside)
        with self.assertRaises(BrowserStateError):
            load_browser_state(self.runtime)
        # Atomic publication replaces the symlink itself rather than its target.
        save_browser_state(self.runtime, self.state(tainted=True))
        self.assertFalse(target.is_symlink())
        self.assertEqual(outside.read_bytes(), original)
        self.assertEqual(load_browser_state(self.runtime), self.state(tainted=True))

    def test_fifo_is_rejected_without_opening_a_blocking_reader(self):
        target = self.runtime.hermes_home / STATE_FILE
        os.mkfifo(target, 0o600)
        with self.assertRaisesRegex(BrowserStateError, "unsafe"):
            load_browser_state(self.runtime)
        save_browser_state(self.runtime, self.state())
        self.assertTrue(target.is_file())
        self.assertEqual(load_browser_state(self.runtime), self.state())

    def test_group_or_other_permissions_are_rejected(self):
        encoded = json.dumps(self.state()).encode()
        for mode in (0o640, 0o620, 0o601, 0o644):
            with self.subTest(mode=oct(mode)):
                path = self.write_fixture(encoded, mode=mode)
                self.assertEqual(path.stat().st_uid, os.getuid())
                with self.assertRaisesRegex(BrowserStateError, "unsafe"):
                    load_browser_state(self.runtime)
        save_browser_state(self.runtime, self.state(tainted=True))
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        self.assertTrue(load_browser_state(self.runtime)["input_tainted"])

    def test_size_bound_is_in_bytes_and_rejection_preserves_previous_state(self):
        previous = self.state(tainted=True)
        save_browser_state(self.runtime, previous)
        too_large = self.state(value="é" * (MAX_STATE_BYTES // 2))
        self.assertLess(len(json.dumps(too_large, ensure_ascii=False)), MAX_STATE_BYTES)
        with self.assertRaisesRegex(BrowserStateError, "1 MiB"):
            save_browser_state(self.runtime, too_large)
        self.assertEqual(load_browser_state(self.runtime), previous)
        self.assertEqual(list(self.runtime.hermes_home.glob("browser-state-*")), [])
        self.write_fixture(b"x" * (MAX_STATE_BYTES + 1))
        with self.assertRaisesRegex(BrowserStateError, "unsafe"):
            load_browser_state(self.runtime)

    def test_exact_size_and_last_url_boundaries_roundtrip(self):
        state = self.state(value="")
        state["last_url"] = "x" * 8192
        overhead = len(json.dumps(state, ensure_ascii=False).encode())
        state["storage"]["origins"][0]["localStorage"][0]["value"] = "x" * (MAX_STATE_BYTES - overhead)
        self.assertEqual(len(json.dumps(state, ensure_ascii=False).encode()), MAX_STATE_BYTES)
        save_browser_state(self.runtime, state)
        self.assertEqual((self.runtime.hermes_home / STATE_FILE).stat().st_size, MAX_STATE_BYTES)
        self.assertEqual(load_browser_state(self.runtime), state)
        state["last_url"] += "x"
        with self.assertRaisesRegex(BrowserStateError, "invalid"):
            save_browser_state(self.runtime, state)

    def test_invalid_json_and_state_shapes_are_rejected_on_load_and_save(self):
        invalid_states = [
            None,
            [],
            {},
            {**self.state(), "unexpected": True},
            {**self.state(), "input_tainted": 1},
            {**self.state(), "last_url": None},
            {**self.state(), "last_url": "x" * 8193},
            {**self.state(), "storage": []},
            {**self.state(), "storage": {"cookies": []}},
            {**self.state(), "storage": {"cookies": {}, "origins": []}},
            {**self.state(), "storage": {"cookies": [], "origins": "wrong"}},
            {**self.state(), "storage": {"cookies": [], "origins": [], "unexpected": []}},
        ]
        for state in invalid_states:
            with self.subTest(state=state):
                self.write_fixture(json.dumps(state).encode())
                with self.assertRaises(BrowserStateError):
                    load_browser_state(self.runtime)
                with self.assertRaises(BrowserStateError):
                    save_browser_state(self.runtime, state)
        for raw in (b"{invalid", b"\xff", b""):
            with self.subTest(raw=raw):
                self.write_fixture(raw)
                with self.assertRaises(BrowserStateError):
                    load_browser_state(self.runtime)


if __name__ == "__main__":
    unittest.main()
