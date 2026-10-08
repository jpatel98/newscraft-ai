from __future__ import annotations

import asyncio
import contextlib
import io
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from hermes_chat.isolation import TenantIsolation, TenantIsolationError, tenant_run_scope
from hermes_chat.browser_network import GatewayResponse
from hermes_chat.sandbox import (
    ComputerSandbox, SandboxError, _BROWSER_PROGRAM, _FILE_PROGRAM, _TERMINAL_PROGRAM,
    _IMAGE_CONTRACT, schemas,
)


class FakeInput:
    def __init__(self):
        self.data = bytearray()
        self.closed = False
    def write(self, data): self.data.extend(data)
    async def drain(self): pass
    def close(self): self.closed = True


class FakeProcess:
    def __init__(self, output=b'{}', *, hangs=False):
        self.stdin = FakeInput()
        self.stdout = asyncio.StreamReader()
        self.stderr = asyncio.StreamReader()
        self.returncode = None
        self.killed = False
        self.done = asyncio.Event()
        if not hangs:
            self.stdout.feed_data(output)
            self.stdout.feed_eof()
            self.stderr.feed_eof()
            self.done.set()
    async def wait(self):
        await self.done.wait()
        self.returncode = -9 if self.killed else 0
        return self.returncode
    def kill(self):
        self.killed = True
        self.stdout.feed_eof()
        self.stderr.feed_eof()
        self.done.set()


class ComputerSandboxTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name).resolve()
        isolate = TenantIsolation(root / 'state', root / 'workspaces')
        self.runtime = isolate.ensure(isolate.resolve('tenant-a-opaque', 'conversation-a'))
        self.sandbox = ComputerSandbox(self.runtime, 'conversation-a', image='owned-image:tested')
        class WorkerOS:
            # Simulate the container identity without changing real filesystem
            # ownership checks in the private-state/Docker-config helpers.
            def __getattr__(self, name): return getattr(os, name)
            def getuid(self): return 501
            def getgid(self): return 20
        self.worker_os = patch('hermes_chat.sandbox.os', new=WorkerOS())
        self.worker_os.start()
        self.addCleanup(self.worker_os.stop)
        self.quota = patch('hermes_chat.quota.verify_workspace_quota', new=AsyncMock(return_value={
            'quota_enforced': True, 'seccomp_profile': '/root-owned/seccomp.json',
        }))
        self.quota.start()
        self.addCleanup(self.quota.stop)
        self.quota_ready = patch('hermes_chat.quota.quota_readiness', new=AsyncMock(return_value={'configured': True}))
        self.quota_ready.start()
        self.addCleanup(self.quota_ready.stop)
        async def verified(argv, *, config_dir):
            self.assertTrue(config_dir.is_dir())
            self.assertEqual(list(config_dir.iterdir()), [])
            return argv
        self.docker_boundary = patch('hermes_chat.docker_boundary.verified_docker_argv', side_effect=verified)
        self.docker_boundary.start()
        self.addCleanup(self.docker_boundary.stop)

    async def test_all_actions_use_docker_same_workspace_and_no_host_credentials(self):
        calls = []
        async def create(*argv, **kwargs):
            output = json.dumps(_IMAGE_CONTRACT).encode() if 'image' in argv else b'' if 'ps' in argv else b'{"path":"/workspace/report.md","bytes":5}'
            process = FakeProcess(output)
            calls.append((argv, kwargs, process))
            return process
        with patch.dict(os.environ, {'OPENAI_API_KEY': 'secret-fixture', 'AWS_SECRET_ACCESS_KEY': 'secret-fixture', 'DOCKER_HOST': 'tcp://unsafe'}), \
             patch('asyncio.create_subprocess_exec', side_effect=create):
            await self.sandbox.execute('write_file', {'path': 'report.md', 'content': 'hello'})
            await self.sandbox.execute('terminal', {'command': 'cat report.md', 'workdir': None, 'timeout_seconds': None})
            await self.sandbox.close()
        self.assertEqual([call[0][0] for call in calls], ['docker'] * 6)
        run = calls[2][0]
        for flag in ('--network=none', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges',
                     '--pull=never', '--pids-limit=128', '--memory=768m', '--cpus=1'):
            self.assertIn(flag, run)
        self.assertIn(f'type=bind,source={self.runtime.workspace},target=/workspace', run)
        self.assertEqual(run.count('--mount'), 1)
        self.assertNotIn(str(self.runtime.hermes_home), ' '.join(run))
        self.assertNotIn('/var/run/docker.sock', ' '.join(run))
        self.assertEqual(run[run.index('--user') + 1], '501:20')
        self.assertIn('seccomp=/root-owned/seccomp.json', run)
        for _, kwargs, _ in calls:
            self.assertEqual(set(kwargs['env']), {'PATH', 'LANG'})
            self.assertNotIn('secret-fixture', json.dumps(kwargs['env']))
        self.assertEqual(calls[3][0][3], self.sandbox.name)
        self.assertEqual(calls[4][0][3], self.sandbox.name)
        self.assertEqual(calls[-1][0], ('docker', 'rm', '--force', self.sandbox.name))
        self.assertTrue(self.runtime.workspace.exists())

    async def test_no_image_and_host_paths_never_launch_subprocess(self):
        no_image = ComputerSandbox(self.runtime, 'conversation-a', image='')
        no_image.image = ''
        with patch('asyncio.create_subprocess_exec', new_callable=AsyncMock) as create:
            with self.assertRaises(SandboxError):
                await no_image.execute('read_file', {'path': 'report.md'})
            with self.assertRaises(TenantIsolationError):
                await self.sandbox.execute('read_file', {'path': '/etc/passwd'})
            with self.assertRaises(TenantIsolationError):
                await self.sandbox.execute('terminal', {'command': 'echo x', 'network': 'host'})
            create.assert_not_awaited()

    async def test_scope_identity_includes_tenant_and_conversation(self):
        isolation = TenantIsolation(self.runtime.hermes_home.parents[3], self.runtime.workspace.parents[3])
        other_conversation = isolation.ensure(isolation.resolve('tenant-a-opaque', 'conversation-b'))
        other_tenant = isolation.ensure(isolation.resolve('tenant-b-opaque', 'conversation-a'))
        second = ComputerSandbox(other_conversation, 'conversation-b', image='owned-image:tested')
        third = ComputerSandbox(other_tenant, 'conversation-a', image='owned-image:tested')
        self.assertEqual(len({self.sandbox.name.split('-')[-2], second.name.split('-')[-2], third.name.split('-')[-2]}), 3)
        with self.assertRaises(TenantIsolationError):
            ComputerSandbox(self.runtime, 'conversation-b')

    async def test_timeout_removes_entire_container_and_preserves_files(self):
        self.sandbox._started = True
        with patch.object(self.sandbox, '_process', side_effect=[TimeoutError(), (0, '', '')]) as process:
            with self.assertRaisesRegex(SandboxError, 'timed out'):
                await self.sandbox.execute('terminal', {'command': 'sleep 999', 'workdir': '/workspace', 'timeout_seconds': 1})
            self.assertEqual(process.await_args_list[-1].args[0], ['docker', 'rm', '--force', self.sandbox.name])
        self.assertFalse(self.sandbox._started)
        self.assertTrue(self.runtime.workspace.exists())

    async def test_cancel_kills_cli_then_removes_container_exec_descendants(self):
        self.sandbox._started = True
        stalled = FakeProcess(hangs=True)
        calls = []
        async def create(*argv, **kwargs):
            calls.append(argv)
            return stalled if 'exec' in argv else FakeProcess()
        with patch('asyncio.create_subprocess_exec', side_effect=create):
            task = asyncio.create_task(self.sandbox.execute('terminal', {'command': 'sleep 999'}))
            await asyncio.sleep(0)
            await asyncio.sleep(0)
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task
        self.assertTrue(stalled.killed)
        self.assertEqual(calls[-1], ('docker', 'rm', '--force', self.sandbox.name))

    async def test_output_bound_kills_cli_and_container(self):
        self.sandbox._started = True
        flooding = FakeProcess(b'x' * (129 * 1024))
        calls = []
        async def create(*argv, **kwargs):
            calls.append(argv)
            return flooding if 'exec' in argv else FakeProcess()
        with patch('asyncio.create_subprocess_exec', side_effect=create):
            with self.assertRaisesRegex(SandboxError, '128 KiB'):
                await self.sandbox.execute('terminal', {'command': 'yes'})
        self.assertEqual(calls[-1], ('docker', 'rm', '--force', self.sandbox.name))

    async def test_browser_document_and_profile_run_inside_same_container(self):
        self.sandbox._started = True
        with patch('hermes_chat.sandbox.BrowserSession') as browser:
            browser.return_value.storage_state = {'cookies': [], 'origins': []}
            browser.return_value.input_tainted = False
            browser.return_value.last_url = 'https://public.example/'
            browser.return_value.command = AsyncMock(return_value=({'text': 'News', 'evidence_text': 'News', 'untrusted_source': True}, None))
            result = await self.sandbox.execute('browser', {'action': 'navigate', 'url': 'https://public.example/', 'selector': None})
        self.assertEqual(browser.call_args.args[0], self.sandbox.name)
        self.assertEqual(browser.call_args.kwargs['browser_uid'], 66037)
        self.assertEqual(browser.call_args.kwargs['group_id'], 20)
        self.assertEqual(browser.return_value.command.await_args.args[0], {'action': 'navigate', 'url': 'https://public.example/'})
        self.assertTrue(result['untrusted_source'])
        self.assertNotIn('evidence_text', result)
        self.assertIn("java_script_enabled=True", _BROWSER_PROGRAM)
        self.assertIn("chromium_sandbox=True", _BROWSER_PROGRAM)
        self.assertIn("route_request", _BROWSER_PROGRAM)
        self.assertNotIn("/workspace/.browser/profile", _BROWSER_PROGRAM)
        self.assertIn("tempfile.mkdtemp(prefix='newscraft-browser-'", _BROWSER_PROGRAM)
        self.assertIn('O_NOFOLLOW', _FILE_PROGRAM)
        self.assertIn('O_NOFOLLOW', _TERMINAL_PROGRAM)

    async def test_verified_mainframe_record_mints_private_bound_browser_receipt(self):
        import hashlib
        body = b'<html><body>Source text</body></html>'
        response = GatewayResponse('https://public.example/article', 200, {'content-type': 'text/html'}, body, hashlib.sha256(body).hexdigest())
        result = {'url': response.url, 'title': 'Article', 'text': 'Source text',
                  'evidence_text': 'Source text', 'navigation_id': 'navigation-a'}
        document = {'response': response, 'fetched_at': 1234.0, 'validated_request_count': 3}
        self.sandbox._started = True
        with patch('hermes_chat.sandbox.BrowserSession') as browser:
            browser.return_value.storage_state = {'cookies': [], 'origins': []}
            browser.return_value.input_tainted = False
            browser.return_value.last_url = response.url
            browser.return_value.command = AsyncMock(return_value=(result, document))
            with tenant_run_scope(self.runtime, thread_id='conversation-a', run_id='run-a'):
                public = await self.sandbox.execute('browser', {'action': 'navigate', 'url': response.url})
        receipt = self.sandbox.browser_receipt(public['receipt_id'])
        self.assertEqual(receipt.rendered_text, 'Source text')
        self.assertEqual(receipt.main_document_sha256, response.sha256)
        self.assertEqual(receipt.tenant_key, 'tenant-a-opaque')
        self.assertEqual(receipt.run_id, 'run-a')
        self.assertEqual(receipt.conversation_id, 'conversation-a')
        self.assertTrue(receipt.public_network_validated)
        self.assertIsNone(self.sandbox.browser_receipt('model-spoofed-id'))

    async def test_browser_reset_clears_private_saved_state_and_evidence(self):
        from hermes_chat.browser_state import load_browser_state, save_browser_state
        save_browser_state(self.runtime, {'storage': {'cookies': [], 'origins': []}, 'input_tainted': True, 'last_url': 'https://public.example/'})
        self.sandbox._started = True
        self.sandbox._browser_receipts['receipt-old'] = object()
        with patch.object(self.sandbox, '_process', return_value=(0, '', '')):
            result = await self.sandbox.execute('browser', {'action': 'reset'})
        self.assertTrue(result['reset'])
        self.assertFalse(self.sandbox._started)
        self.assertFalse(load_browser_state(self.runtime)['input_tainted'])
        self.assertEqual(load_browser_state(self.runtime)['last_url'], '')
        self.assertIsNone(self.sandbox.browser_receipt('receipt-old'))

    def test_screenshot_host_save_rejects_model_symlink_parent(self):
        outside = Path(self.temp.name).resolve() / 'foreign-images'
        outside.mkdir()
        (self.runtime.workspace / 'browser-screenshots').symlink_to(outside, target_is_directory=True)
        with self.assertRaises(SandboxError):
            self.sandbox._save_screenshot(b'fixture-image')
        self.assertEqual(list(outside.iterdir()), [])

    async def test_missing_kernel_quota_never_starts_container(self):
        from hermes_chat.quota import WorkspaceQuotaError
        with patch.object(self.sandbox, '_image_manifest', new_callable=AsyncMock), \
             patch.object(self.sandbox, 'prepare', new_callable=AsyncMock), \
             patch('hermes_chat.quota.verify_workspace_quota', side_effect=WorkspaceQuotaError('No kernel quota')), \
             patch.object(self.sandbox, '_process', new_callable=AsyncMock) as process:
            with self.assertRaisesRegex(SandboxError, 'quota/security'):
                await self.sandbox.execute('terminal', {'command': 'echo hello'})
        process.assert_not_awaited()

    async def test_fixture_allowlist_prevents_browsing_before_container_start(self):
        with self.assertRaises(SandboxError):
            ComputerSandbox(self.runtime, 'conversation-a', resource_fetcher=AsyncMock())
        fixture = ComputerSandbox(self.runtime, 'conversation-a', resource_fetcher=AsyncMock(),
                                  allowed_urls=frozenset({'https://fixture.invalid/article'}), synthetic_fixture=True)
        with patch.object(fixture, '_start', new_callable=AsyncMock) as start:
            with self.assertRaisesRegex(SandboxError, 'allowlist'):
                await fixture.execute('browser', {'action': 'navigate', 'url': 'https://unlisted.example/article'})
        start.assert_not_awaited()

    async def test_readiness_is_readonly_never_pulls_or_starts_docker(self):
        with patch.dict(os.environ, {'NEWSCRAFT_SANDBOX_IMAGE': 'owned-image:tested'}), \
             patch('hermes_chat.sandbox.shutil.which', return_value='/usr/local/bin/docker'), \
             patch.object(ComputerSandbox, '_process', return_value=(0, json.dumps(_IMAGE_CONTRACT), '')) as process:
            result = await ComputerSandbox.readiness()
        self.assertTrue(result['ready'])
        self.assertTrue(result['configured'])
        self.assertFalse(result['verified'])
        self.assertIn('not verified', result['reason'])
        self.assertEqual(process.await_args.args[0], ['docker', 'image', 'inspect', '--format', '{{json .Config.Labels}}', 'owned-image:tested'])

    async def test_readiness_rejects_image_without_owned_capability_manifest(self):
        with patch.dict(os.environ, {'NEWSCRAFT_SANDBOX_IMAGE': 'owned-image:tested'}), \
             patch('hermes_chat.sandbox.shutil.which', return_value='/usr/local/bin/docker'), \
             patch.object(ComputerSandbox, '_process', return_value=(0, '{}', '')):
            result = await ComputerSandbox.readiness()
        self.assertFalse(result['ready'])
        self.assertFalse(result['configured'])
        self.assertFalse(result['verified'])

    async def test_failed_removal_retains_owned_identity_for_retry_and_blocks_reuse(self):
        self.sandbox._started = True
        with patch.object(self.sandbox, '_process', side_effect=[(1, '', 'offline'), (1, '', 'offline'), (0, '', '')]) as process:
            with self.assertRaisesRegex(SandboxError, 'cleanup is unconfirmed'):
                await self.sandbox.close()
            self.assertTrue(self.sandbox._started)
            self.assertTrue(self.sandbox._closed)
            await self.sandbox.close()
            self.assertFalse(self.sandbox._started)
            self.assertEqual(process.await_count, 3)

    async def test_crash_recovery_stops_only_verified_same_conversation_container(self):
        crashed_id = 'a' * 64
        labels = {'newscraft.managed': 'research-agent', 'newscraft.scope': self.runtime.task_key}
        with patch.object(self.sandbox, '_process', side_effect=[(0, crashed_id + '\n', ''), (0, json.dumps(labels), ''), (0, '', '')]) as process:
            await self.sandbox._reclaim_scope()
        listing = process.await_args_list[0].args[0]
        self.assertIn('label=newscraft.scope=' + self.runtime.task_key, listing)
        self.assertEqual(process.await_args_list[-1].args[0], ['docker', 'rm', '--force', crashed_id])
        labels['newscraft.scope'] = 'another-conversation'
        with patch.object(self.sandbox, '_process', side_effect=[(0, crashed_id + '\n', ''), (0, json.dumps(labels), '')]) as process:
            with self.assertRaisesRegex(SandboxError, 'ownership'):
                await self.sandbox._reclaim_scope()
            self.assertEqual(process.await_count, 2)

    async def test_prepare_reclaims_without_image_or_computer_dispatch(self):
        self.sandbox.image = ''
        crashed_id = 'b' * 64
        labels = {'newscraft.managed': 'research-agent', 'newscraft.scope': self.runtime.task_key}
        with patch.object(self.sandbox, '_process', side_effect=[(0, crashed_id + '\n', ''), (0, json.dumps(labels), ''), (0, '', '')]) as process:
            await self.sandbox.prepare()
            await self.sandbox.prepare()
            await self.sandbox.close()
        self.assertEqual(process.await_count, 3)
        self.assertFalse(self.sandbox._started)
        self.assertTrue(self.sandbox._prepared)
        self.assertFalse(any('run' in call.args[0] or 'image' in call.args[0] for call in process.await_args_list))

    def test_schemas_are_explicit_strict_and_programs_compile(self):
        self.assertEqual({tool['name'] for tool in schemas()}, {'terminal', 'browser', 'read_file', 'write_file', 'list_files'})
        for tool in schemas():
            self.assertTrue(tool['strict'])
            self.assertFalse(tool['parameters']['additionalProperties'])
            self.assertEqual(set(tool['parameters']['required']), set(tool['parameters']['properties']))
        for program in (_FILE_PROGRAM, _TERMINAL_PROGRAM, _BROWSER_PROGRAM):
            compile(program, '<sandbox>', 'exec')

    def test_file_program_rejects_symlink_escape_and_nonregular_targets(self):
        outside = Path(self.temp.name).resolve() / 'outside'
        outside.mkdir()
        secret = outside / 'foreign.txt'
        secret.write_text('OTHER_CONVERSATION_SECRET')
        (self.runtime.workspace / 'linked').symlink_to(outside, target_is_directory=True)
        (self.runtime.workspace / 'secret-link').symlink_to(secret)
        os.mkfifo(self.runtime.workspace / 'pipe')
        real_open = os.open
        def virtual_open(path, flags, *args, **kwargs):
            return real_open(self.runtime.workspace if path == '/workspace' else path, flags, *args, **kwargs)
        def file_action(request):
            output = io.StringIO()
            with patch('os.open', side_effect=virtual_open), patch('sys.stdin', io.StringIO(json.dumps(request))), contextlib.redirect_stdout(output):
                exec(compile(_FILE_PROGRAM, '<sandbox-file-test>', 'exec'), {})
            return json.loads(output.getvalue())
        for path in ('/workspace/linked/foreign.txt', '/workspace/secret-link', '/workspace/pipe'):
            with self.subTest(path=path):
                result = file_action({'operation': 'read_file', 'path': path})
                self.assertIn('error', result)
                self.assertNotIn('OTHER_CONVERSATION_SECRET', json.dumps(result))
                result = file_action({'operation': 'write_file', 'path': path, 'content': 'overwrite'})
                self.assertIn('error', result)
        self.assertEqual(secret.read_text(), 'OTHER_CONVERSATION_SECRET')
        written = file_action({'operation': 'write_file', 'path': '/workspace/reports/news.md', 'content': 'Cited news'})
        self.assertEqual(written['bytes'], 10)
        read = file_action({'operation': 'read_file', 'path': '/workspace/reports/news.md'})
        self.assertEqual(read['content'], 'Cited news')
        self.assertEqual(file_action({'operation': 'list_files', 'path': '/workspace/reports'})['entries'], ['news.md'])


if __name__ == '__main__':
    unittest.main()
