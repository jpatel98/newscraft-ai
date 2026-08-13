# NewsCraft Hermes chat

This service is NewsCraft's only agent runtime. It uses the Hermes AG-UI adapter at reviewed commit `5370d535ab926da41abe3ba4d9d975f1f94875d5`.

The browser calls NewsCraft. NewsCraft calls this service. NewsCraft does not register a custom toolset or filter Hermes tools. The service uses Hermes's standard `hermes-acp` toolset. This includes web search, browser control, terminal and process tools, file read and write, patching, code execution, skills, memory, and delegation.

A failed Hermes run stays failed. NewsCraft does not switch to the old agent or another model endpoint.

Each request uses Hermes's native iteration budget. The default is 25 model turns. Set `NEWSCRAFT_HERMES_MAX_ITERATIONS` from 4 through 90 when a different bound is required. Hermes keeps every standard tool. At the limit, the same Hermes run makes its built-in final-summary attempt. It does not switch engines.

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
