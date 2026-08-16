# NewsCraft Hermes chat

This service is NewsCraft's only agent runtime. It uses the Hermes AG-UI adapter at reviewed commit `5370d535ab926da41abe3ba4d9d975f1f94875d5`.

The browser calls NewsCraft. NewsCraft calls this service. NewsCraft does not register a custom toolset or filter Hermes tools. The service uses Hermes's standard `hermes-acp` toolset plus the tenant-safe `cronjob_tools` set. This includes web search, browser control, terminal and process tools, file read and write, patching, code execution, skills, memory, scheduled-job management, and delegation.

## Account isolation

NewsCraft authentication is authoritative. The NewsCraft server derives one opaque HMAC tenant key from the authenticated account and sends it in `x-newscraft-tenant-key`. The browser cannot set the account scope. Hermes rejects a run without exactly one valid tenant key.

The service keeps one AG-UI process. Each run uses a context-local Hermes home and a stable task key. The service registers that key as Hermes's per-task container-isolation override, so Hermes's normal delegate-task collapse to one shared `default` container cannot merge accounts. Hermes state, skills, scheduled jobs, browser profile, and persistent Docker terminal belong to that tenant scope. External skill directories and unrelated Hermes plugins are disabled; only the NewsCraft retrieval plugin is enabled. The Docker terminal uses `/workspace`; its private tenant bind mounts run as the service UID so normal file tools can write them. NewsCraft supplies no caller-selected host volume, cwd mount, credential file, forwarded environment, or provider secret. The browser uses the tenant browser profile and stable session name. Hermes's hard-coded process-global prompt backend probe is disabled for tenant runs, so it cannot reuse a container from another Hermes process.

The AG-UI contract uses Hermes `hermes-acp`. It isolates scheduled-job state, but this adapter does not start Hermes's separate gateway cron ticker. Automatic scheduled-job execution needs a separate Docker-backed staging gate before it is enabled.

Hermes's host crash checkpoint is disabled for this service because the pinned checkpoint path is process-global and Docker process IDs cannot be recovered safely after a service restart. The process tool still restricts every handle to its tenant task key. A restart drops in-flight process handles but does not expose one account's process metadata to another account.

Hermes's process-global async-delegation recovery queue is also disabled at service startup because no authenticated tenant exists at that point. A delegation started inside a tenant run uses that tenant's state scope. An in-flight delegation is not recovered after a service restart.

NewsCraft remains the source of truth for account-scoped conversation history. The adapter passes only the authenticated account's history to Hermes. Hermes `session_search` cannot select a profile or home from model arguments. Hydra, Jigar's personal Hermes service, has a separate process, user, home, and state and is not migrated.

Hermes uses only its built-in tenant-local memory files in this service. External memory providers are disabled until a provider with an explicit NewsCraft account boundary is available.

A failed Hermes run stays failed. NewsCraft does not switch to the old agent or another model endpoint.

Each request uses Hermes's native iteration budget. The default is 25 model turns. Set `NEWSCRAFT_HERMES_MAX_ITERATIONS` from 4 through 90 when a different bound is required. Hermes keeps every standard tool. At the limit, the same Hermes run makes its built-in final-summary attempt. It does not switch engines.

## Web extraction

NewsCraft enables the `newscraft-local` Hermes web-extract backend. It uses one bounded direct HTTP request for each candidate page. It extracts article text and page timestamps without a paid API key.

When a live page is blocked or unreadable, the backend makes one Wayback CDX lookup and one Wayback replay request. It records the original URL, archive URL, capture time, page time, retrieval time, and fallback reason. It does not bypass challenges, CAPTCHAs, or paywalls. It does not use archive.today.

Search results remain leads. Hermes must use `verify_this_lead` to verify one candidate before it treats the page as evidence. The tool passes the candidate timestamp, title, and snippet into the local extractor when available. A page without usable text, an acceptable page class, or a publication/update timestamp returns an explicit rejection reason. The normal `web_extract` tool remains available for other direct page reads.

The service selects the backend through Hermes config:

```yaml
web:
  extract_backend: newscraft-local
```

The service enables its pip plugin in the generated Hermes config. `/ready` reports the backend and fails when the plugin is missing.

## Isolation

Use a separate Linux account, Hermes home, workspace, token, model key, and process. Do not point either directory at a personal Hermes home, a user home, or the NewsCraft checkout. Hermes has normal access inside this separate workspace.

The model endpoint is explicit. Remote endpoints must use HTTPS. The model provider and model are also explicit. The service writes a standard Hermes `config.yaml` into its dedicated Hermes home. Main calls and Hermes auxiliary calls use the same endpoint. No second model endpoint is configured.

DDGS is available for low-cost search. It needs no API key. The standard local Hermes browser reads public pages with headless Chromium.

## Local install

Use the clean reviewed Hermes checkout. The installer rejects another commit or a dirty checkout.

```bash
services/hermes-chat/scripts/install-runtime.sh \
  /absolute/path/to/hermes-agent \
  /absolute/path/to/newscraft-hermes-venv \
  /absolute/path/to/newscraft-hermes-home
```

The installer also installs the native `agent-browser@0.26.0` command and its Chrome build. Both stay under the dedicated Hermes home. Run it as the separate `newscraft-hermes` operating-system user.

Copy `.env.example` to a private environment file. For a local OpenAI-compatible test server, use its loopback base URL. Then export the values and start:

```bash
/absolute/path/to/newscraft-hermes-venv/bin/newscraft-hermes-chat
```

For the repository start command, install the runtime at `services/hermes-chat/.venv`, save the service values in `services/hermes-chat/.env`, and save the two NewsCraft server values in the root `.env.local`. Then run:

```bash
corepack pnpm dev:all
```

This command starts the chat UI and the isolated Hermes service. It rejects a missing runtime, a remote local-development URL, or mismatched service tokens. It never starts the old newsroom harness.

Set these NewsCraft server values to the matching service URL and token:

```text
NEWSCRAFT_HERMES_URL=http://127.0.0.1:8000
NEWSCRAFT_HERMES_API_TOKEN=<same value as HERMES_AGUI_SESSION_TOKEN>
NEWSCRAFT_HERMES_TENANT_SECRET=<server-only HMAC secret>
```

## Contabo deployment

Use the existing VPS, but create an isolated `newscraft-hermes` user. Install the pinned runtime under `/opt/newscraft-hermes`. Keep runtime data under `/var/lib/newscraft-hermes`. Keep secrets in `/etc/newscraft-hermes-chat.env` with mode `0600`.

The supplied systemd unit binds Hermes to loopback. If NewsCraft stays on Vercel, put Caddy, Nginx, or Tailscale Funnel in front of Hermes and expose one HTTPS host. Set `NEWSCRAFT_HERMES_PUBLIC_HOST` to that exact hostname. Configure the HTTPS URL and matching token in NewsCraft server secrets. The browser still never receives either value.

Before a cutover, verify all of these gates:

1. `/ready` reports the pinned commit, `hermes-acp`, the configured model endpoint, the iteration budget, and the standard capability groups.
2. A normal chat reply streams and saves.
3. A live article query uses the standard Hermes browser, reads selected pages, and saves resolvable citations.
4. A provider failure produces a clear Hermes failure and no second agent request.
5. Restart the service and repeat the chat and citation checks.

Do not promote the branch or change the VPS until these gates pass with the real model configuration.
