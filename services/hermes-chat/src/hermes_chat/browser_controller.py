"""Owned, durable browser actions over a replaceable isolated-process backend."""
import asyncio
from datetime import datetime, timezone
import hashlib
import json
import re
import secrets

from .browser_evidence import _issue_browser_receipt
from .browser_network import _public_url, BrowserNetworkError, require_browser_runtime
from .browser_rpc import BrowserSession, BrowserProtocolError
from .browser_state import BrowserStateError
from .browser_store import BrowserStore, EMPTY
from .executor_state import ExecutorError, ExecutorUncertain, MAX_BROWSER_EVIDENCE
from .isolation import guard_tool_arguments

ACTIONS = {"navigate", "snapshot", "click", "fill", "type", "key", "scroll", "screenshot", "reset"}


def bounded_text(value, limit):
    return value.encode("utf-8")[:limit].decode("utf-8", errors="ignore") if isinstance(value, str) else ""


def browser_arguments(arguments):
    safe = guard_tool_arguments("browser", arguments)
    if set(safe) - {"action", "url", "selector", "text", "key", "delta_y"}:
        raise ValueError("Unknown browser argument")
    action = safe.get("action")
    if action not in ACTIONS:
        raise ValueError("Unknown browser action")
    payload = {"action": action}
    if action == "navigate":
        try:
            payload["url"] = _public_url(safe.get("url"))[0]
        except BrowserNetworkError:
            raise ValueError("Browser navigation requires a public HTTP(S) URL") from None
    if action in {"click", "fill", "type"}:
        selector = safe.get("selector")
        if not isinstance(selector, str) or not 0 < len(selector.encode()) <= 512:
            raise ValueError("A bounded CSS selector is required")
        payload["selector"] = selector
    if action in {"fill", "type"}:
        text = safe.get("text")
        if not isinstance(text, str) or len(text.encode()) > 4096:
            raise ValueError("Browser input exceeds its bound")
        payload["text"] = text
    if action == "key":
        key = safe.get("key")
        if not isinstance(key, str) or not 0 < len(key.encode()) <= 64:
            raise ValueError("A bounded browser key chord is required")
        payload["key"] = key
    if action == "scroll":
        delta = safe.get("delta_y")
        if type(delta) is not int or not -4000 <= delta <= 4000:
            raise ValueError("Browser scroll exceeds its bound")
        payload["delta_y"] = delta
    # Reject non-null fields irrelevant to the selected action rather than
    # accepting different requests under an identical action fingerprint.
    if any(value is not None and key not in payload for key, value in safe.items()):
        raise ValueError("Browser arguments do not match the selected action")
    return payload


class BrowserController:
    def __init__(self, runtime, thread_id, run_id, *, scope, run, backend, store, policy,
                 resource_fetcher=None, allowed_urls=None, synthetic_fixture=False):
        self.runtime, self.thread_id, self.run_id = runtime, thread_id, run_id
        self.scope, self.run = scope, run
        self.backend, self.store, self.policy = backend, BrowserStore(store), policy
        if synthetic_fixture and (resource_fetcher is None or not allowed_urls):
            raise ValueError("Synthetic browser fixtures require an exact bounded resource provider")
        self.resource_fetcher, self.allowed_urls = resource_fetcher, allowed_urls
        self.synthetic_fixture = synthetic_fixture
        self.session = None
        self._lock, self._cleanup_lock = asyncio.Lock(), asyncio.Lock()

    def request_key(self, payload):
        return hashlib.sha256(json.dumps([self.policy, payload], sort_keys=True).encode()).hexdigest()

    async def completed(self, arguments, *, operation_id):
        payload = browser_arguments(arguments)
        return self.store.receipt(self.scope, self.run, operation_id, self.request_key(payload))

    def evidence(self, operation_id):
        value = self.store.evidence(self.scope, self.run, operation_id)
        if not value:
            return None
        if (value.get("tenant_key"), value.get("conversation_id"), value.get("run_id")) != (self.runtime.key, self.thread_id, self.run_id):
            raise ExecutorError("Browser evidence ownership does not match.")
        return _issue_browser_receipt(**value)

    def labels(self, row):
        return self.backend.labels(self.scope, row["run"], hashlib.sha256(row["name"].encode()).hexdigest())

    async def recover(self):
        # A new worker cannot authenticate/rejoin the old browser pipe. Stop
        # its exact saved container before any new model or browser dispatch.
        row = self.store.session(self.scope)
        if row and self.session is None:
            if not await self.cancel(recover_previous=True):
                raise ExecutorUncertain("The previous browser still requires confirmed cleanup.")
        try:
            require_browser_runtime()
        except BrowserNetworkError as exc:
            raise ExecutorError(str(exc)) from None

    async def cancel(self, *, cancel_actions=True, recover_previous=False):
        async with self._cleanup_lock:
            pipe_closed = True
            if self.session is not None:
                session, self.session = self.session, None
                try:
                    await session.close()  # Drains relay requests as well as RPC.
                except (OSError, TimeoutError, BrowserProtocolError):
                    # A failed pipe shutdown must not skip container removal.
                    pipe_closed = False
            row = self.store.session(self.scope)
            try:
                if row:
                    foreign = row["run"] != self.run
                    if foreign and not recover_previous:
                        return False
                    if await self.backend.probe_host() != row["daemon"]:
                        return False
                    item = await self.backend.inspect(row["name"])
                    if item is None:
                        if row["phase"] == "creating":
                            return False
                    else:
                        if (any(item.get("Config", {}).get("Labels", {}).get(key) != value for key, value in self.labels(row).items())
                                or row["container"] and item.get("Id") != row["container"]):
                            return False
                        # Repair an orphan from a terminal legacy run only after
                        # its exact container has exited (e.g. the watchdog).
                        # Never stop another run's live or not-yet-started work.
                        if foreign and (row["phase"] != "running" or not row["container"]
                                or item.get("State", {}).get("Running") is not False
                                or item.get("State", {}).get("Status") not in {"exited", "dead"}):
                            return False
                        await self.backend.remove(item["Id"])
                        if await self.backend.inspect(row["name"]) is not None:
                            return False
                if pipe_closed:
                    self.store.closed(self.scope, row["run"] if row else self.run, cancel_actions=cancel_actions)
                return pipe_closed
            except (ExecutorError, OSError, TimeoutError):
                return False

    async def start(self, operation_id):
        require_browser_runtime()
        if self.session is not None:
            return
        image = await self.backend.probe()
        name = "newscraft-browser-" + hashlib.sha256((self.scope + self.run + secrets.token_hex(16)).encode()).hexdigest()[:40]
        self.store.admit_session(self.scope, self.run, operation_id, name, self.backend.daemon)
        row = self.store.session(self.scope)
        identity = await self.backend.create(image, name, self.labels(row))
        self.store.created(self.scope, self.run, identity)
        item = await self.backend.inspect(name)
        if item is None:
            raise ExecutorUncertain("The admitted browser disappeared before dispatch.")
        self.backend.verify_container(item, self.labels(row), image)
        await self.backend.start(identity)
        profile = self.store.profile(self.scope)
        if profile["last_url"]:
            _public_url(profile["last_url"])
        async def process(program, limit):
            return await self.backend.spawn_browser(identity, program, limit)
        self.session = BrowserSession(identity, env={}, browser_uid=1000, group_id=1000,
            process_factory=process, resource_fetcher=self.resource_fetcher, allowed_urls=self.allowed_urls,
            storage_state=profile["storage"], input_tainted=profile["input_tainted"], last_url=profile["last_url"])

    async def execute(self, arguments, *, operation_id):
        if not isinstance(operation_id, str) or not re.fullmatch(r"[a-f0-9]{64}", operation_id):
            raise ValueError("A server-owned browser operation identity is required")
        payload = browser_arguments(arguments)
        async with self._lock:
            old = self.store.admit_action(self.scope, self.run, operation_id, self.request_key(payload),
                taint=payload["action"] in {"fill", "type", "key"})
            if old is not None:
                return old
            try:
                if payload["action"] == "reset":
                    if not await self.cancel(cancel_actions=False):
                        raise ExecutorUncertain("Browser reset could not confirm termination.")
                    result = {"reset": True, "storage_cleared": True, "input_tainted": False, "evidence_available": False}
                    self.store.finish(self.scope, self.run, operation_id, result, profile=EMPTY)
                    return result
                async with asyncio.timeout(60):
                    await self.start(operation_id)
                    result, document = await self.session.command(payload, timeout=35)
                # Only explicit public observation fields leave the controller.
                result = dict(result)
                evidence_text = result.pop("evidence_text", None)
                image = result.pop("_screenshot_bytes", None)
                profile = {"storage": self.session.storage_state, "input_tainted": self.session.input_tainted,
                           "last_url": self.session.last_url}
                if profile["last_url"]:
                    _public_url(profile["last_url"])
                result = {key: value for key, value in result.items() if key in {
                    "url", "title", "text", "links", "page_id", "navigation_id", "untrusted_source",
                    "scripts_enabled", "network_policy", "screenshot_sha256", "screenshot_bytes"}}
                # Bound bytes as well as characters so multilingual pages and
                # long link lists still fit the durable public receipt.
                for key, limit in (("url", 8192), ("title", 1024), ("text", 24000)):
                    result[key] = bounded_text(result.get(key), limit)
                if "links" in result:
                    result["links"] = [{"text": bounded_text(link.get("text"), 160),
                                        "href": bounded_text(link.get("href"), 512)}
                                       for link in result["links"][:30] if isinstance(link, dict)]
                result["untrusted_source"] = True
                result["input_tainted"] = self.session.input_tainted
                evidence = None
                if document and isinstance(evidence_text, str) and not self.session.input_tainted:
                    response = document["response"]
                    evidence = {"receipt_id": operation_id, "tenant_key": self.runtime.key,
                        "conversation_id": self.thread_id, "run_id": self.run_id, "final_url": result["url"],
                        "rendered_text": evidence_text, "title": result.get("title", ""),
                        "main_document_url": response.url, "main_document_sha256": response.sha256,
                        "main_document_html": response.body.decode("utf-8", errors="replace"),
                        "response_headers": response.headers, "navigation_id": result["navigation_id"],
                        "fetched_at": datetime.fromtimestamp(document["fetched_at"], tz=timezone.utc).isoformat(),
                        "validated_request_count": document["validated_request_count"], "javascript_enabled": True,
                        "synthetic_fixture": self.synthetic_fixture, "public_network_validated": not self.synthetic_fixture}
                    if len(json.dumps(evidence, ensure_ascii=False).encode()) > MAX_BROWSER_EVIDENCE:
                        evidence = None
                result["evidence_available"] = evidence is not None
                if evidence:
                    result["receipt_id"] = operation_id
                screenshot = None
                if image is not None:
                    name = "browser-screenshots/" + operation_id + ".png"
                    screenshot = (name, image)
                    result["screenshot_path"] = "/workspace/" + name
                self.store.finish(self.scope, self.run, operation_id, result, profile=profile, evidence=evidence, screenshot=screenshot)
                return result
            except asyncio.CancelledError:
                if not await asyncio.shield(self.cancel()):
                    raise ExecutorUncertain("Browser cancellation could not be confirmed.") from None
                raise
            except (ExecutorError, BrowserProtocolError, BrowserNetworkError, BrowserStateError, OSError, ValueError, TimeoutError) as exc:
                if not await self.cancel(cancel_actions=False):
                    raise ExecutorUncertain("Browser cleanup remains uncertain; the action will not be repeated.") from None
                if isinstance(exc, ExecutorUncertain):
                    self.store.closed(self.scope, self.run)
                    raise
                result = {"error": "The isolated browser action failed; uncommitted changes were discarded and execution stopped."}
                self.store.finish(self.scope, self.run, operation_id, result)
                return result
            except BaseException:
                if not await self.cancel():
                    raise ExecutorUncertain("Browser cleanup remains uncertain; the action will not be repeated.") from None
                raise
