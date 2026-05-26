# NewsCraft AI Agent Notes

This repo is the NewsCraft agent UI plus the same-repo newsroom harness. Future agents should treat it as a working product codebase, not a greenfield prototype.

## Current Shape

- Root app: SvelteKit 2 / Svelte 5 UI for the editor-facing NewsCraft experience.
- Harness service: `services/newsroom-harness`, a TypeScript HTTP/SSE service on `127.0.0.1:8650`.
- Shared contracts: `packages/shared`, especially gateway, health, jobs, and SSE DTOs.
- UI persistence: Supabase Postgres via server-only `DATABASE_URL`.
- Harness persistence: SQLite via `NEWSROOM_HARNESS_DB_PATH`, with Supabase
  mirroring/restoration enabled when `NEWSROOM_HARNESS_DATABASE_URL` or
  `DATABASE_URL` is available to the harness process.
- Local UI port: `127.0.0.1:3001`.
- Local harness port: `127.0.0.1:8650`.

The intended product loop is:

```text
Agents notice -> propose -> execute -> present -> human approves -> ship.
```

Keep humans in control. NewsCraft can recommend, summarize, compare, draft, package, and alert. It should not silently publish or hide unresolved sourcing risk.

## Non-Negotiable Boundaries

- Keep the existing `/api/agent/*` UI routes stable unless the user explicitly asks for a migration.
- Keep gateway behavior concentrated in `src/lib/server/agent/*`. `transport.ts` owns URL/auth/streaming/health; `board.ts` owns mission/job/run normalization.
- Keep chat streaming compatible with the current browser contract in `src/routes/api/chat/stream/+server.ts`: SSE framing, tool/source events, partial-response behavior, and `[DONE]` all matter.
- Let `services/newsroom-harness` own agent runtime behavior: routing, tool budgets, source strategy, reports, scheduler, and health.
- Do not reintroduce old placeholder model names like `hermes-agent`. The UI default model can stay abstract; the harness should own real model/runtime settings.
- Preserve editor-facing route names and affordances. The user notices missing buttons, renamed tabs, and exposed implementation details.
- Mission controls are feature-gated by `ENABLE_MISSIONS=1` in `src/routes/+layout.server.ts`. If the "New mission" UI is missing, check login/setup state, that flag, and gateway health before assuming a Svelte regression.

## Product Direction

NewsCraft is a newsroom of agents for one human editor. It is not a CMS-lite, Kanban board, generic chatbot, or scheduled-prompt runner.

The durable direction is:

- Pitch Queue as the future front door.
- Active Story Workspaces for accepted pitches.
- Wire/event log as the coordination and audit trail.
- Standing Briefs/Beats replacing "missions" as a user mental model over time.
- Agents with role boundaries: monitor, assignment, research, verification, drafting, copy, packaging.
- Gates for editorial decisions: pitch, verification, draft review, legal/style, publish.

Compatibility work may still use existing missions/jobs/runs tables and pages. Do not rename user-facing concepts broadly unless the task is explicitly about that migration.

## Source And Report Quality

- Cite or stay silent. Current-events and research answers need source-backed evidence.
- Prefer official, primary, configured source monitors, internal mission output, and direct feeds before broad web search.
- Use web search as fallback/broad discovery when configured, especially after source failures.
- Preserve timestamps and source identity where relevant.
- Flag conflicts, weak sourcing, paywalls, blocked pages, CAPTCHA, and stale data instead of smoothing them over.
- Mission reports shown to editors should read like producer/editor briefs. Do not leak tool traces, JSON, model internals, retry details, implementation language, or debug metadata into the visible report.
- Source quality helpers live in `services/newsroom-harness/src/util/source-quality.ts` and `services/newsroom-harness/src/util/report-quality.ts`.

## Local Development

Install:

```sh
corepack pnpm install
```

Run the full local app:

```sh
corepack pnpm dev:all
```

This starts or reuses:

- UI: `http://127.0.0.1:3001`
- Harness: `http://127.0.0.1:8650`

Stop stale local listeners:

```sh
corepack pnpm dev:stop
```

Health checks:

```sh
corepack pnpm health:agent
corepack pnpm health:harness
```

Useful direct harness prompt:

```sh
corepack pnpm agent:ask -- "What are the top stories in Canada right now?"
```

The app loads root `.env.local`; the harness loads `services/newsroom-harness/.env.local`, `.env`, then the root `.env.local` / `.env` as fallback. Keep secrets out of docs, commits, logs, and memory.

Important local env:

```sh
DATABASE_URL=<Supabase Postgres connection string>
APP_SESSION_SECRET=...
AGENT_GATEWAY_URL=http://127.0.0.1:8650
AGENT_GATEWAY_API_KEY=
ENABLE_MISSIONS=1
NEWSROOM_HARNESS_DB_PATH=.data/newsroom-harness.db
NEWSROOM_HARNESS_DATABASE_URL=<optional Supabase Postgres connection string>
NEWSROOM_HARNESS_API_KEY=
OPENAI_API_KEY=
NEWSROOM_UI_INGEST_URL=http://127.0.0.1:3001/api/agent/channel-posts
NEWSROOM_UI_INGEST_KEY=
```

Use the Supabase session-pooler URI when IPv4 is required. The app does not
need local Homebrew Postgres on this machine. If `/api/health` fails with
`DATABASE_URL is required`, the UI is missing Supabase Postgres config. Older
SQLite-only assumptions are stale for the main UI path.

## Validation

Use the narrowest check that proves the change, then broaden when the change crosses a boundary.

Common checks:

```sh
corepack pnpm check
corepack pnpm test
corepack pnpm test:harness
corepack pnpm build
corepack pnpm smoke:producer:fixture
```

Full producer acceptance:

```sh
corepack pnpm producer:acceptance
```

Use browser acceptance for visible UI, mission controls, chat streaming, report display, login/setup, and anything the user says should be tested "like an actual user." Backend health checks alone are not enough for those tasks.

For local startup issues, inspect ports before changing scripts:

```sh
lsof -nP -iTCP:3001 -sTCP:LISTEN
lsof -nP -iTCP:8650 -sTCP:LISTEN
```

`corepack pnpm dev:all` is the repo-owned one-terminal workflow. If it breaks, fix that path instead of asking the user to manually juggle separate terminals.

## Implementation Habits

- Start with `git status --short --branch`; this repo is often dirty.
- Do not revert user changes. If a pull/update requires discarding local WIP, make a reversible safety step first, then discard only after explicit approval.
- Before broad harness changes, read:
  - `NEWSROOM_HARNESS_NOTES.md`
  - `AGENTIC_NEWSROOM.md`
  - `src/lib/server/agent/transport.ts`
  - `src/routes/api/chat/stream/+server.ts`
  - `services/newsroom-harness/src/agents/runtime.ts`
  - `services/newsroom-harness/src/jobs/runner.ts`
- Prefer compatibility-first changes behind the adapter/harness boundary over sweeping UI rewrites.
- Keep route names, slash commands, buttons, and visible labels stable unless the user asks to change them.
- Update README or this file when changing local workflow, ports, env requirements, or agent/harness boundaries.
- When changing reports or prompts, prefer repo-owned Markdown/config/code first so behavior is inspectable.
- Keep technical metadata available for diagnostics, but hidden from the default editor-facing experience.

## Known Traps

- Missing mission UI is usually `ENABLE_MISSIONS`, auth/setup state, or gateway health.
- Simple chat tasks that stall are usually harness/runtime orchestration, not just frontend rendering.
- Current-news prompts need source/search behavior; do not answer from static memory.
- Report quality bugs often span `runtime.runMission()` -> `JobRunner` -> report wrapping/ingest -> `src/routes/missions/+page.svelte`.
- Source pages may be blocked, boilerplate-heavy, or stale. Filter low-value pages and fall back to configured search/source paths with clear caveats.
- The local split-process flow is intentional. Do not embed the harness inside the SvelteKit server as a quick fix.
