# NewsCraft AI — Source of Truth & Roadmap

Last updated: 2026-07-09

This is the single canonical document for NewsCraft AI: what the product is,
how it is built today, where it is going, and how to work on it. If any other
file conflicts with this one, this file wins. There is intentionally only one
doc — update it as the product changes instead of adding new ones.

---

## 1. What It Is

NewsCraft AI is a **newsroom-smart chat tool for a solo news producer**. Not a
team editorial system, not a publishing pipeline, not a multi-agent
verification workflow.

**Decision (2026-07-03): chat-first, tracker frozen.** The product ships one
surface until it is excellent:

1. **Newsroom-smart chat** — a research chat agent with source-backed answers:
   web search, configured source URLs, honest publication dates, honest
   caveats. Clean formatted answers — a short paragraph and links, not a tool
   trace or system log. This is the entire product until it clears the chat
   quality gate (§5).
2. **Story tracker — FROZEN.** The jobs/runs/reports/scheduler skeleton stays
   in the repo but gets **no new work** and is not surfaced as product. The
   product thesis is that tracking ("watch this story, tell me what changed")
   is the long-term differentiator — but a tracker built on a research engine
   that fails its own eval just delivers wrong answers on a schedule. The
   tracker unfreezes only when the chat quality gate passes **and** daily chat
   use shows the pull signal (re-asking the same story every morning).

Everything from the old "newsroom of agents" design — gates, editor decision
queues, verification/copy/packaging agents, delivery adapters, crawl plans,
story workspaces, beat-monitor pitching, house memory, citation graph — has
been **cut**. If a real multi-user newsroom product is ever needed, it gets
rebuilt for that.

---

## 2. Current State (what actually ships)

### UI (SvelteKit, `127.0.0.1:3001`)

- `/` — chat-first start screen (hero + composer). Starter prompts cover
  current updates, coverage comparison, sourced discovery, and beat research.
  Title is "New chat · NewsCraft".
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
- **Provider separation (shipped 2026-07-02).** OpenAI and Perplexity are
  distinct request shapes behind one call site: OpenAI uses the Responses API
  (`/v1/responses`, `input`/`instructions`/`reasoning`), Perplexity uses the
  Sonar API (`https://api.perplexity.ai/v1/sonar`, `messages`, plain model ids
  like `sonar`). `normalizeProviderModel` strips `openai/`/`perplexity/`
  prefixes and hard-rejects cross-provider model/provider mismatches with
  actionable messages (`util/openai-complete.ts`). `validateHarnessConfig`
  (`config.ts`) surfaces errors/warnings in `/health` — missing keys warn,
  provider/model mismatches are errors and flip health `ok:false`. Provider is
  inferred from available keys when `NEWSROOM_MODEL_PROVIDER` is unset.
- **Health capabilities (shipped 2026-07-02).** `GatewayHealthResponse.capabilities`
  reports what each deployment shape actually supports (`chat`, `jobs`,
  `memory`, `savedResearch`, `scheduler`, `persistence:
  'sqlite'|'sqlite+supabase'|'stateless'`). The UI can gate surfaces on it.
- Source fetch pipeline + adapters (RSS, Atom, HTML, Bluesky, sitemap, PDF).
  These stay **backend-only** and are never named in the UI ("From BBC World
  Service" or a link — never adapter names or fetch metadata).
- SQLite persistence (`NEWSROOM_HARNESS_DB_PATH`), with Supabase/Postgres
  mirroring only when `NEWSROOM_HARNESS_DATABASE_URL` is **explicitly** set.
  The UI `DATABASE_URL` is never the harness mirror. (The mirror is slated for
  deletion — see §5 Phase C.)
- Process-local scheduler (off by default). No Redis/BullMQ. (Frozen with the
  tracker — see §1.)
- Model-policy controls: `NEWSROOM_MODEL_POLICY_MODE` (`cost_saver` default),
  with scheduled model calls and scheduled web search gated off by default
  (`NEWSROOM_ALLOW_SCHEDULED_MODEL_CALLS`,
  `NEWSROOM_ALLOW_SCHEDULED_WEB_SEARCH`).

### Production (Vercel, as of 2026-07-09)

- **UI** — `agent.newscraftai.com`, SvelteKit on `@sveltejs/adapter-vercel`
  (`nodejs24.x`), Supabase Postgres app DB. Chat resume claims are DB-backed
  (`messages.resume_claimed_at`, atomic conditional claim with a 5-minute TTL
  in `src/lib/server/db/conversations.ts`) so concurrent serverless instances
  cannot double-resume. Public `/api/health` returns only `{ok, service,
  time}` unauthenticated; app/gateway detail requires a session. The
  `newscraft-ai` Vercel project is linked to `jpatel98/newscraft-ai`; pushes to
  `main` auto-deploy it.
- **Harness** — separate Vercel project (`newscraft-harness`), **stateless
  chat-only** serverless function: `api/index.js` → `dist/serverless.js`.
  `vercel.json` uses `framework: null` + `functions` + `rewrites` (the legacy
  `builds` config and the committed esbuild bundle are gone).
  `includeFiles: "dist/**"` packages the compiled runtime and copied prompts;
  `excludeFiles: ".data/**"` keeps local SQLite data out of deploys. `public/`
  exists only because Vercel requires a static output directory. The project
  is linked to the same GitHub repo with `services/newsroom-harness` as its
  root, so pushes to `main` auto-deploy it. Production explicitly selects
  Perplexity with `perplexity/sonar`; `/health` reports a configured provider
  and no config errors. **This stateless shape is the intended production
  topology for the chat-first product** — no jobs, no scheduler, no harness
  persistence in prod. Health reports `persistence: 'stateless'` honestly.
- The UI talks to the harness over `AGENT_GATEWAY_URL` + bearer key. A remote
  gateway URL without a key is a hard error; loopback dev gateways may run
  keyless (`src/lib/server/agent/transport.ts`).
- **Public site** — `newscraftai.com` and `www.newscraftai.com` remain on the
  separate `newscraft-ai-landing` Vercel project. Do not move those domains to
  the app project unless the deployment architecture is explicitly changed.

### Persistence

- **App DB** — Supabase Postgres via Drizzle (server-only `DATABASE_URL`):
  accounts, conversations, messages, settings, per-message provenance,
  persisted diagnostics, revocable sessions, organization foundations, and
  frozen internal agent-job state.
- **Harness DB (local only)** — SQLite: jobs (backing store for stories), runs,
  sources, source snapshots, reports, events. The production harness is
  stateless and does not use this database.

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
- **Eval + gates (M4, shipped 2026-06-12, live-verified 2026-07-09).** The
  15-prompt golden suite covers latency, citations, clarification, caveats,
  paywalls, and no-leak behavior. The latest production Perplexity run passed
  15/15.
- **Durable app hardening (shipped through 2026-07-03).** Chat diagnostics,
  per-message provenance receipts, revocable sessions, organization ids, and
  internal agent-job state are persisted in Postgres (migrations 0007–0011).

### What's holding the core experience back

1. **Latency reliability.** The final 2026-07-09 production-default Perplexity
   run passed 15/15 with TTFT median = 1.57s, p90 = 1.81s, worst = 1.81s and
   total p50 = 3.65s / p90 = 4.35s. That clears the automated latency gate.
   Sonar still showed occasional multi-second variance in earlier repeated
   runs, so shift monitoring remains necessary even though local orchestration
   is no longer serial for ordinary one-step chat research.
2. **Production provenance acceptance.** Per-message receipts are implemented
   and persisted at stream completion, including sources, tool metadata,
   timing, completion state, model, and transport metadata. The remaining gate
   is an authenticated production acceptance check proving that every
   source-backed answer creates a readable receipt through the real app path.
3. **Real-shift evidence.** Correctness and latency now clear the automated
   gate, but the product still needs 2+ weeks of daily newsroom use after
   production provenance acceptance holds. Tracker, scheduler, and real-time
   ingestion remain frozen until then.

---

## 5. Roadmap

**Sequencing decision (2026-07-03):** chat excellence first; the tracker/Wire
is frozen behind an explicit quality gate. The middle path — half-built
tracker in the repo while chat is below its own eval bar — is the one outcome
this roadmap rules out.

### Phase A — Chat excellence (NOW)

Goal: a producer asks a newsroom question and gets a fast, honest,
source-backed answer that they would defend to an editor. Nothing else ships
until this holds.

1. **Latency attack (fast path shipped 2026-07-09).** One-step chat research
   now uses the deterministic router plan and makes one provider
   search-and-answer call. Context follow-ups without explicit source
   requirements use the same path. Multi-step research, explicit source
   requirements, reports, and `planner_enabled: true` diagnostics retain the
   model planner.
2. **Model-owned synthesis.** One synthesis contract owns the final answer —
   evidence + conversation + output rules in, prose with citations and honest
   caveats out. Delete the template/regex special cases as it lands
   (`runtime.ts` format-followup + fixture-table interceptors, the
   hand-templated caveat assembly in `answer.ts` stays only as the
   no-API-key fallback). The eval failures (missing caveats, unflagged
   paywall, answered-instead-of-clarified) are judgment behaviors and belong
   to the model contract, not to string templates.
3. **Provenance receipts (implementation shipped).** Persist a sanitized
   per-answer evidence bundle in app Postgres at stream-complete and keep
   sources available with the answer. The storage path is live; authenticated
   production acceptance and the every-source-backed-answer invariant remain
   part of the quality gate.
4. **Security hardening.** Session revocation (DB-backed session ids), hard-
   fail harness auth when deployed, SSRF/private-IP guard in `polite-fetch.ts`,
   basic rate limits on chat + login.
5. **Cost + observability.** Usage-ledger rows (model, tokens, task, ms) on
   every model call in app Postgres; chat diagnostics persisted instead of
   in-memory; one error tracker across app + harness.

**Chat quality gate (all must hold before anything unfreezes):**

- Golden-prompt eval (full mode, live API): **≥ 12/15 passing**, including
  every caveat/clarification/paywall trap.
- Latency: **TTFT ≤ 3s, p50 ≤ 12s, p90 ≤ 25s** for chat-class prompts.
- Provenance: every source-backed answer has a stored evidence bundle.
- Used on real shifts for **2+ weeks** after the above hold.

### Phase 1 — Chat + the multi-step agent (shipped 2026-06, historical record)

Goal was: a producer asks a question and *watches* the agent work — visible
plan, live steps, sources appearing, answer streaming token-by-token — and the
same single agent brain handles every chat request. All four milestones
shipped; the full-mode eval results (§4) are what Phase A now fixes.

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

### Phase B — Story tracker / real-time wire (FROZEN)

**Frozen 2026-07-03.** No new work here until the Phase A quality gate passes
*and* daily use shows the pull signal (§1). The jobs/runs/reports/scheduler
code stays in the repo as a skeleton; it is not product. Kept as planning
notes so decisions made now don't block later:

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

Implementation notes:

- **X API reality check.** Real-time filtered streams need the expensive paid
  tiers (verify current pricing before committing). Plan A: Bluesky + RSS/
  sitemap competitor monitors + scheduled checks. Plan B: X via curated lists
  on the cheapest viable tier. Either way it's one more adapter behind
  `tools/source-adapters/` — nothing in the chat product needs to know.
- **Push channel.** One SSE endpoint fed by the harness scheduler via the
  existing ingest path (`NEWSROOM_UI_INGEST_URL`); no Redis/WebSocket infra
  until scale demands it.
- **Cost control.** Scheduled model calls stay gated by
  `NEWSROOM_ALLOW_SCHEDULED_MODEL_CALLS`; the Wire should mostly be fetch +
  diff + heuristics, with model summarization only on user click or explicit
  alert rules.

### Phase C — Cleanup & consolidation (opportunistic, alongside Phase A)

- **Delete the Supabase mirror** (`db/supabase-mirror.ts` + the
  `NEWSROOM_HARNESS_DATABASE_URL` path). It mirrors tracker state that is
  frozen; if the tracker unfreezes it gets a proper Postgres repository, not
  a mirror.
- **Target architecture: merge at the deployment level, keep the module
  boundary.** Package the harness as `@newscraft/agent`, imported in-process
  by the SvelteKit chat route and streamed directly — one Vercel project, one
  deploy, one health check, no gateway hop, and the transport/auth/contract
  layer between app and harness stops existing. Keep a thin standalone
  entrypoint for `agent:ask`, the eval runner, and local dev. If the tracker
  ever unfreezes, the same package gets a `worker.ts` entrypoint on a small
  always-on host. Do this as part of a deletion pass, not before Phase A
  items 1–3 land — the split deploy works today.
- Retire duplicated app-DB tracker tables (`missions*`, `agent_channel_*`)
  when the merge pass touches them.

### Phase D — Producer workflows (was Phase 3)

- **Story dossiers.** Per-story timeline of evidence, what's-new diffs between
  checks, coverage comparison across outlets.
- **Drafting.** Broadcast script / web brief / social-post drafts generated
  from the evidence in a dossier — always draft, never publish.
- **Story clustering.** Dedupe the same story across outlets; surface "who had
  it first" and angle differences.

### Phase E — Only if daily-use demand exists (was Phase 4)

Multi-user/teams (orgs, seats, quotas, billing), CMS publishing,
source-credibility scoring, external API, email digests, Slack delivery,
paywall handling, distributed scheduler, real-time push at scale, mobile app.
These stay out of scope until chat is used daily. One exception pulled
forward: **new durable tables should carry an `org_id` column from creation**
(even with a single org row) — tenancy is the one thing that cannot be bolted
on later without migrating every row of customer content.

---

## 6. PRD — Phase 1: Chat + Agent (historical)

Phase A supersedes this PRD's latency targets — the quality gate in §5 is the
current bar.

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

## 7. Implementation Plan — Phase 1 (shipped; historical record)

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
  `NEWSROOM_EVAL_COMPARE_PLANNER=1`). Normal full mode omits planner overrides
  so it measures the production-default route; comparison mode explicitly
  runs both `true` and `false`. Checks cover ttft/total budgets, plan events,
  citation presence, no internal term leakage, and known traps. Results,
  including answer text, source count, and final plan, are written to
  `.tmp/eval/eval-{mode}-{ts}.json`.
- `scripts/producer-acceptance.mjs` — extended with M4 assertions: captures
  ttft/totalMs + planEvents + sources on every `streamChat` call; asserts
  simple-answer timing (≤8s real / ≤20s fixture), research timing (ttft ≤8s /
  total ≤60s real; ≤60s/120s fixture), plan event presence on research prompts,
  citation presence when OpenAI is configured, and no internal tool/adapter
  name leakage. Internal leak term list matches the eval runner.
- `package.json` `eval:fixture` script runs the golden-prompt suite in fixture
  mode (no API key, no running servers needed).
- CI exists as of 2026-06-12: `.github/workflows/ci.yml` runs
  install → check → test → eval:fixture on pushes to main and PRs. As of
  2026-07-09, `package.json` pins pnpm 9.15.9, `check` builds
  `@newscraft/shared` before Svelte type-checking, and supported architectures
  install the Linux Argon2 binding needed by Vercel tracing. A clean isolated
  install, check, build, test, fixture eval, and GitHub Actions run all pass.
- **Current full-mode eval (2026-07-09, production Perplexity):** 15/15 passed,
  including every caveat, clarification, and paywall trap; citation and
  no-internal-leak checks passed. TTFT was median = 1.57s / p90 = 1.81s /
  worst = 1.81s; total latency was p50 = 3.65s / p90 = 4.35s. This run clears
  the automated correctness and latency gates; production provenance
  acceptance and 2+ weeks of shift use remain open.
- **Historical baseline (2026-06-12, with planner comparison):** 6/15 passed.
  Latency p50 = 30.9s / p90 = 51.7s (budget: p50 ≤ 30s research, ≤ 8s
  simple). Failures: 5 prompts over latency budget, 5 missing
  caveat-on-no-evidence, paywall trap not flagged, ambiguous follow-up not
  met with a clarification request, brief generation over-planned by the
  planner (10s vs router 3ms). Fixing the full-mode runner itself was part
  of this run: it had never been executed and was written against a
  nonexistent API (wrong auth header, wrong route, ignored planner flag) —
  it now uses `POST /v1/chat/completions` with Bearer auth, and the harness
  accepts a per-request `planner_enabled` override (gateway DTO →
  `RuntimeContext` → agent config) so the side-by-side comparison is real.

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
path — don't ask the user to juggle terminals. Don't embed the harness inside
the SvelteKit server *as an ad-hoc shortcut*; the sanctioned merge is the
deliberate `@newscraft/agent` package refactor described in §5 Phase C, done
as its own pass with the module boundary kept.

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
chat streaming, the chat-start surface, source display, login/setup.

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
  tool/search/timeout budgets, `NEWSROOM_SOURCE_FETCH_TIMEOUT_MS` (per-URL
  configured-source fetch timeout, default 8000), `NEWSROOM_AGENT_PLANNER_ENABLED`,
  and `NEWSROOM_HARNESS_SCHEDULER_*`.
- **AI / model policy**: `NEWSROOM_MODEL_PROVIDER`, `PERPLEXITY_API_KEY`,
  `OPENAI_API_KEY`, `NEWSROOM_MODEL_POLICY_MODE`,
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
