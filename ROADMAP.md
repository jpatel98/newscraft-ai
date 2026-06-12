# NewsCraft AI — Source of Truth & Roadmap

Last updated: 2026-06-12

This is the single canonical document for NewsCraft AI: what the product is,
how it is built today, where it is going, and how to work on it. If any other
file conflicts with this one, this file wins. There is intentionally only one
doc — update it as the product changes instead of adding new ones.

---

## 1. What It Is

NewsCraft AI is a **solo news-producer tool**. Not a team editorial system, not
a publishing pipeline, not a multi-agent verification workflow. It is two
things:

1. **Story tracker** — give it a topic, region, or story. A research agent
   gathers what it can find — web search, social, configured source URLs — and
   you check back to see what's new.
2. **Newsroom-smart chat** — a general chat agent with the same research tools.
   Ask it things, get clean formatted answers: a short paragraph and links, not
   a tool trace or system log.

Everything from the old "newsroom of agents" design — gates, editor decision
queues, verification/copy/packaging agents, delivery adapters, crawl plans,
story workspaces, beat-monitor pitching, house memory, citation graph — has
been **cut**. If a real multi-user newsroom product is ever needed, it gets
rebuilt for that.

---

## 2. Current State (what actually ships)

### UI (SvelteKit, `127.0.0.1:3001`)

- `/` — Story Tracker landing (hero + composer). Starter prompts funnel
  research into a chat thread. Title is "Stories · NewsCraft".
- `/c/[id]` — chat thread. Sidebar lists recent threads (pinned / today /
  yesterday / last 7 days / earlier), rename, search.
- `/settings` — account + app settings.
- `/login`, `/signup`, `/setup`, `/account-setup/[token]` — auth/setup pages.
- `/logout` — auth sign-out endpoint.

No tracked page routes exist beyond these. `ENABLE_MISSIONS` no longer exists
in the code.

### App API (SvelteKit)

- Chat/conversations: `/api/chat/stream`, `/api/conversations`,
  `/api/conversations/[id]`, `/api/conversations/[id]/assistant-note`,
  `/api/conversations/[id]/export`, `/api/conversations/[id]/title`,
  `/api/messages/[id]/clear-partial`, `/api/messages/[id]/onwards`,
  `/api/search`.
- Agent bridge / Story Tracker internals: `/api/agent/commands`,
  `/api/agent/skills`, `/api/agent/skills/[slug]`, `/api/agent/jobs`,
  `/api/agent/jobs/[id]`, `/api/agent/jobs/[id]/run`,
  `/api/agent/jobs/[id]/pause`, `/api/agent/jobs/[id]/resume`,
  `/api/agent/channel-posts`, `/api/agent/board`, `/api/agent/reports/[id]`
  (the last two are diagnostics reads over the internal board/report helpers).
- Test-only (inert unless `E2E_SECRET` is set; 404 otherwise): `/api/e2e/seed`,
  `/api/e2e/seed-conversation` — used by the Playwright suite to provision the
  test account and pre-seed conversations.
- Health/settings/admin: `/api/health`, `/api/settings/status`,
  `/api/settings/export`, `/api/settings/password`, `/api/settings/accounts`,
  `/api/settings/accounts/[id]`, `/api/settings/accounts/[id]/setup-link`,
  `/api/settings/wipe-db`.

`missions`, `jobs`, `runs`, `reports`, and `board` survive as **internal**
DB/helper names for compatibility and diagnostics; they are not surfaced in
user-facing UI.

### Harness (TypeScript HTTP/SSE service, `127.0.0.1:8650`)

- Agent runtime: one disciplined agent brain for chat and missions (the old
  parallel OpenAI Agents SDK path is deleted; titles are a direct cheap model
  call; the `@openai/agents` dependency is gone).
- **Agentic loop (M2, shipped 2026-06-10).** A model planner
  (`agents/planner.ts`, policy task `interactive_chat`, zod-validated JSON,
  `NEWSROOM_AGENT_PLANNER_ENABLED` to disable) turns each request into explicit
  steps `{tool, input, label}` constrained to the tool registry; the regex
  router (`router.ts`) remains the offline/failure fallback and still supplies
  budgets and answer mode. The loop executes a growable step queue and
  observes after each step: failed source steps append a web-search fallback,
  and report-style runs append `url_fetch_read` follow-ups (max 2) to recover
  publication dates from undated search citations (chat skips these for
  latency). `agent.plan` SSE snapshots stream every step-status change.
- **True streaming (M1, shipped 2026-06-10):** the `openai_web_search` tool
  streams its Responses API call when an answer-delta sink is attached, the
  agent forwards deltas from the first answer-producing tool, and the runtime
  sanitizes them incrementally (re-running the batch cleaner over the growing
  prefix and emitting the diff) before the gateway passes them through live.
- Source fetch pipeline + adapters (RSS, Atom, HTML, Bluesky, sitemap, PDF).
  These stay **backend-only** and are never named in the UI ("From BBC World
  Service" or a link — never adapter names or fetch metadata).
- SQLite persistence (`NEWSROOM_HARNESS_DB_PATH`), with Supabase/Postgres
  mirroring only when `NEWSROOM_HARNESS_DATABASE_URL` is **explicitly** set.
  The UI `DATABASE_URL` is never the harness mirror.
- Process-local scheduler (off by default). No Redis/BullMQ.
- Model-policy controls: `NEWSROOM_MODEL_POLICY_MODE` (`cost_saver` default),
  with scheduled model calls and scheduled web search gated off by default
  (`NEWSROOM_ALLOW_SCHEDULED_MODEL_CALLS`,
  `NEWSROOM_ALLOW_SCHEDULED_WEB_SEARCH`).

### Persistence

- **App DB** — Supabase Postgres via Drizzle (server-only `DATABASE_URL`):
  accounts, conversations, messages, settings, and the internal missions
  tables.
- **Harness DB** — SQLite: jobs (backing store for stories), runs, sources,
  source snapshots, reports, events.

### Architecture

```
Browser
  └─ SvelteKit app (3001)
       ├─ Supabase Postgres  (accounts, conversations, messages, settings)
       └─ Newsroom harness (8650)   via AGENT_GATEWAY_URL
            ├─ Disciplined research/chat agent (router → tools → evidence → answer)
            └─ SQLite (jobs, runs, sources, reports, events)
```

The harness owns model execution, source fetching, and research. The app owns
UI, auth, and persistence of user-facing data. They talk over
`AGENT_GATEWAY_URL`.

---

## 3. Product Rules (non-negotiable)

- **Dates are publication dates.** Story dates reported to the user must use
  the article's `publishedAt`, never `fetchedAt`, run start, or accessed time.
  If `publishedAt` is unavailable, mark it "date unknown" — never substitute a
  retrieval time. Enforced at normalization in the harness.
- **No technical leakage.** No tool traces, JSON, job/run IDs, file paths,
  HTTP status, adapter names, or model internals in user-facing output. A
  search shows a subtle "Searching…" indicator, not a tool log.
- **Sources shown once.** Citations are inline markdown links. No source-tag
  chips plus inline links for the same source.
- **Cite or stay silent.** Current-events answers need source-backed evidence.
  Prefer official/primary/configured monitors before broad web search; use
  search as fallback/broad discovery. Flag conflicts, weak sourcing, paywalls,
  blocked pages, CAPTCHA, and stale data instead of smoothing them over.
- **Humans stay in control.** NewsCraft recommends, summarizes, compares,
  drafts. It does not silently publish.
- Keep route names, slash commands, buttons, and visible labels stable unless
  the task is explicitly about changing them.

---

## 4. Where We Are (honest assessment)

### What's solid

- Clean two-process architecture; each side evolves independently.
- Evidence discipline: provenance-tracked sources, publication-date
  enforcement, tool budgets, model-policy gating, run events for diagnostics.
- UI plumbing: SSE pipeline with tool-progress and source events, ToolActivity
  strip, resumable partial messages, slash commands, diagnostics.
- **True streaming (M1, shipped 2026-06-10).** Answer text reaches the user
  while the run is still going; nothing buffers end-to-end.
- **One agentic loop (M2, shipped 2026-06-10).** Model planner + plan→act→
  observe loop; one agent brain for every chat request.
- **Visible plan UI (M3, shipped 2026-06-11).** Live step timeline with human
  labels, per-step sources, honest failure states, collapse-on-answer.
- **Eval + gates (M4, shipped 2026-06-12, fixture-verified).** 15-prompt
  golden suite, latency/citation/no-leak assertions in producer acceptance;
  full-mode (real API) run still pending.

### What's holding the core experience back

1. **Latency.** Research prompts can take 30–60s: configured-source fetches
   can eat a 20s timeout before web search starts, and the web_search model
   call searches before it writes. The M4 gates (golden-prompt suite,
   ttft/total-time assertions in producer acceptance) now exist to measure
   this, but real-API latency hasn't been measured yet (full-mode eval run
   still pending) and the fetch-timeout tightening itself hasn't been done.
2. **No X / real-time ingestion yet.** Social coverage is Bluesky only; the
   scheduler is off by default; there is no push channel for "something new
   just landed on your beat."

---

## 5. Roadmap

### Phase 1 — Nail chat + the multi-step agent (now)

Goal: a producer asks a question and *watches* the agent work — visible plan,
live steps, sources appearing, answer streaming token-by-token — and the same
single agent brain handles every chat request.

- **M1. True end-to-end streaming** — *shipped 2026-06-10.* Deltas stream from
  the web-search model call through an incremental sanitizer
  (`stream-sanitizer.ts`); the harness no longer buffers; mid-run failures
  yield an honest interruption note; caveats are reconciled onto the tail.
- **M2. One agentic loop** — *shipped 2026-06-10.* Model planner + plan→act→
  observe loop with dynamic fallback/follow-up steps; regex router demoted to
  fallback; SDK fork deleted; `agent.plan` events streaming. Budgets and
  evidence discipline retained.
- **M3. Visible plan UI** — *shipped 2026-06-11.* Step timeline with human
  labels, pending/running/ok/failed/skipped states, collapse-on-answer,
  re-expandable.
- **M4. Eval + latency gates** — *shipped 2026-06-12.* Golden-prompt suite
  (15 prompts, 4 job classes + 6 known traps), fixture runner for CI,
  streaming/timing/plan/citation/no-leak assertions in producer acceptance,
  `eval:fixture` package.json script.

### Phase 2 — Real-time wire (after Phase 1 ships and is used daily)

- **Always-on monitoring.** Scheduler on for tracked stories; change detection
  on competitor/source pages (snapshots + content hashes already exist).
- **Social ingestion.** Bluesky first (adapter exists). X/Twitter via the paid
  API behind an adapter interface — start with curated lists for cost control;
  one adapter among several, not the foundation.
- **The Wire view.** A live in-app feed: new items on tracked stories,
  competitor coverage changes, social spikes — pushed over SSE, each item one
  click from "research this" in chat.
- **Alerting rules.** Per-story thresholds ("alert me if an official source
  publishes", "if 3+ outlets pick this up").

Phase 2 notes so decisions now don't block later:

- **X API reality check.** Real-time filtered streams need the expensive paid
  tiers (verify current pricing before committing). Plan A: Bluesky + RSS/
  sitemap competitor monitors + scheduled checks. Plan B: X via curated lists
  on the cheapest viable tier. Either way it's one more adapter behind
  `tools/source-adapters/` — nothing in Phase 1 needs to know.
- **Push channel.** One SSE endpoint fed by the harness scheduler via the
  existing ingest path (`NEWSROOM_UI_INGEST_URL`); no Redis/WebSocket infra
  until scale demands it.
- **Cost control.** Scheduled model calls stay gated by
  `NEWSROOM_ALLOW_SCHEDULED_MODEL_CALLS`; the Wire should mostly be fetch +
  diff + heuristics, with model summarization only on user click or explicit
  alert rules.

### Phase 3 — Producer workflows

- **Story dossiers.** Per-story timeline of evidence, what's-new diffs between
  checks, coverage comparison across outlets.
- **Drafting.** Broadcast script / web brief / social-post drafts generated
  from the evidence in a dossier — always draft, never publish.
- **Story clustering.** Dedupe the same story across outlets; surface "who had
  it first" and angle differences.

### Phase 4 — Only if daily-use demand exists

Multi-user/teams, CMS publishing, source-credibility scoring, external API,
email digests, Slack delivery, paywall handling, distributed scheduler,
real-time push at scale, mobile app. These stay out of scope until the two
surfaces are used daily.

---

## 6. PRD — Phase 1: Chat + Agent

### Users & jobs

Solo news producer (radio/TV/digital). Jobs to be done:

1. "What's happening right now on X topic/region?" → sourced brief, fast.
2. "Verify this claim / what are official sources saying?" →
   primary-source-first research with honest caveats.
3. "What are competitors reporting that I'm missing?" → coverage comparison.
4. Follow-ups that keep context ("what did the police statement actually
   say?").

### Functional requirements

**F1. Streaming answer** *(shipped — M1)*: first visible token as soon as the
answer-producing model call starts writing; no buffer-then-burst; tool/plan
progress visible within 1s of request start.

**F2. Agentic multi-step research** *(shipped — M2)*:
- A planner model turns the request (plus conversation context) into an
  explicit plan: ordered steps, each bound to a registered tool with a
  concrete input (query, URL, feed).
- After each step, the agent observes evidence and decides: continue, add a
  step (e.g., fetch a specific article found in a feed), refine a query, or
  stop. Hard caps: existing `ToolBudgetLedger` budgets and `runTimeoutMs`.
- All product rules hold (§3). No API key → graceful local fallback.

**F3. One brain** *(shipped — M2)*: every chat request goes through the same
agent loop; the separate SDK role-agent path is removed; URL fetching is a
registered tool in the one loop.

**F4. Visible process** *(M3)*:
- The UI renders the plan as a step timeline: pending → running → done/failed,
  with human labels ("Checking official sources", "Reading CBC article") —
  never tool names, IDs, or adapter names.
- Sources appear under the step that found them, as they arrive.
- Failures are shown honestly per step and the final answer states what
  couldn't be verified.
- The timeline collapses to a one-line summary once the answer starts
  streaming; expandable afterward.

**F5. Control**: stop button aborts cleanly (abort signal already plumbed);
partial work is persisted and resumable (existing partial-message machinery).

### Non-functional requirements

- p50 ≤ 30s / p90 ≤ 60s for research answers; simple answers ≤ 8s.
- Every current-events claim in the answer maps to gathered evidence.
- No regression on the "no technical leakage" rule.

### Success metrics

- Time-to-first-token and time-to-complete (capturable via
  `chat-diagnostics`).
- % of answers with ≥1 cited source on current-events prompts.
- Golden-prompt eval pass rate (M4).
- The only metric that really matters: you use it every day.

---

## 7. Implementation Plan — Phase 1 (remaining)

### M1 — True streaming ✅ (shipped 2026-06-10)

As built (differs slightly from the original sketch — the visible chat answer
comes from the model call *inside* `openai_web_search`, not a separate
synthesis call):

- `agents/stream-sanitizer.ts` — incremental sanitizer that re-runs the batch
  `cleanVisibleChatOutput` over the growing raw prefix at safe boundaries and
  emits the diff, plus tail reconciliation against the final answer.
- `util/openai-stream.ts` — Responses API SSE reader.
- `onAnswerDelta` hook through `ToolRunContext` → disciplined agent (first
  answer-producing tool only) → `runtime.disciplinedStream()` → gateway
  pass-through in `chat.ts`.
- Tests in `tests/streaming-chat.test.ts`, including a liveness test proving
  deltas arrive before the tool finishes.

### M2 — One agentic loop ✅ (shipped 2026-06-10)

As built:

- `agents/planner.ts` — model call (policy task `interactive_chat`) returns a
  zod-validated JSON plan of `{tool, input, label}` steps (max 4) constrained
  to enabled registry tools; the regex router is the fallback for no-key,
  policy-denied (e.g. scheduled runs), and invalid-plan cases.
  `NEWSROOM_AGENT_PLANNER_ENABLED=false` turns it off. The browser stub is
  excluded from the planner catalog.
- `DisciplinedNewsroomAgent.run()` executes a growable step queue with
  observe rules after each step: web-search fallback when a planned source
  step fails with no usable evidence; report-only `url_fetch_read` follow-ups
  (max 2) to recover publication dates from undated citations — chat skips
  these for latency. `ToolBudgetLedger` + abort signal remain the hard rails.
- `url_fetch_read` is a registry tool in `default-tools.ts`; the SDK fork
  (`sdkComplete`/`sdkStream`/`createSdkAgent`) is deleted, titles and mission
  synthesis are direct Responses API calls, the `@openai/agents` dependency
  and dead `agents/research.ts` are removed.
- `agent.plan` SSE frames (full step snapshot per status change) flow through
  chat; mission runs persist them as `plan.updated` events. Planner labels
  also reach today's tool chips via the progress detail field.

### M3 — Visible plan UI ✅ (shipped 2026-06-11)

As built:

- `src/lib/utils/stream-events.ts`: new `PlanStep`, `StreamPlanUpdate` types
  and `applyAgentPlan` method on `StreamEventState`; `agent.plan` frames are
  parsed into `StreamEventUpdate.plan` snapshots. `StreamSourceUpdate` and
  `PersistedSource` carry an optional `stepId` field parsed from the
  `agent.source` SSE payload.
- `src/lib/stores/chat.svelte.ts`: `ActivePlan` / `PlanStep` types, `plan`
  reactive state, `setPlan()` method; plan is reset on each `startStream`.
  `PlanStep` carries an optional `sources` array (title + url); `setPlan`
  preserves per-step sources across snapshot updates; `pushSource` calls
  `addSourceToStep` when a `stepId` is present so sources are attributed
  live as they arrive.
- `src/lib/client/stream.ts`: `onPlan` callback added to `StreamCallbacks`;
  plan updates forwarded from the SSE loop.
- `src/routes/c/[id]/+page.svelte`: `onPlan` wired to `chat.setPlan`.
- `src/lib/components/PlanTimeline.svelte`: new component — step timeline with
  pending/running/ok/failed/skipped states, spinner animation for running
  steps, human labels (server-side sanitized, never tool names or IDs),
  per-step failure detail on failed/skipped steps, per-step source links
  rendered as they arrive under each step (title as link text, never adapter
  or tool names), collapses to a one-line summary when the first answer token
  arrives, expandable afterward, toggle button with `aria-expanded`.
- `src/lib/components/Thread.svelte`: `PlanTimeline` rendered above
  `ToolActivity` on the active last assistant message.
- `src/lib/utils/tool-metadata.ts`: `normalizeSource` and `mergeToolMetadata`
  preserve `stepId` so per-step source attribution survives in the persisted
  `tool_calls` message column for future reload rendering.
- `services/newsroom-harness/src/agents/newsroom-agent.ts`: `AgentToolEvent`
  carries optional `stepId`; `tool_started`, `tool_completed`, and
  `tool_skipped` events all include the id of the currently-executing plan step.
- `services/newsroom-harness/src/agents/runtime.ts`: `RuntimeProgressEvent`
  source variant carries optional `stepId`; forwarded from `AgentToolEvent`
  when emitting per-evidence source progress events.
- `services/newsroom-harness/src/chat.ts`: `agent.source` SSE frame includes
  `stepId` when the source came from a plan step.
- `tests/e2e/app.spec.ts`: `plan timeline UI` test suite with SSE fixture
  interceptor; asserts plan steps render with human labels, no tool names leak,
  timeline collapses on answer, and is re-expandable.

### M4 — Eval + gates ✅ (shipped 2026-06-12)

As built:

- `services/newsroom-harness/eval/golden-prompts.json` — 15 repo-owned prompts
  covering all four jobs-to-be-done (current events, claim verification,
  competitor coverage, context follow-up) plus 6 known-trap variants:
  ambiguous follow-up, "today" recency phrasing, no-evidence/obscure topic,
  paywalled source, claim with no available evidence, and obscure local council
  story. Each entry declares: `class`, `latency_class` (`simple` / `research`),
  and machine-checkable `checks` (requires_citation, requires_plan_events,
  must_not_leak_tool_names/adapter_names/ids, requires_caveat_on_no_evidence,
  must_request_clarification, must_flag_paywall_or_blocked).
- `services/newsroom-harness/eval/run-eval.mjs` — runner with two modes:
  fixture (no API key, deterministic canned answers, CI-safe) and full (real
  harness, live latency, planner vs router side-by-side comparison when
  `NEWSROOM_EVAL_COMPARE_PLANNER=1`). Checks: ttft/total budgets per
  latency_class, plan events, citation presence, no internal term leakage.
  Results written to `.tmp/eval/eval-{mode}-{ts}.json`.
- `scripts/producer-acceptance.mjs` — extended with M4 assertions: captures
  ttft/totalMs + planEvents + sources on every `streamChat` call; asserts
  simple-answer timing (≤8s real / ≤20s fixture), research timing (ttft ≤8s /
  total ≤60s real; ≤60s/120s fixture), plan event presence on research prompts,
  citation presence when OpenAI is configured, and no internal tool/adapter
  name leakage. Internal leak term list matches the eval runner.
- `package.json` `eval:fixture` script runs the golden-prompt suite in fixture
  mode (no API key, no running servers needed).
- No CI config file exists in this repo; the `eval:fixture` script is ready to
  add to one when CI is set up (e.g. `.github/workflows/ci.yml`: run
  `corepack pnpm eval:fixture` after `corepack pnpm test`).
- **Still pending (manual):** a full-mode eval run against the real API —
  including the planner-vs-router side-by-side comparison
  (`NEWSROOM_EVAL_COMPARE_PLANNER=1`) and real latency measurement. Fixture
  mode (15/15) is verified; full mode has not been run yet. Run it before
  treating the latency budgets as validated.

### Sequencing & risk

- M3 consumes M2's `agent.plan` events; it can stub against fixture streams.
- M4 should also watch planner quality (a bad plan now shapes the whole run);
  golden prompts compare router-fallback vs planner answers side by side.

---

## 8. Local Development

```sh
corepack pnpm install          # install
corepack pnpm dev:all          # start/reuse UI (3001) + harness (8650)
corepack pnpm dev:stop         # stop stale local listeners
corepack pnpm health:agent     # UI health
corepack pnpm health:harness   # harness health
corepack pnpm agent:ask -- "What are the top stories in Canada right now?"
```

`dev:all` is the repo-owned one-terminal workflow. If it breaks, fix that
path — don't ask the user to juggle terminals, and don't embed the harness
inside the SvelteKit server as a shortcut (the split-process flow is
intentional).

Env loading: the app reads root `.env.local`; the harness reads
`services/newsroom-harness/.env.local`, then `.env`, then the root files as
fallback. See `.env.example`. Keep secrets out of docs, commits, logs, and
memory.

If `/api/health` fails with `DATABASE_URL is required`, the UI is missing
Supabase Postgres config. Use the Supabase session-pooler URI when IPv4 is
required; SQLite-only assumptions for the main UI path are stale.

---

## 9. Validation

Use the narrowest check that proves the change, then broaden at boundaries.

```sh
corepack pnpm check                  # svelte-check / types
corepack pnpm test                   # unit (app + shared + harness)
corepack pnpm test:harness           # harness + shared only
corepack pnpm build                  # production build
corepack pnpm smoke:producer:fixture # fixture-mode producer smoke
corepack pnpm eval:fixture           # golden-prompt eval suite, fixture mode (CI-safe)
corepack pnpm producer:acceptance    # full producer acceptance
corepack pnpm test:e2e               # Playwright
```

`eval:fixture` runs the 15-prompt golden suite in deterministic mode — no API
key or running servers required. For full-mode eval (real API, latency
measurement, planner comparison), start the harness and run:
`NEWSROOM_EVAL_MODE=full node services/newsroom-harness/eval/run-eval.mjs`

Use browser-based acceptance (not just backend health) for anything visible:
chat streaming, the story-tracker surface, report display, login/setup.

Known-broken as of 2026-06-10 — **fixed 2026-06-12:**

- `smoke:producer:fixture` was failing inserting a duplicate
  `fixture-cbc-politics` row into `mission_sources`. Fixed in
  `src/lib/server/db/missions.ts` `saveMissionConfig`: the transaction now
  checks which of the requested source IDs already exist in the table (post-
  delete) before deciding whether to use the requested id or generate a fresh
  one — so re-running the smoke against a pre-seeded DB no longer fails with a
  unique-constraint violation. `smoke:producer:fixture` passes cleanly.

Fixed 2026-06-12:

- `test:e2e` previously failed when `DATABASE_URL` pointed at a pre-seeded DB
  because the suite assumed a fresh database. Fixed by: adding an
  `/api/e2e/seed` endpoint (protected by `E2E_SECRET`) that idempotently
  provisions the test account; adding `/api/e2e/seed-conversation` to pre-seed
  conversations with messages for the plan-timeline test; and restructuring the
  first test to handle both fresh and pre-seeded database paths.
- `plan timeline UI` Playwright test was unable to observe mid-stream plan
  steps due to `route.fulfill()` delivering the entire SSE body at once. Fixed
  by: using `page.addInitScript()` to override `window.fetch` with a
  browser-side `ReadableStream` that streams in two phases; and fixing a bug in
  `PlanTimeline.svelte` where the collapse `$effect` tracked `expanded` as a
  dependency, preventing the user from manually re-expanding after the answer
  arrived (now uses `untrack()` so only `hasAssistantOutput` is a dependency).

Inspect ports before changing dev scripts:

```sh
lsof -nP -iTCP:3001 -sTCP:LISTEN
lsof -nP -iTCP:8650 -sTCP:LISTEN
```

---

## 10. Working In This Repo

- Start with `git status --short --branch`; this repo is often dirty.
- Do not revert user changes. If an update needs discarding local WIP, make a
  reversible safety step first and discard only after explicit approval.
- Prefer compatibility-first changes behind the adapter/harness boundary over
  sweeping UI rewrites.
- When changing reports or prompts, prefer repo-owned Markdown/config/code so
  behavior stays inspectable (e.g.
  `services/newsroom-harness/prompts/newsroom-report.md`).
- Keep technical metadata available for diagnostics but hidden from the
  default user-facing experience.
- Keep this document current: when a milestone ships or the architecture
  changes, update the relevant sections here instead of creating new docs.

### Known traps

- Simple chat tasks that stall are usually harness/runtime orchestration, not
  frontend rendering.
- Current-news prompts need source/search behavior; never answer from static
  memory.
- Report-quality bugs span `runtime.runMission()` → `JobRunner` → report
  wrapping/ingest.
- Source pages may be blocked, boilerplate-heavy, or stale. Filter low-value
  pages and fall back to configured search/source paths with clear caveats.

---

## 11. Environment Variables

The authoritative list lives in `.env.example`. Key groups:

- **App**: `APP_SESSION_SECRET`, `APP_PASSWORD_HASH`, `DATABASE_URL`,
  `AGENT_GATEWAY_URL`, `AGENT_GATEWAY_API_KEY`.
- **Harness**: `NEWSROOM_HARNESS_HOST/PORT`, `NEWSROOM_HARNESS_DB_PATH`,
  `NEWSROOM_HARNESS_DATABASE_URL`, `NEWSROOM_HARNESS_API_KEY`, the
  tool/search/timeout budgets, `NEWSROOM_AGENT_PLANNER_ENABLED`, and
  `NEWSROOM_HARNESS_SCHEDULER_*`.
- **AI / model policy**: `OPENAI_API_KEY`, `NEWSROOM_MODEL_POLICY_MODE`,
  `NEWSROOM_ALLOW_SCHEDULED_MODEL_CALLS`, `NEWSROOM_ALLOW_SCHEDULED_WEB_SEARCH`,
  `NEWSROOM_MODEL_*`, `NEWSROOM_WEB_SEARCH_MODEL`.
- **Ingest**: `NEWSROOM_UI_INGEST_URL`, `NEWSROOM_UI_INGEST_KEY`.

The `NEWSROOM_EMAIL_DIGEST_WEBHOOK_URL` and `NEWSROOM_SLACK_WEBHOOK_URL`
placeholders still appear in `.env.example`, but point at **cut** delivery
features. Treat them as inert until/unless delivery is deliberately rebuilt.

---

## 12. Repository Layout

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
  `services/newsroom-harness/src/agents/newsroom-agent.ts`,
  `services/newsroom-harness/src/agents/planner.ts`,
  `services/newsroom-harness/src/agents/stream-sanitizer.ts`,
  `services/newsroom-harness/src/util/openai-stream.ts`,
  `services/newsroom-harness/src/jobs/runner.ts`,
  `services/newsroom-harness/src/tools/sources.ts`,
  `services/newsroom-harness/src/tools/article-extraction.ts`,
  `services/newsroom-harness/src/db/repository.ts`,
  `services/newsroom-harness/prompts/newsroom-report.md`.
