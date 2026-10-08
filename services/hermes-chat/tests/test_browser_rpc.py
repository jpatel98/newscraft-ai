from __future__ import annotations

import asyncio
import ast
import hashlib
import json
import unittest
from unittest.mock import AsyncMock, patch

from hermes_chat.browser_network import GatewayResponse, BrowserNetworkError
from hermes_chat.browser_rpc import (BrowserSession, BrowserProtocolError, _BROWSER_PROGRAM,
                                    MAX_RESOURCE_WIRE_BYTES, MAX_ACTION_NETWORK_BYTES)

URL = 'https://fixture.example/article'
PAGE = b'<html><body><button>Clicks 0</button></body></html>'


def response(url=URL, status=200, headers=None, body=PAGE):
    return GatewayResponse(url, status, headers or {'content-type': 'text/html'}, body, hashlib.sha256(body).hexdigest())


class ProtocolProcess:
    """A controlled guest protocol peer; never launches Docker or Chromium."""
    def __init__(self):
        self.stdin = self
        self.stdout = asyncio.StreamReader(limit=4 * 1024 * 1024)
        self.stderr = asyncio.StreamReader()
        self.returncode = None
        self.token = None
        self.url = None
        self.nav = None
        self.page = 'f' * 24
        self.count = 0
        self.buffer = bytearray()
        self.requests = {}
        self.messages = []
        self.done = asyncio.Event()

    def write(self, data):
        self.buffer.extend(data)
        while b'\n' in self.buffer:
            line, _, remaining = self.buffer.partition(b'\n')
            self.buffer = bytearray(remaining)
            message = json.loads(line)
            self.messages.append(message)
            self.receive(message)

    def emit(self, value):
        self.stdout.feed_data(json.dumps({'token': self.token, **value}).encode() + b'\n')

    def result(self, message):
        self.emit({'event': 'result', 'id': message['id'], 'result': {
            'url': self.url, 'title': 'Fixture', 'text': f'Clicks {self.count}',
            'evidence_text': f'Clicks {self.count}', 'page_id': self.page,
            'navigation_id': self.nav, 'scripts_enabled': True,
            'storage_state': {'cookies': [], 'origins': []},
        }})

    def receive(self, message):
        if message.get('event') is None:
            self.token = message['token']
            self.emit({'event': 'ready'})
        elif message['event'] == 'command':
            if message['action'] == 'navigate':
                self.url = message['url']
                self.nav = message['id']
                request_id = 'a' * 24
                self.requests[request_id] = message
                self.emit({'event': 'request', 'id': request_id, 'action_id': message['id'],
                           'url': self.url, 'method': 'GET', 'headers': {}, 'main_document': True,
                           'navigation_id': self.nav, 'page_id': self.page})
            else:
                if message['action'] == 'click': self.count += 1
                self.result(message)
        elif message['event'] == 'response':
            command = self.requests.pop(message['id'])
            if message.get('error'):
                self.emit({'event': 'result', 'id': command['id'], 'error': 'Blocked'})
            else:
                self.result(command)
        elif message['event'] == 'close':
            self.returncode = 0
            self.stdout.feed_eof()
            self.stderr.feed_eof()
            self.done.set()

    async def drain(self): pass
    def close(self): pass
    def kill(self):
        self.returncode = -9
        self.stdout.feed_eof()
        self.stderr.feed_eof()
        self.done.set()
    async def wait(self):
        await self.done.wait()
        return self.returncode


class BrowserRpcTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.configs = []
        async def verified(argv, *, config_dir):
            self.configs.append(config_dir)
            self.assertTrue(config_dir.is_dir())
            self.assertEqual(list(config_dir.iterdir()), [])
            return argv
        guard = patch('hermes_chat.docker_boundary.verified_docker_argv', side_effect=verified)
        guard.start()
        self.addCleanup(guard.stop)

    async def test_persistent_protocol_uses_separate_uid_and_retains_interaction_state(self):
        process = ProtocolProcess()
        fetch = AsyncMock(return_value=response())
        session = BrowserSession('owned-container', env={'PATH': '/bin'}, browser_uid=66037, group_id=20,
                                 resource_fetcher=fetch, allowed_urls=frozenset({URL}))
        with patch('asyncio.create_subprocess_exec', return_value=process) as create:
            first, receipt = await session.command({'action': 'navigate', 'url': URL}, timeout=1)
            second, clicked = await session.command({'action': 'click', 'selector': 'button'}, timeout=1)
            third, snapshot = await session.command({'action': 'snapshot'}, timeout=1)
            await session.close()
        self.assertEqual(first['text'], 'Clicks 0')
        self.assertEqual(second['text'], 'Clicks 1')
        self.assertEqual(third['text'], 'Clicks 1')
        self.assertEqual(receipt['response'].sha256, hashlib.sha256(PAGE).hexdigest())
        self.assertEqual(clicked['response'], snapshot['response'])
        self.assertEqual(create.await_count, 1)
        self.assertEqual(fetch.await_count, 1)
        argv = create.await_args.args
        self.assertIn('66037:20', argv)
        self.assertIn('-I', argv)
        self.assertEqual(argv[argv.index('--workdir') + 1], '/tmp')
        self.assertIn('HOME=/tmp', argv)
        self.assertEqual(argv[0], 'docker')
        self.assertIn('chromium_sandbox=True', argv[-1])
        self.assertNotIn('set_content(', argv[-1])
        self.assertIn('java_script_enabled=True', argv[-1])
        self.assertTrue(process.done.is_set())
        self.assertFalse(self.configs[0].exists())

    async def test_entered_text_cannot_mint_evidence_even_after_fresh_navigation(self):
        process = ProtocolProcess()
        fetch = AsyncMock(return_value=response())
        session = BrowserSession('owned-container', env={}, browser_uid=66037, group_id=20,
                                 resource_fetcher=fetch, allowed_urls=frozenset({URL}))
        with patch('asyncio.create_subprocess_exec', return_value=process):
            _, initial = await session.command({'action': 'navigate', 'url': URL}, timeout=1)
            _, entered = await session.command({'action': 'fill', 'selector': 'input', 'text': 'invented quote'}, timeout=1)
            _, unchanged = await session.command({'action': 'snapshot'}, timeout=1)
            _, fresh = await session.command({'action': 'navigate', 'url': URL}, timeout=1)
            await session.close()
        self.assertIsNotNone(initial)
        self.assertIsNone(entered)
        self.assertIsNone(unchanged)
        self.assertIsNone(fresh)
        self.assertTrue(session.input_tainted)
        self.assertIn('input,textarea,select,[contenteditable]', _BROWSER_PROGRAM)

    async def test_restored_input_taint_blocks_evidence_in_next_session(self):
        process = ProtocolProcess()
        session = BrowserSession('owned', env={}, browser_uid=66037, group_id=20,
                                 resource_fetcher=AsyncMock(return_value=response()),
                                 allowed_urls=frozenset({URL}), input_tainted=True,
                                 storage_state={'cookies': [], 'origins': []})
        with patch('asyncio.create_subprocess_exec', return_value=process):
            result, evidence = await session.command({'action': 'navigate', 'url': URL}, timeout=1)
            await session.close()
        self.assertEqual(result['url'], URL)
        self.assertIsNone(evidence)
        self.assertTrue(session.input_tainted)

    async def test_allowlist_never_falls_through_to_public_network(self):
        fetch = AsyncMock(return_value=response())
        session = BrowserSession('owned', env={}, browser_uid=66037, group_id=20,
                                 resource_fetcher=fetch, allowed_urls=frozenset({URL}))
        session._active_action = 'action'
        with patch.object(session, '_send', new_callable=AsyncMock) as send, \
             patch('hermes_chat.browser_rpc.fetch_public_resource', new_callable=AsyncMock) as public:
            for url, method in [('http://169.254.169.254/latest/', 'GET'), (URL, 'POST'),
                                ('https://fixture.example/unlisted', 'GET')]:
                await session._relay({'id': 'a' * 24, 'action_id': 'action', 'url': url, 'method': method})
                self.assertIn('error', send.await_args.args[0])
            fetch.assert_not_awaited()
            public.assert_not_awaited()

    async def test_allowlist_redirect_gate_blocks_response_before_chromium_follows(self):
        fetch = AsyncMock(return_value=response(status=302, headers={'location': 'https://elsewhere.example/'}))
        session = BrowserSession('owned', env={}, browser_uid=66037, group_id=20,
                                 resource_fetcher=fetch, allowed_urls=frozenset({URL}))
        session._active_action = 'action'
        with patch.object(session, '_send', new_callable=AsyncMock) as send:
            await session._relay({'id': 'a' * 24, 'action_id': 'action', 'url': URL, 'method': 'GET'})
        self.assertEqual(fetch.await_count, 1)
        self.assertIn('error', send.await_args.args[0])

    async def test_idle_page_requests_are_blocked_without_a_new_action_budget(self):
        fetch = AsyncMock(return_value=response())
        session = BrowserSession('owned', env={}, browser_uid=66037, group_id=20,
                                 resource_fetcher=fetch, allowed_urls=frozenset({URL}))
        with patch.object(session, '_send', new_callable=AsyncMock) as send:
            await session._relay({'id': 'a' * 24, 'action_id': 'old-action', 'url': URL, 'method': 'GET'})
        fetch.assert_not_awaited()
        self.assertIn('error', send.await_args.args[0])

    async def test_fake_result_without_validated_main_response_has_no_receipt(self):
        process = ProtocolProcess()
        fetch = AsyncMock(return_value=response())
        session = BrowserSession('owned', env={}, browser_uid=66037, group_id=20,
                                 resource_fetcher=fetch, allowed_urls=frozenset({URL}))
        process.url, process.nav = URL, 'a' * 24
        with patch('asyncio.create_subprocess_exec', return_value=process):
            _, document = await session.command({'action': 'snapshot'}, timeout=1)
            await session.close()
        self.assertIsNone(document)
        fetch.assert_not_awaited()

    async def test_nonce_mismatch_fails_closed(self):
        process = ProtocolProcess()
        session = BrowserSession('owned', env={}, browser_uid=66037, group_id=20)
        with patch('asyncio.create_subprocess_exec', return_value=process):
            await session.start()
            process.stdout.feed_data(b'{"event":"ready","token":"forged"}\n')
            await asyncio.sleep(0)
            with self.assertRaises(BrowserProtocolError):
                await session.command({'action': 'snapshot'}, timeout=1)
            await session.close()

    def test_custom_provider_requires_exact_allowlist(self):
        with self.assertRaises(BrowserProtocolError):
            BrowserSession('owned', env={}, browser_uid=66037, group_id=20, resource_fetcher=AsyncMock())

    def test_guest_program_compiles_with_real_api_navigation_and_no_static_renderer(self):
        compile(_BROWSER_PROGRAM, '<browser-guest>', 'exec')
        self.assertIn('page.goto(', _BROWSER_PROGRAM)
        self.assertIn('press_sequentially(', _BROWSER_PROGRAM)
        self.assertIn('page.keyboard.press(', _BROWSER_PROGRAM)
        self.assertIn('page.mouse.wheel(', _BROWSER_PROGRAM)
        self.assertIn('page.screenshot(', _BROWSER_PROGRAM)
        self.assertIn("route_web_socket('**/*'", _BROWSER_PROGRAM)
        self.assertNotIn('set_content(', _BROWSER_PROGRAM)
        self.assertIn('browser.new_context(', _BROWSER_PROGRAM)
        self.assertIn("storage_state=first.get('storage_state'", _BROWSER_PROGRAM)
        self.assertNotIn('add_init_script', _BROWSER_PROGRAM)
        self.assertNotIn('/workspace/.browser/profile', _BROWSER_PROGRAM)

    def test_embedded_guest_rpc_and_javascript_string_escaping(self):
        # Parsing Python alone does not validate the JavaScript inside a guest
        # string. A literal newline inside its quoted separator breaks every
        # real snapshot while mocked protocol tests continue to pass.
        tree = ast.parse(_BROWSER_PROGRAM)
        evaluated = [node.args[0].value for node in ast.walk(tree)
                     if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
                     and node.func.attr == 'evaluate' and isinstance(node.args[0], ast.Constant)]
        self.assertEqual(len(evaluated), 1)
        self.assertIn("parts.join('\\n')", evaluated[0])
        self.assertNotIn("parts.join('\n')", evaluated[0])
        writes = [node.args[0].right.value for node in ast.walk(tree)
                  if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
                  and node.func.attr == 'write' and isinstance(node.args[0], ast.BinOp)]
        self.assertEqual(writes, ['\n'])

    async def test_failed_fetch_spends_full_reservation_and_stops_further_network(self):
        fetch = AsyncMock(side_effect=BrowserNetworkError('truncated after reading bounded bytes'))
        session = BrowserSession('owned', env={}, browser_uid=66037, group_id=20,
                                 resource_fetcher=fetch, allowed_urls=frozenset({URL}))
        session._active_action = 'action'
        with patch.object(session, '_send', new_callable=AsyncMock):
            for _ in range(20):
                await session._relay({'id': 'a' * 24, 'action_id': 'action', 'url': URL, 'method': 'GET'})
        admitted = MAX_ACTION_NETWORK_BYTES // MAX_RESOURCE_WIRE_BYTES
        self.assertEqual(fetch.await_count, admitted)
        self.assertEqual(session._action_bytes, admitted * MAX_RESOURCE_WIRE_BYTES)
        self.assertEqual(session._action_reserved, 0)

    async def test_zero_decoded_body_still_charges_encoded_response_bytes(self):
        wire_bytes = 2_000_011
        empty = GatewayResponse(URL, 200, {'content-type': 'text/plain'}, b'', hashlib.sha256(b'').hexdigest(), wire_bytes)
        fetch = AsyncMock(return_value=empty)
        session = BrowserSession('owned', env={}, browser_uid=66037, group_id=20,
                                 resource_fetcher=fetch, allowed_urls=frozenset({URL}))
        session._active_action = 'action'
        with patch.object(session, '_send', new_callable=AsyncMock):
            for _ in range(20):
                await session._relay({'id': 'a' * 24, 'action_id': 'action', 'url': URL, 'method': 'GET'})
        self.assertGreater(fetch.await_count, 0)
        self.assertLess(fetch.await_count, 20)
        self.assertEqual(session._action_bytes, fetch.await_count * wire_bytes)
        self.assertLessEqual(session._action_bytes, MAX_ACTION_NETWORK_BYTES)

    async def test_concurrent_resource_admission_reserves_before_fetching(self):
        entered = 0
        release = asyncio.Event()
        async def fetch(*args, **kwargs):
            nonlocal entered
            entered += 1
            await release.wait()
            return GatewayResponse(URL, 200, {}, b'', hashlib.sha256(b'').hexdigest(), MAX_RESOURCE_WIRE_BYTES)
        session = BrowserSession('owned', env={}, browser_uid=66037, group_id=20,
                                 resource_fetcher=fetch, allowed_urls=frozenset({URL}))
        session._active_action = 'action'
        with patch.object(session, '_send', new_callable=AsyncMock):
            tasks = [asyncio.create_task(session._relay({'id': 'a' * 24, 'action_id': 'action', 'url': URL, 'method': 'GET'})) for _ in range(20)]
            await asyncio.sleep(0)
            self.assertLessEqual(entered * MAX_RESOURCE_WIRE_BYTES, MAX_ACTION_NETWORK_BYTES)
            self.assertGreater(entered, 1)
            release.set()
            await asyncio.gather(*tasks)
        self.assertLessEqual(session._action_bytes, MAX_ACTION_NETWORK_BYTES)
        self.assertEqual(session._action_reserved, 0)


if __name__ == '__main__':
    unittest.main()
