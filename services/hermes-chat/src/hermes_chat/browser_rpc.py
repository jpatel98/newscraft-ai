"""Persistent Chromium RPC over Docker pipes; no container network/socket relay."""
from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import secrets
import time
from urllib.parse import urljoin
from typing import Any

from .browser_network import (BrowserNetworkError, GatewayResponse, fetch_public_resource,
                              MAX_RESOURCE_BYTES, MAX_RESOURCE_WIRE_BYTES)

MAX_RPC_LINE = 4 * 1024 * 1024
MAX_REQUESTS_PER_ACTION = 80
MAX_ACTION_NETWORK_BYTES = 16 * 1024 * 1024
MAX_RUN_REQUESTS = 400
MAX_PENDING_REQUESTS = 24


class BrowserProtocolError(RuntimeError):
    pass


# Executed with python -I under a distinct container UID. Workspace modules,
# model terminal /proc writes, cookies, and host secrets cannot become the RPC
# issuer. The renderer's DOM remains untrusted source data.
_BROWSER_PROGRAM = r'''
import asyncio, base64, hashlib, json, os, pathlib, secrets, shutil, sys, tempfile
from playwright.async_api import async_playwright
MAX_LINE = 4194304
async def main():
    loop = asyncio.get_running_loop()
    reader = asyncio.StreamReader(limit=MAX_LINE)
    protocol = asyncio.StreamReaderProtocol(reader)
    await loop.connect_read_pipe(lambda: protocol, sys.stdin.buffer)
    first = json.loads(await reader.readline())
    token = first['token']
    pending = {}
    active_action = None
    active_task = None
    navigation_ids = {}
    page_ids = {}
    def send(message):
        message['token'] = token
        data = json.dumps(message, ensure_ascii=False)
        if len(data.encode()) > MAX_LINE: raise ValueError('RPC output too large')
        sys.stdout.write(data + '\n')
        sys.stdout.flush()
    def page_id(page):
        return page_ids.setdefault(page, secrets.token_hex(12))
    async with async_playwright() as p:
        # Model terminal and filesystem tools cannot alter browser storage or
        # inspect its pipe: the separate browser UID owns this random 0700
        # directory in tmpfs. Persistence comes only from authenticated stdin.
        os.umask(0o077)
        profile = pathlib.Path(tempfile.mkdtemp(prefix='newscraft-browser-', dir='/tmp'))
        profile.chmod(0o700)
        os.environ['HOME'] = str(profile)
        # Internal Chromium sandbox must work in the approved operator seccomp
        # policy; no fallback disables it or grants extra privileges.
        browser = await p.chromium.launch(headless=True, chromium_sandbox=True,
            args=['--disable-dev-shm-usage', '--disable-extensions', '--disable-background-networking',
                  '--disable-features=FileSystemAccessAPI'])
        # Native context restore happens once. An init script on each navigation
        # would overwrite interactive storage changes with the initial state.
        context = await browser.new_context(java_script_enabled=True, service_workers='block',
            accept_downloads=False, viewport={'width': 1280, 'height': 720},
            storage_state=first.get('storage_state', {'cookies': [], 'origins': []}))
        page = await context.new_page()
        async def route_request(route):
            request = route.request
            if not active_action or not request.url.startswith(('http://', 'https://')):
                await route.abort('blockedbyclient')
                return
            identity = secrets.token_hex(12)
            frame = request.frame
            owner = frame.page
            main_document = request.is_navigation_request() and frame == owner.main_frame
            navigation_id = secrets.token_hex(12) if main_document else None
            future = loop.create_future()
            pending[identity] = future
            send({'event': 'request', 'id': identity, 'action_id': active_action,
                  'url': request.url, 'method': request.method,
                  'headers': request.headers, 'main_document': main_document,
                  'navigation_id': navigation_id, 'page_id': page_id(owner)})
            try:
                response = await asyncio.wait_for(future, timeout=16)
                if response.get('error'):
                    await route.abort('blockedbyclient')
                else:
                    await route.fulfill(status=response['status'], headers=response['headers'],
                                        body=base64.b64decode(response['body'], validate=True))
                    if main_document and 200 <= response['status'] < 300:
                        navigation_ids[owner] = navigation_id
            except Exception:
                await route.abort('failed')
            finally: pending.pop(identity, None)
        await context.route('**/*', route_request)
        async def reject_socket(socket):
            await socket.close(code=1008, reason='Research browser does not allow socket egress')
        await context.route_web_socket('**/*', reject_socket)
        def new_page(opened):
            if len(context.pages) > 4:
                asyncio.create_task(opened.close())
            opened.on('download', lambda download: asyncio.create_task(download.cancel()))
        context.on('page', new_page)
        page.on('download', lambda download: asyncio.create_task(download.cancel()))
        async def snapshot():
            text = await page.locator('body').inner_text(timeout=5000)
            # Form values and editable DOM are not citation evidence. Host also
            # taints the persisted context after any model input until reset.
            evidence = await page.locator('body').evaluate(''' + "'''" + r'''
                (body) => {
                    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
                    const parts = [];
                    while (walker.nextNode()) {
                        const node = walker.currentNode, parent = node.parentElement;
                        if (!parent || parent.closest('input,textarea,select,[contenteditable],script,style,noscript')) continue;
                        let visible = true;
                        for (let item = parent; item; item = item.parentElement) {
                            const style = getComputedStyle(item);
                            if (style.display === 'none' || style.visibility === 'hidden') { visible = false; break; }
                        }
                        if (visible && node.textContent.trim()) parts.push(node.textContent.trim());
                    }
                    return parts.join('\\n');
                }
            ''' + "'''" + r''')
            links = await page.locator('a[href]').evaluate_all('(els) => els.slice(0,30).map(e => ({text:(e.innerText||" ").slice(0,160),href:(e.getAttribute("href")||"").slice(0,512)}))')
            return {'url': page.url, 'title': (await page.title())[:512], 'text': text[:24000],
                    'evidence_text': evidence[:60000], 'links': links, 'page_id': page_id(page),
                    'navigation_id': navigation_ids.get(page), 'untrusted_source': True,
                    'scripts_enabled': True, 'network_policy': 'public_get_head'}
        async def action(message):
            nonlocal active_action, active_task, page
            identity = message['id']
            active_action = identity
            try:
                name = message['action']
                if name == 'navigate':
                    await page.goto(message['url'], wait_until='domcontentloaded', timeout=20000)
                elif page.url == 'about:blank' and first.get('last_url'):
                    await page.goto(first['last_url'], wait_until='domcontentloaded', timeout=20000)
                if name == 'click':
                    previous = list(context.pages)
                    await page.locator(message['selector']).first.click(timeout=10000)
                    opened = [item for item in context.pages if item not in previous]
                    if opened: page = opened[-1]
                elif name == 'fill':
                    await page.locator(message['selector']).first.fill(message['text'], timeout=10000)
                elif name == 'type':
                    await page.locator(message['selector']).first.press_sequentially(message['text'], timeout=10000)
                elif name == 'key':
                    await page.keyboard.press(message['key'])
                elif name == 'scroll':
                    await page.mouse.wheel(0, message['delta_y'])
                elif name not in {'navigate', 'snapshot', 'screenshot'}:
                    raise ValueError('unknown browser action')
                # Give task/microtask-driven rendering a bounded settling time.
                # Never wait indefinitely for analytics/long polling.
                await page.wait_for_timeout(200)
                settle_deadline = loop.time() + 3
                while pending and loop.time() < settle_deadline:
                    await asyncio.sleep(0.05)
                # A fulfilled async resource can schedule a DOM update after
                # its route callback returns. Keep that final settle bounded.
                await page.wait_for_timeout(50)
                result = await snapshot()
                if name == 'screenshot':
                    image = await page.screenshot(type='png', full_page=False, timeout=10000)
                    if len(image) > 1048576: raise ValueError('screenshot exceeds 1 MiB')
                    result['screenshot_base64'] = base64.b64encode(image).decode('ascii')
                result['storage_state'] = await context.storage_state()
                send({'event': 'result', 'id': identity, 'result': result})
            except Exception as exc:
                send({'event': 'result', 'id': identity, 'error': type(exc).__name__ + ': browser action could not complete'})
            finally:
                active_action = None
                active_task = None
        send({'event': 'ready'})
        try:
            while line := await reader.readline():
                if len(line) > MAX_LINE: raise ValueError('RPC input too large')
                message = json.loads(line)
                if message.get('token') != token: raise ValueError('RPC identity mismatch')
                if message.get('event') == 'response':
                    future = pending.get(message['id'])
                    if future and not future.done(): future.set_result(message)
                elif message.get('event') == 'command':
                    if active_task: raise ValueError('concurrent browser actions rejected')
                    active_task = asyncio.create_task(action(message))
                elif message.get('event') == 'close':
                    break
                else: raise ValueError('unknown RPC message')
        finally:
            if active_task:
                active_task.cancel()
                await asyncio.gather(active_task, return_exceptions=True)
            for future in pending.values():
                if not future.done(): future.cancel()
            await context.close()
            await browser.close()
            shutil.rmtree(profile, ignore_errors=True)
asyncio.run(main())
'''


class BrowserSession:
    def __init__(self, container: str, *, env: dict[str, str], browser_uid: int, group_id: int,
                 resource_fetcher: Any = None, allowed_urls: frozenset[str] | None = None,
                 storage_state: dict[str, Any] | None = None, input_tainted: bool = False, last_url: str = '',
                 docker_argv_builder: Any = None, process_factory: Any = None):
        self.container = container
        self.env = env
        self.browser_uid = browser_uid
        self.group_id = group_id
        # Trusted host injection for the disposable validator, never a tool argument.
        self._docker_argv_builder = docker_argv_builder
        # Active adapters can supply any verified isolated process transport.
        # No local-process fallback is selected by the owned runtime.
        self._process_factory = process_factory
        if resource_fetcher is not None and not allowed_urls:
            raise BrowserProtocolError('Custom browser resource providers require an exact URL allowlist')
        self.resource_fetcher = resource_fetcher or fetch_public_resource
        self.allowed_urls = frozenset(allowed_urls) if allowed_urls is not None else None
        self.storage_state = storage_state or {'cookies': [], 'origins': []}
        self.input_tainted = input_tainted
        self.last_url = last_url
        self.token = secrets.token_hex(32)
        self.process: Any = None
        self.reader_task: asyncio.Task | None = None
        self.stderr_task: asyncio.Task | None = None
        self.request_tasks: set[asyncio.Task] = set()
        self.ready: asyncio.Future | None = None
        self.pending: dict[str, asyncio.Future] = {}
        self.documents: dict[str, dict[str, Any]] = {}
        self._writer_lock = asyncio.Lock()
        self._network_semaphore = asyncio.Semaphore(min(6, MAX_ACTION_NETWORK_BYTES // MAX_RESOURCE_WIRE_BYTES))
        self._active_action: str | None = None
        self._action_requests = 0
        self._action_bytes = 0
        self._action_reserved = 0
        self._run_requests = 0
        self._validated_requests = 0
        self._tainted_navigation: str | None = None
        self._last_navigation: str | None = None
        self._fault: BaseException | None = None
        self._config_context: Any = None

    async def start(self) -> None:
        if self.process:
            return
        self.ready = asyncio.get_running_loop().create_future()
        from .docker_boundary import DockerBoundaryError, empty_docker_config, verified_docker_argv
        try:
            if self._process_factory is not None:
                self.process = await self._process_factory(_BROWSER_PROGRAM, MAX_RPC_LINE)
            else:
                self._config_context = empty_docker_config()
                config = self._config_context.__enter__()
                builder = self._docker_argv_builder or verified_docker_argv
                argv = await builder([
                    'docker', 'exec', '--interactive', '--user', f'{self.browser_uid}:{self.group_id}',
                    '--workdir', '/tmp', '--env', 'HOME=/tmp', self.container,
                    'python3', '-I', '-u', '-c', _BROWSER_PROGRAM], config_dir=config)
                self.process = await asyncio.create_subprocess_exec(*argv,
                    stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
                    env=self.env, limit=MAX_RPC_LINE)
            self.reader_task = asyncio.create_task(self._read_messages())
            self.stderr_task = asyncio.create_task(self._drain_stderr())
            await self._send({'token': self.token, 'storage_state': self.storage_state, 'last_url': self.last_url})
            await asyncio.wait_for(self.ready, timeout=20)
        except DockerBoundaryError as exc:
            await self.close()
            raise BrowserProtocolError('Browser Docker daemon does not match the local quota boundary') from exc
        except BaseException:
            await self.close()
            raise

    async def _send(self, message: dict[str, Any]) -> None:
        message['token'] = self.token
        data = json.dumps(message, ensure_ascii=False).encode() + b'\n'
        if len(data) > MAX_RPC_LINE:
            raise BrowserProtocolError('Browser RPC message exceeds its bound')
        async with self._writer_lock:
            if not self.process or self.process.returncode is not None or not self.process.stdin:
                raise BrowserProtocolError('Browser RPC process is unavailable')
            self.process.stdin.write(data)
            await self.process.stdin.drain()

    def _fail(self, exc: BaseException) -> None:
        self._fault = exc
        for future in [self.ready, *self.pending.values()]:
            if future is not None and not future.done():
                future.set_exception(BrowserProtocolError('Browser RPC failed closed'))

    async def _drain_stderr(self) -> None:
        try:
            total = 0
            while chunk := await self.process.stderr.read(16384):
                total += len(chunk)
                if total > 128 * 1024:
                    raise BrowserProtocolError('Browser stderr exceeded its bound')
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            self._fail(exc)

    async def _read_messages(self) -> None:
        try:
            while line := await self.process.stdout.readline():
                if len(line) > MAX_RPC_LINE:
                    raise BrowserProtocolError('Browser RPC response exceeded its bound')
                message = json.loads(line)
                if not isinstance(message, dict) or message.get('token') != self.token:
                    raise BrowserProtocolError('Browser RPC response identity is invalid')
                event = message.get('event')
                if event == 'ready':
                    if self.ready.done():
                        raise BrowserProtocolError('Browser duplicate ready event')
                    self.ready.set_result(None)
                elif event == 'request':
                    if len(self.request_tasks) >= MAX_PENDING_REQUESTS:
                        await self._send({'event': 'response', 'id': message.get('id'),
                                          'error': 'Browser concurrent request budget is exhausted'})
                        continue
                    task = asyncio.create_task(self._relay(message))
                    self.request_tasks.add(task)
                    task.add_done_callback(self.request_tasks.discard)
                elif event == 'result':
                    future = self.pending.get(message.get('id'))
                    if future is None or future.done():
                        raise BrowserProtocolError('Browser unsolicited or duplicate action result')
                    if message.get('error'):
                        future.set_exception(BrowserProtocolError('Browser action failed in isolated Chromium'))
                    elif isinstance(message.get('result'), dict):
                        future.set_result(message['result'])
                    else:
                        raise BrowserProtocolError('Browser invalid action result')
                else:
                    raise BrowserProtocolError('Browser RPC unknown message')
            raise BrowserProtocolError('Browser RPC closed unexpectedly')
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            self._fail(exc)

    async def _relay(self, message: dict[str, Any]) -> None:
        identity = message.get('id')
        try:
            if not isinstance(identity, str) or len(identity) != 24 or message.get('action_id') != self._active_action or not self._active_action:
                raise BrowserNetworkError('Browser network request is outside an active action')
            self._action_requests += 1
            self._run_requests += 1
            if self._action_requests > MAX_REQUESTS_PER_ACTION or self._run_requests > MAX_RUN_REQUESTS:
                raise BrowserNetworkError('Browser network request budget is exhausted')
            url = message.get('url')
            method = message.get('method')
            if method not in {'GET', 'HEAD'}:
                raise BrowserNetworkError('Browser external writes require separate authorization')
            if self.allowed_urls is not None and url not in self.allowed_urls:
                raise BrowserNetworkError('Browser URL is outside the trusted request allowlist')
            async with self._network_semaphore:
                # Reserve the maximum bounded resource before the fetch, so
                # concurrent responses cannot overspend the action budget.
                reserve = MAX_RESOURCE_WIRE_BYTES
                if self._action_bytes + self._action_reserved + reserve > MAX_ACTION_NETWORK_BYTES:
                    raise BrowserNetworkError('Browser network byte budget is exhausted')
                self._action_reserved += reserve
                try:
                    response = await self.resource_fetcher(url, method=method,
                                                          request_headers=message.get('headers'), timeout_seconds=15)
                    if type(response) is not GatewayResponse or response.url != url or len(response.body) > MAX_RESOURCE_BYTES:
                        raise BrowserNetworkError('Browser provider returned an invalid bounded response')
                    if hashlib.sha256(response.body).hexdigest() != response.sha256:
                        raise BrowserNetworkError('Browser provider response digest is invalid')
                    wire = response.wire_bytes
                    if wire is not None and (isinstance(wire, bool) or not isinstance(wire, int) or not 0 <= wire <= reserve):
                        raise BrowserNetworkError('Browser provider wire accounting is invalid')
                    charge = max(len(response.body), wire or 0)
                    if response.status in {301, 302, 303, 307, 308} and self.allowed_urls is not None:
                        location = response.headers.get('location')
                        if not location or urljoin(url, location) not in self.allowed_urls:
                            raise BrowserNetworkError('Browser redirect is outside the trusted request allowlist')
                except BaseException:
                    # A malformed/failed response may already have transferred
                    # its entire bound. Never refund unknown network spending.
                    self._action_bytes += reserve
                    raise
                else:
                    self._action_bytes += charge
                finally:
                    self._action_reserved -= reserve
                if self._action_bytes > MAX_ACTION_NETWORK_BYTES:
                    raise BrowserNetworkError('Browser network byte budget is exhausted')
                self._validated_requests += 1
                navigation = message.get('navigation_id')
                if message.get('main_document') and isinstance(navigation, str) and 200 <= response.status < 300:
                    kind = response.headers.get('content-type', '').split(';', 1)[0].strip().lower()
                    if kind in {'text/html', 'application/xhtml+xml', 'text/plain'}:
                        self.documents[navigation] = {
                            'response': response, 'fetched_at': time.time(),
                            'page_id': message.get('page_id'), 'action_id': self._active_action,
                        }
                        # Keep only a bounded private trace for this run.
                        while len(self.documents) > 32:
                            self.documents.pop(next(iter(self.documents)))
                await self._send({'event': 'response', 'id': identity, 'status': response.status,
                                  'headers': response.headers, 'body': base64.b64encode(response.body).decode('ascii')})
        except asyncio.CancelledError:
            raise
        except Exception:
            try:
                await self._send({'event': 'response', 'id': identity, 'error': 'Request blocked by public browser network policy'})
            except (BrowserProtocolError, OSError):
                self._fail(BrowserProtocolError('Browser network relay failed'))

    async def command(self, payload: dict[str, Any], *, timeout: float) -> tuple[dict[str, Any], dict[str, Any] | None]:
        if self._fault:
            raise BrowserProtocolError('Browser RPC is unavailable after a protocol failure')
        await self.start()
        identity = secrets.token_hex(12)
        future = asyncio.get_running_loop().create_future()
        self.pending[identity] = future
        self._active_action = identity
        self._action_requests = self._action_bytes = self._action_reserved = 0
        if payload['action'] in {'fill', 'type', 'key'}:
            # Taint the whole persisted browser context before an input action
            # starts, including failed/partial inputs and cross-origin echoes.
            self.input_tainted = True
        try:
            await self._send({'event': 'command', 'id': identity, **payload})
            result = await asyncio.wait_for(future, timeout=timeout)
            navigation = result.get('navigation_id')
            if payload['action'] in {'fill', 'type', 'key'}:
                self._tainted_navigation = navigation
            storage = result.pop('storage_state', None)
            if not isinstance(storage, dict) or len(json.dumps(storage).encode()) > 1024 * 1024:
                raise BrowserProtocolError('Browser persistent state is invalid or oversized')
            self.storage_state = storage
            self.last_url = result.get('url', '')
            document = self.documents.get(navigation)
            if (not document or document['page_id'] != result.get('page_id')
                    or self.input_tainted or not isinstance(result.get('evidence_text'), str)):
                document = None
            if document and result.get('url') != document['response'].url:
                document = None
            if document:
                document = dict(document)
                document['validated_request_count'] = self._validated_requests
            screenshot = result.pop('screenshot_base64', None)
            if screenshot is not None:
                try:
                    data = base64.b64decode(screenshot, validate=True)
                except (ValueError, TypeError) as exc:
                    raise BrowserProtocolError('Browser screenshot encoding is invalid') from exc
                if len(data) > 1024 * 1024 or not data.startswith(b'\x89PNG\r\n\x1a\n'):
                    raise BrowserProtocolError('Browser screenshot exceeds its image bound')
                result['screenshot_sha256'] = hashlib.sha256(data).hexdigest()
                result['screenshot_bytes'] = len(data)
                result['_screenshot_bytes'] = data
            return result, document
        finally:
            self._active_action = None
            self.pending.pop(identity, None)
            # A page's idle timers never get an independent network budget.
            tasks = list(self.request_tasks)
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)

    async def close(self) -> None:
        if self.process and self.process.returncode is None:
            try:
                await self._send({'event': 'close'})
                await asyncio.wait_for(self.process.wait(), timeout=5)
            except (BrowserProtocolError, OSError, TimeoutError):
                pass
        tasks = [self.reader_task, self.stderr_task, *self.request_tasks]
        for task in tasks:
            if task is not None:
                task.cancel()
        await asyncio.gather(*(task for task in tasks if task is not None), return_exceptions=True)
        if self.process:
            if self.process.stdin:
                try:
                    self.process.stdin.close()
                except OSError:
                    pass
            if self.process.returncode is None:
                try:
                    self.process.kill()
                except ProcessLookupError:
                    pass
            await self.process.wait()
            self.process = None
        if self._config_context is not None:
            context, self._config_context = self._config_context, None
            context.__exit__(None, None, None)
