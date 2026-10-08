# Rootless OCI execution adapter

`oci_executor.py` implements the active runner's terminal, filesystem and interactive browser boundary. It uses the existing `PortableAgentRunner`, durable Postgres leases/checkpoints/events, source verification and artifact publisher. The browser controller accepts a replaceable isolated-process backend; the supplied backend is rootless OCI, independent of either model provider. There is no host-execution fallback or automatic Docker installation/start/image pull.

## What persists

The scope is a hash of the server-owned tenant key and conversation ID. A fresh container is admitted for each terminal/filesystem action. Only validated regular files/directories under `/workspace` survive a successful action. Container processes, memory, `/tmp`, sockets, devices, links and arbitrary ownership/mode metadata do not persist. A failed or cancelled action discards its workspace changes. Files survive subsequent turns and worker restarts **on the same retained executor state volume**. Host loss is not covered without an operator-managed backup/restore of that private volume.

Deploy this adapter as one worker with its retained state volume and original daemon endpoint. It is not a stateless multi-host autoscaling executor: do not move active runs to a new host with an empty SQLite store. Host replacement must first confirm the old containers are stopped and restore the private state/receipts. The independent namespace watchdog bounds orphaned process lifetime, but is not proof of completed cleanup or durable host-volume replication.

The final answer is checkpointed as `finishing` while cleanup is pending. Confirmed browser/container cleanup precedes the `finished` checkpoint and public terminal event, so recovery can finish the saved answer without another model call or repeated action. A subsequent turn can repair a legacy ownership row only on its original daemon when the container is confirmed absent after creation, or the exact saved container/labels are confirmed exited/dead. Another run's live/unknown/creating container is never taken over.

`<NEWSCRAFT_AGENT_STATE_HOME>/computer/computer.sqlite3` stores bounded workspace archives, action admission records, completed receipts and private browser state/evidence. Postgres remains the authority for conversations, runs, orchestration and artifacts. The model never sees or mounts this SQLite file. Published Markdown/CSV continue to use app-owned immutable object storage; an executor file is not a downloadable artifact until published through the existing tools.

Each operation binds its run, exact request, image, scope, daemon identity and container ID. A duplicate completed operation replays its result. A saved Postgres tool intent can reconcile a matching completed SQLite receipt without repeating the action or charging another step. Failed terminal exits/file errors preserve the previous snapshot. An uncertain operation is never rerun. Cleanup verifies identity and labels, removes only that container, and confirms absence before reporting success. A timed-out create with no observed container stays quarantined: a current absence cannot prove the daemon will not finish creating it later. Keep the original endpoint/state/image policy available until all runs have drained; changing policy cannot confirm cancellation of work on the old endpoint.

## Terminal/filesystem enforced bounds

| Resource | Bound |
| --- | --- |
| Container | Rootless daemon, private namespaces, network none, read-only root, all capabilities dropped, default seccomp, no-new-privileges, no healthcheck |
| Processes | Tool UID 1000; capability-free PID 1 watchdog UID 0; 64 PIDs |
| CPU/memory | One CPU; 256 MiB memory; no extra swap |
| Time | Tool timeout at most 60 seconds; independent 90-second namespace watchdog |
| Workspace | 8 MiB/512 inodes tmpfs, noexec/nosuid/nodev; persisted contents at most 4 MiB/256 entries/1 MiB per file |
| Temporary files | 16 MiB/1024 inodes tmpfs; 8 MiB shared memory |
| Host state | 128 workspaces, 4096 operation records, 64 MiB reserved aggregate content budget; SQLite hard cap 128 MiB plus bounded rollback journal |

Daemon/image admission validates rootless Docker, cgroup v2/systemd and reported controller support. Each in-container helper separately checks its actual UID, capabilities, seccomp, no-new-privileges, cgroup CPU/memory/swap/PID values and tmpfs size/inode/mount flags before tool code runs. Snapshot first stops all other live UID 1000 processes and then streams regular files through trusted exec. No archive is extracted on the worker. [`docker cp` does not support tmpfs](https://docs.docker.com/reference/cli/docker/container/cp/#corner-cases), so it is not used.

Retention is deliberately fail-closed at capacity. No automatic conversation deletion or operation-record pruning is implemented. Before any future retention operation, drain active runs and preserve pending cleanup identities. The adapter does not silently discard user files to admit more work.

## Existing Linux host configuration

A suitable **already authorized** non-root Linux service account needs an existing private rootless Docker Unix socket, reviewed image and cgroup v2/systemd CPU/memory/PID delegation. Socket ancestors must not be symlinks; its parent must be owned by the worker with mode 0700. The worker need not join a privileged Docker group. See [Docker's rootless resource requirements](https://docs.docker.com/engine/security/rootless/tips/#limiting-resources). No host setup, permission changes or restart was performed here.

Install the worker with **CPython 3.11** and the stdlib asyncio selector loop. `install-runtime.sh` selects an existing `cpython@3.11` and forbids interpreter downloads; the service entrypoint pins Uvicorn's `asyncio` loop. Browser readiness fails before daemon probes on unsupported interpreters/loops, and dispatch independently checks the same constraint. The HTTPS gateway additionally checks the actual private stdlib TLS transport fields. These worker requirements differ from the Python 3.12 container guest base below.

`executor.Dockerfile` is the minimal image recipe. Supply a reviewed immutable Python 3.12+ base via `BASE_IMAGE`, build it on the authorized host, and configure the resulting immutable digest. Neither building nor installing the image is automatic. The image must contain no baked-in secrets. The existing `sandbox.Dockerfile` belongs to the unselected historical browser implementation and does not meet this adapter's image contract.

Set these server-only values alongside the existing worker environment:

```dotenv
NEWSCRAFT_EXECUTOR_IMAGE=sha256:<reviewed-64-hex-image-id>
NEWSCRAFT_EXECUTOR_SOCKET=/run/user/<worker-uid>/docker.sock
NEWSCRAFT_EXECUTOR_DOCKER_BIN=/usr/bin/docker
```

Use the user service template on that account. The endpoint is a private Unix socket, never a public Docker port. Authenticated readiness reports configuration and available tools, with `accessVerified: false`. A failed configured backend fails readiness. Without executor configuration, cited research and artifact rendering remain available and no terminal/filesystem tools are advertised.

Before accepting the executor, run the supplied synthetic command on the authorized Linux worker:

```sh
PYTHONPATH=services/hermes-chat/src services/hermes-chat/.venv-owned/bin/python \
  services/hermes-chat/scripts/validate-oci-executor.py \
  --image 'sha256:<reviewed-64-hex-image-id>' \
  --socket '/run/user/<worker-uid>/docker.sock'
```

It verifies actual guarded execution, persistent files, separate tenants/conversations, duplicate receipts and confirmed cancellation of running code. It creates only its own disposable containers/private fixture state, makes no model calls and retains state if cleanup is uncertain. It has **not been run here**: this Mac is not the required Linux executor, and the user deleted its Colima VM and removed Docker/Colima/Lima. Reinstallation is not authorized. Fault injection for daemon outage, worker crash, disk exhaustion and production-volume backup/restore still needs an approved host.

## Interactive browser

`OCIBrowserComputer` adds navigate, snapshot, click, fill/type, key, scroll, screenshot and reset. It keeps one interactive browser container during a run, separate from every terminal container. Both use UID 1000 in different PID/filesystem namespaces; terminal code cannot inspect the browser pipe, profile or private state database. Browser storage is scoped to tenant plus conversation and survives turns/worker restarts on the retained volume. A new turn reloads the last URL with the stored profile; arbitrary page memory, open tabs and live DOM do not survive. A recovering worker removes its exact old browser before dispatch and can replay completed receipts. Reset clears storage/input taint. Screenshots merge into the conversation archive under `/workspace/browser-screenshots/`.

The container has no network. Authenticated stdin/stdout RPC relays bounded public HTTP(S) GET/HEAD requests through the worker. The gateway checks destination/DNS on every request and redirect, strips authentication/cookies, and blocks private addresses, writes, downloads and sockets. Each action has at most 80 requests/16 MiB wire transfer; each live session has at most 400 requests, and the owned run's action/time budgets also apply. Browser results are untrusted observations. Private host-issued evidence receipts feed the existing exact-excerpt/source-quality checks. Filled/typed/key input taints citation evidence until reset, including after a partial failure or worker restart. Cookies/profile state, provider reasoning and raw private receipts never enter public replay.

The browser uses one CPU, **1 GiB RAM/no extra swap, 128 PIDs**, 128 MiB/8192 inodes temporary storage, private 8 MiB shared memory, and a 360-second independent watchdog. The in-container guard verifies the actual limits. Private profile state is at most 1 MiB and a saved evidence receipt at most 256 KiB; both share the computer store's aggregate reservations and retention cap. Four simultaneous browsers plus four terminal actions can reserve approximately 5 GiB of container memory, excluding the worker/daemon/app. Adjust existing run concurrency to the authorized host capacity.

`browser.Dockerfile` prepares Playwright 1.63.0 plus its matching Chromium from an explicitly supplied immutable Python base. Build/review/pin the resulting image on the authorized host. The worker does not install Playwright or launch a browser on itself. Supply these additional private service settings together:

```dotenv
NEWSCRAFT_BROWSER_IMAGE=sha256:<reviewed-64-hex-browser-image-id>
NEWSCRAFT_BROWSER_SECCOMP_PROFILE=/etc/newscraft-agent/chromium-seccomp.json
NEWSCRAFT_BROWSER_SECCOMP_SHA256=<reviewed-policy-file-sha256>
```

**Security approval needed before live activation:** review an existing deny-by-default Docker seccomp profile with the Chromium user-namespace allowances for `clone`, `setns` and `unshare`, and approve applying it to these isolated containers. [Playwright documents these namespace requirements](https://playwright.dev/python/docs/docker#crawling-and-scraping). The adapter verifies the exact approved file hash and retained container policy; the file must be root/worker-owned, not group/world-writable, and traverse no symlinks. Its shape/hash checks do not replace operator policy review. No policy has been downloaded, installed or activated by this implementation. Chromium's internal sandbox stays enabled. No unconfined seccomp, SYS_ADMIN, privileged container, host IPC or host mount fallback exists. A missing/invalid configured browser profile fails readiness.

On that authorized host, run this synthetic Chromium acceptance after the terminal command above:

```sh
PYTHONPATH=services/hermes-chat/src services/hermes-chat/.venv-owned/bin/python \
  services/hermes-chat/scripts/validate-oci-browser.py \
  --image 'sha256:<reviewed-terminal-image-id>' \
  --browser-image 'sha256:<reviewed-browser-image-id>' \
  --socket '/run/user/<worker-uid>/docker.sock' \
  --seccomp-profile '/etc/newscraft-agent/chromium-seccomp.json' \
  --seccomp-sha256 '<reviewed-policy-file-sha256>'
```

This verifies actual Chromium JavaScript/clicks, source evidence, screenshot persistence, separate terminal execution, duplicate replay, private storage across turns, input taint/reset, tenant/conversation separation and cancellation. It uses only an in-memory synthetic page with an exact URL allowlist, makes no public-web/model/database calls, and retains fixture state if cleanup is unconfirmed. It has **not been run on Linux here**. Actual Chromium compatibility, kernel isolation, public-web sites, host failure/restore and cloud app/provider/storage acceptance remain unverified. No new host or cost was approved or provisioned.
