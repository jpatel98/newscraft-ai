# Deployment/acceptance decision — 2026-10-07

**Historical assessment and proposals:** the subsequent repository review did not repeat the remote metadata, SSH, storage-health, pricing or image checks below. They are not current acceptance evidence or authorization. The current task prohibits SSH into Contabo, cloud creation, Docker/Colima/Lima reinstallation, production changes and paid calls. See [current local status](agent-local-handoff.md).

This is a read-only readiness assessment and proposed commands, not deployment authorization. No application code changed during this assessment. No credentials were retrieved, host trust changed, image built, daemon installed/started, infrastructure created, or paid inference run.

A subsequent authorized review-fix pass changed cleanup/completion ordering and pinned the supported worker runtime. Both fixes passed the full offline service suite; see [implementation and verification](agent-replacement-workflow.md). The infrastructure findings and unexecuted commands below remain unchanged.

## Verified existing targets

| Target | Evidence obtained now | What is still missing |
| --- | --- | --- |
| NewsCraft UI on Vercel | Authenticated project metadata confirms `prj_pywLQLbNvNjJQObIjfs2XZIyaT9D`, team `team_51SGoYrM9iWXGMMLmzaumD2c`, Node 24, production deployment `dpl_GzH3r6d1VUo77C7PL3WUB9p2KjG3`, and `agent.newscraftai.com` | That deployment is not this uncommitted replacement. No deployment environment values were requested. |
| Existing Contabo host | Existing Tailscale status identifies `contabo.tail9ffe16.ts.net` as **online Linux**. `GET https://contabo.tail9ffe16.ts.net/newscraft-storage/health` returned **200, `ok:true`** | CPU/RAM/disk, Linux distribution, rootless daemon, service account, image and actual Chromium compatibility are unverified. A healthy storage process does not establish executor suitability. |
| Existing Contabo SSH route | The existing known-hosts file already trusts its Tailscale IP `100.80.215.42`. Strict SSH to that exact existing alias reached authentication | `root@100.80.215.42: Permission denied (publickey,password)`. No password was requested or supplied. The FQDN has no trusted host-key entry; none was added. The Tailscale SSH wrapper also did not yield a shell. |
| New Supabase project | Parent previously initialized `ygsiifvjzdazfxflmpjq`: 19 migrations, 33 protected tables | Runtime `DATABASE_URL` is still absent. Do not rerun initialization or fall back to the old database. |
| Local mini | `docker`, `colima`, `limactl`, `doctl` and `hcloud` are absent; `uv` and Tailscale remain available | The user deleted the Colima VM and removed its tools. Linux acceptance cannot run here, and reinstalling them is not authorized. |

Sources for the existing topology are [the Contabo record](newscraft-contabo-readiness-20260907.md), [infrastructure configuration](../infra/README.md), current connected Vercel metadata, and the scoped read-only health/Tailscale/SSH checks above. Initial sandboxed network errors were resolved by an approved read-only network probe; they were not evidence that Contabo was offline.

## Smallest next decision

**First choice: reuse Contabo only after an existing authorized operator login can produce its read-only capacity/daemon receipt.** The exact access blocker is SSH authentication, not a missing provider key and not a reason to create another database. Restoring/providing an existing authorized SSH session is sufficient for inspection; it does not authorize creating users or changing Docker/security policy. No new VM rental is expected if it has spare resources, but its plan/transfer billing was not inspected.

The minimum proposed workload is **one active run**, one browser at 1 CPU/1 GiB/128 PIDs plus at most one terminal at 1 CPU/256 MiB/64 PIDs. Set both global and per-tenant active-run limits to 1; queue limits to 2. Require a 2-vCPU/4-GiB-class host with enough **available** memory for this workload plus its existing services, cgroup v2/systemd delegation and a retained private state volume. Those capacity figures are engineering sizing for initial acceptance, not measured performance guarantees. Do not touch Contabo's personal services, old database, existing rootful daemon or Funnel routes to force compatibility.

**Concrete reversible fallback if that existing access cannot be restored: one DigitalOcean Basic Regular Droplet, `s-2vcpu-4gb`, Debian 12 x64, NYC3, one-hour disposable acceptance.** Published limits are 2 shared vCPUs, 4 GiB RAM, 80 GiB SSD and 4,000 GiB monthly outbound transfer. Published price is **$0.03571/hour, capped at $24/month**, with bundled public IPv4 included. One hour is approximately **$0.04 compute before tax**, with no backups, snapshots, extra volumes, load balancer or model calls. Region/account capacity is not verified, and no DigitalOcean account connection or CLI exists here. Do not silently substitute a different plan/region or create new credentials. [Official plan/prices](https://www.digitalocean.com/pricing/droplets), [billing and transfer rules](https://docs.digitalocean.com/products/droplets/details/pricing/).

Authorize creation **and destruction of this one new synthetic-only VM** as one bounded action, with a one-hour deadline. Destroying that VM ends its compute billing; merely powering it off does not. Capture the redacted result first. Keeping it as the worker instead requires the continuing $24/month allowance and private-volume retention/backup arrangements. Taxes and any transfer overage are separate; inbound transfer is free and outbound overage is $0.01/GiB. No free trial credit is assumed.

The existing Contabo route is the lower-infrastructure alternative. A managed sandbox would require a new backend adapter; this implementation already works against the specified rootless OCI contract, so adding another provider is not the smallest deployment step. The Vercel UI and initialized Supabase project stay in place.

## Exact artifact selection

Public, unauthenticated metadata was read in memory; nothing was pulled or installed:

- Terminal recipe: [executor.Dockerfile](../services/hermes-chat/deploy/executor.Dockerfile), label `newscraft.executor.contract=v1`.
- Browser recipe: [browser.Dockerfile](../services/hermes-chat/deploy/browser.Dockerfile), Playwright **1.63.0** and its matching Chromium, label `newscraft.browser.contract=v1`.
- Immutable Linux amd64 Python base: `python:3.12-bookworm@sha256:edd0b3ec946cc68bd20e39480bd03929016d0fb6254cbf870cd3bc55ea25116d`. Docker Hub's tag metadata also reported multi-platform manifest `sha256:5560e9ab8709f459489e5b8aa696eda8a07ef821e14bb122be62d91234bfa98b`, updated 2026-10-06. [Official tag metadata](https://hub.docker.com/v2/repositories/library/python/tags/3.12-bookworm/).
- Proposed policy bytes: [Playwright v1.63.0 seccomp profile](https://raw.githubusercontent.com/microsoft/playwright/v1.63.0/utils/docker/seccomp_profile.json), **12,997 bytes**, SHA256 **`cc3e61cabda6bbc1e53e54d27ba4d55a9d3be829b6dd1a596f4a7b31b1cc7849`**. Read-back found `SCMP_ACT_ERRNO` by default and unconditional `clone`, `setns`, `unshare` allowances. The upstream profile has additional default-Docker rules; reviewing its full bytes is part of the security approval, not just checking these three names.

Runtime image IDs must be captured from the actual builds and supplied as immutable `sha256:` values; they do not exist yet and must not be invented. Chromium's internal sandbox remains enabled. No `--privileged`, `SYS_ADMIN`, unconfined seccomp, host IPC, shared terminal/browser PID namespace or host workspace mount is proposed. [Playwright's sandbox requirements](https://playwright.dev/python/docs/docker#crawling-and-scraping).

## Per-action approvals and commands

The parent should obtain only the applicable approvals, in this order:

1. **Existing-host access, if available:** a working previously authorized SSH session for the read-only facts. Do not request or post a password/private key in chat. No service restart is needed for this inspection.
2. **Computer setup/acceptance:** permission on the chosen host for a dedicated `newscraft-agent` non-root user, subordinate UID/GID range, private state directories, rootless Docker user service, CPU/memory/PID cgroup delegation, the two image builds and the exact Chromium seccomp policy above. Run only the two synthetic acceptance commands. On Contabo, stop if setup would alter existing service policy or require an unrelated service restart. No model credential is necessary for these commands.
3. **Fallback VM purchase only if chosen:** the one-hour/$0.04-before-tax compute allowance, use of an existing authorized account/SSH key, and deletion of only that newly created fixture VM. Account access and provider capacity must be checked before creation; neither is established here.
4. **Application release:** secure new-project DB credential entry, verified object-service access and matching existing app/worker tokens, then the single owned-worker/app deployment. Public DNS/HTTPS/firewall routing for the worker must be concrete before applying it. Existing SSO-protected Vercel preview URLs cannot be assumed usable as callbacks. No production DNS/alias or service was changed by this assessment.
5. **Paid inference:** the separate single-run allowance below. Credential reuse approval already exists and is not the spending approval.

Rootless setup requires `newuidmap`/`newgidmap`, at least 65,536 subordinate UIDs/GIDs for the account, and working cgroup v2/systemd CPU/memory/PID delegation. The worker is not added to a privileged Docker group. Use the existing reviewed daemon where possible. Any needed package/OS/user-service setup is part of action 2, with [Docker's Debian instructions](https://docs.docker.com/engine/install/debian/), [rootless prerequisites](https://docs.docker.com/engine/security/rootless/) and [resource delegation requirements](https://docs.docker.com/engine/security/rootless/tips/#limiting-resources). Do not run a generic installer or disable the existing rootful daemon on Contabo.

The host worker additionally requires an existing **CPython 3.11** interpreter and `uv`. The installer selects `cpython@3.11` with `--no-python-downloads`; it does not fetch a runtime implicitly. The service selects the stdlib asyncio loop, and browser readiness/dispatch reject unsupported runtimes before model or browser admission. The immutable **Python 3.12 guest image** above is separate and does not change the worker requirement.

If fallback provisioning is approved, the resource command below is for an already authorized operator CLI. Required variables prevent an implicit password-based VM or unselected key. The region, image and size must first appear in that account's read-only catalog. `doctl` is not installed here, and obtaining its credentials/installing it was not attempted. [Official CLI contract](https://docs.digitalocean.com/reference/doctl/reference/compute/droplet/create/).

```sh
: "${NEWSCRAFT_EXISTING_SSH_KEY_ID:?Select an already authorized account SSH key}"
doctl compute droplet create newscraft-agent-acceptance-20261007 \
  --region nyc3 --size s-2vcpu-4gb --image debian-12-x64 \
  --ssh-keys "$NEWSCRAFT_EXISTING_SSH_KEY_ID" \
  --enable-backups=false --enable-monitoring=false --droplet-agent=false \
  --wait --format ID,Name,PublicIPv4,Status
```

Record the returned ID as `NEWSCRAFT_ACCEPTANCE_DROPLET_ID`. Use a cloud firewall allowing SSH only from the authorized operator's source CIDR; acceptance needs no inbound application/browser/database port. Do not reuse an ID belonging to an existing machine. The approved one-hour fixture teardown is:

```sh
: "${NEWSCRAFT_ACCEPTANCE_DROPLET_ID:?Must be the ID returned by this fixture creation}"
doctl compute droplet get "$NEWSCRAFT_ACCEPTANCE_DROPLET_ID" --format ID,Name
# Verify the exact fixture name/ID and preserve the redacted report first.
doctl compute droplet delete "$NEWSCRAFT_ACCEPTANCE_DROPLET_ID"
```

After action 2 has provisioned the chosen Linux host, run the following as its non-root worker, from a reviewed copy of this checkout. The dedicated socket must already exist; the commands do not create/start Docker. `NEWSCRAFT_ACCEPTANCE_ROOT` must be a fresh private directory for this review, outside any production state. The Docker config directory must be empty so registry credentials/plugins are not inherited.

```sh
: "${NEWSCRAFT_ACCEPTANCE_ROOT:?Fresh private Linux acceptance directory}"
NEWSCRAFT_SOCKET="/run/user/$(id -u)/docker.sock"
test -S "$NEWSCRAFT_SOCKET"
test ! -e "$NEWSCRAFT_ACCEPTANCE_ROOT"
install -d -m 0700 "$NEWSCRAFT_ACCEPTANCE_ROOT/docker-config"
NEWSCRAFT_BASE='python:3.12-bookworm@sha256:edd0b3ec946cc68bd20e39480bd03929016d0fb6254cbf870cd3bc55ea25116d'

curl --fail --proto '=https' --tlsv1.2 \
  'https://raw.githubusercontent.com/microsoft/playwright/v1.63.0/utils/docker/seccomp_profile.json' \
  --output "$NEWSCRAFT_ACCEPTANCE_ROOT/chromium-seccomp.json"
printf '%s  %s\n' \
  'cc3e61cabda6bbc1e53e54d27ba4d55a9d3be829b6dd1a596f4a7b31b1cc7849' \
  "$NEWSCRAFT_ACCEPTANCE_ROOT/chromium-seccomp.json" | sha256sum --check -
chmod 0600 "$NEWSCRAFT_ACCEPTANCE_ROOT/chromium-seccomp.json"

/usr/bin/docker --host "unix://$NEWSCRAFT_SOCKET" \
  --config "$NEWSCRAFT_ACCEPTANCE_ROOT/docker-config" build \
  --build-arg "BASE_IMAGE=$NEWSCRAFT_BASE" \
  --iidfile "$NEWSCRAFT_ACCEPTANCE_ROOT/terminal-image.id" \
  --file services/hermes-chat/deploy/executor.Dockerfile services/hermes-chat/deploy
/usr/bin/docker --host "unix://$NEWSCRAFT_SOCKET" \
  --config "$NEWSCRAFT_ACCEPTANCE_ROOT/docker-config" build \
  --build-arg "BASE_IMAGE=$NEWSCRAFT_BASE" \
  --iidfile "$NEWSCRAFT_ACCEPTANCE_ROOT/browser-image.id" \
  --file services/hermes-chat/deploy/browser.Dockerfile services/hermes-chat/deploy

services/hermes-chat/scripts/install-runtime.sh "$NEWSCRAFT_ACCEPTANCE_ROOT/venv"
NEWSCRAFT_TERMINAL_IMAGE=$(cat "$NEWSCRAFT_ACCEPTANCE_ROOT/terminal-image.id")
NEWSCRAFT_BROWSER_IMAGE=$(cat "$NEWSCRAFT_ACCEPTANCE_ROOT/browser-image.id")

PYTHONPATH=services/hermes-chat/src "$NEWSCRAFT_ACCEPTANCE_ROOT/venv/bin/python" \
  services/hermes-chat/scripts/validate-oci-executor.py \
  --image "$NEWSCRAFT_TERMINAL_IMAGE" --socket "$NEWSCRAFT_SOCKET"
PYTHONPATH=services/hermes-chat/src "$NEWSCRAFT_ACCEPTANCE_ROOT/venv/bin/python" \
  services/hermes-chat/scripts/validate-oci-browser.py \
  --image "$NEWSCRAFT_TERMINAL_IMAGE" --socket "$NEWSCRAFT_SOCKET" \
  --browser-image "$NEWSCRAFT_BROWSER_IMAGE" \
  --seccomp-profile "$NEWSCRAFT_ACCEPTANCE_ROOT/chromium-seccomp.json" \
  --seccomp-sha256 'cc3e61cabda6bbc1e53e54d27ba4d55a9d3be829b6dd1a596f4a7b31b1cc7849'
```

The script examples intentionally stop before starting the app/worker or opening a public route. A successful acceptance report is required before installing the user service with real state/configuration. Service environment selects the actual built digests and policy hash, `NEWSCRAFT_AGENT_MAX_ACTIVE_RUNS=1`, `NEWSCRAFT_AGENT_MAX_ACTIVE_RUNS_PER_TENANT=1`, and both queued-run limits `2`. Keep one retained state volume and original daemon endpoint; do not autoscale this SQLite-backed adapter across unrelated hosts.

## Checks that need no paid model calls

- Both Linux acceptance commands: actual guarded code execution, Chromium JavaScript/clicks, screenshots, file/profile persistence, tenant/conversation separation, source evidence, duplicate replay and cancellation. Browser content is a fixed in-memory fixture; no public website or model is called.
- Once the authorized DB/runtime credential is securely configured: connection/schema checks, disposable signup/sign-in/session revocation and two-account access checks. No schema initialization is repeated. Disposable accounts/rows are application writes, not read-only metadata inspection.
- Once existing object-service access is verified: synthetic scoped upload/finalize/download/checksum, expiry and wrong-owner checks. These can incur the existing hosting/storage provider's normal usage; no new bucket or storage vendor is automatically created.
- The deterministic model-adapter/durable UI tests and disposable Postgres fixture already passed. They require no API calls and do not prove live provider access.

## Separate bounded paid-test decision

Proposed approval text: **"Use the already approved OpenAI key for one NewsCraft public/synthetic research-to-cited-answer-and-Markdown/CSV acceptance run, with a $4.23 application reservation ceiling, and do not retry the run automatically."**

Exact existing setup: `gpt-6-astra`, `https://api.openai.com/v1`, default service tier, text only, public search, one active run, at most **8 model requests**, **180 seconds**, **120,000 cumulative conservative input tokens**, **2,048 output tokens per request**, **no images**, **no paid search tool**, and no automatic replay of uncertain calls. Prices are conservatively bounded at **$25 input / $75 output per million tokens**. Current [official Standard pricing](https://developers.openai.com/api/docs/pricing) lists Astra short-context input/output $10/$50, and long-context input/cache-write/output $20/$25/$75, so those ceilings cover the selected endpoint/tier's listed rates.

Reservation arithmetic: `(120000 × 25 + 8 × 2048 × 75) / 1000000 = $4.2288`, below $4.23. The application reserves before each request and stops at its bounds; this is **not a provider-enforced hard billing cap** and cancellation does not prove provider billing stopped. Successful completion within eight requests is not guaranteed. This approval does not include a second provider, a second test run, normal ongoing production inference, paid web search, or VM charges. Record request IDs, reservations, public events and artifact checksums; never credentials or private reasoning.
