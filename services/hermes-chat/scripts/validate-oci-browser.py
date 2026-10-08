#!/usr/bin/env python3
"""Synthetic Chromium acceptance on an already authorized rootless Linux host.

Starts only its own bounded containers. Uses a fixed in-memory page and an exact
URL allowlist: no public websites, model, database or paid calls. Does not pull
images, install policies, alter permissions, or start existing host services.
"""
import argparse
import asyncio
import hashlib
import io
import json
from pathlib import Path
import shutil
import sys
import tarfile
import tempfile

from hermes_chat.browser_network import GatewayResponse
from hermes_chat.executor_state import SnapshotStore
from hermes_chat.isolation import TenantIsolation
from hermes_chat.oci_executor import OCIConfig, OCIComputerFactory, OCIBrowserComputer
from hermes_chat.retrieval import ResearchTools, RetrievalConfig

URL = "https://newscraft-fixture.example/article"
BLOCKED = "https://newscraft-fixture.example/pending"
EXCERPT = "The synthetic source reports three measured results for this browser acceptance fixture."
PAGE = ("""<!doctype html><html><head><title>Synthetic research</title></head><body>
<article>""" + (EXCERPT + " ") * 12 + """</article><input id="entry">
<button id="increment">Increment</button><p id="count"></p>
<script>
let count = Number(localStorage.getItem('count') || '0');
const render = () => document.getElementById('count').textContent = 'Clicks ' + count;
document.getElementById('increment').onclick = () => {
  count += 1; localStorage.setItem('count', String(count)); render();
};
render();
</script></body></html>""").encode()


async def validate(args):
    root = Path(tempfile.mkdtemp(prefix="newscraft-browser-acceptance-")).resolve()
    config = OCIConfig(args.image, Path(args.socket), root / "computer", args.docker_binary,
        browser_image=args.browser_image, browser_seccomp=Path(args.seccomp_profile),
        browser_seccomp_sha256=args.seccomp_sha256)
    isolation = TenantIsolation(root / "identities", root / "unused-staging")
    store, computers, checks = SnapshotStore(config.state_root), [], []
    blocked, drained = asyncio.Event(), asyncio.Event()

    async def fetch(url, **kwargs):
        if url == BLOCKED:
            blocked.set()
            try:
                await asyncio.Event().wait()
            finally:
                drained.set()
        if url != URL:
            raise RuntimeError("Unlisted synthetic resource")
        return GatewayResponse(URL, 200, {"content-type": "text/html"}, PAGE, hashlib.sha256(PAGE).hexdigest())

    def computer(tenant="synthetic-a", thread="synthetic-thread", run="synthetic-run"):
        runtime = isolation.resolve(tenant, thread)
        value = OCIBrowserComputer(runtime, thread, run, config=config, store=store,
            resource_fetcher=fetch, allowed_urls=frozenset({URL, BLOCKED}), synthetic_fixture=True)
        computers.append(value)
        return value

    async def action(value, kind, identity, **arguments):
        result = await value.execute("browser", {"action": kind, **arguments},
            operation_id=hashlib.sha256(identity.encode()).hexdigest())
        if "error" in result:
            raise RuntimeError("Synthetic browser action failed; tool output was not logged.")
        return result

    safe_to_remove = False
    try:
        if not (await OCIComputerFactory(config).readiness())["configured"]:
            raise RuntimeError("The existing executor and browser must pass configuration admission.")
        first = computer()
        result = await action(first, "navigate", "navigate", url=URL)
        if "Clicks 0" not in result["text"] or not result["evidence_available"]:
            raise RuntimeError("JavaScript rendering or browser evidence failed.")
        research = ResearchTools(RetrievalConfig())
        research.bind_run("synthetic-a", "synthetic-thread", "synthetic-run")
        research.remember_browser_receipt(first.browser_receipt(result["receipt_id"]))
        checks.append("guarded-chromium-javascript-and-source-evidence")

        result = await first.execute("terminal", {"command": "printf 'private files [1]' > brief.md"},
            operation_id=hashlib.sha256(b"terminal").hexdigest())
        if result.get("error") or result.get("exit_code") != 0:
            raise RuntimeError("The separate terminal fixture failed.")
        clicked = await action(first, "click", "click", selector="#increment")
        repeated = await action(first, "click", "click", selector="#increment")
        snapshot = await action(first, "snapshot", "snapshot")
        if clicked != repeated or "Clicks 1" not in snapshot["text"]:
            raise RuntimeError("Interactive state or duplicate receipt failed.")
        checks.append("interaction-survives-terminal-and-duplicate-is-not-repeated")

        shot = await action(first, "screenshot", "screenshot")
        with store.connect() as db:
            data = db.execute("SELECT snapshot FROM workspaces WHERE scope=?", (first.scope,)).fetchone()[0]
        with tarfile.open(fileobj=io.BytesIO(data)) as archive:
            image = archive.extractfile(shot["screenshot_path"].removeprefix("/workspace/")).read()
            if not image.startswith(b"\x89PNG\r\n\x1a\n") or archive.extractfile("brief.md").read() != b"private files [1]":
                raise RuntimeError("Screenshot or persistent conversation files failed.")
        checks.append("screenshot-merged-into-persistent-files")
        await first.close()

        resumed = computer(run="synthetic-next-run")
        result = await action(resumed, "snapshot", "reload")
        if "Clicks 1" not in result["text"]:
            raise RuntimeError("Private storage and last-URL restoration failed.")
        checks.append("storage-survives-worker-and-turn")
        result = await action(resumed, "fill", "input", selector="#entry", text="invented quote")
        if result["evidence_available"] or not result["input_tainted"]:
            raise RuntimeError("Model input was not excluded from citation evidence.")
        await action(resumed, "reset", "reset")
        result = await action(resumed, "navigate", "fresh", url=URL)
        if not result["evidence_available"] or "Clicks 0" not in result["text"]:
            raise RuntimeError("Browser reset failed.")
        await resumed.close()
        checks.append("input-taint-and-reset")

        for other in (computer(tenant="synthetic-b"), computer(thread="synthetic-other-thread")):
            result = await action(other, "navigate", "other", url=URL)
            if "Clicks 0" not in result["text"]:
                raise RuntimeError("Private browser storage crossed an ownership boundary.")
            await other.close()
        checks.append("tenant-and-conversation-isolation")

        task = asyncio.create_task(action(first, "navigate", "pending", url=BLOCKED))
        try:
            await asyncio.wait_for(blocked.wait(), 30)
        finally:
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
        if not drained.is_set() or first.browser.store.session(first.scope):
            raise RuntimeError("Browser cancellation did not drain the gateway and confirm container cleanup.")
        checks.append("cancel-running-browser-and-drain-network")
        safe_to_remove = all([await value.cancel() for value in computers])
        if not safe_to_remove:
            raise RuntimeError("Fixture cleanup remains uncertain.")
        print(json.dumps({"result": "pass", "checks": checks, "model_calls": 0,
            "public_network_tested": False, "cloud_app_tested": False}))
    finally:
        if not safe_to_remove:
            try:
                safe_to_remove = all([await value.cancel() for value in computers])
            except Exception:
                safe_to_remove = False
        if safe_to_remove:
            shutil.rmtree(root)
        else:
            print(f"Cleanup unconfirmed; retained private fixture state at {root}", file=sys.stderr)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image", required=True, help="Pre-provisioned immutable terminal image")
    parser.add_argument("--browser-image", required=True, help="Pre-provisioned immutable browser image")
    parser.add_argument("--socket", required=True)
    parser.add_argument("--seccomp-profile", required=True, help="Existing reviewed Chromium policy file")
    parser.add_argument("--seccomp-sha256", required=True)
    parser.add_argument("--docker-binary", default="/usr/bin/docker")
    arguments = parser.parse_args()
    if sys.platform != "linux":
        parser.error("Live browser acceptance requires an authorized Linux worker; no service was started.")
    try:
        asyncio.run(validate(arguments))
    except Exception:
        print("Browser acceptance failed; no credentials or tool output were logged.", file=sys.stderr)
        raise SystemExit(1)
