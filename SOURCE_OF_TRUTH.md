# NewsCraft AI — Source of Truth

Last updated: 2026-06-06

This is the single canonical document for NewsCraft AI. It describes what the
product is, how it is built today, and how to work on it. If any other file
conflicts with this one, this file wins. There is intentionally only one doc.

---

## What It Is

NewsCraft AI is a **solo news-producer tool**. Not a team editorial system, not a
publishing pipeline, not a multi-agent verification workflow. It is two things:

1. **Story tracker** — give it a topic, region, or story. A research agent (with
   sub-agents) gathers what it can find — web search, social, configured source
   URLs — and you check back to see what's new.
2. **Newsroom-smart chat** — a general chat agent with the same research tools.
   Ask it things, get clean formatted answers: a short paragraph and links, not a
   tool trace or system log.

Everything from the old "newsroom of agents" design — gates, editor decision
queues, verification/copy/packaging agents, delivery adapters, crawl plans, story
workspaces, beat-monitor pitching, house memory, citation graph — has been **cut**.
If a real multi-user newsroom product is ever needed, it gets rebuilt for that.

---

## Current State (what actually ships)

### UI (SvelteKit, `127.0.0.1:3001`)

Tracked routes currently expose:

- `/` — Story Tracker landing (hero + composer). Starter prompts funnel research
  into a chat thread. Title is "Stories · NewsCraft".
- `/c/[id]` — chat thread. Sidebar lists recent threads (pinned / today /
  yesterday / last 7 days / earlier), rename, search.
- `/settings` — account + app settings.
- `/login`, `/signup`, `/setup`, `/account-setup/[token]` — auth/setup pages.
- `/logout` — auth sign-out endpoint.

No tracked page routes exist beyond the routes above. Legacy page route
directories from the cut design are gone. `ENABLE_MISSIONS` no longer exists in
the code.

### App API (SvelteKit)

Tracked API routes currently expose:

- Chat/conversations: `/api/chat/stream`, `/api/conversations`,
  `/api/conversations/[id]`, `/api/conversations/[id]/assistant-note`,
  `/api/conversations/[id]/export`, `/api/conversations/[id]/title`,
  `/api/messages/[id]/clear-partial`, `/api/messages/[id]/onwards`,
  `/api/search`.
- Agent bridge / Story Tracker internals: `/api/agent/commands`,
  `/api/agent/skills`, `/api/agent/skills/[slug]`, `/api/agent/jobs`,
  `/api/agent/jobs/[id]`, `/api/agent/jobs/[id]/run`,
  `/api/agent/jobs/[id]/pause`, `/api/agent/jobs/[id]/resume`,
  `/api/agent/channel-posts`.
- Health/settings/admin: `/api/health`, `/api/settings/status`,
  `/api/settings/export`, `/api/settings/password`, `/api/settings/accounts`,
  `/api/settings/accounts/[id]`, `/api/settings/accounts/[id]/setup-link`,
  `/api/settings/wipe-db`.

No legacy compatibility API route files from the old board, channel, report,
operator, gate, crawl-plan, or editor-command surfaces are tracked. `missions`,
`jobs`, `runs`, `reports`, and `board` survive as **internal** DB/helper names
for compatibility and diagnostics; they are not surfaced in user-facing UI.

### Harness (TypeScript HTTP/SSE service, `127.0.0.1:8650`)

- Agent runtime on the OpenAI Agents SDK: routing, tool budgets, source strategy,
  reports, scheduler, health.
- Source fetch pipeline + adapters (RSS, Atom, HTML, Bluesky, sitemap, PDF). These
  stay **backend-only** and are never named in the UI ("From BBC World Service" or
  a link — never adapter names or fetch metadata).
- SQLite persistence (`NEWSROOM_HARNESS_DB_PATH`), with Supabase/Postgres mirroring
  only when `NEWSROOM_HARNESS_DATABASE_URL` is **explicitly** set. The UI
  `DATABASE_URL` is never the harness mirror.
- Process-local scheduler (off by default). No Redis/BullMQ.
- Model-policy controls: `NEWSROOM_MODEL_POLICY_MODE` (`cost_saver` default), with
  scheduled model calls and scheduled web search gated off by default
  (`NEWSROOM_ALLOW_SCHEDULED_MODEL_CALLS`, `NEWSROOM_ALLOW_SCHEDULED_WEB_SEARCH`).

### Persistence

- **App DB** — Supabase Postgres via Drizzle (server-only `DATABASE_URL`):
  accounts, conversations, messages, settings, and the internal missions tables.
- **Harness DB** — SQLite: jobs (backing store for stories), runs, sources,
  source snapshots, reports, events.

---

## Architecture

```
Browser
  └─ SvelteKit app (3001)
       ├─ Supabase Postgres  (accounts, conversations, messages, settings)
       └─ Newsroom harness (8650)   via AGENT_GATEWAY_URL
            ├─ Research agent
            │    ├─ Web search sub-agent (OpenAI web_search)
            │    ├─ Social sub-agent (Bluesky)
            │    └─ Source monitor sub-agent (configured URLs)
            ├─ Chat agent
            └─ SQLite (jobs, runs, sources, reports, events)
```

The harness owns model execution, source fetching, and research. The app owns UI,
auth, and persistence of user-facing data. They talk over `AGENT_GATEWAY_URL`.

---

## Product Rules (non-negotiable)

- **Dates are publication dates.** Story dates reported to the user must use the
  article's `publishedAt`, never `fetchedAt`, run start, or accessed time. If
  `publishedAt` is unavailable, mark it "date unknown" — never substitute a
  retrieval time. Enforced at normalization in the harness.
- **No technical leakage.** No tool traces, JSON, job/run IDs, file paths, HTTP
  status, adapter names, or model internals in user-facing output. A search shows
  a subtle "Searching…" indicator, not a tool log.
- **Sources shown once.** Citations are inline markdown links. No source-tag chips
  plus inline links for the same source.
- **Cite or stay silent.** Current-events answers need source-backed evidence.
  Prefer official/primary/configured monitors before broad web search; use search
  as fallback/broad discovery. Flag conflicts, weak sourcing, paywalls, blocked
  pages, CAPTCHA, and stale data instead of smoothing them over.
- **Humans stay in control.** NewsCraft recommends, summarizes, compares, drafts.
  It does not silently publish.
- Keep route names, slash commands, buttons, and visible labels stable unless the
  task is explicitly about changing them.

---

## Local Development

```sh
corepack pnpm install          # install
corepack pnpm dev:all          # start/reuse UI (3001) + harness (8650)
corepack pnpm dev:stop         # stop stale local listeners
corepack pnpm health:agent     # UI health
corepack pnpm health:harness   # harness health
corepack pnpm agent:ask -- "What are the top stories in Canada right now?"
```

`dev:all` is the repo-owned one-terminal workflow. If it breaks, fix that path —
don't ask the user to juggle terminals, and don't embed the harness inside the
SvelteKit server as a shortcut (the split-process flow is intentional).

Env loading: the app reads root `.env.local`; the harness reads
`services/newsroom-harness/.env.local`, then `.env`, then the root files as
fallback. See `.env.example`. Keep secrets out of docs, commits, logs, and memory.

If `/api/health` fails with `DATABASE_URL is required`, the UI is missing Supabase
Postgres config. Use the Supabase session-pooler URI when IPv4 is required;
SQLite-only assumptions for the main UI path are stale.

---

## Validation

Use the narrowest check that proves the change, then broaden at boundaries.

```sh
corepack pnpm check                  # svelte-check / types
corepack pnpm test                   # unit (app + shared + harness)
corepack pnpm test:harness           # harness + shared only
corepack pnpm build                  # production build
corepack pnpm smoke:producer:fixture # fixture-mode producer smoke
corepack pnpm producer:acceptance    # full producer acceptance
corepack pnpm test:e2e               # Playwright
```

Use browser-based acceptance (not just backend health) for anything visible: chat
streaming, the story-tracker surface, report display, login/setup.

Inspect ports before changing dev scripts:

```sh
lsof -nP -iTCP:3001 -sTCP:LISTEN
lsof -nP -iTCP:8650 -sTCP:LISTEN
```

---

## Working In This Repo

- Start with `git status --short --branch`; this repo is often dirty.
- Do not revert user changes. If an update needs discarding local WIP, make a
  reversible safety step first and discard only after explicit approval.
- Prefer compatibility-first changes behind the adapter/harness boundary over
  sweeping UI rewrites.
- When changing reports or prompts, prefer repo-owned Markdown/config/code so
  behavior stays inspectable (e.g.
  `services/newsroom-harness/prompts/newsroom-report.md`).
- Keep technical metadata available for diagnostics but hidden from the default
  user-facing experience.

### Known traps

- Simple chat tasks that stall are usually harness/runtime orchestration, not
  frontend rendering.
- Current-news prompts need source/search behavior; never answer from static
  memory.
- Report-quality bugs span `runtime.runMission()` → `JobRunner` → report
  wrapping/ingest.
- Source pages may be blocked, boilerplate-heavy, or stale. Filter low-value pages
  and fall back to configured search/source paths with clear caveats.

---

## Environment Variables

The authoritative list lives in `.env.example`. Key groups:

- **App**: `APP_SESSION_SECRET`, `APP_PASSWORD_HASH`, `DATABASE_URL`,
  `AGENT_GATEWAY_URL`, `AGENT_GATEWAY_API_KEY`.
- **Harness**: `NEWSROOM_HARNESS_HOST/PORT`, `NEWSROOM_HARNESS_DB_PATH`,
  `NEWSROOM_HARNESS_DATABASE_URL`, `NEWSROOM_HARNESS_API_KEY`, the tool/search/
  timeout budgets, and `NEWSROOM_HARNESS_SCHEDULER_*`.
- **AI / model policy**: `OPENAI_API_KEY`, `NEWSROOM_MODEL_POLICY_MODE`,
  `NEWSROOM_ALLOW_SCHEDULED_MODEL_CALLS`, `NEWSROOM_ALLOW_SCHEDULED_WEB_SEARCH`,
  `NEWSROOM_MODEL_*`, `NEWSROOM_WEB_SEARCH_MODEL`.
- **Ingest**: `NEWSROOM_UI_INGEST_URL`, `NEWSROOM_UI_INGEST_KEY`.

The `NEWSROOM_EMAIL_DIGEST_WEBHOOK_URL` and `NEWSROOM_SLACK_WEBHOOK_URL`
placeholders still appear in `.env.example`, but point at **cut** delivery
features. Treat them as inert until/unless delivery is deliberately rebuilt.

---

## Repository Layout

```
newscraft-ai/
  src/                         SvelteKit web app
  services/newsroom-harness/   Agent harness service
  packages/shared/             Shared DTOs and SSE helpers
  drizzle/                     App DB migrations
  scripts/                     Utility scripts
  tests/e2e/                   Playwright smoke tests
```

### Key files

- Chat / streaming: `src/routes/api/chat/stream/+server.ts`,
  `src/lib/server/agent/transport.ts` (URL/auth/streaming/health),
  `src/lib/server/agent/board.ts` (mission/job/run normalization),
  `src/routes/c/[id]/+page.svelte`.
- Auth: `src/hooks.server.ts`, `src/lib/server/auth/cookie.ts`,
  `src/lib/server/db/accounts.ts`.
- Harness: `services/newsroom-harness/src/agents/runtime.ts`,
  `services/newsroom-harness/src/jobs/runner.ts`,
  `services/newsroom-harness/src/tools/sources.ts`,
  `services/newsroom-harness/src/tools/article-extraction.ts`,
  `services/newsroom-harness/src/db/repository.ts`,
  `services/newsroom-harness/prompts/newsroom-report.md`.

---

## Out Of Scope (until the two surfaces are used daily)

Publishing to CMS/WordPress, email digests, Slack delivery, multi-user roles,
paywall handling, source-credibility scoring, distributed scheduler, real-time
push, mobile app, external API access.
