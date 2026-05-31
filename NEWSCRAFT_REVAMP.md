# NewsCraft AI — Complete Transition & Revamp Plan

> **Last updated:** 2026-05-31
>
> Cross-reference: `AGENT.md` (operational boundaries for agents working in this repo), `SOURCE_OF_TRUTH.md` (live canonical architecture reference). This document covers _why_ things are changing, _what_ the target state is, and the ordered plan to get there.

---

## 1. Purpose of This Document

NewsCraft AI has reached a stable Phase 3 baseline (packaging, delivery, gate system, verification, copy/legal). The codebase now carries a layer of stale documentation artifacts from previous work sessions and a naming/routing layer that was correct during the gateway compatibility phase but now needs to be cleaned up as the harness path is stable.

This document serves as the single reference for:

1. What is being removed (stale docs, compatibility shims).
2. What the current system is and can do.
3. Where the product is going next, with full detail.
4. The ordered implementation plan.
5. Risks, known limitations, and verification steps.

---

## 2. What Was Removed

### Deleted Documentation Files

The following files were deleted as part of this revamp commit:

| File | Reason |
|------|--------|
| `README.md` | Superseded by this document and `SOURCE_OF_TRUTH.md` |
| `services/newsroom-harness/README.md` | Content absorbed into `SOURCE_OF_TRUTH.md`; duplicative |
| `.workflow/claude-phase-2-findings-remediation/**` | Stale Phase 2 orchestration artifacts (13 files) |
| `.workflow/newscraft-ai-phase-3-milestone/**` | Stale Phase 3 orchestration artifacts (9 files) |

### File Preserved Intentionally

`services/newsroom-harness/prompts/newsroom-report.md` is a **runtime prompt template** loaded by the harness during mission report generation. It is functional code, not documentation — do not delete it.

### Files Always Kept

- `AGENT.md` — operational guard-rails and product direction for agents
- `SOURCE_OF_TRUTH.md` — live canonical architecture, data model, and API reference

---

## 3. Current System State (as of 2026-05-31)

### 3.1 Processes and Ports

| Service | Default address | Start command |
|---------|----------------|---------------|
| SvelteKit UI | `http://127.0.0.1:3001` | `corepack pnpm dev:all` |
| Newsroom harness | `http://127.0.0.1:8650` | included in `dev:all` |

One-terminal start/stop:
```sh
corepack pnpm dev:all
corepack pnpm dev:stop
```

### 3.2 Monorepo Layout

```
newscraft-ai/
  src/                         SvelteKit 2 / Svelte 5 web app
  services/newsroom-harness/   Node HTTP agent harness (port 8650)
  packages/shared/             Shared gateway DTOs and SSE helpers
  drizzle/                     SvelteKit app DB migrations (Supabase Postgres)
  scripts/                     Acceptance loop, health check, hash-password
  tests/e2e/                   Playwright smoke/e2e tests
  docs/mockups/                UI mockup images
```

### 3.3 What Has Been Completed

**Phase 1 (JIG-141 era)**
- Newsroom overview as the front page
- Editor command routing (monitor, research, drafting agents)
- Research fact ledger with `claim.proposed` events
- Verification: two-source rule, counter-source conflict detection, Verification gates
- Copy/legal: house-memory style pass, Legal/Style gates
- Citation graph with per-claim citation view and dispute highlighting
- Packaging: brief, web story, feature, broadcast, social, push, newsletter, headline-pack outputs
- Source health gates with pause/drop enforcement
- Structured article extraction and source provenance propagation
- Beat monitor article discovery (HTML watchlist pages → candidate fetch → pitch)
- Crawl-plan provenance preserved through beat monitor pitches
- Publication-date grounding (no publication date inferred from run/access timestamps)

**Phase 2 (Remediation)**
- Citation graph unsafe missing-status fallback fixed
- Fact ledger: gate resolutions now supersede prior verification events
- `request_more_research` re-runs once after new evidence arrives
- Independent source counting enforced by host/publisher
- Duplicate open gates deduplicated (Source Health, Legal/Style)
- Source Health pause/drop decisions block crawl-plan and beat-monitor refetches
- Copy legal-risk attribution scoped to claim-like segments
- Counter-source framing preserved in citation graph

**Phase 3 (JIG-157–161)**
- Packager agent creates all output formats from an approved draft
- Headline pack: 5 general + 1 SEO + 1 social headline with rationale
- Delivery adapters: email digest, generic webhook, Slack
- WordPress REST draft push (credentials from env only, never story memory)
- Publish gate: package creation queues gate; delivery requires resolved gate

### 3.4 Current Feature Set

Full list lives in `SOURCE_OF_TRUTH.md §"What the app can do today"`. Summary:

- Password-protected multi-account access with signed httpOnly session cookies
- Chat threads: streaming, partial response recovery, regeneration, resume, vision attachments
- Slash commands, command palette (`Cmd+K`), keyboard shortcuts
- Newsroom overview: pitch queue panel, open gate decision queue, story leads, active workspaces, standing briefs, wire
- Ask NewsCraft editor command routing to agent roles
- Mission/job CRUD, scheduling, pause/resume, run-now
- Source watchlists, crawl plans with provenance, beat monitor
- Fact ledger: proposed and verified claims, counter-source requests
- Gate resolution queue with Publish gate requirement before delivery
- Story drafts: packaging into multiple output formats
- Delivery adapters (behind Publish gate)
- Supabase Postgres persistence for UI state
- Harness SQLite persistence with optional Supabase mirroring
- Producer acceptance loop and deterministic smoke path

### 3.5 Current Limitations

| Area | Limitation |
|------|-----------|
| Naming | Routes/types still say `agent`/`agent-channel` — a compatibility layer from before the harness existed |
| Scheduler | Process-local; jobs only run while the harness process is alive |
| Cron | Conservative: interval schedules + simple five-field only |
| Thread UI | Long chat virtualization not implemented (~50+ message threads scroll poorly) |
| Auth | No role/permission hierarchy; any logged-in account can reach settings endpoints |
| Accounts | Invite flow schema exists but signup path is password-only in the UI |
| Source | Paywall detection, source credibility scoring, and comprehensive dedup are partial |
| Search | FTS exists; image content in multimodal messages can create noisy index entries |
| Deployment | Vercel adapter for UI; harness needs its own hosted service (no systemd scripts) |

---

## 4. The Transition — What We Are Moving Away From

### 4.1 The `agent`/`agent-channel` Compatibility Layer

When the newsroom harness replaced the original OpenAI-backed agent gateway, all UI routes and types were intentionally kept named `agent/*` so the frontend could swap backends without a rewrite. That compatibility phase is now over.

**What exists today:**
- `/api/agent/*` UI routes
- `src/lib/server/agent/` server modules
- `AgentJob`, `AgentRun`, `BoardChannel`, `BoardPost` types in `packages/shared/`
- `agent_channel_configs`, `agent_channel_sources`, `agent_channel_posts` legacy tables

**Target:** Rename to `gateway/*` naming. Keep legacy routes as 301 redirects through one full release cycle so any existing clients or webhooks aren't silently broken.

### 4.2 "Missions" as the Primary UX

Missions (the scheduled-prompt-runner config surface at `/missions`) served as the primary newsroom interface. The product is moving to a proper editorial workflow:

```
Beat monitor → pitches → Pitch Queue (/) → Story Workspace → Delivery
```

Missions become **Standing Briefs** in user-facing language — background, operator-configured monitors. `/missions` stays as an admin config surface but is no longer the editorial front door.

### 4.3 Process-Local Scheduler

The current `scheduler.ts` polls a SQLite table in-process. This means:
- If the harness crashes, no jobs run until it restarts
- No visibility into scheduled job state from outside the process
- Difficult to scale horizontally

Target: a durable queue (options: BullMQ backed by Redis, or a simple Postgres-backed queue given Supabase is already in use).

### 4.4 Stale Workflow Artifacts

The `.workflow/` directory accumulated orchestration markdown from previous Claude Code sessions. These are not documentation — they are scaffolding artifacts for multi-agent workflows. They have been deleted in this commit.

---

## 5. Target State — Where We Are Going

### 5.1 Product Mental Model

```
┌──────────────────────────────────────────────────────────────┐
│  NEWSROOM OVERVIEW  (/)                                       │
│                                                               │
│  [ Pitch Queue ]  ← beat monitors submit pitch gates here    │
│         ↓ editor accepts                                      │
│  [ Active Story Workspaces ]                                  │
│    ├── Research (fact ledger, counter-source)                 │
│    ├── Verification (two-source, dispute, Verification gate) │
│    ├── Drafting (story artifacts)                             │
│    ├── Copy/Legal (style pass, Legal/Style gate)             │
│    └── Packaging (all output formats, Publish gate)          │
│         ↓ Publish gate approved                               │
│  [ Delivery ]  email / webhook / Slack / WordPress           │
│                                                               │
│  [ Wire / Event Log ]  coordination + audit trail            │
│  [ Standing Briefs ]   background scheduled monitors         │
└──────────────────────────────────────────────────────────────┘
```

### 5.2 UI Surfaces (Post-Revamp)

| Surface | Route | Status |
|---------|-------|--------|
| Newsroom Overview | `/` | Exists; evolves to emphasize Pitch Queue |
| Story Workspace | `/stories/[id]` | New route (currently embedded in overview) |
| Standing Briefs (admin) | `/briefs` | Rename from `/missions` |
| Missions (compat) | `/missions` | Redirect to `/briefs` |
| Chat | `/c/[id]` | Unchanged |
| Settings | `/settings` | Unchanged |
| Login/Setup | `/login`, `/setup`, etc. | Unchanged |

### 5.3 Agent Role Boundaries (Harness-Owned)

| Agent | Responsibility |
|-------|---------------|
| Monitor | Watchlist/beat scanning; pitches story gates to queue |
| Assignment | Routes accepted pitches to story workspaces |
| Research | Source fetch, `claim.proposed` events, fact-ledger entries |
| Verification | `claim.verified/disputed/needs_more`, two-source rule, Verification gates |
| Drafting | Story artifacts from accepted pitch facts |
| Copy | House-memory style pass, Legal/Style gates |
| Packaging | All output formats; queues Publish gate |
| Delivery | Email/webhook/Slack/WordPress (Publish gate must be resolved) |

### 5.4 Gate System (Current + Planned)

| Gate Type | Trigger | Resolution Options |
|-----------|---------|-------------------|
| Pitch | Beat monitor proposes a story lead | accept, reject, hold |
| Source Health | Configured source blocked/degraded | pause, drop, ignore |
| Verification | Claim disputed or insufficient sources | accept_claim, reject_claim, request_more_research |
| Draft Review | Packager draft ready for review | approve, reject, request_revision |
| Legal/Style | Copy pass finds high-risk segments | approve, revise, escalate |
| Publish | Packaging complete | approve, send_to_cms, reject |

Gate resolution supersedes prior events in the effective fact ledger. `request_more_research` can re-run the Research agent once after new evidence arrives.

### 5.5 Adapter/Route Rename (Post-Compatibility)

**Before → After:**

| Before | After |
|--------|-------|
| `/api/agent/*` | `/api/gateway/*` (+ 301 redirects from old paths) |
| `src/lib/server/agent/` | `src/lib/server/gateway/` |
| `AgentJob`, `AgentRun` | `HarnessJob`, `HarnessRun` |
| `BoardChannel`, `BoardPost` | `GatewayChannel`, `GatewayPost` |
| `agent_channel_*` tables | Deprecated; read path kept for existing rows |

### 5.6 Harness Scheduler Upgrade (Planned)

Replace process-local polling scheduler with a durable queue:

```
Option A: BullMQ + Redis
  + well-supported, retries, delays, priorities
  - adds a Redis dependency

Option B: Postgres-backed queue (using existing Supabase)
  + no new dependencies, Supabase already present
  - requires building/maintaining a simple worker loop

Option C: Keep SQLite scheduler, add heartbeat + restart watchdog
  + no new dependencies
  - still process-local; doesn't solve horizontal scaling
```

Recommended: **Option B** (Postgres queue) since Supabase is already the production database. Avoids a Redis dependency and keeps infrastructure simple for a one-human newsroom.

New env variable: `NEWSROOM_HARNESS_QUEUE_URL` (uses `NEWSROOM_HARNESS_DATABASE_URL` or falls back to SQLite polling if not set).

### 5.7 Thread Virtualization

Add `virtua/svelte` for chat threads with >50 messages.

Target files:
- `src/lib/components/Thread.svelte`
- `src/routes/c/[id]/+page.svelte`

Trigger: message count exceeds configurable threshold (default 50). Below threshold, existing rendering stays unchanged.

### 5.8 Auth: Role/Permission Hierarchy (Future)

The schema supports multiple accounts. Currently any logged-in account can call all settings/maintenance endpoints. A future role model:

| Role | Access |
|------|--------|
| `owner` | All settings, wipe DB, manage accounts, delivery config |
| `editor` | Missions, gates, chat, story workspaces, export own data |
| `viewer` | Chat, story workspace read-only |

Not blocking for current work but required before multi-person newsroom onboarding.

### 5.9 Source: Paywall + Credibility (Future)

- Paywall detection: HTTP fingerprinting + content heuristics; surface "source requires subscription" rather than returning boilerplate as news
- Credibility scoring: domain reputation signals attached to source chips in citation graph
- Dedup: cross-workspace dedup of source URLs and claim text

---

## 6. Step-by-Step Implementation Order

```
Step 1 (this commit)  — Delete stale MD files, create NEWSCRAFT_REVAMP.md
Step 2               — Adapter/route rename: /api/agent → /api/gateway
Step 3               — Story Workspace route: /stories/[id]
Step 4               — Pitch Queue emphasis in /
Step 5               — Rename /missions → /briefs + redirect
Step 6               — Thread virtualization (virtua/svelte)
Step 7               — Scheduler durability (Postgres queue)
Step 8               — Auth role hierarchy
Step 9               — Source paywall + credibility
```

Steps 1–5 are product-visible changes that together complete the transition from the "compatibility" era to the intended product shape. Steps 6–9 are quality/scale improvements.

### Step 2 Detail: Adapter Rename

**Files to change:**
- `src/lib/server/agent/transport.ts` → `src/lib/server/gateway/transport.ts`
- `src/lib/server/agent/board.ts` → `src/lib/server/gateway/board.ts`
- `src/lib/server/agent/gates.ts` → `src/lib/server/gateway/gates.ts`
- `src/lib/server/agent/crawl-plans.ts` → `src/lib/server/gateway/crawl-plans.ts`
- `src/lib/server/agent/crawl-plan-sync.ts` → `src/lib/server/gateway/crawl-plan-sync.ts`
- `src/routes/api/agent/` → Add `/api/gateway/` mirrors; keep `/api/agent/` as 301 redirects
- `packages/shared/src/` — rename exported types

**Constraint:** `AGENT.md` says keep `/api/agent/*` stable unless the user explicitly asks for a migration. This step IS that explicit migration. Redirects preserve compatibility for any existing clients.

### Step 3 Detail: Story Workspace Route

New file: `src/routes/stories/[id]/+page.svelte`

Pulls content from the existing overview story-workspace panel into a dedicated full-page experience:
- Fact ledger with claim status chips
- Citation graph
- Draft history and output formats
- Open gates scoped to this story
- Research/verification command bar

### Step 4 Detail: Pitch Queue Emphasis

Modify `src/routes/+page.svelte` to give the Pitch Queue panel top billing:
- Pitched story cards with accept/reject/hold actions
- Source and confidence metadata on each pitch
- Quick-action to open the story workspace on accept

### Step 5 Detail: /missions → /briefs

- Add `src/routes/briefs/` as the new location
- Add `src/routes/missions/+page.server.ts` redirect (308 to `/briefs`)
- Update nav labels in `src/routes/+layout.svelte`
- Update internal links
- Underlying API stays at `/api/agent/jobs` (or `/api/gateway/jobs` after Step 2)

---

## 7. Key Files Quick Reference

### Chat / Streaming
- `src/routes/api/chat/stream/+server.ts`
- `src/lib/server/agent/transport.ts`
- `src/lib/client/stream.ts`
- `src/lib/utils/stream-events.ts`
- `src/lib/stores/chat.svelte.ts`
- `src/routes/c/[id]/+page.svelte`
- `src/lib/components/Composer.svelte`
- `src/lib/components/Thread.svelte`
- `src/lib/components/ToolActivity.svelte`

### Auth / Accounts
- `src/hooks.server.ts`
- `src/lib/server/auth/cookie.ts`
- `src/lib/server/auth/password.ts`
- `src/lib/server/db/accounts.ts`
- `src/routes/settings/+page.svelte`
- `src/routes/api/settings/*`

### Missions / Briefs / Jobs
- `src/routes/+page.svelte`
- `src/routes/missions/+page.svelte`
- `src/lib/server/agent/board.ts`
- `src/lib/server/agent/gates.ts`
- `src/lib/server/agent/crawl-plans.ts`
- `src/lib/server/db/missions.ts`
- `src/lib/server/db/mission-reports.ts`
- `src/lib/utils/board.ts`
- `src/lib/utils/channel-sources.ts`
- `src/lib/utils/cron-delivery.ts`
- `src/lib/utils/run-poll.ts`
- `src/routes/api/agent/*`

### Harness
- `services/newsroom-harness/src/server.ts`
- `services/newsroom-harness/src/chat.ts`
- `services/newsroom-harness/src/agents/beat-monitor.ts`
- `services/newsroom-harness/src/agents/editor-command.ts`
- `services/newsroom-harness/src/agents/research.ts`
- `services/newsroom-harness/src/agents/verification.ts`
- `services/newsroom-harness/src/agents/copy.ts`
- `services/newsroom-harness/src/agents/drafting.ts`
- `services/newsroom-harness/src/agents/runtime.ts`
- `services/newsroom-harness/src/crawl-plans/executor.ts`
- `services/newsroom-harness/src/jobs/runner.ts`
- `services/newsroom-harness/src/jobs/scheduler.ts`
- `services/newsroom-harness/src/jobs/report.ts`
- `services/newsroom-harness/src/db/database.ts`
- `services/newsroom-harness/src/db/repository.ts`
- `services/newsroom-harness/src/tools/sources.ts`
- `services/newsroom-harness/src/tools/article-extraction.ts`
- `services/newsroom-harness/src/tools/polite-fetch.ts`
- `services/newsroom-harness/src/tools/source-adapters/*`

### Shared Types
- `packages/shared/src/` — all exported DTOs; touch when renaming types

---

## 8. Environment Variables

### No Changes Required for Steps 1–5

All existing variables documented in `SOURCE_OF_TRUTH.md §"Important environment variables"` remain unchanged.

### New Variables (Step 7 — Scheduler Durability)

| Variable | Purpose | Default |
|----------|---------|---------|
| `NEWSROOM_HARNESS_QUEUE_URL` | Postgres connection for durable job queue | Falls back to SQLite polling |
| `NEWSROOM_HARNESS_WORKER_CONCURRENCY` | Max concurrent job executions | `1` |

---

## 9. API Contract Summary

### Web App Routes (Current)

Full reference in `SOURCE_OF_TRUTH.md §"API route reference"`. Key gateway routes:

```
GET  /api/health
GET  /api/agent/board
GET  /api/agent/jobs
POST /api/agent/jobs
PATCH /api/agent/jobs/[id]
POST /api/agent/jobs/[id]         (run/pause/resume)
DELETE /api/agent/jobs/[id]
GET  /api/agent/reports/[id]
POST /api/agent/channel-posts     (harness report ingest)
POST /api/agent/editor-command
GET  /api/agent/commands
GET  /api/agent/skills
GET  /api/agent/skills/[slug]
```

### Harness Endpoints (Current)

Full reference in `SOURCE_OF_TRUTH.md §"Newsroom harness architecture"`. All current paths remain unchanged until Step 2.

---

## 10. Testing & Verification

### For Every Change

```sh
corepack pnpm check               # TypeScript/Svelte types
corepack pnpm test                # Root + shared + harness Vitest
corepack pnpm test:harness        # Harness Vitest only
corepack pnpm build               # Full production build
corepack pnpm smoke:producer:fixture  # Deterministic local smoke
```

### For UI-Touching Changes

```sh
corepack pnpm producer:acceptance  # Full UI + harness acceptance loop
```

Requires `OPENAI_API_KEY` in harness env. Use `PRODUCER_ACCEPTANCE_REQUIRE_OPENAI=0` for fallback-path testing.

### For This PR (Doc Cleanup Only)

```sh
# Confirm deleted files are gone
git status --short

# Confirm kept files exist
ls AGENT.md SOURCE_OF_TRUTH.md NEWSCRAFT_REVAMP.md \
   services/newsroom-harness/prompts/newsroom-report.md

# Confirm nothing in source broke
corepack pnpm check
```

### For Step 2 (Adapter Rename)

- All existing tests pass
- `/api/agent/board` returns 301 to `/api/gateway/board`
- UI board and missions pages render correctly
- Producer acceptance loop completes

### For Step 5 (Missions Rename)

- `/missions` returns 308 to `/briefs`
- Sidebar nav shows "Standing Briefs" label
- Job CRUD from the `/briefs` page works end-to-end

---

## 11. Known Risks

| Risk | Severity | Mitigation |
|------|----------|-----------|
| `services/newsroom-harness/prompts/newsroom-report.md` deleted accidentally | High | Explicitly preserved; it is a runtime prompt template |
| Adapter rename breaks UI if old routes are missed | High | Keep `/api/agent/*` as 301 redirects for one release cycle; run producer acceptance |
| `/missions` bookmark breaks for existing users | Medium | Add 308 redirect in `src/routes/missions/+page.server.ts` |
| Scheduler upgrade corrupts existing SQLite job rows | Medium | Run migration in harness startup repair path in `database.ts` |
| Thread virtualization breaks scroll behavior | Medium | Test with 50+ real message threads before merging; test streaming state |
| Type rename breaks external clients using `AgentJob`/`AgentRun` | Low | Keep old type aliases exported for one release cycle |
| Auth role hierarchy locks out early users if misconfigured | Medium | Migrate existing accounts to `owner` role automatically; test first-account setup flow |
| WordPress credentials leaking into logs/events | High | Read from env only; never serialize into events, memory, or error messages |

---

## 12. Maintenance Rule

Update `SOURCE_OF_TRUTH.md` whenever:
- A new route or major page is added
- A new environment variable is introduced
- The database schema or migration changes
- The gateway/harness API contract changes
- Mission/gate lifecycle behavior changes
- Auth, session, or account behavior changes
- The deployment process changes
- A known limitation is removed or newly discovered

Update this document (`NEWSCRAFT_REVAMP.md`) when the transition plan itself changes — when a step is completed, reordered, or newly added.
