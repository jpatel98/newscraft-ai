#!/usr/bin/env python3
"""Synthetic live computer acceptance on an already authorized Linux executor.

No model, database, service restart, image pull, Docker setup or host commands
from a model. Creates only fresh bounded containers and private fixture state.
Retains state if daemon cleanup cannot be confirmed. Not run on this Mac.
"""
import argparse
import asyncio
import hashlib
import json
from pathlib import Path
import shutil
import sys
import tempfile
import time

from hermes_chat.executor_state import SnapshotStore
from hermes_chat.isolation import TenantIsolation
from hermes_chat.oci_executor import DockerEngine, OCIComputer, OCIConfig


async def validate(args):
    root = Path(tempfile.mkdtemp(prefix="newscraft-oci-acceptance-")).resolve()
    config = OCIConfig(args.image, Path(args.socket), root / "computer", args.docker_binary)
    isolation = TenantIsolation(root / "identities", root / "unused-staging")
    store = SnapshotStore(config.state_root)
    computers = []
    checks = []
    def computer(tenant="synthetic-a", thread="synthetic-thread", run="synthetic-run"):
        runtime = isolation.resolve(tenant, thread)
        value = OCIComputer(runtime, thread, run, config=config, store=store)
        computers.append(value)
        return value
    async def action(value, name, arguments, identity):
        result = await value.execute(name, arguments, operation_id=hashlib.sha256(identity.encode()).hexdigest())
        if "error" in result:
            raise RuntimeError("Synthetic computer acceptance action failed; no tool output was logged.")
        return result
    safe_to_remove = False
    try:
        await DockerEngine(config).probe()
        first = computer()
        await action(first, "write_file", {"path": "brief.md", "content": "Synthetic citation fixture [1].\n"}, "write")
        result = await action(first, "terminal", {"command": "printf 'total\\n3\\n' > calculated.csv; printf 'synthetic-ok'"}, "calculate")
        if result.get("exit_code") != 0 or result.get("stdout") != "synthetic-ok":
            raise RuntimeError("The isolated terminal fixture did not complete.")
        checks.append("guarded-terminal-and-write")
        resumed = computer(run="synthetic-resumed-run")
        result = await action(resumed, "read_file", {"path": "calculated.csv"}, "read")
        if result.get("content") != "total\n3\n":
            raise RuntimeError("Conversation persistence failed.")
        checks.append("files-survive-fresh-container-and-run")
        for value in (computer(tenant="synthetic-b"), computer(thread="synthetic-other-thread")):
            result = await action(value, "list_files", {"path": "/workspace"}, "list")
            if result.get("entries"):
                raise RuntimeError("Tenant or conversation isolation failed.")
        checks.append("tenant-and-conversation-separation")
        # A filesystem change proves a duplicate would be observable.
        append = {"command": "printf x >> once.txt"}
        await action(first, "terminal", append, "duplicate")
        await action(first, "terminal", append, "duplicate")
        result = await action(first, "read_file", {"path": "once.txt"}, "read-once")
        if result.get("content") != "x":
            raise RuntimeError("Duplicate operation was executed again.")
        checks.append("duplicate-receipt-without-reexecution")
        pending = asyncio.create_task(action(first, "terminal", {"command": "printf started > waiting; sleep 30"}, "cancel"))
        deadline = time.monotonic() + 15
        try:
            started = False
            while not pending.done() and time.monotonic() < deadline:
                for row in store.pending(first.scope, first.run):
                    if row["container"]:
                        item = await first.engine.inspect(row["name"])
                        if item and item.get("State", {}).get("Running"):
                            result = await first.engine.execute(row["container"], "read_file", {"path": "/workspace/waiting"})
                            started = result.get("content") == "started"
                if started:
                    break
                await asyncio.sleep(.1)
            if not started:
                raise RuntimeError("The cancellation fixture did not confirm running code.")
        finally:
            pending.cancel()
            try:
                await pending
            except asyncio.CancelledError:
                pass
        if store.pending(first.scope, first.run):
            raise RuntimeError("Container cancellation was not confirmed.")
        checks.append("cancel-running-code-and-confirm-removal")
        if not all([await value.cancel() for value in computers]):
            raise RuntimeError("Fixture cleanup remains uncertain.")
        safe_to_remove = True
        print(json.dumps({"result": "pass", "checks": checks,
            "model_calls": 0, "browser_tested": False, "cloud_app_tested": False}))
    finally:
        # Never throw away pending admission identities after a daemon failure.
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
    parser.add_argument("--image", required=True, help="Already provisioned immutable image digest")
    parser.add_argument("--socket", required=True, help="Existing private rootless Docker Unix socket")
    parser.add_argument("--docker-binary", default="/usr/bin/docker")
    arguments = parser.parse_args()
    if sys.platform != "linux":
        parser.error("Live executor acceptance requires an authorized non-root Linux worker; no services were started.")
    try:
        asyncio.run(validate(arguments))
    except Exception:
        print("Executor acceptance failed; no credentials or model/tool output were logged.", file=sys.stderr)
        raise SystemExit(1)
