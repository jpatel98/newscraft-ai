from __future__ import annotations

import concurrent.futures
import os
import tempfile
import threading
import unittest
from dataclasses import replace
from pathlib import Path
from unittest.mock import patch

from hermes_chat.isolation import (
    TENANT_HEADER, TenantIsolation, TenantIsolationError,
    current_tenant_run, guard_tool_arguments, tenant_run_scope, workspace_path,
    _ensure_private_directory,
)


class ConversationIsolationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.isolation = TenantIsolation(self.root / 'state', self.root / 'workspaces')

    def test_tenant_and_conversation_have_independent_private_persisted_roots(self):
        first = self.isolation.ensure(self.isolation.resolve('tenant-a-opaque', 'conversation-a'))
        second = self.isolation.ensure(self.isolation.resolve('tenant-a-opaque', 'conversation-b'))
        other = self.isolation.ensure(self.isolation.resolve('tenant-b-opaque', 'conversation-a'))
        self.assertEqual(len({first.workspace, second.workspace, other.workspace}), 3)
        self.assertEqual(len({first.task_key, second.task_key, other.task_key}), 3)
        (first.workspace / 'note.md').write_text('Conversation A only')
        restarted = TenantIsolation(self.root / 'state', self.root / 'workspaces')
        self.assertEqual(restarted.resolve('tenant-a-opaque', 'conversation-a'), first)
        self.assertEqual((first.workspace / 'note.md').read_text(), 'Conversation A only')
        self.assertFalse((second.workspace / 'note.md').exists())
        self.assertFalse((other.workspace / 'note.md').exists())
        self.assertTrue(first.browser_profile.is_relative_to(first.workspace))
        self.assertFalse(first.hermes_home.is_relative_to(first.workspace))
        for path in (first.workspace, first.hermes_home, first.browser_profile):
            self.assertEqual(path.stat().st_mode & 0o777, 0o700)

    def test_invalid_tenant_and_conversation_identity_cannot_select_paths(self):
        for key in ('', '../other', '/tmp/other', 'tenant/a', 'tenant with spaces'):
            with self.subTest(key=key), self.assertRaises(TenantIsolationError):
                self.isolation.resolve(key, 'conversation-a')
        for conversation in ('', 'x' * 257, 'abc\x00def'):
            with self.subTest(conversation=conversation), self.assertRaises(TenantIsolationError):
                self.isolation.resolve('tenant-a-opaque', conversation)
        # A conversation's punctuation never becomes a filesystem component.
        runtime = self.isolation.resolve('tenant-a-opaque', '../../foreign/conversation')
        self.assertTrue(runtime.workspace.is_relative_to(self.isolation.workspace_root))
        self.assertNotIn('foreign', str(runtime.workspace))

    def test_rejects_root_parent_and_tenant_symlinks_and_forged_runtime(self):
        real = self.root / 'real'
        real.mkdir()
        alias = self.root / 'alias'
        alias.symlink_to(real, target_is_directory=True)
        for path in (alias, alias / 'nested'):
            with self.subTest(path=path), self.assertRaises(TenantIsolationError):
                TenantIsolation(path, self.root / 'other')
        self.isolation.workspace_root.mkdir()
        (self.isolation.workspace_root / 'tenants').symlink_to(real, target_is_directory=True)
        with self.assertRaises(TenantIsolationError):
            self.isolation.resolve('tenant-a-opaque', 'conversation-a')
        (self.isolation.workspace_root / 'tenants').unlink()
        runtime = self.isolation.resolve('tenant-a-opaque', 'conversation-a')
        with self.assertRaises(TenantIsolationError):
            self.isolation.ensure(replace(runtime, workspace=real))

    def test_contextvars_do_not_bleed_across_simultaneous_runs_or_errors(self):
        barrier = threading.Barrier(2)
        def run(key):
            runtime = self.isolation.resolve(key, 'conversation-a')
            with tenant_run_scope(runtime, thread_id='conversation-a', run_id=key):
                barrier.wait(timeout=5)
                return current_tenant_run().runtime.key
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            result = list(pool.map(run, ('tenant-a-opaque', 'tenant-b-opaque')))
        self.assertEqual(result, ['tenant-a-opaque', 'tenant-b-opaque'])
        self.assertIsNone(current_tenant_run())
        runtime = self.isolation.resolve('tenant-a-opaque', 'conversation-a')
        with self.assertRaises(RuntimeError):
            with tenant_run_scope(runtime, thread_id='conversation-a', run_id='run-a'):
                raise RuntimeError('stop')
        self.assertIsNone(current_tenant_run())
        with self.assertRaises(TenantIsolationError):
            with tenant_run_scope(runtime, thread_id='conversation-b', run_id='run-a'):
                pass

    def test_host_paths_traversal_and_profile_overrides_are_rejected(self):
        for path in ('/root/secret', '/tmp/file', '~/file', '/Users/private', '../escape',
                     '/workspace/../escape', 'dir/../../escape', 'dir//file', 'dir\\file', ''):
            with self.subTest(path=path), self.assertRaises(TenantIsolationError):
                workspace_path(path)
        self.assertEqual(workspace_path('reports/notes.md'), '/workspace/reports/notes.md')
        self.assertEqual(workspace_path('/workspace/reports/notes.md'), '/workspace/reports/notes.md')
        self.assertEqual(guard_tool_arguments('terminal', {'workdir': None}), {'workdir': None})
        for field in ('tenant_key', 'image', 'mounts', 'network', 'env', 'browser_profile', 'conversation_id'):
            with self.subTest(field=field), self.assertRaises(TenantIsolationError):
                guard_tool_arguments('terminal', {field: 'other'})

    def test_tenant_headers_are_unambiguous(self):
        self.assertEqual(self.isolation.tenant_from_headers({TENANT_HEADER.upper(): 'tenant-a-opaque'}), 'tenant-a-opaque')
        for headers in ({}, {TENANT_HEADER: 'short'},
                        {TENANT_HEADER: 'tenant-a-opaque', TENANT_HEADER.upper(): 'tenant-b-opaque'}):
            with self.subTest(headers=headers), self.assertRaises(TenantIsolationError):
                self.isolation.tenant_from_headers(headers)

    def test_scope_does_not_import_hermes_or_change_environment(self):
        runtime = self.isolation.resolve('tenant-a-opaque', 'conversation-a')
        before = dict(os.environ)
        with tenant_run_scope(runtime, thread_id='conversation-a', run_id='run-a'):
            self.assertEqual(current_tenant_run().runtime, runtime)
            self.assertEqual(dict(os.environ), before)
        self.assertEqual(dict(os.environ), before)

    def test_swapped_directory_cannot_chmod_outside_workspace(self):
        owned = self.root / 'owned'
        owned.mkdir(mode=0o700)
        outside = self.root / 'outside'
        outside.mkdir(mode=0o777)
        outside.chmod(0o777)
        real_fchmod = os.fchmod
        def swap_then_chmod(fd, mode):
            owned.rename(self.root / 'detached-owned')
            owned.symlink_to(outside, target_is_directory=True)
            real_fchmod(fd, mode)
        with patch('hermes_chat.isolation.os.fchmod', side_effect=swap_then_chmod):
            _ensure_private_directory(owned)
        self.assertEqual(outside.stat().st_mode & 0o777, 0o777)
        self.assertEqual((self.root / 'detached-owned').stat().st_mode & 0o777, 0o700)

    def test_identity_setup_before_crash_reclaim_does_not_visit_browser_children(self):
        runtime = self.isolation.ensure(self.isolation.resolve('tenant-a-opaque', 'conversation-a'), computer_state=False)
        self.assertFalse((runtime.workspace / '.browser').exists())
        (runtime.workspace / '.browser').symlink_to(self.root / 'other-profile', target_is_directory=True)
        self.isolation.ensure(runtime, computer_state=False)
        with self.assertRaises(TenantIsolationError):
            self.isolation.ensure(runtime)


if __name__ == '__main__':
    unittest.main()
