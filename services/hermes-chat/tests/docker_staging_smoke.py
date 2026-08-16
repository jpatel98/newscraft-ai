"""Run the two-account Hermes isolation matrix against a real Docker daemon.

This is a staging harness, not a production test. It starts one temporary
model stub and one temporary NewsCraft Hermes process, then uses the real
AG-UI endpoint and Hermes tools. The caller must provide a separate staging
directory and a pinned Hermes source checkout.

Example::

    python docker_staging_smoke.py \
      --service-python /path/to/venv/bin/python \
      --hermes-agent /path/to/hermes-agent \
      --source /path/to/hermes-chat/src \
      --root /tmp/newscraft-hermes-stage
"""

from __future__ import annotations

import argparse
import concurrent.futures
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any


TENANT_HEADER = "x-newscraft-tenant-key"
TOKEN_HEADER = "X-Hermes-Session-Token"
_SSE_DATA = re.compile(r"^data:\s*(.+)$")


class StagingFailure(RuntimeError):
    pass


def _command_output(command: list[str]) -> str:
    result = subprocess.run(command, check=True, text=True, capture_output=True)
    return result.stdout.strip()


def _stop(process: subprocess.Popen[Any] | None) -> None:
    if process is None or process.poll() is not None:
        return
    process.terminate()
    try:
        process.wait(timeout=15)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=10)


def _wait_for(url: str, token: str, port: int, timeout: float = 45.0) -> dict[str, Any]:
    deadline = time.monotonic() + timeout
    last_error: Exception | None = None
    while time.monotonic() < deadline:
        try:
            request = urllib.request.Request(
                url,
                headers={
                    TOKEN_HEADER: token,
                    "Host": f"127.0.0.1:{port}",
                },
            )
            with urllib.request.urlopen(request, timeout=3) as response:
                return json.loads(response.read().decode("utf-8"))
        except (OSError, ValueError, urllib.error.URLError) as exc:
            last_error = exc
            time.sleep(0.25)
    raise StagingFailure(f"Hermes did not become ready: {last_error}")


def _event_text(event: dict[str, Any]) -> str:
    for key in ("delta", "content", "message"):
        value = event.get(key)
        if isinstance(value, str):
            return value
    return ""


def _run_agent(
    *,
    url: str,
    port: int,
    token: str,
    tenant: str,
    prompt: str,
    label: str,
) -> str:
    if label == "process-start":
        prompt = "STAGING_TOOL terminal " + json.dumps(
            {
                "command": "sh -c 'echo ACCOUNT_A_PROCESS_51d2; sleep 120'",
                "background": True,
            }
        )
    body = {
        "threadId": f"staging-{tenant}-{label}",
        "runId": f"run-{tenant}-{label}-{time.time_ns()}",
        "state": {},
        "messages": [{"id": f"message-{time.time_ns()}", "role": "user", "content": prompt}],
        "tools": [],
        "context": [],
        "forwardedProps": {},
    }
    request = urllib.request.Request(
        url,
        data=json.dumps(body).encode("utf-8"),
        headers={
            "content-type": "application/json",
            "accept": "text/event-stream",
            TOKEN_HEADER: token,
            TENANT_HEADER: tenant,
            "Host": f"127.0.0.1:{port}",
        },
        method="POST",
    )
    try:
        response = urllib.request.urlopen(request, timeout=180)
    except urllib.error.HTTPError as exc:
        raise StagingFailure(f"AG-UI request failed for {tenant}/{label}: HTTP {exc.code}") from exc

    events: list[dict[str, Any]] = []
    text_parts: list[str] = []
    with response:
        for raw_line in response:
            line = raw_line.decode("utf-8", errors="replace").strip()
            match = _SSE_DATA.match(line)
            if not match:
                continue
            if match.group(1) == "[DONE]":
                continue
            try:
                event = json.loads(match.group(1))
            except json.JSONDecodeError:
                continue
            if not isinstance(event, dict):
                continue
            events.append(event)
            text_parts.append(_event_text(event))

    event_types = {str(event.get("type") or "") for event in events}
    if "RUN_ERROR" in event_types:
        raise StagingFailure(f"AG-UI run errored for {tenant}/{label}: {events[-1:]}")
    if "RUN_FINISHED" not in event_types:
        raise StagingFailure(f"AG-UI run did not finish for {tenant}/{label}: {event_types}")
    return "".join(text_parts)


def _json_from_tool_text(text: str) -> Any:
    prefix = "STAGING_TOOL_RESULT "
    value = text.split(prefix, 1)[1].strip() if prefix in text else text
    wrapped = re.search(
        r"<untrusted_tool_result[^>]*>\s*(.*?)\s*</untrusted_tool_result>",
        value,
        flags=re.DOTALL,
    )
    if wrapped:
        value = wrapped.group(1).strip()
    try:
        return json.loads(value)
    except json.JSONDecodeError:
        decoder = json.JSONDecoder()
        for index, character in enumerate(value):
            if character != "{":
                continue
            try:
                candidate, _end = decoder.raw_decode(value[index:])
            except json.JSONDecodeError:
                continue
            if isinstance(candidate, dict) and "success" in candidate:
                return candidate
        return value


def _assert_contains(text: str, marker: str, description: str) -> None:
    if marker not in text:
        raise StagingFailure(f"{description}: missing {marker!r}; response={text[:2000]!r}")


def _assert_not_contains(text: str, marker: str, description: str) -> None:
    if marker in text:
        raise StagingFailure(f"{description}: found {marker!r}; response={text[:2000]!r}")


def _assert_result_contains(text: str, marker: str, description: str) -> None:
    rendered = json.dumps(_json_from_tool_text(text), ensure_ascii=False)
    if marker not in rendered:
        raise StagingFailure(f"{description}: result missing {marker!r}; response={rendered[:2000]!r}")


def _assert_result_not_contains(text: str, marker: str, description: str) -> None:
    rendered = json.dumps(_json_from_tool_text(text), ensure_ascii=False)
    if marker in rendered:
        raise StagingFailure(f"{description}: result found {marker!r}; response={rendered[:2000]!r}")


def _assert_tool_success(text: str, description: str) -> None:
    value = _json_from_tool_text(text)
    if not isinstance(value, dict) or value.get("success") is not True:
        raise StagingFailure(f"{description}: tool did not succeed; response={text[:2000]!r}")


def _search_results(text: str) -> str:
    value = _json_from_tool_text(text)
    if isinstance(value, dict):
        value = value.get("results", [])
    return json.dumps(value, ensure_ascii=False)


def _assert_search_contains(text: str, marker: str, description: str) -> None:
    rendered = _search_results(text)
    if marker not in rendered:
        raise StagingFailure(f"{description}: search results missing {marker!r}; response={rendered[:2000]!r}")


def _assert_search_not_contains(text: str, marker: str, description: str) -> None:
    rendered = _search_results(text)
    if marker in rendered:
        raise StagingFailure(f"{description}: search results found {marker!r}; response={rendered[:2000]!r}")


def _seed_session_db(source: Path, hermes_agent: Path, root: Path, tenants: dict[str, str]) -> None:
    sys.path.insert(0, str(source))
    sys.path.insert(0, str(hermes_agent))
    from hermes_chat.isolation import TenantIsolation, tenant_run_scope
    from hermes_state import SessionDB

    isolation = TenantIsolation(root / "home", root / "workspace")
    for tenant, marker in tenants.items():
        runtime = isolation.resolve(tenant)
        isolation.ensure(runtime)
        with tenant_run_scope(runtime, thread_id=f"seed-{tenant}", run_id=f"seed-{tenant}"):
            database = SessionDB()
            try:
                session_id = f"history-{tenant}"
                database.create_session(session_id, "newscraft")
                database.append_message(session_id, "user", marker)
            finally:
                database.close()


def _docker_containers(task_key: str) -> list[str]:
    output = _command_output(
        [
            "docker",
            "ps",
            "-aq",
            "--filter",
            "label=hermes-agent=1",
            "--filter",
            f"label=hermes-task-id={task_key}",
        ]
    )
    return [line for line in output.splitlines() if line]


def _assert_mounts_are_tenant_local(container_ids: dict[str, list[str]], root: Path) -> None:
    for tenant, ids in container_ids.items():
        tenant_home = (root / "home" / "tenants" / tenant).resolve()
        tenant_workspace = (root / "workspace" / "tenants" / tenant).resolve()
        allowed = (tenant_home, tenant_workspace)
        for container_id in ids:
            raw = _command_output(["docker", "inspect", container_id])
            details = json.loads(raw)[0]
            for mount in details.get("Mounts") or []:
                source = mount.get("Source")
                if not source:
                    continue
                resolved = Path(source).resolve()
                if not any(resolved == path or path in resolved.parents for path in allowed):
                    raise StagingFailure(
                        f"Docker container {container_id[:12]} for {tenant} mounts outside its tenant roots: {resolved}"
                    )


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--service-python", required=True, type=Path)
    parser.add_argument("--hermes-agent", required=True, type=Path)
    parser.add_argument("--source", required=True, type=Path)
    parser.add_argument("--root", required=True, type=Path)
    parser.add_argument("--port", type=int, default=18980)
    parser.add_argument("--model-port", type=int, default=18981)
    parser.add_argument("--agent-browser", type=Path)
    parser.add_argument("--browser-executable", type=Path)
    parser.add_argument("--docker-image", default="honcho-api:latest")
    return parser.parse_args()


def main() -> int:
    args = _parse_args()
    root = args.root.resolve()
    if root.exists() and any(root.iterdir()):
        raise StagingFailure(f"Staging root must be new or empty: {root}")
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    (root / "logs").mkdir(mode=0o700)

    tenants = {
        "stageTenantA123": "ACCOUNT_A_MEMORY_71c9",
        "stageTenantB456": "ACCOUNT_B_MEMORY_2a4f",
    }
    history_markers = {
        "stageTenantA123": "ACCOUNT_A_CHAT_9f3a",
        "stageTenantB456": "ACCOUNT_B_CHAT_6c2d",
    }
    service_token = "staging-hermes-token-8b7d2f4a9c1e6d3b"
    model_token = "staging-model-token"
    base_url = f"http://127.0.0.1:{args.port}"
    endpoint = f"{base_url}/"
    model_endpoint = f"http://127.0.0.1:{args.model_port}/v1"

    _seed_session_db(args.source, args.hermes_agent, root, history_markers)
    isolation_home = root / "home" / "tenants"
    for tenant, marker in tenants.items():
        tenant_home = isolation_home / tenant
        (tenant_home / "memories").mkdir(mode=0o700, parents=True, exist_ok=True)
        (tenant_home / "memories" / "MEMORY.md").write_text(marker, encoding="utf-8")
        (tenant_home / "memories" / "USER.md").write_text(f"NAME_{tenant}", encoding="utf-8")

    environment = {
        "PATH": os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin"),
        "PYTHONPATH": os.pathsep.join([str(args.source), str(args.hermes_agent)]),
        "NEWSCRAFT_ISOLATION_MODEL_PORT": str(args.model_port),
    }
    model_log = (root / "logs" / "model.log").open("w", encoding="utf-8")
    model_process = subprocess.Popen(
        [str(args.service_python), str(args.source.parent / "tests" / "fixtures" / "isolation_tool_model.py")],
        env=environment,
        stdout=model_log,
        stderr=subprocess.STDOUT,
        start_new_session=True,
    )

    def start_service() -> subprocess.Popen[Any]:
        service_env = environment.copy()
        service_env.update(
            {
                "HERMES_AGUI_HOST": "127.0.0.1",
                "HERMES_AGUI_PORT": str(args.port),
                "HERMES_AGUI_SESSION_TOKEN": service_token,
                "NEWSCRAFT_HERMES_HOME": str(root / "home"),
                "NEWSCRAFT_HERMES_WORKSPACE": str(root / "workspace"),
                "NEWSCRAFT_HERMES_MODEL_PROVIDER": "staging-local",
                "NEWSCRAFT_HERMES_MODEL": "newscraft-hermes-isolation-test",
                "NEWSCRAFT_HERMES_MODEL_BASE_URL": model_endpoint,
                "NEWSCRAFT_HERMES_MODEL_API_KEY": model_token,
                "TERMINAL_DOCKER_IMAGE": args.docker_image,
                "AGENT_BROWSER_HEADED": "false",
            }
        )
        if args.agent_browser is not None:
            browser_path = [str(args.agent_browser.parent)]
            # The managed install keeps the agent-browser shim under
            # node/<version>/node_modules/.bin and Node under node/bin. A
            # staging service home is intentionally separate, so add both
            # paths explicitly instead of relying on the operator shell.
            for parent in args.agent_browser.parents:
                node = parent / "bin" / "node"
                if node.is_file():
                    browser_path.insert(0, str(node.parent))
                    break
            service_env["PATH"] = os.pathsep.join(browser_path + [service_env["PATH"]])
        if args.browser_executable is not None:
            service_env["AGENT_BROWSER_EXECUTABLE_PATH"] = str(args.browser_executable)
        log = (root / "logs" / f"service-{time.time_ns()}.log").open("w", encoding="utf-8")
        return subprocess.Popen(
            [str(args.service_python.parent / "newscraft-hermes-chat")],
            env=service_env,
            cwd=str(root / "workspace"),
            stdout=log,
            stderr=subprocess.STDOUT,
            start_new_session=True,
        )

    service_process: subprocess.Popen[Any] | None = None
    try:
        service_process = start_service()
        ready = _wait_for(f"{base_url}/ready", service_token, args.port)
        isolation_capability = ready.get("capabilities", {}).get("accountIsolation")
        if not isinstance(isolation_capability, dict) or not all(isolation_capability.values()):
            raise StagingFailure(f"account isolation readiness failed: {isolation_capability}")
        browser_ready = ready.get("capabilities", {}).get("browser") is True
        if args.agent_browser is not None or args.browser_executable is not None:
            if not browser_ready:
                raise StagingFailure(
                    f"browser staging was requested but /ready reported browser={browser_ready}"
                )

        # Create one Docker task per account and write distinct workspace data
        # concurrently. This is the live AG-UI race check.
        def write_workspace(item: tuple[str, str]) -> str:
            tenant, marker = item
            return _run_agent(
                url=endpoint,
                port=args.port,
                token=service_token,
                tenant=tenant,
                prompt=f'STAGING_TOOL write_file {json.dumps({"path": "/workspace/account-marker.txt", "content": marker})}',
                label="write-workspace",
            )

        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            list(pool.map(write_workspace, tenants.items()))

        # Add valid skills after the tenant directories exist, then inspect
        # memory, skills, history, cron state, and the workspace through the
        # real service.
        for tenant, marker in tenants.items():
            skill_name = f"{tenant.lower()}-skill"
            skill_dir = isolation_home / tenant / "skills" / skill_name
            skill_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
            (skill_dir / "SKILL.md").write_text(
                f"---\nname: {skill_name}\ndescription: {marker}\n---\n{marker}\n",
                encoding="utf-8",
            )

        responses: dict[tuple[str, str], str] = {}
        for tenant, marker in tenants.items():
            own = _run_agent(
                url=endpoint,
                port=args.port,
                token=service_token,
                tenant=tenant,
                prompt="STAGING_MEMORY_PROBE",
                label="memory",
            )
            responses[(tenant, "memory")] = own
            _assert_contains(own, marker, f"{tenant} memory")
            _assert_contains(own, f"NAME_{tenant}", f"{tenant} name")

            own_read = _run_agent(
                url=endpoint,
                port=args.port,
                token=service_token,
                tenant=tenant,
                prompt='STAGING_TOOL read_file {"path":"/workspace/account-marker.txt"}',
                label="workspace-own",
            )
            _assert_result_contains(own_read, marker, f"{tenant} workspace")

            own_history = _run_agent(
                url=endpoint,
                port=args.port,
                token=service_token,
                tenant=tenant,
                prompt=f'STAGING_TOOL session_search {json.dumps({"query": history_markers[tenant]})}',
                label="history-own",
            )
            _assert_search_contains(own_history, history_markers[tenant], f"{tenant} history")

            own_skills = _run_agent(
                url=endpoint,
                port=args.port,
                token=service_token,
                tenant=tenant,
                prompt="STAGING_TOOL skills_list {}",
                label="skills-list",
            )
            _assert_result_contains(own_skills, f"{tenant.lower()}-skill", f"{tenant} skill list")

            own_skill = _run_agent(
                url=endpoint,
                port=args.port,
                token=service_token,
                tenant=tenant,
                prompt=f'STAGING_TOOL skill_view {json.dumps({"name": f"{tenant.lower()}-skill"})}',
                label="skill-view",
            )
            _assert_result_contains(own_skill, marker, f"{tenant} skill content")

            cron_create = _run_agent(
                url=endpoint,
                port=args.port,
                token=service_token,
                tenant=tenant,
                prompt=f'STAGING_TOOL cronjob {json.dumps({"action": "create", "prompt": marker, "schedule": "every 1h", "name": f"{tenant}-job", "deliver": "local"})}',
                label="cron-create",
            )
            if "success" not in cron_create.lower():
                raise StagingFailure(f"{tenant} cron create failed: {cron_create[:2000]}")

            cron_list = _run_agent(
                url=endpoint,
                port=args.port,
                token=service_token,
                tenant=tenant,
                prompt='STAGING_TOOL cronjob {"action":"list"}',
                label="cron-list",
            )
            _assert_result_contains(cron_list, marker, f"{tenant} cron list")

        # Account B must not see any A state, including the real Docker task
        # process registry. The response contains the JSON tool result.
        account_a = "stageTenantA123"
        account_b = "stageTenantB456"
        foreign_checks = [
            ("workspace", 'STAGING_TOOL read_file {"path":"/workspace/account-marker.txt"}', tenants[account_a]),
            ("history", f'STAGING_TOOL session_search {json.dumps({"query": history_markers[account_a]})}', history_markers[account_a]),
            ("skills", "STAGING_TOOL skills_list {}", f"{account_a.lower()}-skill"),
            ("skill", f'STAGING_TOOL skill_view {json.dumps({"name": f"{account_a.lower()}-skill"})}', tenants[account_a]),
            ("cron", 'STAGING_TOOL cronjob {"action":"list"}', tenants[account_a]),
        ]
        for name, prompt, marker in foreign_checks:
            response = _run_agent(
                url=endpoint,
                port=args.port,
                token=service_token,
                tenant=account_b,
                prompt=prompt,
                label=f"foreign-{name}",
            )
            if name == "history":
                _assert_search_not_contains(response, marker, f"account B foreign {name}")
            else:
                _assert_result_not_contains(response, marker, f"account B foreign {name}")

        account_a_process = _run_agent(
            url=endpoint,
            port=args.port,
            token=service_token,
            tenant=account_a,
            prompt='STAGING_TOOL terminal {"command":"python -u -c \\\"import time; print(\\\'ACCOUNT_A_PROCESS_51d2\\\', flush=True); time.sleep(120)\\\"","background":true}',
            label="process-start",
        )
        _assert_contains(account_a_process, "session_id", "account A background process")
        account_a_process_list = _run_agent(
            url=endpoint,
            port=args.port,
            token=service_token,
            tenant=account_a,
            prompt='STAGING_TOOL process {"action":"list"}',
            label="process-own",
        )
        _assert_result_contains(account_a_process_list, "ACCOUNT_A_PROCESS_51d2", "account A process list")
        account_b_process_list = _run_agent(
            url=endpoint,
            port=args.port,
            token=service_token,
            tenant=account_b,
            prompt='STAGING_TOOL process {"action":"list"}',
            label="process-foreign",
        )
        _assert_result_not_contains(account_b_process_list, "ACCOUNT_A_PROCESS_51d2", "account B foreign process")

        task_containers = {
            tenant: _docker_containers(f"newscraft-{tenant}")
            for tenant in tenants
        }
        if not all(task_containers.values()):
            raise StagingFailure(f"Docker task containers were not created: {task_containers}")
        _assert_mounts_are_tenant_local(task_containers, root)
        if set(task_containers[account_a]) & set(task_containers[account_b]):
            raise StagingFailure(f"Accounts reused one Docker container: {task_containers}")

        browser_results: dict[str, str] = {}
        if args.agent_browser is not None and args.browser_executable is not None:
            def probe_browser_cookie(item: tuple[str, str]) -> tuple[str, str]:
                tenant, marker = item
                navigated = _run_agent(
                    url=endpoint,
                    port=args.port,
                    token=service_token,
                    tenant=tenant,
                    prompt='STAGING_TOOL browser_navigate {"url":"https://example.com/"}',
                    label="browser-set-cookie",
                )
                _assert_tool_success(navigated, f"{tenant} browser navigation")
                set_expression = (
                    f"document.cookie = {json.dumps(f'account_marker={marker}; Max-Age=86400; Path=/')}; "
                    "document.cookie"
                )
                set_cookie = _run_agent(
                    url=endpoint,
                    port=args.port,
                    token=service_token,
                    tenant=tenant,
                    prompt=f'STAGING_TOOL browser_console {json.dumps({"expression": set_expression})}',
                    label="browser-set-cookie-value",
                )
                _assert_tool_success(set_cookie, f"{tenant} browser cookie set")
                _assert_contains(set_cookie, marker, f"{tenant} browser cookie set")
                observed = _run_agent(
                    url=endpoint,
                    port=args.port,
                    token=service_token,
                    tenant=tenant,
                    prompt='STAGING_TOOL browser_console {"expression":"document.cookie"}',
                    label="browser-read-cookie",
                )
                _assert_tool_success(observed, f"{tenant} browser cookie read")
                _assert_contains(observed, marker, f"{tenant} browser cookie")
                return tenant, observed

            with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
                for tenant, observed in pool.map(probe_browser_cookie, tenants.items()):
                    browser_results[tenant] = observed
            _assert_not_contains(
                browser_results[account_b],
                tenants[account_a],
                "account B browser cookie",
            )

        # Restart the isolated service and repeat persistence/isolation checks.
        _stop(service_process)
        service_process = start_service()
        _wait_for(f"{base_url}/ready", service_token, args.port)
        for tenant, marker in tenants.items():
            restarted = _run_agent(
                url=endpoint,
                port=args.port,
                token=service_token,
                tenant=tenant,
                prompt='STAGING_TOOL read_file {"path":"/workspace/account-marker.txt"}',
                label="restart-workspace",
            )
            _assert_result_contains(restarted, marker, f"{tenant} workspace after restart")
            restarted_cron = _run_agent(
                url=endpoint,
                port=args.port,
                token=service_token,
                tenant=tenant,
                prompt='STAGING_TOOL cronjob {"action":"list"}',
                label="restart-cron",
            )
            _assert_result_contains(restarted_cron, marker, f"{tenant} cron after restart")

        if args.agent_browser is not None and args.browser_executable is not None:
            for tenant, marker in tenants.items():
                observed = _run_agent(
                    url=endpoint,
                    port=args.port,
                    token=service_token,
                    tenant=tenant,
                    prompt='STAGING_TOOL browser_navigate {"url":"https://example.com/"}',
                    label="restart-browser-read",
                )
                _assert_tool_success(observed, f"{tenant} browser navigation after restart")
                observed = _run_agent(
                    url=endpoint,
                    port=args.port,
                    token=service_token,
                    tenant=tenant,
                    prompt='STAGING_TOOL browser_console {"expression":"document.cookie"}',
                    label="restart-browser-cookie",
                )
                _assert_tool_success(observed, f"{tenant} browser cookie after restart")
                _assert_contains(observed, marker, f"{tenant} browser cookie after restart")
                if tenant == account_b:
                    _assert_not_contains(
                        observed,
                        tenants[account_a],
                        "account B browser cookie after restart",
                    )

        after_restart = _run_agent(
            url=endpoint,
            port=args.port,
            token=service_token,
            tenant=account_b,
            prompt='STAGING_TOOL process {"action":"list"}',
            label="restart-process-foreign",
        )
        _assert_result_not_contains(after_restart, "ACCOUNT_A_PROCESS_51d2", "account B process after restart")

        print("DOCKER_STAGING_PASS")
        print(json.dumps({"ready": ready, "containers": task_containers}, sort_keys=True))
        if args.agent_browser is not None and args.browser_executable is not None:
            print("BROWSER_STAGING_PASS")
        else:
            print("BROWSER_LIVE_UNRUN browser executable was not supplied")
        return 0
    finally:
        _stop(service_process)
        _stop(model_process)
        model_log.close()
        # Remove only containers bearing the two unique staging task labels.
        for tenant in tenants:
            for container_id in _docker_containers(f"newscraft-{tenant}"):
                subprocess.run(["docker", "rm", "-f", container_id], check=False, capture_output=True)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except StagingFailure as exc:
        print(f"DOCKER_STAGING_FAIL {exc}", file=sys.stderr)
        raise SystemExit(1) from exc
