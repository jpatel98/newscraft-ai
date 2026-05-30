# NewsCraft AI Source of Truth

Last updated: 2026-05-29

This document is the canonical project reference for the current state of the
`newscraft-ai` repository. It is meant to answer four questions in one place:

1. What is this system?
2. What can it do today?
3. How is it architected?
4. What are the known limits, contracts, and next decisions?

This file should be treated as the current source of truth when onboarding,
planning, debugging, or deciding where to make changes.

## Executive summary

NewsCraft AI is a SvelteKit application for an authenticated newsroom agent UI.
It supports conversational chat, a newsroom overview, source-aware agent
activity, standing-brief missions, editor gates, story leads, mission reports,
account management, Supabase Postgres-backed persistence, export/status tools,
and a NewsCraft-native newsroom harness.

The repo is now a small pnpm monorepo:

```text
newscraft-ai/
  src/                         SvelteKit web app
  services/newsroom-harness/   sibling agent harness service
  packages/shared/             shared gateway DTOs and SSE helpers
  drizzle/                     SvelteKit app database migrations
  scripts/                     deployment, acceptance, bridge, utility scripts
  tests/e2e/                   Playwright app smoke/e2e tests
```

The web app still exposes UI route names under `/api/agent/*` for compatibility,
but the active local target is the newsroom harness. The preferred gateway is
`AGENT_GATEWAY_URL`.

The newsroom harness is a separate Node service that listens by default on
`127.0.0.1:8650`, implements the gateway endpoints the UI needs, owns its own
SQLite database, runs scheduled missions, fetches and extracts source material,
routes editor commands to newsroom agents, tracks gates/events/memory, drafts
reports, and can post completed mission reports back into the SvelteKit UI
ingest endpoint.

## Current checkpoint

As of 2026-05-29, Phase 1/JIG-141-era work has the repo on a pushed `main`
state with these important changes in place:

- The front page is the Newsroom overview, not the old new-thread starter
  screen.
- Overview scrolling is document-level and works with the Newsroom overview
  layout.
- Mission setup no longer exposes fixed Delivery target or Output format
  fields; those are compatibility defaults behind the API.
- Editor commands route to monitor or drafting agents.
- Story-workspace editor commands can route to the Research agent, which writes
  source-backed `claim.proposed` events and fact-ledger memory entries.
- The harness starts against older local SQLite databases by repairing missing
  `workspace_id` columns before index creation.
- Structured article extraction, source adapters, archive snapshots, and
  provenance propagation are active in the harness path.
- HTML watchlist pages can now act as discovery pages: the beat monitor follows
  candidate story links, fetches the article pages, and extracts article
  metadata before pitching.
- Mission output synthesis must distinguish publication dates from retrieval
  times; missing publication metadata is not allowed to be inferred from run or
  accessed timestamps.
- Crawl-plan provenance is preserved through beat monitor pitches.

## Current product shape

### Primary user-facing surfaces

- `/` is the Newsroom overview: Ask NewsCraft command bar, monitor health,
  open gates/decision queue, story leads, active story workspaces, standing
  briefs, and activity wire.
- `/c/[id]` is an individual chat thread.
- `/missions` is the mission control surface for scheduled editorial work,
  standing-brief configuration, mission runs, source lists, and generated
  reports.
- `/settings` is the operator/admin surface for accounts, password changes,
  export, status, and destructive maintenance actions.
- `/login`, `/signup`, `/setup`, and `/account-setup/[token]` handle access and
  account setup.
- `/board`, `/channels`, and `/mission-control` are compatibility redirects to
  `/missions`.

### What the app can do today

The current app supports:

- Password-protected access with signed, httpOnly session cookies.
- First-account setup, signup through a legacy/bootstrap access code, and
  password-only invite links for additional accounts.
- Multi-account storage in the configured Supabase Postgres database.
- Chat threads with persisted messages.
- New chat creation from the sidebar, keyboard shortcut, or conversation API.
- Thread list navigation with pinned threads and date grouping.
- Rename, pin, delete, and export for conversations.
- Per-conversation system prompt overrides.
- Streaming assistant responses through a server-side gateway proxy.
- Server-side persistence of user messages, assistant messages, partial
  assistant messages, and tool/source metadata.
- Resume-after-disconnect for partial assistant responses.
- Discarding partial assistant responses.
- Regeneration by truncating a message and everything after it.
- Markdown rendering with safe HTML handling and code highlighting.
- Copy actions for messages and exported transcripts.
- Vision/image attachments in chat, serialized into the message content column.
- Client-side image resizing/compression before upload.
- Slash command parsing and discovery.
- Built-in slash commands for help, commands, reasoning, status, and profile.
- Per-thread reasoning effort via `/reasoning low|medium|high|default`.
- Command palette via `Cmd+K`.
- Sidebar search backed by persisted conversation/message records.
- Keyboard shortcuts for common chat navigation.
- Live tool activity display while the gateway is working.
- Persisted tool/source recap after a streamed response finishes.
- Source chips and source metadata for agent runs that emit source events.
- Operator footer/status checks.
- Newsroom overview with monitor health, decision queue, story leads, active
  story workspaces, standing briefs, and recent activity.
- Ask NewsCraft editor command routing to monitor, research, or drafting
  agents.
- Open gate resolution for editor decisions.
- Mission/job list, creation, editing, deletion, pause/resume, and run-now.
- Mission source configuration with URL watchlists. Attached sources are
  starting points; scheduled missions default to broad source discovery unless
  the prompt asks for official/primary-only research.
- Source-discovery rules remain backend plumbing for approved legacy plans, but
  crawl-plan review is no longer a journalist-facing Missions workflow.
- Story lead and workspace workflows seeded from monitor pitches.
- Research fact-ledger growth from story-workspace commands, including
  counter-source requests and URL-backed proposed claims with source provenance.
- Mission report ingestion and display.
- Mission run polling and active/failed run cards.
- Structured article/source extraction with provenance, archive snapshots, and
  source links suitable for citation chips.
- Mission agents ground output dates in source metadata; accessed/run times are
  retrieval metadata only.
- Supabase Postgres database status checks.
- Full account-scoped data export as JSONL.
- Per-thread export as Markdown or JSONL.
- Account-scoped database wipe with explicit confirmation.
- Production build through SvelteKit adapter-vercel.
- Hosted-platform deployment is now expected to own production deploys.
- JSON readiness checks that fail when the UI cannot reach the configured
  gateway.
- A producer acceptance loop that can run the UI against a configured Postgres
  database and the harness against an isolated local database.
- A deterministic producer smoke path using a local fixture feed.

## Architecture at a glance

```text
Browser
  |
  | SvelteKit pages and client fetches
  v
SvelteKit app on 127.0.0.1:3001
  |
  | Auth, routing, local UI persistence, exports, settings,
  | chat stream proxy, mission board adapter
  |
  +--> Supabase Postgres app DB via Drizzle
  |
  +--> agent gateway adapter
        |
        | Preferred: AGENT_GATEWAY_URL
        v
      Newsroom harness on 127.0.0.1:8650
        |
        | Chat, Responses-compatible endpoint, mission CRUD,
        | scheduled runs, source fetches, crawl plans,
        | editor gates, memory, story drafts, reports
        |
        +--> Harness SQLite DB
        |
        +--> Disciplined agent router, tool budgets, evidence model
        |
        +--> Optional OpenAI Agents SDK chat and web_search provider
        |
        +--> Optional report ingest back to SvelteKit
```

The web app owns the user interface, account/session state, local chat
transcripts, local mission configuration overlays, and mission report display.

The gateway or harness owns model execution and remote job/run execution. During
the transition, the SvelteKit server keeps existing route and type names so the UI can swap gateway implementations without a large rewrite.

## Repository layout

### Root

- `package.json` defines root scripts for the SvelteKit app, harness commands,
  test entrypoints, database migrations, deploy/reload, and acceptance testing.
- `pnpm-workspace.yaml` includes the root app, `services/*`, and `packages/*`.
- `svelte.config.js` configures SvelteKit with adapter-vercel and `$lib`.
- `vite.config.ts` configures SvelteKit/Vite and root Vitest tests.
- `drizzle.config.ts` points Drizzle at `src/lib/server/db/schema.ts`.
- `.env.example` documents root web-app and harness integration variables.
- `playwright.config.ts` defines the e2e dev server and database env wiring.
- `SOURCE_OF_TRUTH.md` is this canonical architecture/current-state document.

### `src/`

The SvelteKit web app. Important areas:

- `src/hooks.server.ts` enforces migrations, session loading, setup redirects,
  login redirects, and public route exceptions.
- `src/routes/` contains pages and API routes.
- `src/lib/server/` contains server-only auth, database, gateway, gates,
  crawl-plan, and operator status modules.
- `src/lib/components/` contains reusable Svelte UI components for chat,
  markdown, composer, command palette, tool activity, shortcuts, and system
  prompt editing.
- `src/lib/stores/chat.svelte.ts` contains live chat streaming state.
- `src/lib/utils/` contains source parsing, SSE normalization, search helpers,
  board data shaping, cron delivery helpers, and chat/thread utilities.
- `src/lib/client/stream.ts` is the browser-side stream reader for chat.
- `src/lib/types.ts` defines UI-facing app types.

### `services/newsroom-harness/`

A sibling TypeScript Node service that implements the compatible agent gateway
contract. It owns its own SQLite database and can run with or without OpenAI
configured.

Important areas:

- `src/index.ts` loads `.env.local` then `.env`, creates the server, starts it,
  and handles shutdown.
- `src/config.ts` maps environment variables into typed harness config.
- `src/server.ts` owns HTTP routing, auth, health, chat, responses, jobs, runs,
  events, gates, crawl plans, memory, editor commands, story drafts, and
  graceful close.
- `src/chat.ts` adapts runtime output into chat-completion and Responses-style
  outputs.
- `src/agents/runtime.ts` is the model/runtime abstraction, using OpenAI Agents
  SDK when configured and deterministic fallbacks otherwise.
- `src/agents/roles.ts` defines newsroom-oriented role prompts.
- `src/agents/beat-monitor.ts` turns watchlists and approved crawl plans into
  pitch gates and story-lead events, hydrating discovered listing/feed items by
  fetching the candidate article pages when available.
- `src/agents/editor-command.ts` routes Ask NewsCraft/editor commands to the
  monitor, research, or drafting agent.
- `src/agents/research.ts` handles story-workspace research commands, ad-hoc
  source scrapes, `claim.proposed` events, and fact-ledger memory updates.
- `src/agents/drafting.ts` drafts story artifacts from accepted pitch facts.
- `src/crawl-plans/executor.ts` executes approved crawl plans and preserves
  source provenance for downstream pitches.
- `src/jobs/scheduler.ts` polls due jobs.
- `src/jobs/runner.ts` executes runs and updates state.
- `src/jobs/report.ts` creates and optionally ingests reports.
- `src/jobs/schedule.ts` parses interval and simple cron schedules.
- `src/db/database.ts` creates the harness tables and applies idempotent legacy
  workspace-column repair for older SQLite databases.
- `src/db/repository.ts` contains job, run, source, snapshot, report, event,
  gate, crawl-plan, and memory persistence.
- `src/tools/sources.ts`, `src/tools/source-adapters/*`,
  `src/tools/article-extraction.ts`, and `src/tools/polite-fetch.ts` fetch and
  extract source material while preserving provenance. HTML adapters separate
  listing-page discovery from standalone article extraction.

### `packages/shared/`

Shared TypeScript package used by the web app and harness.

It contains:

- Gateway chat/request/response DTOs.
- Gateway health DTOs.
- Job, run, source, and report DTOs.
- Gate, event, crawl-plan, memory, and story draft DTOs.
- SSE framing helpers.
- Chat-completion delta helpers.
- agent tool/source event frame helpers.

### `drizzle/`

Migration history for the SvelteKit app database. The live schema is declared in
`src/lib/server/db/schema.ts`; migrations are generated and applied through the
root `db:generate` and `db:migrate` scripts.

### `scripts/`

Important scripts include:

- `scripts/hash-password.mjs` for creating an Argon2 password hash.
- `local command registry` for older agent command/skill metadata.
- `scripts/check-health.mjs` for JSON readiness validation.
- `scripts/producer-acceptance.mjs` for end-to-end producer acceptance against
  a configured app database and isolated harness database.

## Runtime architecture

### SvelteKit app runtime

The web app is a SvelteKit 2 / Svelte 5 app built with adapter-vercel.

Key runtime properties:

- Hosted production output is produced by the Vercel adapter.
- The expected local/prod UI port in this repo is `3001`.
- The app stores UI/account/conversation state in Supabase Postgres through
  Drizzle.
- Local development does not require a local Homebrew/Docker Postgres process.
- Migrations are applied on server startup from `src/hooks.server.ts`.
- The UI server talks to an agent gateway through server-only fetch calls.
- `/api/health` is a readiness endpoint. It returns JSON and uses a non-2xx
  status when the app DB quick check fails or the configured gateway is not
  healthy.

### Newsroom harness runtime

The harness is a Node HTTP service, not embedded in SvelteKit.

Key runtime properties:

- Default host: `127.0.0.1`.
- Default port: `8650`.
- Default DB path: `.data/newsroom-harness.db`.
- Optional bearer auth through `NEWSROOM_HARNESS_API_KEY`.
- `GET /health` is public.
- `GET /health` returns JSON readiness details for database, scheduler, ingest,
  OpenAI configuration, runtime limits, version, and uptime.
- All other endpoints require the API key if configured.
- It creates its schema directly on startup.
- It starts a process-local scheduler unless explicitly disabled by tests.
- It closes the scheduler and database on server close.

### Gateway selection

The web app chooses the agent gateway in `src/lib/server/agent/transport.ts`.

Selection order:

1. `AGENT_GATEWAY_URL`
2. `http://127.0.0.1:8650`

Gateway API key selection:

1. `AGENT_GATEWAY_API_KEY`
2. `NEWSROOM_HARNESS_API_KEY`
3. _none (URL-only auth is allowed)_

When using `AGENT_GATEWAY_URL`, the key can be empty if the harness does not
require one.

## Data model

### SvelteKit app database

The app database is configured by `DATABASE_URL`. In current NewsCraft
development this is a server-only Supabase Postgres connection string. Prefer
the Supabase session pooler when IPv4 is required; use the direct connection
only from networks that can route to the direct Supabase host.

Current logical tables:

- `accounts`
- `conversations`
- `messages`
- `settings`
- `agent_channel_posts`
- `agent_channel_configs`
- `agent_channel_sources`
- `missions`
- `mission_sources`
- `mission_crawl_plans`
- `mission_runs`
- `mission_reports`

#### `accounts`

Stores local accounts:

- Email and display name.
- Optional Argon2id password hash.
- Optional setup token hash and expiry.
- Created/updated/last-login timestamps.

Current login is password-oriented. Some account helpers support email/name and
invite flows, but the visible app path uses password-only setup/invite behavior.

#### `conversations`

Stores chat threads:

- Account ownership.
- Title.
- Optional system prompt override.
- Created/updated timestamps.
- Pinned flag.

Conversations are always account-scoped.

#### `messages`

Stores chat messages:

- Conversation ownership.
- Role: `user`, `assistant`, `system`, or `tool`.
- Content.
- Optional persisted tool/source metadata.
- Partial flag for incomplete assistant responses.
- Created timestamp.

Plain text content is stored directly. Multimodal content arrays are serialized
with a sentinel prefix so existing plain rows remain cheap to read. Tool/source
metadata is serialized as a versioned envelope containing tool calls and sources.

#### `settings`

Stores key/value operational settings. Currently used for values such as:

- Migrated legacy password hash.
- Hidden mission/channel job ids.

#### Mission/report tables

Mission-related tables support the migration from older agent channel naming
to NewsCraft-native missions.

- `missions` stores account-scoped mission config overlays.
- `mission_sources` stores URL watchlist entries for missions.
- `mission_crawl_plans` stores approved/discarded crawl-plan versions and
  execution metadata for mission source discovery.
- `mission_runs` exists in the app schema for local run state, though current
  run execution is primarily gateway/harness-driven.
- `mission_reports` stores generated markdown report summaries and full report
  bodies with markdown as the current fixed output format.
- `agent_channel_configs`, `agent_channel_sources`, and
  `agent_channel_posts` are legacy compatibility tables.

The read paths intentionally fall back from the newer mission tables to legacy
Agent channel tables when needed.

### Harness database

The harness database is configured by `NEWSROOM_HARNESS_DB_PATH`.

Current harness tables:

- `jobs`
- `runs`
- `run_steps`
- `tool_calls`
- `source_snapshots`
- `sources`
- `reports`
- `events`
- `gates`
- `house_memory`
- `memory_entries`

On startup the harness creates missing tables and repairs older SQLite
databases by adding `workspace_id` to legacy `jobs`, `events`, `gates`, and
`memory_entries` tables before creating indexes. This keeps existing local
databases from failing startup when newer workspace-scoped queries run.

#### `jobs`

Stores scheduled mission definitions:

- Name.
- Description.
- Prompt.
- Schedule.
- Enabled flag.
- Next run.
- Last run/status/error/delivery error.
- Compatibility delivery target.
- Compatibility output format, currently defaulting to `markdown`.
- Created/updated timestamps.

Delivery target and output format remain stored for gateway/API compatibility,
but they are not visible mission setup controls. Current product behavior is a
fixed database/dashboard delivery path with markdown/text report bodies rendered
by the app.

#### `runs`

Stores mission run lifecycle:

- Job id.
- Status.
- Trigger.
- Queued/started/completed/updated timestamps.
- Elapsed time.
- Last error.

#### `source_snapshots` and `sources`

Store fetched source provenance:

- URL.
- Title.
- Fetch timestamp.
- Content text.
- Content hash.
- Content type/status.
- Snippet.
- Summary.
- Whether the source was used.

#### `reports`

Stores generated mission reports:

- Run id.
- Job id.
- Report title.
- Markdown body.
- Created timestamp.
- UI ingest status and error.

#### `events`

Stores append-only newsroom activity:

- Workspace, story, job, and run scope.
- Agent and event kind.
- Payload and source metadata JSON.
- Optional parent event and cost metadata.
- Created timestamp.

Updates and deletes are blocked by SQLite triggers.

#### `gates`

Stores editor decision queue items:

- Workspace, story, job, and run scope.
- Gate type, title, summary, priority, status, and actions.
- Creator and creation timestamp.
- Resolution action, notes, payload, resolver, and resolved timestamp.

The overview uses open gates as the decision queue.

#### `house_memory` and `memory_entries`

Store newsroom memory:

- `house_memory` stores current house-level key/value state.
- `memory_entries` appends immutable house, beat, and story memory entries.
- Beat and story memory can be inspected by agents and editor commands.

## Authentication and authorization

### Session cookies

The app uses a signed `agent_sess` cookie.

Cookie properties:

- httpOnly.
- SameSite `lax`.
- Secure only when `NODE_ENV=production`.
- Path `/`.
- 30 day max age.

The cookie payload contains:

- Version.
- Issued-at timestamp.
- Random token id.
- Account id subject.

The payload is HMAC-signed with `APP_SESSION_SECRET`, which must be base64 and
decode to at least 32 bytes.

### Passwords

Passwords are hashed with Argon2id using `@node-rs/argon2`.

The app also maintains an in-memory brute-force defense:

- 5 failed attempts.
- 30 second lockout.
- Per-key tracking based on client address or route-specific setup/signup key.
- State resets on process restart.

### Public paths

The server hook allows these public paths:

- `/login`
- `/signup`
- `/setup`
- `/api/health`
- `/api/agent/channel-posts`
- `/account-setup/*`

All other app routes require a valid session.

### First-account behavior

If no accounts exist:

- Most routes redirect to `/setup`.
- `/setup` creates the first password-only account.
- If a legacy password hash exists, setup requires that bootstrap password.
- The first account claims orphaned local data where supported by the account
  helper layer.

### Additional accounts

Logged-in users can create password-only invites from settings. The server
returns a setup URL with a token. The invited user claims the token on
`/account-setup/[token]`.

## Chat architecture

### Browser flow

The chat UI lives primarily in:

- `src/routes/+page.svelte`
- `src/routes/c/[id]/+page.svelte`
- `src/lib/components/Composer.svelte`
- `src/lib/components/Thread.svelte`
- `src/lib/client/stream.ts`
- `src/lib/stores/chat.svelte.ts`

For a normal send:

1. User submits text or multimodal content through `Composer`.
2. The page creates optimistic overlay user/assistant messages.
3. The browser posts to `/api/chat/stream`.
4. `src/lib/client/stream.ts` reads SSE events.
5. Deltas update the live assistant overlay.
6. Tool/source events update `chat` store state.
7. When the stream ends, the page invalidates SvelteKit data.
8. Persisted messages replace the overlay.

### Server flow

The server streaming endpoint is `/api/chat/stream`.

Responsibilities include:

- Validating the logged-in account.
- Creating a conversation if one is not supplied.
- Loading prior messages.
- Applying the conversation-level system prompt.
- Handling slash commands.
- Handling regenerate and resume modes.
- Persisting the new user message when appropriate.
- Creating or reusing an assistant message row.
- Proxying to the gateway through `streamChatCompletion` or `streamResponse`.
- Parsing gateway SSE frames.
- Persisting assistant deltas.
- Capturing tool/source metadata.
- Finalizing or leaving partial assistant messages.
- Emitting metadata and title events back to the browser.

### Streaming and events

The app supports several event shapes:

- OpenAI-compatible `chat.completion.chunk` deltas.
- Responses-style output events.
- agent `agent.tool.progress` events.
- agent source events.
- App-local `agent.meta` events.
- App-local title update events.

`src/lib/utils/stream-events.ts` normalizes this into:

- Text deltas.
- Tool starts/progress/completions.
- Source updates.
- Done/failure/title updates.

### Partial responses and recovery

If a stream is interrupted:

- The assistant row can remain marked `partial`.
- The UI displays resume/discard affordances.
- Resume streams additional deltas into the same persisted assistant row.
- Discard clears the partial flag without generating more text.

If the user aborts a long-running stream and chooses to use a partial answer, the
client can save an assistant note explaining that no usable draft was available
if the gateway had not produced text yet.

### Tool/source persistence

Live tool activity is ephemeral while a stream is running. At the end of a
stream, normalized tool calls and sources are serialized onto the assistant
message in a versioned metadata envelope. This lets the thread render a
completed recap after reload without replaying live events.

## Mission architecture

Mission functionality is implemented as a compatibility layer around gateway
jobs/runs plus local app overlays.

The operational front door is `/`: newsroom overview, Ask NewsCraft, gates,
story leads, workspaces, standing briefs, and activity. `/missions` remains the
configuration/admin surface for standing briefs, watchlists, crawl plans, runs,
and reports.

### UI concepts

In the UI, a mission is a recurring newsroom task with:

- Name.
- Description.
- Prompt.
- Schedule.
- Enabled/paused state.
- URL sources/watchlist.
- Approved crawl plans.
- Recent runs.
- Generated reports.

Delivery target and output format are intentionally not shown in mission setup.
Current behavior is fixed: outputs are stored in the database/dashboard path and
rendered as markdown/text by the app.

The UI currently uses `/missions` as the canonical route. Older `/board`,
`/channels`, and `/mission-control` routes redirect there.

### Web app mission API

The SvelteKit API routes under `/api/agent/*` provide the UI contract:

- `GET /api/agent/board`
- `GET /api/agent/jobs`
- `POST /api/agent/jobs`
- `PATCH /api/agent/jobs/[id]`
- `DELETE /api/agent/jobs/[id]`
- `POST /api/agent/jobs/[id]` actions such as run/pause/resume depending on
  request shape.
- `GET /api/agent/reports/[id]`
- `POST /api/agent/channel-posts`
- `DELETE /api/agent/channels/[jobId]`
- `POST /api/agent/editor-command`
- `GET /api/agent/commands`
- `GET /api/agent/skills`
- `GET /api/agent/skills/[slug]`

The server adapter normalizes many possible upstream job/run shapes into the UI
types `AgentJob`, `AgentRun`, `BoardChannel`, and `BoardPost`.

### Mission config overlays

The gateway owns the actual job. The SvelteKit app stores additional
account-scoped mission metadata and source configuration locally.

This matters because the compatibility gateway contract does not necessarily
have first-class fields for every UI concept. The app compiles the local source
watchlist into the prompt sent to the gateway while preserving the original base
prompt locally.

### Source watchlists

Only URL sources are configurable from mission setup right now.

Source behavior:

- URL must be `http://` or `https://`.
- Source has name, URL, enabled flag, and sort order.
- Enabled sources are appended to the base prompt under
  `## Configured Watchlist`.
- Disabled sources remain stored but are not included in the compiled prompt.

### Crawl plans

Mission crawl plans are source-discovery plans proposed by the monitor workflow
and approved or discarded by an editor. Approved versions can be executed by the
harness. Execution preserves provenance such as discovered/fetched timestamps,
content type, status code, content hash, archive snapshot, and extraction
metadata so downstream pitches can carry their source trail.

### Editor commands and gates

Ask NewsCraft/editor commands are posted through the SvelteKit
`/api/agent/editor-command` route and forwarded to the harness
`/api/editor-commands` endpoint. The harness routes commands to the monitor,
research, or drafting agent based on command context and target agent hints.

Research owns fact-ledger growth in story workspaces. Story-context commands
such as "find a counter-source on claim 3" create Research events tied to the
referenced claim. Story-context URL commands fetch/extract the source, preserve
source provenance and hash metadata, emit a source-backed `claim.proposed`
event, and append the proposed claim to story memory under `fact_ledger`.

Open gates are editor decision items. The overview presents them as the
decision queue; resolving a gate records the resolution and lets follow-on
agent workflows continue from the accepted/rejected action.

### Reports

Mission reports are markdown documents stored in `mission_reports`.

Mission runs that execute the Beat Monitor / Standing Brief path also save a
mission report. The report summarizes sources scanned, pitch gates queued, lead
candidates, and the human review action so the mission page has visible output
even when the primary agent artifact is an editor gate.

The harness writes reports in a parseable board format:

```md
# Cron Job: Mission name
**Job ID:** job_...
**Run Time:** 2026-05-18T...
**Schedule:** every 180m

## Response
...
```

The UI ingest endpoint accepts either `responseMarkdown` or `markdown`, parses
metadata, resolves the mission account id, and upserts the report.

The Missions board also reads saved reports from the harness `/api/reports`
endpoint for the user's live mission ids. This keeps output visible when the
harness has stored the report but UI ingest is not configured or has not
completed.

### Run cards

The board builder combines:

- Gateway jobs.
- Gateway runs.
- Local mission reports.
- Harness mission reports.
- Hidden/deleted channel ids.

It builds channels and posts, including synthetic posts for queued, running, or
failed runs that have not yet produced a saved markdown report.

Stale active run rows are not allowed to block manual runs indefinitely. The
harness marks old `queued`/`running` rows failed when the runner no longer has
active execution for them, and the Missions UI ignores active-looking run rows
that have not had activity within its freshness window.

## Newsroom harness architecture

### API contract

The harness currently implements:

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
- `GET /api/events`
- `GET /api/gates`
- `POST /api/gates`
- `GET /api/gates/:id`
- `POST /api/gates/:id/resolve`
- `GET /api/crawl-plans?beat_id=...`
- `POST /api/crawl-plans`
- `GET /api/crawl-plans/:id?beat_id=...`
- `POST /api/crawl-plans/:id/execute?beat_id=...`
- `POST /api/editor-commands`
- `GET /api/memory/house`
- `PATCH /api/memory/house`
- `GET /api/memory/beats/:id`
- `POST /api/memory/beats/:id`
- `GET /api/memory/stories/:id`
- `POST /api/memory/stories/:id`
- `POST /api/stories/:id/drafts/web-story`

These endpoints are shaped to satisfy the existing SvelteKit adapter and UI.

### Chat behavior

The harness chat endpoint supports streaming and non-streaming chat-completion
style responses. It emits agent tool progress frames around runtime
execution so the existing UI can display assignment/routing activity.

When `OPENAI_API_KEY` is present, chat can use the OpenAI Agents SDK and the
disciplined agent can use OpenAI `web_search` for broad discovery. Without it,
deterministic local fallbacks keep development and tests runnable.

### Responses behavior

The harness also implements `/v1/responses` for clients that use a
Responses-style shape. The web app can fall back to this path where needed.

### Scheduler behavior

The scheduler is intentionally conservative and process-local in v1.

Supported schedule forms include:

- `hourly`
- `daily`
- `every 10s`
- `every 15m`
- `every 2h`
- `every 1d`
- Simple five-field cron schedules where minute/hour matching is enough for the
  current implementation.

If parsing fails, the scheduler falls back to roughly one hour from the base
time.

### Source fetching

The harness source tools now use `politeFetch`, source adapters, and structured
article extraction.

Current adapter coverage:

- RSS.
- Atom.
- Sitemap.
- Web search.
- PR/newswire style feeds.
- PDF.
- Bluesky.
- HTML article pages.

Stored/propagated source evidence includes:

- Adapter and source URL.
- Discovered and fetched timestamps.
- Content type and status code.
- Content hash.
- Archive snapshot metadata when available.
- ETag and last-modified headers when available.
- Title, description, canonical URL, site name, publish/update times, authors,
  image, section, keywords, structured type, and metadata source hints.
- Readable text, snippet, summary, extraction method, and source/canonical
  provenance.

This is now more than a lightweight fetch layer, but it is still not a complete
paywall, credibility-scoring, or comprehensive dedupe system.

### Source discovery behavior

Scheduled missions default to broad discovery across reputable media and
configured sources. Official and primary sources are labeled separately from
media reports. The agent should restrict itself to official/primary sources
only when the mission prompt explicitly asks for that.

The backend still supports approved source-discovery rules for legacy/advanced
flows. Those rules combine seed URLs, source fetch/extraction output, and beat
memory to create pitch gates with preserved provenance, but they are not exposed
as a primary Missions-page workflow.

### Report delivery back to UI

If these harness env values are configured:

- `NEWSROOM_UI_INGEST_URL`
- `NEWSROOM_UI_INGEST_KEY`

then completed mission reports are posted back to the SvelteKit UI endpoint:

```text
POST /api/agent/channel-posts
Authorization: Bearer <NEWSROOM_UI_INGEST_KEY>
```

The ingest key must match the UI's `NEWSROOM_UI_INGEST_KEY`.

## Important environment variables

### Web app network

```sh
PORT=3001
HOST=127.0.0.1
PROTOCOL_HEADER=x-forwarded-proto
HOST_HEADER=x-forwarded-host
```

`ORIGIN` is intentionally optional. The app can derive URL information from
hosted platform or reverse proxy headers.

### Gateway integration

```sh
AGENT_GATEWAY_URL=http://127.0.0.1:8650
AGENT_GATEWAY_API_KEY=
NEWSROOM_UI_INGEST_KEY=
```

`AGENT_GATEWAY_URL` points to the NewsCraft-native harness.

### App auth

```sh
APP_SESSION_SECRET=
APP_PASSWORD_HASH=
```

`APP_SESSION_SECRET` is required for sessions. `APP_PASSWORD_HASH` is optional
legacy/bootstrap config and is copied into settings on first migration when no
stored hash exists.

### App persistence

```sh
DATABASE_URL=<Supabase Postgres connection string>
```

Keep the real direct or pooler URL out of docs and commits. Store it in
`.env.local` for local development or in the hosted platform's secret store.

### Harness

```sh
NEWSROOM_HARNESS_HOST=127.0.0.1
NEWSROOM_HARNESS_PORT=8650
NEWSROOM_HARNESS_DB_PATH=.data/newsroom-harness.db
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

All of these are represented in the example env files. The timeout, tool-call,
retry, scheduler interval, source priority, and agent tool values are supported
by `services/newsroom-harness/src/config.ts`.

## Commands

### Install

```sh
corepack pnpm install
```

If `corepack` is unavailable but `pnpm` is installed, use `pnpm` directly. The
package scripts call `pnpm` internally for workspace commands.

### Web app development

```sh
corepack pnpm dev
```

Run the web app and newsroom harness together:

```sh
corepack pnpm dev:all
```

The local web app dev server uses `127.0.0.1:3001`; the harness uses
`127.0.0.1:8650`.

If an old NewsCraft dev run is occupying either port, stop it with:

```sh
corepack pnpm dev:stop
```

### Harness development

```sh
corepack pnpm dev:harness
```

Equivalent filtered command:

```sh
corepack pnpm --filter @newscraft/newsroom-harness dev
```

### Build

```sh
corepack pnpm build
corepack pnpm build:harness
```

### Start production build

```sh
corepack pnpm start
```

### Type/check/test

```sh
corepack pnpm check
corepack pnpm test
corepack pnpm test:harness
corepack pnpm --filter @newscraft/newsroom-harness test -- tests/database.test.ts
corepack pnpm test:e2e
```

The root `test` script runs root Vitest tests, shared package tests, and harness
tests. The e2e script uses Playwright. Use the filtered harness command when
running a single harness test file by path.

### Database migrations

```sh
corepack pnpm db:generate
corepack pnpm db:migrate
```

### Password hash

```sh
corepack pnpm hash-password
```

### Producer acceptance

```sh
corepack pnpm producer:acceptance
```

Deterministic local smoke mode:

```sh
corepack pnpm smoke:producer:fixture
```

The producer acceptance loop:

- Loads root `.env.local`.
- Loads `services/newsroom-harness/.env.local`.
- Starts the harness on `127.0.0.1:8650`.
- Starts the UI on `127.0.0.1:3001`.
- Uses an isolated harness SQLite database under `.tmp/producer-acceptance` and
  the app Supabase Postgres database from `PRODUCER_ACCEPTANCE_DATABASE_URL` or
  `DATABASE_URL`.
- Validates public RSS feeds or deterministic fixtures.
- Creates a local test account.
- Creates and runs a producer-style mission.
- Verifies the completed report in Missions.
- Checks harness persistence and UI ingest.
- Exercises pause/resume.
- Checks chat streaming for non-empty output without adjacent duplicate chunks.

By default it requires live OpenAI configuration. Use
`PRODUCER_ACCEPTANCE_REQUIRE_OPENAI=0` only for fallback-path testing.

### Production deploy

```sh
corepack pnpm health:harness
corepack pnpm health:agent
```

The old VPS/systemd/Caddy deployment commands have been removed. Production
deploys should be owned by the selected hosted platform, with the UI and
harness configured as explicit deployable services.

## Frontend details

### Design system

The app uses custom styles in:

- `src/lib/styles/foundations.css`
- `src/lib/styles/components.css`

The visual language is NewsCraft-specific: cream/ink/cobalt tokens, dark
sidebar, cream main pane, mono metadata, sharp geometry, Lucide icons, and light
plus system dark behavior.

### Layout

`src/routes/+layout.svelte` owns:

- Global stylesheet imports.
- Sidebar shell.
- Conversation list.
- Mission list shortcuts.
- Mobile drawer behavior.
- Command palette state.
- Keyboard shortcut component.
- System prompt editor.
- Operator footer status polling.

The layout loads current user, recent conversations, and board channels from
`src/routes/+layout.server.ts`.

### Composer

The composer supports:

- Text input.
- Send on Enter.
- Newline with Shift+Enter.
- Last-message recall through keyboard store integration.
- Slash command recognition.
- Image attachments.
- Client-side image resizing/compression.

### Thread

The thread renders:

- User and assistant messages.
- Markdown.
- Streaming state.
- Partial response banners.
- Resume/discard actions.
- Copy/regenerate affordances.
- Tool activity.
- Persisted source/tool recap.

### Markdown

Markdown rendering uses:

- `marked`
- `dompurify`
- Lazy Shiki highlighting after rendering.

The renderer wraps code blocks with a copy-friendly shell and avoids doing
expensive highlighting during token streaming.

### Command palette and shortcuts

Supported shortcuts include:

- `Cmd+K`: command palette.
- `Cmd+B`: sidebar drawer toggle.
- `Cmd+Shift+O`: new thread.
- `Cmd+/`: shortcut help.
- `Cmd+[` and `Cmd+]`: previous/next thread.
- `Esc`: abort current reply or close help.
- `ArrowUp` in an empty composer: recall last user message.

## API route reference

### Public/auth routes

- `POST /logout`
- `/login`
- `/signup`
- `/setup`
- `/account-setup/[token]`

### Conversation routes

- `POST /api/conversations`
- `PATCH /api/conversations/[id]`
- `DELETE /api/conversations/[id]`
- `POST /api/conversations/[id]/assistant-note`
- `GET /api/conversations/[id]/export?format=md`
- `GET /api/conversations/[id]/export?format=jsonl`

### Message routes

- `POST /api/messages/[id]/clear-partial`
- `DELETE /api/messages/[id]/onwards`

### Chat/search routes

- `POST /api/chat/stream`
- `POST /api/search`

### Settings/maintenance routes

- `GET /api/settings/status`
- `GET /api/settings/export`
- `POST /api/settings/wipe-db`
- `POST /api/settings/accounts`
- `DELETE /api/settings/accounts/[id]`
- `POST /api/settings/password`

### Gateway/mission routes

- `GET /api/health`
- `GET /api/operator/status`
- `GET /api/agent/board`
- `GET /api/agent/jobs`
- `POST /api/agent/jobs`
- `PATCH /api/agent/jobs/[id]`
- `POST /api/agent/jobs/[id]`
- `DELETE /api/agent/jobs/[id]`
- `GET /api/agent/reports/[id]`
- `POST /api/agent/channel-posts`
- `DELETE /api/agent/channels/[jobId]`
- `POST /api/agent/editor-command`
- `GET /api/agent/commands`
- `GET /api/agent/skills`
- `GET /api/agent/skills/[slug]`

## Testing and verification assets

Current test coverage includes:

- Root Vitest tests under `src/**/*.test.ts`.
- Shared package tests.
- Harness Vitest tests.
- Playwright e2e tests under `tests/e2e`.
- Producer acceptance script for a fuller UI + harness workflow.

Notable tested utility areas visible in the repo:

- Account database behavior.
- Mission report database behavior.
- Harness database schema creation, idempotency, and legacy `workspace_id`
  repair.
- Agent bridge and transport behavior.
- Editor command routing.
- Reasoning command behavior.
- Board data shaping.
- Channel source normalization.
- Open gates, story leads, and active story workspace shaping.
- Crawl-plan execution and provenance preservation.
- Cron delivery helpers.
- Run polling.
- Search dedupe/snippets.
- Source adapters and structured article extraction.
- Slash commands.
- SSE parsing.
- Thread message projection.
- Tool labels and metadata.
- Harness runtime and server behavior.

## Current limitations

### Naming and compatibility

- Many route, file, and type names still say `Agent` even when the target is
  the NewsCraft-native harness.
- This is intentional during the compatibility phase.
- A later cleanup can rename the adapter layer to `agent-gateway` once the
  harness path is stable.

### Harness scheduler

- Scheduler state is process-local.
- Scheduled jobs only run while the harness process is alive.
- There is no distributed scheduler or durable worker queue yet.

### Cron support

- Interval schedules and simple five-field cron schedules are supported.
- Cron parsing is intentionally conservative.
- Unsupported cron shapes fall back to a future default rather than failing
  hard.

### Source extraction

- URL sources are the only configured mission source type.
- RSS, Atom, sitemap, web search, PR/newswire, PDF, Bluesky, and HTML article
  adapters are supported.
- Structured article extraction and provenance preservation exist, but paywall
  handling, source credibility scoring, and comprehensive dedupe are not yet
  complete systems.

### Publishing

- The system drafts reports and stores/displays them.
- It does not publish to a CMS.
- It does not write to external newsroom systems beyond optional ingest back to
  the UI.
- Delivery/output format controls are fixed defaults in the current product,
  not user-selectable publishing channels.
- Human review remains required for editorial decisions.

### Auth/admin model

- The app supports multiple local accounts, but there is no role/permission
  hierarchy yet.
- Any logged-in account can currently access settings-style app functionality
  exposed by the UI/API unless restricted elsewhere later.

### Password/login model

- Login is password-only in the visible flow.
- Account emails/names exist in the schema and helper types, but current signup
  paths create generated password-only accounts.

### Search

- FTS search exists for conversations/messages.
- Multimodal messages serialize content arrays into a text column, so image
  messages can create noisy text if indexed directly.

### Virtualization

- Long chat thread virtualization is still not implemented.
- The plan notes `virtua/svelte` once conversations cross roughly 50 messages.

### Deployment

- The old VPS/systemd/Caddy deployment path has been removed.
- Production deploys should be owned by the selected hosted platform.
- The UI and harness are separate deployable services even though they live in
  one repo.

### Budgeting and guardrails

- Harness config exposes timeout, max tool calls, and retry limit.
- Richer agent budget controls, audit trails, cancellation UX, approval queues,
  and role-based editorial permissions are still future work. Basic gate
  creation/resolution exists, but it is not a full permission model.

## Operational notes

### Local development path

Typical local setup:

1. Install dependencies.
2. Start the harness in one terminal.
3. Start the SvelteKit app in another terminal.
4. Point the UI at the harness with `AGENT_GATEWAY_URL=http://127.0.0.1:8650`.
5. Set `AGENT_GATEWAY_API_KEY` only if the harness requires
   `NEWSROOM_HARNESS_API_KEY`.

### Production path

The current production path is platform-owned:

- UI deployable: the SvelteKit app at the repo root.
- Harness deployable: `services/newsroom-harness`.
- Shared package: `packages/shared`, built before the harness.
- `APP_SESSION_SECRET` must be configured for the UI.
- `NEWSROOM_HARNESS_API_KEY`, `AGENT_GATEWAY_API_KEY`, and `NEWSROOM_UI_INGEST_KEY`
  should be aligned when bearer auth and report ingest are enabled.

The repo no longer carries VPS cutover, systemd, or reverse-proxy scripts.

### Backups

The SvelteKit app no longer creates local SQLite backups. App database backups
are owned by Supabase or the configured deployment platform. The app keeps
conversation and account export endpoints for operator-controlled data export.

## Implementation hotspots

When making changes, these are the usual files to know first.

### Chat

- `src/routes/api/chat/stream/+server.ts`
- `src/lib/server/agent/transport.ts`
- `src/lib/client/stream.ts`
- `src/lib/utils/stream-events.ts`
- `src/lib/stores/chat.svelte.ts`
- `src/routes/c/[id]/+page.svelte`
- `src/lib/components/Composer.svelte`
- `src/lib/components/Thread.svelte`
- `src/lib/components/ToolActivity.svelte`

### Conversations and search

- `src/lib/server/db/conversations.ts`
- `src/routes/api/conversations/+server.ts`
- `src/routes/api/conversations/[id]/+server.ts`
- `src/routes/api/search/+server.ts`
- `src/lib/utils/search-dedupe.ts`
- `src/lib/utils/search-snippets.ts`

### Auth/accounts/settings

- `src/hooks.server.ts`
- `src/lib/server/auth/cookie.ts`
- `src/lib/server/auth/password.ts`
- `src/lib/server/db/accounts.ts`
- `src/routes/settings/+page.svelte`
- `src/routes/api/settings/*`

### Missions

- `src/routes/+page.svelte`
- `src/routes/missions/+page.svelte`
- `src/lib/server/agent/board.ts`
- `src/lib/server/agent/gates.ts`
- `src/lib/server/agent/crawl-plans.ts`
- `src/lib/server/agent/crawl-plan-sync.ts`
- `src/lib/server/db/missions.ts`
- `src/lib/server/db/mission-reports.ts`
- `src/lib/utils/board.ts`
- `src/lib/utils/channel-sources.ts`
- `src/lib/utils/cron-delivery.ts`
- `src/lib/utils/run-poll.ts`
- `src/routes/api/agent/editor-command/+server.ts`
- `src/routes/api/agent/*`

### Harness

- `services/newsroom-harness/src/server.ts`
- `services/newsroom-harness/src/chat.ts`
- `services/newsroom-harness/src/agents/beat-monitor.ts`
- `services/newsroom-harness/src/agents/drafting.ts`
- `services/newsroom-harness/src/agents/editor-command.ts`
- `services/newsroom-harness/src/agents/runtime.ts`
- `services/newsroom-harness/src/crawl-plans/executor.ts`
- `services/newsroom-harness/src/jobs/runner.ts`
- `services/newsroom-harness/src/jobs/scheduler.ts`
- `services/newsroom-harness/src/jobs/report.ts`
- `services/newsroom-harness/src/db/database.ts`
- `services/newsroom-harness/src/db/repository.ts`
- `services/newsroom-harness/src/tools/article-extraction.ts`
- `services/newsroom-harness/src/tools/polite-fetch.ts`
- `services/newsroom-harness/src/tools/source-adapters/*`
- `services/newsroom-harness/src/tools/sources.ts`
- `packages/shared/src/*`

## Suggested future source-of-truth maintenance

Keep this file current when any of these change:

- New route or major page.
- New environment variable.
- Database schema or migration.
- Gateway contract.
- Harness endpoint.
- Mission lifecycle behavior.
- Auth/session/account behavior.
- Deployment process.
- Production limitation removed or newly discovered.

Recommended rule: if a teammate would need to read code to answer "what does
the system do now?", update this document in the same change.
