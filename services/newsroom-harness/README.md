# Newsroom Harness

NewsCraft-native agent harness v1. This is a separate service in the same repo,
designed to replace the agent gateway contract without a large SvelteKit UI
rewrite.

## Architecture

- HTTP service defaults to `127.0.0.1:8650`.
- SQLite persistence is owned by the harness at `NEWSROOM_HARNESS_DB_PATH`.
  When `NEWSROOM_HARNESS_DATABASE_URL` or `DATABASE_URL` is visible to the
  harness process, the service mirrors/restores that state through a private
  Supabase/Postgres `harness` schema.
- The existing UI continues using `/api/agent/*` routes and points at the
  harness with `AGENT_GATEWAY_URL`.
- Shared DTOs and SSE helpers live in `packages/shared`.
- The disciplined agent harness routes each request, enforces hard tool budgets,
  normalizes tool output into evidence objects, and generates final answers from
  that evidence.
- OpenAI `web_search` is used only for broad discovery or related coverage when
  `OPENAI_API_KEY` is configured. Browser automation is an optional provider for
  direct page interaction, not the center of the harness.

The harness can scan, fetch, summarize, draft, verify, monitor, and alert.
Publishing and sensitive editorial decisions remain human-approved.

## Commands

```sh
corepack pnpm install
corepack pnpm --filter @newscraft/newsroom-harness dev
corepack pnpm --filter @newscraft/newsroom-harness build
corepack pnpm --filter @newscraft/newsroom-harness test
npm run agent:ask -- "Check the latest Toronto Police releases and summarize anything newsworthy"
npm run agent:ask -- "What are other outlets reporting about this story?"
npm run agent:ask -- "Summarize the latest mission output"
node scripts/check-health.mjs --url http://127.0.0.1:8650/health --expect harness
```

From the repo root:

```sh
corepack pnpm dev:harness
corepack pnpm build:harness
corepack pnpm test:harness
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
NEWSROOM_HARNESS_DATABASE_URL=<optional Supabase Postgres connection string>
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
```

If `NEWSROOM_HARNESS_API_KEY` is set, all endpoints except `GET /health`
require `Authorization: Bearer <key>`.
Set `NEWSROOM_UI_INGEST_KEY` to the SvelteKit UI's `NEWSROOM_UI_INGEST_KEY`
when you want completed reports to appear in Missions.

## Agent Routing

The router returns `selected_mode`, `reason`, `tools_to_use`, `tool_budget`,
`stop_condition`, and `expected_output`. Modes are:

- `answer_from_memory` for stable newsroom guidance that does not require live
  facts.
- `custom_tool` for internal tools such as saved mission output, direct source
  URLs, PDFs/documents, and producer briefs.
- `source_monitor` for configured monitors, RSS/feed checks, official releases,
  and known source scans.
- `web_search` for broad discovery, related coverage, and what other outlets
  are reporting.
- `browser_automation` only for direct page interaction, dynamic pages, niche
  inspection, clicking, screenshots, or browser-only source inspection.
- `hybrid_research` when source/primary evidence and broader coverage are both
  needed.
- `clarification_needed` when the source, story, document, or mission target is
  missing.

Default hard budgets are:

```text
max_total_tool_calls: 6
max_custom_tool_calls: 4
max_web_searches: 3
max_browser_tasks: 2
max_runtime_seconds: 90
```

Runs stop when enough evidence exists, the budget is exhausted, a source is
blocked or unavailable, login/CAPTCHA/paywall access is required, or more
research is unlikely to materially improve the answer. The runner walks a
finite tool list; it does not free-roam.

## Evidence and Answers

Every tool result is normalized before synthesis:

```ts
{
  source_name,
  source_url,
  accessed_at,
  tool_used,
  title,
  published_at,
  extracted_text,
  summary,
  confidence,
  limitations
}
```

Final answers use evidence objects rather than raw tool output. They cite or
list sources, preserve timestamps, separate official/primary sources from media
reports, identify uncertainty and conflicts, and add police/legal cautions when
the task involves public safety, allegations, arrests, charges, or convictions.

## Adding Tools

Register tools through `ToolRegistry` using the common interface:

```ts
registry.register({
  name: 'court_filing_lookup',
  description: 'Fetch court filing metadata from the newsroom integration.',
  when_to_use: 'Use for court filing checks before broader web search.',
  category: 'custom',
  input_schema: { type: 'object' },
  output_schema: evidenceOutputSchema,
  async run(input, context) {
    return { status: 'ok', evidence: [/* normalized evidence objects */] };
  }
});
```

Prefer custom/internal tools and configured source monitors before broad web
search. Add the tool name to `NEWSROOM_AGENT_ENABLED_TOOLS` if you want an env
allow-list; leave it blank to use the default built-in tools.

## Production Service

The harness is intended to run as its own deployable service. The old
VPS/systemd deployment path has been removed, so production hosting should wire
the harness build/start commands and environment variables directly.

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
