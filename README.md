# NewsCraft Agent UI

SvelteKit app for NewsCraft, backed by the NewsCraft-native newsroom harness in
`services/newsroom-harness`.

## Local Development

```sh
corepack pnpm install
corepack pnpm dev
```

To run the UI and newsroom harness together in one terminal:

```sh
corepack pnpm dev:all
```

That serves the UI on `http://127.0.0.1:3001` and the harness on
`http://127.0.0.1:8650`.

The UI database is Supabase Postgres through `DATABASE_URL`. Local development
does not require a local Homebrew/Docker Postgres process. Use the Supabase
session-pooler connection string when IPv4 is required; use the direct
connection only from networks that can route to the Supabase direct host.

If those ports are already occupied by a previous NewsCraft dev run, `dev:all`
prints the existing URLs instead of starting duplicate servers. To stop stale
local dev processes:

```sh
corepack pnpm dev:stop
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

The UI route names stay `/api/agent/*` during this compatibility phase.

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
NEWSROOM_HARNESS_DATABASE_URL=<optional explicit harness mirror connection string>
NEWSROOM_HARNESS_API_KEY=
OPENAI_API_KEY=
NEWSROOM_UI_INGEST_URL=http://127.0.0.1:3001/api/agent/channel-posts
NEWSROOM_UI_INGEST_KEY=
NEWSROOM_HARNESS_RUN_TIMEOUT_MS=90000
NEWSROOM_HARNESS_MAX_TOOL_CALLS=6
NEWSROOM_HARNESS_MAX_CUSTOM_TOOL_CALLS=4
NEWSROOM_HARNESS_MAX_WEB_SEARCHES=3
NEWSROOM_HARNESS_MAX_BROWSER_TASKS=2
NEWSROOM_HARNESS_RETRY_LIMIT=1
NEWSROOM_HARNESS_SCHEDULER_INTERVAL_MS=30000
NEWSROOM_AGENT_ENABLED_TOOLS=
NEWSROOM_AGENT_SOURCE_PRIORITY=official,primary,source_monitor,internal,media_report,unknown
NEWSROOM_AGENT_SOURCE_MONITORS_JSON=
NEWSROOM_WEB_SEARCH_MODEL=gpt-5
NEWSROOM_EMAIL_DIGEST_WEBHOOK_URL=
NEWSROOM_DELIVERY_WEBHOOK_URL=
NEWSROOM_SLACK_WEBHOOK_URL=
WORDPRESS_REST_URL=
WORDPRESS_USERNAME=
WORDPRESS_APP_PASSWORD=
```

`NEWSROOM_HARNESS_DB_PATH` remains the local hot store. When
`NEWSROOM_HARNESS_DATABASE_URL` is set, the harness creates a private
Supabase/Postgres `harness` schema, restores remote rows into SQLite on start,
and mirrors subsequent harness writes back to Supabase. If it is omitted, the
harness stays SQLite-only; the app `DATABASE_URL` is reserved for the SvelteKit
UI database and does not enable harness mirroring.

Mission runs use the disciplined NewsCraft agent harness: requests are routed
once, tool budgets are enforced before every call, tool output is normalized
into evidence objects, and final answers are generated from that evidence.
`OPENAI_API_KEY` enables the OpenAI `web_search` provider for broad coverage;
custom/internal tools, configured source monitors, feeds, saved mission output,
and document extraction are preferred when they fit the request. Completed
mission runs are saved in the harness DB; if `NEWSROOM_UI_INGEST_URL` and
`NEWSROOM_UI_INGEST_KEY` are set, the markdown report is posted to the existing
UI ingest endpoint so Missions can display it. `NEWSROOM_UI_INGEST_KEY` must
match the UI's `NEWSROOM_UI_INGEST_KEY`.

Phase 3 packaging is harness-owned. Once a draft review gate is approved, the
Packager can create brief, web, feature, broadcast, social, push, newsletter,
and headline-pack outputs, then queue a Publish gate. Delivery adapters for
email digest, generic webhook, Slack, and WordPress REST only run after a
Publish gate is resolved with `approve` or `send_to_cms`; real target URLs and
WordPress credentials must come from env/deployment secrets.

Harness commands:

```sh
corepack pnpm build:harness
corepack pnpm test:harness
corepack pnpm health:harness
npm run agent:ask -- "Check the latest Toronto Police releases and summarize anything newsworthy"
npm run agent:ask -- "What are other outlets reporting about this story?"
npm run agent:ask -- "Summarize the latest mission output"
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

It uses an isolated harness SQLite DB under `.tmp/producer-acceptance` and the
app database configured by `PRODUCER_ACCEPTANCE_DATABASE_URL` or `DATABASE_URL`
(normally the Supabase Postgres URL for this project);
it never prints env secrets. By default it requires `OPENAI_API_KEY` to be configured in the
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
APP_SESSION_SECRET=
DATABASE_URL=<Supabase Postgres connection string>
```

`DATABASE_URL` should be a server-only Supabase Postgres URI. Do not commit the
actual direct or pooler URL; keep it in `.env.local` or the deployment platform
secret store.

When running the native harness in production, also configure:

```sh
AGENT_GATEWAY_URL=
AGENT_GATEWAY_API_KEY=<matches NEWSROOM_HARNESS_API_KEY if set>
NEWSROOM_HARNESS_API_KEY=
NEWSROOM_UI_INGEST_KEY=<optional, required only when report ingest is enabled>
NEWSROOM_UI_INGEST_URL=
```

`APP_PASSWORD_HASH` is now optional. When present and no accounts exist yet, the
first-account setup page requires that legacy password before creating the first
account.

For a hosted production build:

```sh
corepack pnpm build
```

## Current Limits

- `/api/agent/*` route/type names are intentionally preserved for compatibility.
- CMS/delivery adapters are present, but they require a resolved Publish gate
  and explicit env/deployment configuration before anything leaves NewsCraft.
- The v1 scheduler runs only while the harness process is running.
- Cron parsing is intentionally conservative; interval schedules like
  `every 180m` and simple five-field cron schedules are supported first.
