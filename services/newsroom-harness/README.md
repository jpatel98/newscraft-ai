# Newsroom Harness

NewsCraft-native agent harness v1. This is a separate service in the same repo,
designed to replace the Hermes gateway contract without a large SvelteKit UI
rewrite.

## Architecture

- HTTP service defaults to `127.0.0.1:8650`.
- SQLite persistence is owned by the harness at `NEWSROOM_HARNESS_DB_PATH`.
- The existing UI continues using `/api/hermes/*` routes and points at the
  harness with `AGENT_GATEWAY_URL`.
- Shared DTOs and SSE helpers live in `packages/shared`.
- The OpenAI Agents SDK is used when `OPENAI_API_KEY` is configured. Local
  deterministic fallbacks keep tests and offline development runnable.

The harness can scan, fetch, summarize, draft, verify, monitor, and alert.
Publishing and sensitive editorial decisions remain human-approved.

## Commands

```sh
corepack pnpm install
corepack pnpm --filter @newscraft/newsroom-harness dev
corepack pnpm --filter @newscraft/newsroom-harness build
corepack pnpm --filter @newscraft/newsroom-harness test
node scripts/check-health.mjs --url http://127.0.0.1:8650/health --expect harness
```

From the repo root:

```sh
corepack pnpm dev:harness
corepack pnpm build:harness
corepack pnpm test:harness
corepack pnpm reload:harness
corepack pnpm producer:acceptance
corepack pnpm smoke:producer:fixture
```

`producer:acceptance` starts the harness and SvelteKit UI against isolated
SQLite DBs, validates live public RSS feeds, creates a local test account,
creates and runs a producer-style editorial meeting mission, verifies UI ingest
and harness report persistence, exercises pause/resume, and checks chat
streaming. The default source profile uses NPR News, BBC World, and The
Guardian World, then checks that the report includes summary, lead candidates,
source notes, verification notes, and human review in plain newsroom language. It
loads the same `.env.local` files as local development while overriding only
local acceptance ports, DB paths, and matching test auth keys.

Set `PRODUCER_ACCEPTANCE_FEEDS` to a comma-separated list of real newsroom RSS
feeds to test a specific producer workflow. Set
`PRODUCER_ACCEPTANCE_SOURCE_MODE=fixture` for the deterministic local fixture.

## Environment

Copy `.env.example` to `.env.local` or `.env`, or export these values. The
service loads `.env.local` first and then `.env`.

```sh
NEWSROOM_HARNESS_HOST=127.0.0.1
NEWSROOM_HARNESS_PORT=8650
NEWSROOM_HARNESS_DB_PATH=.data/newsroom-harness.db
NEWSROOM_HARNESS_API_KEY=
OPENAI_API_KEY=
NEWSROOM_UI_INGEST_URL=http://127.0.0.1:3001/api/hermes/channel-posts
NEWSROOM_UI_INGEST_KEY=
NEWSROOM_HARNESS_RUN_TIMEOUT_MS=90000
NEWSROOM_HARNESS_MAX_TOOL_CALLS=8
NEWSROOM_HARNESS_RETRY_LIMIT=1
NEWSROOM_HARNESS_SCHEDULER_INTERVAL_MS=30000
```

If `NEWSROOM_HARNESS_API_KEY` is set, all endpoints except `GET /health`
require `Authorization: Bearer <key>`.
Set `NEWSROOM_UI_INGEST_KEY` to the SvelteKit UI's `HERMES_INGEST_KEY` or
`HERMES_API_KEY` when you want completed reports to appear in Missions.

## Production Service

The harness is intended to run as a long-lived sibling service. Review and
install `deploy/systemd/newsroom-harness.service.example`, then use:

```sh
corepack pnpm reload:harness
corepack pnpm health:harness
```

For full-stack reloads, prefer:

```sh
corepack pnpm reload:stack
```

That restarts the harness first, verifies `/health`, then restarts the UI and
verifies `/api/health` can reach the harness. The scripts do not install units
or cut traffic over.

## Endpoints

```sh
curl http://127.0.0.1:8650/health

curl -N http://127.0.0.1:8650/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{"stream":true,"messages":[{"role":"user","content":"Summarize the latest source notes"}]}'

curl http://127.0.0.1:8650/api/jobs?include_disabled=true
```

Mission endpoints:

- `POST /api/jobs`
- `PATCH /api/jobs/:id`
- `DELETE /api/jobs/:id`
- `POST /api/jobs/:id/run`
- `POST /api/jobs/:id/pause`
- `POST /api/jobs/:id/resume`
- `GET /api/runs?include_completed=true&include_recent=true`

## Persistence

Tables are created on startup:

- `jobs`
- `runs`
- `run_steps`
- `tool_calls`
- `sources`
- `source_snapshots`
- `reports`

Mission reports are stored as markdown wrapped in the current parseable board
format:

```md
# Cron Job: Mission name
**Job ID:** job_...
**Run Time:** 2026-05-18T...
**Schedule:** every 180m

## Response
...
```

## Limitations

- Scheduler state is process-local for v1.
- Cron support is conservative: interval schedules and simple five-field minute
  or hour patterns are supported first.
- Source extraction uses lightweight RSS/HTML parsing. It preserves provenance
  and snapshots, but it is not a full article extraction engine yet.
- Reports are drafts for human review. The harness performs no publishing or
  sensitive editorial automation.
