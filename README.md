# NewsCraft Agent UI

SvelteKit app for NewsCraft, backed by either the legacy Hermes gateway or the
NewsCraft-native newsroom harness in `services/newsroom-harness`.

## Local Development

```sh
corepack pnpm install
corepack pnpm dev
```

If `corepack` is not available on a host that already has `pnpm`, use `pnpm`
directly. The package scripts call `pnpm` internally so they work in either
launch style.

Run the harness in a second terminal. The harness loads
`services/newsroom-harness/.env.local` first, then
`services/newsroom-harness/.env`.

```sh
corepack pnpm dev:harness
```

Then point the UI at it:

```sh
AGENT_GATEWAY_URL=http://127.0.0.1:8650
# Optional if NEWSROOM_HARNESS_API_KEY is set on the harness.
AGENT_GATEWAY_API_KEY=
```

`HERMES_GATEWAY_URL` and `HERMES_API_KEY` remain supported as the fallback path.
The UI route names stay `/api/hermes/*` during this compatibility phase.

## Newsroom Harness

The harness is a same-repo sibling service that defaults to
`127.0.0.1:8650`. It implements the current gateway endpoints the UI needs:

- `GET /health`
- `POST /v1/chat/completions`
- `POST /v1/responses`
- `GET /api/jobs?include_disabled=true`
- `POST /api/jobs`
- `PATCH /api/jobs/:id`
- `DELETE /api/jobs/:id`
- `POST /api/jobs/:id/run`
- `POST /api/jobs/:id/pause`
- `POST /api/jobs/:id/resume`
- `GET /api/runs?include_completed=true&include_recent=true`

Harness env:

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

When `OPENAI_API_KEY` is present, chat and mission synthesis use the OpenAI
Agents SDK. Without it, the harness runs deterministic local fallbacks so local
tests and UI wiring still work. Completed mission runs are saved in the harness
DB; if `NEWSROOM_UI_INGEST_URL` and `NEWSROOM_UI_INGEST_KEY` are set, the
markdown report is posted to the existing UI ingest endpoint so Missions can
display it. `NEWSROOM_UI_INGEST_KEY` must match the UI's `HERMES_INGEST_KEY`
or `HERMES_API_KEY`.

Harness commands:

```sh
corepack pnpm build:harness
corepack pnpm test:harness
corepack pnpm health:harness
```

`GET /health` returns readiness JSON with database, scheduler, ingest, OpenAI,
and runtime-limit status. It returns a non-2xx response if the harness database
is not ready.

Producer acceptance loop:

```sh
corepack pnpm producer:acceptance
```

Deterministic local smoke path, without requiring live feeds or OpenAI:

```sh
corepack pnpm smoke:producer:fixture
```

The acceptance script loads root `.env.local` and
`services/newsroom-harness/.env.local`, starts the harness on `127.0.0.1:8650`
and the UI on `127.0.0.1:3001`, validates live public RSS feeds, creates an
isolated local test account, creates and runs a producer-style editorial
meeting mission through the UI API, verifies the completed report in Missions,
checks harness DB persistence plus UI ingest status, exercises pause/resume,
and checks chat streaming for non-empty output without adjacent duplicate
chunks. The default source profile uses NPR News, BBC World, and The Guardian
World feeds, then checks that the report reads like a producer brief: summary,
lead candidates, source notes, verification notes, and human review, without
implementation language leaking into the brief.

It uses isolated SQLite DBs under `.tmp/producer-acceptance` and never prints
env secrets. By default it requires `OPENAI_API_KEY` to be configured in the
harness env so `/api/health` proves the live model path is available. Set
`PRODUCER_ACCEPTANCE_FEEDS=https://example.com/feed.xml,https://example.org/rss`
to run the same acceptance loop against your own newsroom feeds, or set
`PRODUCER_ACCEPTANCE_SOURCE_MODE=fixture` for the deterministic local fallback.
Set `PRODUCER_ACCEPTANCE_REQUIRE_OPENAI=0` only when you want to test the local
fallback path.

The live OpenAI smoke test is intentionally opt-in:

```sh
NEWSROOM_HARNESS_LIVE_OPENAI_SMOKE=1 corepack pnpm test:harness
```

## Deployment

The old VPS/systemd/Caddy deployment path has been removed. Production deploys
should be configured through the selected hosted platform.

Required `.env` values:

```sh
HERMES_API_KEY=
APP_SESSION_SECRET=
```

When running the native harness in production, also configure:

```sh
AGENT_GATEWAY_URL=
AGENT_GATEWAY_API_KEY=<matches NEWSROOM_HARNESS_API_KEY if set>
NEWSROOM_HARNESS_API_KEY=
NEWSROOM_UI_INGEST_URL=
NEWSROOM_UI_INGEST_KEY=<matches HERMES_INGEST_KEY or HERMES_API_KEY>
```

`APP_PASSWORD_HASH` is now optional. When present and no accounts exist yet, the
first-account setup page requires that legacy password before creating the first
email/password account.

For a production build without cutover:

```sh
corepack pnpm build
corepack pnpm start
```

## Current Limitations

- Hermes route/type names are intentionally preserved for compatibility.
- The harness does not publish or write to a CMS; it only drafts reports and
  posts them to the existing UI ingest endpoint when configured.
- The v1 scheduler runs only while the harness process is running.
- Cron parsing is intentionally conservative; interval schedules like
  `every 180m` and simple five-field cron schedules are supported first.
