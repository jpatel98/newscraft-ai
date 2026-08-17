"""Run a bounded two-account matrix against the live NewsCraft Hermes service.

This script uses synthetic account ids. It derives the same opaque tenant key
as the NewsCraft server, then calls only the loopback Hermes endpoint. It
removes only the synthetic tenant roots and Docker tasks that it creates.
"""

from __future__ import annotations

import base64
import concurrent.futures
import hashlib
import hmac
import json
import os
import shutil
import subprocess
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path
from typing import Any, Callable

from docker_staging_smoke import _json_from_tool_text, _run_agent
from hermes_chat.isolation import TenantIsolation, TenantRuntime, tenant_run_scope


PORT = 8100
URL = f"http://127.0.0.1:{PORT}/"
READY_URL = f"http://127.0.0.1:{PORT}/ready"
TOKEN_HEADER = "X-Hermes-Session-Token"
TENANT_HEADER = "x-newscraft-tenant-key"
HYDRA_PIDS = {
    "hermes-gateway.service": "1178145",
    "hermes-serve.service": "1178222",
    "hermes-browser-cdp.service": "1779140",
}


class LiveFailure(RuntimeError):
    """A required live matrix gate failed."""


def _tenant_key(secret: str, account_id: str) -> str:
    digest = hmac.new(
        secret.encode("utf-8"),
        b"newscraft-hermes-tenant:v1\0" + account_id.encode("utf-8"),
        hashlib.sha256,
    ).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")


def _required_ready(data: dict[str, Any]) -> bool:
    capabilities = data.get("capabilities")
    if not isinstance(capabilities, dict) or data.get("ok") is not True:
        return False
    required = (
        "browser",
        "codeExecution",
        "delegation",
        "files",
        "memory",
        "scheduledJobs",
        "skills",
        "terminal",
        "webResearch",
    )
    return all(capabilities.get(name) is True for name in required) and all(
        capabilities.get(group, {}).get(field) is True
        for group, field in (
            ("webExtraction", "configured"),
            ("webExtraction", "tool"),
            ("webLeadVerification", "tool"),
        )
    )


def _ready(token: str) -> dict[str, Any]:
    request = urllib.request.Request(
        READY_URL,
        headers={TOKEN_HEADER: token, "Host": f"127.0.0.1:{PORT}"},
    )
    with urllib.request.urlopen(request, timeout=10) as response:
        return json.loads(response.read().decode("utf-8"))


def _wait_ready(token: str, timeout: float = 60.0) -> dict[str, Any]:
    deadline = time.monotonic() + timeout
    last_error: Exception | None = None
    while time.monotonic() < deadline:
        try:
            data = _ready(token)
            if _required_ready(data):
                return data
        except (OSError, ValueError, urllib.error.URLError) as exc:
            last_error = exc
        time.sleep(1)
    raise LiveFailure("readiness did not become fully green") from last_error


def _pid(unit: str) -> str:
    return subprocess.check_output(
        ["systemctl", "--user", "show", unit, "-p", "MainPID", "--value"],
        text=True,
    ).strip()


def _hydra_pids() -> dict[str, str]:
    return {unit: _pid(unit) for unit in HYDRA_PIDS}


def _assert_contains(text: str, marker: str, gate: str) -> None:
    if marker not in text:
        raise LiveFailure(f"{gate}: expected marker was absent")


def _assert_absent(text: str, marker: str, gate: str) -> None:
    if marker in text:
        raise LiveFailure(f"{gate}: foreign marker was present")


def _tool_result(text: str, gate: str) -> Any:
    value = _json_from_tool_text(text)
    if isinstance(value, dict) and value.get("success") is False:
        raise LiveFailure(f"{gate}: Hermes tool returned failure")
    return value


def _run(
    token: str,
    tenant: str,
    prompt: str,
    gate: str,
) -> str:
    try:
        return _run_agent(
            url=URL,
            port=PORT,
            token=token,
            tenant=tenant,
            prompt=prompt,
            label=gate,
        )
    except Exception as exc:
        raise LiveFailure(f"{gate}: AG-UI request failed") from exc


def _run_after_restart(token: str, tenant: str, prompt: str, gate: str) -> str:
    """Allow the freshly started process a short, bounded warm-up window."""
    last_error: LiveFailure | None = None
    for attempt in range(2):
        try:
            return _run(token, tenant, prompt, gate)
        except LiveFailure as exc:
            last_error = exc
            if attempt == 0:
                time.sleep(5)
    raise LiveFailure(f"{gate}: AG-UI request failed after restart warm-up") from last_error


def _seed_history(source: Path, hermes_agent: Path, runtime: TenantRuntime, marker: str) -> None:
    import sys

    sys.path.insert(0, str(source))
    sys.path.insert(0, str(hermes_agent))
    from hermes_state import SessionDB

    with tenant_run_scope(runtime, thread_id=f"seed-{runtime.key}", run_id=f"seed-{runtime.key}"):
        database = SessionDB()
        try:
            session_id = f"live-history-{runtime.key}"
            database.create_session(session_id, "newscraft")
            database.append_message(session_id, "user", marker)
        finally:
            database.close()


def _container_ids(task_key: str) -> list[str]:
    result = subprocess.run(
        [
            "docker",
            "ps",
            "-aq",
            "--filter",
            "label=hermes-agent=1",
            "--filter",
            f"label=hermes-task-id={task_key}",
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    return [line for line in result.stdout.splitlines() if line]


def _assert_container_mounts(runtime: TenantRuntime) -> None:
    ids = _container_ids(runtime.task_key)
    if not ids:
        raise LiveFailure("docker task container was not created")
    allowed = (runtime.hermes_home.resolve(), runtime.workspace.resolve())
    for container_id in ids:
        raw = subprocess.check_output(["docker", "inspect", container_id], text=True)
        details = json.loads(raw)[0]
        for mount in details.get("Mounts") or []:
            source = mount.get("Source")
            if not source:
                continue
            resolved = Path(source).resolve()
            if not any(resolved == root or root in resolved.parents for root in allowed):
                raise LiveFailure("docker task mounted a path outside its tenant roots")


def _cleanup(runtime: TenantRuntime) -> None:
    for container_id in _container_ids(runtime.task_key):
        subprocess.run(["docker", "rm", "-f", container_id], check=False, capture_output=True)

    def remove_tree(path: Path) -> None:
        if not path.exists():
            return
        try:
            shutil.rmtree(path)
        except PermissionError:
            # Browser sandboxes can create root-owned files inside this
            # synthetic test root. Use a disposable root container only for
            # that exact validated test path, then verify it is gone.
            subprocess.run(
                [
                    "docker",
                    "run",
                    "--rm",
                    "--user",
                    "0",
                    "--mount",
                    f"type=bind,src={path},dst=/target",
                    "--entrypoint",
                    "/bin/sh",
                    "honcho-api:latest",
                    "-c",
                    "rm -rf /target",
                ],
                check=False,
                capture_output=True,
            )
            if path.exists():
                try:
                    path.rmdir()
                except OSError:
                    pass
        if path.exists():
            raise LiveFailure("synthetic cleanup path could not be removed")

    for path, root in (
        (runtime.hermes_home, runtime.hermes_home.parent),
        (runtime.workspace, runtime.workspace.parent),
    ):
        resolved = path.resolve(strict=False)
        if path.is_symlink() or not resolved.is_relative_to(root.resolve()):
            raise LiveFailure("synthetic cleanup path failed its root guard")
        remove_tree(path)


def main() -> int:
    token = os.environ["HERMES_AGUI_SESSION_TOKEN"]
    secret = os.environ["NEWSCRAFT_HERMES_TENANT_SECRET"]
    source = Path(os.environ["NEWSCRAFT_LIVE_HERMES_SOURCE"])
    hermes_agent = Path(os.environ["NEWSCRAFT_LIVE_HERMES_AGENT"])
    isolation = TenantIsolation(
        Path(os.environ["NEWSCRAFT_HERMES_HOME"]),
        Path(os.environ["NEWSCRAFT_HERMES_WORKSPACE"]),
    )
    suffix = uuid.uuid4().hex[:8].upper()
    account_ids = {
        "a": f"newscraft-live-a-{suffix}",
        "b": f"newscraft-live-b-{suffix}",
    }
    tenants = {label: _tenant_key(secret, account_id) for label, account_id in account_ids.items()}
    runtimes = {label: isolation.resolve(tenant) for label, tenant in tenants.items()}
    markers = {
        "a": {
            "memory": f"NC_LIVE_A_MEMORY_{suffix}",
            "name": f"NC_LIVE_A_NAME_{suffix}",
            "chat": f"NC_LIVE_CHAT_A_{suffix}",
            "workspace": f"NC_LIVE_A_WORKSPACE_{suffix}",
            "cookie": f"NC_LIVE_A_COOKIE_{suffix}",
            "skill": f"NC_LIVE_A_SKILL_{suffix}",
            "cron": f"NC_LIVE_A_CRON_{suffix}",
            "process": f"NC_LIVE_A_PROCESS_{suffix}",
        },
        "b": {
            "memory": f"NC_LIVE_B_MEMORY_{suffix}",
            "name": f"NC_LIVE_B_NAME_{suffix}",
            "chat": f"NC_LIVE_CHAT_B_{suffix}",
            "workspace": f"NC_LIVE_B_WORKSPACE_{suffix}",
            "cookie": f"NC_LIVE_B_COOKIE_{suffix}",
            "skill": f"NC_LIVE_B_SKILL_{suffix}",
            "cron": f"NC_LIVE_B_CRON_{suffix}",
            "process": f"NC_LIVE_B_PROCESS_{suffix}",
        },
    }
    old_pid = _pid("newscraft-hermes-chat.service")
    hydra_before = _hydra_pids()
    cleanup_failures: list[Exception] = []
    try:
        ready = _wait_ready(token)
        if not isinstance(ready.get("capabilities", {}).get("accountIsolation"), dict):
            raise LiveFailure("readiness omitted account isolation capability")
        print("readiness=PASS")

        for label, runtime in runtimes.items():
            isolation.ensure(runtime)
            _seed_history(source, hermes_agent, runtime, markers[label]["chat"])
            memory_dir = runtime.hermes_home / "memories"
            (memory_dir / "MEMORY.md").write_text(markers[label]["memory"], encoding="utf-8")
            (memory_dir / "USER.md").write_text(markers[label]["name"], encoding="utf-8")
            skill_dir = runtime.hermes_home / "skills" / f"live-{label}-skill-{suffix.lower()}"
            skill_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
            (skill_dir / "SKILL.md").write_text(
                f"---\nname: live-{label}-skill-{suffix.lower()}\ndescription: {markers[label]['skill']}\n---\n{markers[label]['skill']}\n",
                encoding="utf-8",
            )

        for label in ("a", "b"):
            _assert_contains(
                _run(
                    token,
                    tenants[label],
                    f"Use the memory tool to add this exact private note: {markers[label]['memory']} with target memory. Then confirm it was stored.",
                    f"memory-seed-{label}",
                ),
                markers[label]["memory"],
                f"memory seed {label}",
            )
            _assert_contains(
                _run(
                    token,
                    tenants[label],
                    f"Use the memory tool to store this exact user profile name: {markers[label]['name']}. Then confirm it was stored.",
                    f"name-seed-{label}",
                ),
                markers[label]["name"],
                f"name seed {label}",
            )

        own_memory = {
            label: _run(
                token,
                tenants[label],
                "Use the memory tool to read the current memory and user profile. Report the exact stored name and private note.",
                f"memory-read-{label}",
            )
            for label in ("a", "b")
        }
        for label in ("a", "b"):
            _assert_contains(own_memory[label], markers[label]["memory"], f"memory own {label}")
            _assert_contains(own_memory[label], markers[label]["name"], f"name own {label}")
        _assert_absent(own_memory["b"], markers["a"]["memory"], "account B foreign memory")
        _assert_absent(own_memory["b"], markers["a"]["name"], "account B foreign name")
        print("memory_and_name=PASS")

        own_history = {
            label: _run(
                token,
                tenants[label],
                'Use session_search with query "NC_LIVE_CHAT" and report all matching history results exactly.',
                f"history-{label}",
            )
            for label in ("a", "b")
        }
        _assert_contains(own_history["a"], markers["a"]["chat"], "account A chat history")
        _assert_contains(own_history["b"], markers["b"]["chat"], "account B chat history")
        _assert_absent(own_history["b"], markers["a"]["chat"], "account B foreign chat history")
        print("chat_history=PASS")

        _assert_contains(
            _run(
                token,
                tenants["a"],
                f"Call write_file with path /workspace/NC_LIVE_SHARED.txt and content {markers['a']['workspace']!r}. Then report the tool result.",
                "workspace-write-a",
            ),
            markers["a"]["workspace"],
            "account A workspace write",
        )
        _assert_contains(
            _run(
                token,
                tenants["b"],
                f"Call write_file with path /workspace/NC_LIVE_SHARED.txt and content {markers['b']['workspace']!r}. Then report the tool result.",
                "workspace-write-b",
            ),
            markers["b"]["workspace"],
            "account B workspace write",
        )
        workspace_b = _run(
            token,
            tenants["b"],
            "Call read_file with path /workspace/NC_LIVE_SHARED.txt. Report the exact content, or say not found.",
            "workspace-read-b",
        )
        _assert_absent(workspace_b, markers["a"]["workspace"], "account B foreign workspace")
        _assert_contains(
            _run(
                token,
                tenants["a"],
                "Call read_file with path /workspace/NC_LIVE_SHARED.txt and report the exact content.",
                "workspace-read-a",
            ),
            markers["a"]["workspace"],
            "account A workspace read",
        )
        _assert_container_mounts(runtimes["a"])
        _assert_container_mounts(runtimes["b"])
        if set(_container_ids(runtimes["a"].task_key)) & set(_container_ids(runtimes["b"].task_key)):
            raise LiveFailure("accounts reused one Docker task container")
        print("workspace_files_and_docker_tasks=PASS")

        for label in ("a", "b"):
            _tool_result(
                _run(
                    token,
                    tenants[label],
                    f"Use skills_list to list available skills, including the skill named live-{label}-skill-{suffix.lower()}.",
                    f"skills-list-{label}",
                ),
                f"skills list {label}",
            )
        foreign_skills = _run(
            token,
            tenants["b"],
            "Use skills_list to list every skill available in this account.",
            "skills-foreign-b",
        )
        _assert_absent(foreign_skills, markers["a"]["skill"], "account B foreign skill")
        _assert_absent(foreign_skills, f"live-a-skill-{suffix.lower()}", "account B foreign skill name")
        print("skills=PASS")

        _assert_contains(
            _run(
                token,
                tenants["a"],
                f"Use cronjob action create to create one local scheduled job named live-a-job-{suffix.lower()} with schedule every 1h and prompt {markers['a']['cron']!r}. Then report the tool result.",
                "cron-create-a",
            ),
            markers["a"]["cron"],
            "account A cron create",
        )
        cron_a = _run(
            token,
            tenants["a"],
            "Use cronjob action list and report all scheduled jobs.",
            "cron-list-a",
        )
        cron_b = _run(
            token,
            tenants["b"],
            "Use cronjob action list and report all scheduled jobs.",
            "cron-list-b",
        )
        _assert_contains(cron_a, markers["a"]["cron"], "account A cron list")
        _assert_absent(cron_b, markers["a"]["cron"], "account B foreign cron")
        print("scheduled_jobs=PASS")

        process_a = _run(
            token,
            tenants["a"],
            f"Use terminal with background=true to run sh -c 'printf {markers['a']['process']}\\n; sleep 180'. Report the returned session_id.",
            "process-start-a",
        )
        if "session_id" not in process_a:
            raise LiveFailure("account A background process did not return a session id")
        process_a_list = _run(
            token,
            tenants["a"],
            "Use process action list and report every process.",
            "process-list-a",
        )
        process_b_list = _run(
            token,
            tenants["b"],
            "Use process action list and report every process.",
            "process-list-b",
        )
        _assert_contains(process_a_list, markers["a"]["process"], "account A process list")
        _assert_absent(process_b_list, markers["a"]["process"], "account B foreign process")
        print("background_processes=PASS")

        def concurrent_workspace(label: str) -> str:
            return _run(
                token,
                tenants[label],
                f"Call write_file with path /workspace/NC_LIVE_CONCURRENT.txt and content {markers[label]['workspace']!r}. Then report the tool result.",
                f"concurrent-write-{label}",
            )

        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            concurrent_results = dict(zip(("a", "b"), pool.map(concurrent_workspace, ("a", "b"))))
        for label in ("a", "b"):
            _assert_contains(concurrent_results[label], markers[label]["workspace"], f"concurrent workspace {label}")
        print("simultaneous_account_requests=PASS")

        for label in ("a", "b"):
            _assert_contains(
                _run(
                    token,
                    tenants[label],
                    'Use browser_navigate to open https://example.com/ and report the tool result.',
                    f"browser-navigate-{label}",
                ),
                "success",
                f"browser navigation {label}",
            )
        cookie_expression = (
            f"document.cookie = 'nc_live_marker={markers['a']['cookie']}; "
            "Max-Age=86400; Path=/'; document.cookie"
        )
        _assert_contains(
            _run(
                token,
                tenants["a"],
                f"Use browser_console with expression {json.dumps(cookie_expression)}. Report the tool result.",
                "browser-cookie-set-a",
            ),
            markers["a"]["cookie"],
            "account A browser cookie set",
        )
        _assert_absent(
            _run(
                token,
                tenants["b"],
                'Use browser_console with expression "document.cookie" and report the tool result.',
                "browser-cookie-read-b",
            ),
            markers["a"]["cookie"],
            "account B foreign browser cookie",
        )
        _assert_contains(
            _run(
                token,
                tenants["a"],
                'Use browser_console with expression "document.cookie" and report the tool result.',
                "browser-cookie-read-a",
            ),
            markers["a"]["cookie"],
            "account A browser cookie read",
        )
        print("browser_cookies=PASS")

        restart_result = subprocess.run(
            ["systemctl", "--user", "restart", "--no-block", "newscraft-hermes-chat.service"],
            check=False,
            capture_output=True,
            text=True,
            timeout=15,
        )
        new_pid = ""
        try:
            _wait_ready(token)
            new_pid = _pid("newscraft-hermes-chat.service")
        except Exception as exc:
            raise LiveFailure("restart readiness failed") from exc
        if restart_result.returncode != 0:
            raise LiveFailure("restart command failed")
        if new_pid == old_pid:
            raise LiveFailure("restart did not change the Hermes PID")
        time.sleep(5)
        hydra_after = _hydra_pids()
        if hydra_after != hydra_before or hydra_after != HYDRA_PIDS:
            raise LiveFailure("Hydra PID set changed during NewsCraft restart")

        for label in ("a", "b"):
            restarted_workspace = _run_after_restart(
                token,
                tenants[label],
                "Call read_file with path /workspace/NC_LIVE_SHARED.txt and report the exact content.",
                f"restart-workspace-{label}",
            )
            _assert_contains(restarted_workspace, markers[label]["workspace"], f"restart workspace {label}")
        restarted_cron_a = _run_after_restart(
            token,
            tenants["a"],
            "Use cronjob action list and report all scheduled jobs.",
            "restart-cron-a",
        )
        restarted_cron_b = _run_after_restart(
            token,
            tenants["b"],
            "Use cronjob action list and report all scheduled jobs.",
            "restart-cron-b",
        )
        _assert_contains(restarted_cron_a, markers["a"]["cron"], "restart cron A")
        _assert_absent(restarted_cron_b, markers["a"]["cron"], "restart foreign cron B")
        restarted_memory_b = _run_after_restart(
            token,
            tenants["b"],
            "Use the memory tool to read the current memory and user profile. Report the exact stored name and private note.",
            "restart-memory-b",
        )
        _assert_absent(restarted_memory_b, markers["a"]["memory"], "restart foreign memory B")
        _assert_absent(restarted_memory_b, markers["a"]["name"], "restart foreign name B")
        restarted_history_b = _run_after_restart(
            token,
            tenants["b"],
            'Use session_search with query "NC_LIVE_CHAT" and report all matching history results exactly.',
            "restart-history-b",
        )
        _assert_absent(restarted_history_b, markers["a"]["chat"], "restart foreign history B")
        restarted_browser_b = _run_after_restart(
            token,
            tenants["b"],
            'Use browser_console with expression "document.cookie" and report the tool result.',
            "restart-browser-b",
        )
        _assert_absent(restarted_browser_b, markers["a"]["cookie"], "restart foreign browser B")
        restarted_process_b = _run_after_restart(
            token,
            tenants["b"],
            "Use process action list and report every process.",
            "restart-process-b",
        )
        _assert_absent(restarted_process_b, markers["a"]["process"], "restart foreign process B")
        print("restart_persistence_and_hydra=PASS")
    finally:
        for runtime in runtimes.values():
            try:
                _cleanup(runtime)
            except Exception as exc:
                cleanup_failures.append(exc)

    if cleanup_failures:
        raise LiveFailure("synthetic cleanup failed") from cleanup_failures[0]
    print("synthetic_cleanup=PASS")
    print("LIVE_PRODUCTION_MATRIX_PASS")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except LiveFailure as exc:
        print(f"LIVE_PRODUCTION_MATRIX_FAIL {exc}")
        raise SystemExit(1) from exc
