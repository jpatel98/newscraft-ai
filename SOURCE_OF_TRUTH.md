# NewsCraft AI source of truth

Verification date: 2026-08-24 (America/Toronto)

This document records the current product and runtime boundary from this repository and read-only Linear evidence. It does not prove the state of any live deployment. It does not inspect secret values, hosted configuration values, traffic, database rows, provider accounts, or production infrastructure.

Use these labels throughout this document:

- **Repository verified**: visible in the current checkout.
- **Working**: implemented in the repository or supported by repository tests and contracts. This is not a live-production claim.
- **Failed**: a recorded failure exists. A fix is not claimed unless this document says it was verified.
- **Blocked**: the claim needs an external or missing gate before it can be accepted.
- **Historical**: a dated record or old design remains in the repository or Linear.
- **Unverified**: the repository describes a capability, but current deployment, selection, traffic, or runtime state was not checked.

## Product now

NewsCraft is a chat-first newsroom production assistant for journalists and producers. The current product surface is a SvelteKit web app. A user can create and manage conversations, research and verify sources, attach documents, receive cited answers, retry or resume an answer, transform an answer into newsroom output, and provide feedback.

The browser talks to NewsCraft only. NewsCraft owns authentication, account and organization scope, conversations, messages, documents, citations, feedback, diagnostics, and durable run state. NewsCraft calls one isolated Hermes service for agent execution. Hermes performs research, browsing, source verification, tool use, and drafting. The browser never calls Hermes directly. The source-backed client path is [`src/lib/client/stream.ts`](src/lib/client/stream.ts#L180-L220); the server-only Hermes transport is [`src/lib/server/agent/transport.ts`](src/lib/server/agent/transport.ts#L145-L169).

Hydra is separate. Hydra is Jigar's personal Hermes service with a separate process, user, home, and state. It is not part of NewsCraft and is not migrated by this repository. See [`services/hermes-chat/README.md`](services/hermes-chat/README.md#L15-L20) and [`docs/durable-hermes-streaming.md`](docs/durable-hermes-streaming.md#L70-L74).

### System components

| Component | Repository evidence | Truth status and limit |
| --- | --- | --- |
| Browser and UI | Svelte pages and client fetches are under [`src/routes`](src/routes) and [`src/lib/client`](src/lib/client). The chat client calls NewsCraft `/api/chat/runs` and `/api/chat/runs/:id`, not Hermes. | **Repository verified; working source path.** Browser reachability and live UI behavior are unverified in this task. |
| Vercel app | The SvelteKit adapter is [`svelte.config.js`](svelte.config.js#L1-L14). The root [`vercel.json`](vercel.json#L1-L13) contains UI service-worker cache headers. | **Repository verified; live deployment unverified.** The adapter and config do not prove the current Vercel project, alias, deployment, or traffic. |
| Product database | NewsCraft uses server-side `postgres` and Drizzle with `DATABASE_URL` in [`src/lib/server/db/index.ts`](src/lib/server/db/index.ts#L1-L23). The Linear project and roadmap identify this database as Supabase Postgres. | **Repository-backed Postgres path; Supabase instance and current schema/data unverified.** No database connection or data was inspected. |
| NewsCraft Hermes service | The service package is [`services/hermes-chat`](services/hermes-chat), with an AG-UI app, durable run endpoints, readiness output, and deployment unit examples. | **Repository verified; live Hermes host and process unverified.** The README describes Contabo deployment, but no VPS or production health check was performed. |
| Exa | Hermes permits `NEWSCRAFT_HERMES_WEB_PROVIDER=exa` and requires `EXA_API_KEY` when selected in [`services/hermes-chat/src/hermes_chat/service.py`](services/hermes-chat/src/hermes_chat/service.py#L157-L188). | **Capability implemented; current provider selection and key presence unverified.** No key value was read. |
| Browser Use | Hermes permits `NEWSCRAFT_HERMES_BROWSER_PROVIDER=browser-use` and requires `BROWSER_USE_API_KEY` when selected in [`services/hermes-chat/src/hermes_chat/service.py`](services/hermes-chat/src/hermes_chat/service.py#L175-L188). | **Capability implemented; current provider selection and session traffic unverified.** No key value was read. |
| Local extraction | `newscraft-local` is the no-key direct HTTP extraction and lead-verification backend. Its default configuration enables retrieval and archive fallback in [`services/hermes-chat/src/hermes_chat/retrieval.py`](services/hermes-chat/src/hermes_chat/retrieval.py#L37-L40) and [`services/hermes-chat/src/hermes_chat/retrieval.py`](services/hermes-chat/src/hermes_chat/retrieval.py#L90-L108). | **Repository verified; live readiness unverified.** This path does not prove that a running service has loaded the plugin. |
| Wayback | The local backend makes one bounded CDX lookup and one replay request when a live page is blocked or unreadable. It records original and archived URLs and timestamps in [`services/hermes-chat/src/hermes_chat/retrieval.py`](services/hermes-chat/src/hermes_chat/retrieval.py#L1-L6) and [`services/hermes-chat/src/hermes_chat/retrieval.py`](services/hermes-chat/src/hermes_chat/retrieval.py#L633-L717). | **Repository verified; current archive availability and live use unverified.** The path does not bypass challenges or paywalls. |

The provider boundary is explicit:

1. Hermes remains the agent and runtime.
2. Exa is an optional search and extraction provider selected by server configuration.
3. Browser Use is an optional raw cloud browser session selected by server configuration. It does not become a second agent.
4. `newscraft-local` provides direct extraction and bounded `verify_this_lead` behavior.
5. Wayback is a bounded fallback for blocked or unreadable live pages.
6. A provider failure must remain a Hermes failure. The code does not switch to the old agent or a second model endpoint; see [`services/hermes-chat/README.md`](services/hermes-chat/README.md#L19-L25) and [`src/routes/api/chat/stream/+server.ts`](src/routes/api/chat/stream/+server.ts#L1261-L1305).

## Durable state and request flow

The active request flow is:

`Browser → NewsCraft SvelteKit app → NewsCraft Postgres durable state → NewsCraft Hermes service → Hermes tools and configured retrieval providers`

The interactive chat route prepares the authenticated conversation, builds the Hermes input, checks readiness, and sends one Hermes AG-UI request. The durable branch creates or reuses one idempotent `hermes_runs` row, starts the same run at Hermes, and subscribes to persisted NewsCraft events. See [`src/routes/api/chat/stream/+server.ts`](src/routes/api/chat/stream/+server.ts#L1166-L1255) and [`src/routes/api/chat/stream/+server.ts`](src/routes/api/chat/stream/+server.ts#L1261-L1317).

The durable product state is repository-backed by:

- `hermes_runs` and `hermes_run_events`, defined in [`src/lib/server/db/schema.ts`](src/lib/server/db/schema.ts#L224-L299) and [`drizzle/0015_durable_hermes_runs.sql`](drizzle/0015_durable_hermes_runs.sql#L1-L54).
- `accounts`, `organizations`, `organization_members`, `conversations`, `messages`, `message_provenance`, `chat_feedback`, `chat_diagnostics`, `newsroom_profiles`, `conversation_documents`, and `conversation_document_pages`, defined in [`src/lib/server/db/schema.ts`](src/lib/server/db/schema.ts#L1-L222) and [`src/lib/server/db/schema.ts`](src/lib/server/db/schema.ts#L301-L348).
- NewsCraft-owned leases, cursors, idempotency keys, cancellation state, snapshots, and terminal states in [`src/lib/server/db/hermes-runs.ts`](src/lib/server/db/hermes-runs.ts#L1-L38).

The Hermes service exposes the durable start and cancel contract, starts recovery on service startup, and reports its runtime and capability state through `/ready`. See [`services/hermes-chat/src/hermes_chat/service.py`](services/hermes-chat/src/hermes_chat/service.py#L1382-L1508). The NewsCraft callback contract validates account, tenant, lease, and cursor bindings in [`src/routes/api/internal/hermes/runs/callback/+server.ts`](src/routes/api/internal/hermes/runs/callback/+server.ts#L1-L72).

The current code has no legacy agent fallback. [`agentFetch`](src/lib/server/agent/transport.ts#L888-L890) always throws that legacy agent-job transport is disabled. A short request and a durable request use the same Hermes transport family; see [`src/lib/server/agent/transport.ts`](src/lib/server/agent/transport.ts#L893-L926) and [`src/lib/server/agent/transport.ts`](src/lib/server/agent/transport.ts#L957-L993).

## Active UI routes

These are the UI routes represented by the current `src/routes` pages. Dynamic parameters are shown with `:id` or `:token` for readability.

| UI route | Product surface | Source |
| --- | --- | --- |
| `/` | Marketing landing on the marketing host, or authenticated chat start and recent work on the app host. | [`src/routes/+page.svelte`](src/routes/+page.svelte#L20-L125), [`src/routes/+page.server.ts`](src/routes/+page.server.ts#L1-L3) |
| `/c/:id` | Conversation workspace, message stream, retry, resume, citations, feedback, and output actions. | [`src/routes/c/[id]/+page.svelte`](<src/routes/c/[id]/+page.svelte#L1-L40>), [`src/routes/c/[id]/+page.server.ts`](<src/routes/c/[id]/+page.server.ts#L1-L46>) |
| `/login` | Password sign-in. | [`src/routes/login/+page.svelte`](src/routes/login/+page.svelte#L12-L66), [`src/routes/login/+page.server.ts`](src/routes/login/+page.server.ts#L1-L56) |
| `/signup` | Account creation. | [`src/routes/signup/+page.svelte`](src/routes/signup/+page.svelte#L12-L89), [`src/routes/signup/+page.server.ts`](src/routes/signup/+page.server.ts#L1-L63) |
| `/setup` | First-account setup. | [`src/routes/setup/+page.svelte`](src/routes/setup/+page.svelte#L14-L73), [`src/routes/setup/+page.server.ts`](src/routes/setup/+page.server.ts#L1-L67) |
| `/account-setup/:token` | One-time account password setup. | [`src/routes/account-setup/[token]/+page.svelte`](<src/routes/account-setup/[token]/+page.svelte#L1-L55>), [`src/routes/account-setup/[token]/+page.server.ts`](<src/routes/account-setup/[token]/+page.server.ts#L1-L39>) |
| `/settings` | Accounts, newsroom profile, password, export, sessions, and data controls. | [`src/routes/settings/+page.svelte`](src/routes/settings/+page.svelte#L276-L600), [`src/routes/settings/+page.server.ts`](src/routes/settings/+page.server.ts#L1-L28) |
| `/logout` | Server-side session logout endpoint used by the app shell. | [`src/routes/logout/+server.ts`](src/routes/logout/+server.ts#L1-L10) |

The browser-visible chat shell is not a Story Tracker or assignment board. The current home page and conversation page are the product surfaces. Legacy board and job files remain in the repository and are listed below as compatibility code, not as evidence of the active product runtime.

## Active API routes

The following route inventory is based on the current SvelteKit handlers. The internal Hermes routes are server-to-server routes. The E2E routes are test-only and must not be treated as product surfaces.

### Chat and durable runs

| Method and path | Purpose | Source |
| --- | --- | --- |
| `POST /api/chat/stream` | Authenticated chat preparation and interactive Hermes stream; also contains the durable branch behind an internal marker. | [`src/routes/api/chat/stream/+server.ts`](src/routes/api/chat/stream/+server.ts#L723-L770) |
| `POST /api/chat/runs` | Durable chat creation wrapper. It reuses the authenticated chat route with the durable marker. | [`src/routes/api/chat/runs/+server.ts`](src/routes/api/chat/runs/+server.ts#L1-L14) |
| `GET /api/chat/runs/:id` | Authenticated durable run snapshot and SSE subscription with a cursor. | [`src/routes/api/chat/runs/[id]/+server.ts`](<src/routes/api/chat/runs/[id]/+server.ts#L1-L18>) |
| `POST /api/chat/runs/:id/cancel` | Authenticated durable cancellation request. | [`src/routes/api/chat/runs/[id]/cancel/+server.ts`](<src/routes/api/chat/runs/[id]/cancel/+server.ts#L1-L29>) |

### Conversations, messages, search, and documents

| Method and path | Purpose | Source |
| --- | --- | --- |
| `POST /api/conversations` | Create a conversation for the authenticated account. | [`src/routes/api/conversations/+server.ts`](src/routes/api/conversations/+server.ts#L1-L18) |
| `PATCH|DELETE /api/conversations/:id` | Rename or delete an account-owned conversation. | [`src/routes/api/conversations/[id]/+server.ts`](<src/routes/api/conversations/[id]/+server.ts#L1-L83>) |
| `POST /api/conversations/:id/assistant-note` | Add an assistant-side note to a conversation. | [`src/routes/api/conversations/[id]/assistant-note/+server.ts`](<src/routes/api/conversations/[id]/assistant-note/+server.ts#L1-L33>) |
| `POST /api/conversations/:id/title` | Generate or save a conversation title. | [`src/routes/api/conversations/[id]/title/+server.ts`](<src/routes/api/conversations/[id]/title/+server.ts#L1-L36>) |
| `POST /api/conversations/:id/feedback` | Save account-scoped conversation feedback. | [`src/routes/api/conversations/[id]/feedback/+server.ts`](<src/routes/api/conversations/[id]/feedback/+server.ts#L1-L80>) |
| `GET /api/conversations/:id/export` | Export an account-owned conversation. | [`src/routes/api/conversations/[id]/export/+server.ts`](<src/routes/api/conversations/[id]/export/+server.ts#L1-L100>) |
| `GET /api/conversations/:id/messages/:messageId/export` | Export one account-owned message. | [`src/routes/api/conversations/[id]/messages/[messageId]/export/+server.ts`](<src/routes/api/conversations/[id]/messages/[messageId]/export/+server.ts#L1-L67>) |
| `POST /api/messages/:id/claim-partial` | Claim a partial assistant answer for resume. | [`src/routes/api/messages/[id]/claim-partial/+server.ts`](<src/routes/api/messages/[id]/claim-partial/+server.ts#L1-L27>) |
| `POST /api/messages/:id/clear-partial` | Discard a partial assistant answer after a claim check. | [`src/routes/api/messages/[id]/clear-partial/+server.ts`](<src/routes/api/messages/[id]/clear-partial/+server.ts#L1-L55>) |
| `DELETE /api/messages/:id/onwards` | Remove messages after an account-owned message. | [`src/routes/api/messages/[id]/onwards/+server.ts`](<src/routes/api/messages/[id]/onwards/+server.ts#L1-L24>) |
| `POST /api/search` | Search account-owned conversation titles and messages. | [`src/routes/api/search/+server.ts`](src/routes/api/search/+server.ts#L1-L60) |
| `GET /api/conversations/:id/documents` | List conversation documents. | [`src/routes/api/conversations/[id]/documents/+server.ts`](<src/routes/api/conversations/[id]/documents/+server.ts#L1-L21>) |
| `POST /api/conversations/:id/documents/upload-token` | Create an authenticated document upload token. | [`src/routes/api/conversations/[id]/documents/upload-token/+server.ts`](<src/routes/api/conversations/[id]/documents/upload-token/+server.ts#L1-L27>) |
| `POST /api/conversations/:id/documents/:documentId/process` | Process an uploaded document. | [`src/routes/api/conversations/[id]/documents/[documentId]/process/+server.ts`](<src/routes/api/conversations/[id]/documents/[documentId]/process/+server.ts#L1-L36>) |
| `DELETE /api/conversations/:id/documents/:documentId` | Delete an account-owned document. | [`src/routes/api/conversations/[id]/documents/[documentId]/+server.ts`](<src/routes/api/conversations/[id]/documents/[documentId]/+server.ts#L1-L23>) |
| `GET /api/conversations/:id/documents/:documentId/download` | Download an account-owned document. | [`src/routes/api/conversations/[id]/documents/[documentId]/download/+server.ts`](<src/routes/api/conversations/[id]/documents/[documentId]/download/+server.ts#L1-L34>) |

### Settings, health, and test support

| Method and path | Purpose | Source |
| --- | --- | --- |
| `GET /api/health` | Check NewsCraft Postgres, Hermes readiness, and authenticated document capability. | [`src/routes/api/health/+server.ts`](src/routes/api/health/+server.ts#L1-L76) |
| `POST /api/settings/accounts` | Create an account setup link for an authorized administrator. | [`src/routes/api/settings/accounts/+server.ts`](src/routes/api/settings/accounts/+server.ts#L1-L28) |
| `DELETE /api/settings/accounts/:id` | Delete an account through the authorized settings flow. | [`src/routes/api/settings/accounts/[id]/+server.ts`](<src/routes/api/settings/accounts/[id]/+server.ts#L1-L17>) |
| `POST /api/settings/accounts/:id/setup-link` | Create a setup link for an existing account. | [`src/routes/api/settings/accounts/[id]/setup-link/+server.ts`](<src/routes/api/settings/accounts/[id]/setup-link/+server.ts#L1-L21>) |
| `GET /api/settings/export` | Export account data. | [`src/routes/api/settings/export/+server.ts`](src/routes/api/settings/export/+server.ts#L1-L60) |
| `GET|PATCH /api/settings/newsroom-profile` | Read or update the organization newsroom profile. | [`src/routes/api/settings/newsroom-profile/+server.ts`](src/routes/api/settings/newsroom-profile/+server.ts#L1-L57) |
| `POST /api/settings/password` | Change the authenticated account password. | [`src/routes/api/settings/password/+server.ts`](src/routes/api/settings/password/+server.ts#L1-L33) |
| `GET /api/settings/status` | Return account-scoped maintenance and Hermes status. | [`src/routes/api/settings/status/+server.ts`](src/routes/api/settings/status/+server.ts#L1-L24) |
| `POST /api/settings/wipe-db` | Run the authorized account data-wipe flow. | [`src/routes/api/settings/wipe-db/+server.ts`](src/routes/api/settings/wipe-db/+server.ts#L1-L49) |
| `POST /api/e2e/seed` | Test-account provisioning when `E2E_SECRET` is configured. | [`src/routes/api/e2e/seed/+server.ts`](src/routes/api/e2e/seed/+server.ts#L1-L43) |
| `POST /api/e2e/seed-conversation` | E2E fixture seeding. | [`src/routes/api/e2e/seed-conversation/+server.ts`](src/routes/api/e2e/seed-conversation/+server.ts#L1-L80) |

### Hermes internal control plane

| Method and path | Purpose | Source |
| --- | --- | --- |
| `POST /api/internal/hermes/runs/claim` | Claim a queued or expired run lease. | [`src/routes/api/internal/hermes/runs/claim/+server.ts`](<src/routes/api/internal/hermes/runs/claim/+server.ts#L1-L44>) |
| `POST /api/internal/hermes/runs/renew` | Renew a durable run lease. | [`src/routes/api/internal/hermes/runs/renew/+server.ts`](<src/routes/api/internal/hermes/runs/renew/+server.ts#L1-L30>) |
| `GET /api/internal/hermes/runs/recover` | Recover queued or expired runs for the Hermes worker. | [`src/routes/api/internal/hermes/runs/recover/+server.ts`](<src/routes/api/internal/hermes/runs/recover/+server.ts#L1-L31>) |
| `POST /api/internal/hermes/runs/callback` | Persist authenticated Hermes events and advance the NewsCraft cursor. | [`src/routes/api/internal/hermes/runs/callback/+server.ts`](<src/routes/api/internal/hermes/runs/callback/+server.ts#L1-L72>) |

## Compatibility routes that are not the active runtime

The repository still contains these `/api/agent/*` handlers:

| Method and path | Repository fact | Product status |
| --- | --- | --- |
| `GET /api/agent/commands` | Returns local slash-command metadata. The bridge returns built-in commands, an empty skill list, and no external agent request in [`src/lib/server/agent/bridge.ts`](src/lib/server/agent/bridge.ts#L3-L74). The composer still reads this route for its local command menu in [`src/lib/components/Composer.svelte`](src/lib/components/Composer.svelte#L135-L148). | **Keep as a small UI compatibility surface until separately simplified.** It is not a Hermes gateway. |
| `GET /api/agent/board` | Reads board data from legacy agent/job helpers. | **Legacy repository surface; not the chat runtime.** |
| `GET|POST|DELETE /api/agent/jobs` | Lists, creates, or deletes legacy mission/job state. | **Legacy repository surface; quarantine before any removal.** |
| `PATCH|DELETE /api/agent/jobs/:id` | Updates or deletes a legacy mission/job. | **Legacy repository surface; quarantine before any removal.** |
| `POST /api/agent/jobs/:id/run` | Runs a legacy job action. | **Legacy repository surface; no active Hermes transport.** |
| `POST /api/agent/jobs/:id/pause` | Pauses a legacy job action. | **Legacy repository surface; no active Hermes transport.** |
| `POST /api/agent/jobs/:id/resume` | Resumes a legacy job action. | **Legacy repository surface; no active Hermes transport.** |
| `GET /api/agent/reports/:id` | Reads a legacy mission report. | **Legacy repository surface; no active durable Hermes read path.** |
| `POST /api/agent/channel-posts` | Authenticated legacy harness-to-app report ingest using `NEWSROOM_UI_INGEST_KEY`. | **Legacy compatibility surface; live traffic unverified.** |
| `GET /api/agent/skills` | Reads the bridge skill list, which is currently empty. | **Legacy compatibility surface.** |
| `GET /api/agent/skills/:slug` | Reads a bridge skill detail and currently returns not found for unavailable skills. | **Legacy compatibility surface.** |

These files remain because the Phase 0 disposition is not a deletion authorization. The detailed inventory and removal gates are in [`docs/legacy-runtime-disposition.md`](docs/legacy-runtime-disposition.md). The root test command still includes the legacy harness package in [`package.json`](package.json#L17-L26); that build/test reference is not evidence that the harness is the active product runtime.

## Hermes runtime contract

The repository identifies Hermes as the only NewsCraft agent runtime. The service uses the standard `hermes-acp` toolset plus the tenant-safe scheduled-job tool set. It keeps NewsCraft authentication and durable state authoritative and derives an opaque tenant key on the server. See [`services/hermes-chat/README.md`](services/hermes-chat/README.md#L1-L25), [`services/hermes-chat/src/hermes_chat/isolation.py`](services/hermes-chat/src/hermes_chat/isolation.py#L1-L180), and [`src/lib/server/agent/transport.ts`](src/lib/server/agent/transport.ts#L145-L169).

The service source exposes:

- `POST /v1/runs/start` for one durable run.
- `POST /v1/runs/:run_id/cancel` for that same run.
- Startup recovery for queued or expired runs.
- `/ready` with service identity, Hermes commit, toolset, provider metadata, extraction state, durable-run state, and tenant-isolation capabilities.

These contracts are in [`services/hermes-chat/src/hermes_chat/service.py`](services/hermes-chat/src/hermes_chat/service.py#L1393-L1505). They describe the intended service behavior. They do not prove that the service is running on Contabo now.

## Release identifiers

### Repository-verified identifiers

The checkout inspected for this document is detached at:

- NewsCraft repository `HEAD`: `59f409bb60767090e6737db3c4b4852bc216ec29`.
- Local commit subject: `Fix iPhone browser and keyboard viewport alignment`.
- Local commit timestamp: `2026-08-19T19:58:41-04:00`.
- Hermes reviewed runtime commit: `5370d535ab926da41abe3ba4d9d975f1f94875d5`, declared in [`services/hermes-chat/src/hermes_chat/__init__.py`](services/hermes-chat/src/hermes_chat/__init__.py#L1-L3) and enforced by [`services/hermes-chat/scripts/install-runtime.sh`](services/hermes-chat/scripts/install-runtime.sh#L1-L78).
- Root package version: `0.0.1`, package manager `pnpm@9.15.9`, in [`package.json`](package.json#L1-L8).
- Hermes service package version: `0.1.0`, in [`services/hermes-chat/pyproject.toml`](services/hermes-chat/pyproject.toml#L5-L17).

These are repository identifiers. They are not proof of the current production source, deployment, alias, process, or traffic.

### Read-only Linear release record

The read-only Linear project record reports the UI commit as `59f409bb60767090e6737db3c4b4852bc216ec29` and the Vercel deployment identifier `dpl_3wMWkU6vjmTvEHEymFuw8QsAhaX1`. These are reported identifiers, not live evidence. The current Vercel deployment ID, alias, source hash, traffic, and health remain **unverified** because no live deployment check was authorized or performed.

## Claim status

### Working: repository-backed

- The chat-first UI and authenticated conversation routes exist.
- NewsCraft has a server-only Hermes transport and no legacy agent fallback.
- Durable NewsCraft run tables, idempotency, leases, cursors, cancellation, callbacks, and replay subscription code exist.
- The Hermes service has explicit tool, model, tenant, retrieval, browser, durable-run, and readiness contracts.
- Local extraction and bounded Wayback fallback are implemented in the Hermes plugin.
- Exa and Browser Use are explicit optional provider paths. Their values are not in this document.
- Hydra is outside the NewsCraft runtime boundary.

“Working” here means repository implementation or contract evidence. It does not mean a current production probe passed.

### Failed or not green

The read-only Linear project record dated 2026-08-22 reports that the legacy newsroom harness had three failing answer-quality assertions and that the complete live production matrix had not been rerun. This remains historical evidence. It was superseded for the Phase 0 repository test baseline by the accepted 2026-08-24 canonical JIG-178 result: the focused newsroom-harness fixture run passed 46/46, and canonical `corepack pnpm test` exited 0 with root 373 passed and 27 skipped, shared 5 passed, and newsroom harness 343 passed and 2 skipped. The live production matrix remains explicitly blocked and unrun; no live release or deployment claim follows. The existing JIG-178 fixture patch is preserved in [`services/newsroom-harness/tests/agent-harness.test.ts`](services/newsroom-harness/tests/agent-harness.test.ts).

The root command also still includes the harness suite. This is a repository gate-design fact, not proof of a live harness deployment.

### Blocked

The following claims are blocked until an authorized live or data gate exists:

- Current Vercel deployment, alias, deployed source hash, route rewrites, and request traffic.
- Current Contabo Hermes process, `/ready` response, service package, restart behavior, and host identity.
- Current Supabase project, connection, schema state, row counts, backups, restore status, and data ownership.
- Current Exa or Browser Use selection, account state, request traffic, or provider health.
- Current production p50/p95 latency, queue wait, stream gaps, retries, cancellation, isolation, and restart recovery.
- Whether any old `/api/agent/*` route, `AGENT_GATEWAY_*` name, or `NEWSROOM_HARNESS_*` name receives live traffic.

No code or external system was changed to clear these blocks.

### Historical

[`ROADMAP.md`](ROADMAP.md) is an older, unmodified planning document. Its July 2026 sections describe a frozen Story Tracker, a separate newsroom-harness Vercel deployment, an old gateway, and old provider behavior. Examples are [`ROADMAP.md`](ROADMAP.md#L14-L30), [`ROADMAP.md`](ROADMAP.md#L148-L203), and [`ROADMAP.md`](ROADMAP.md#L403-L444). Those sections are historical repository text. They are not current production evidence.

The read-only Linear document [“NewsCraft product and reliability roadmap — 2026-08-22”](https://linear.app/jigars-project/document/newscraft-product-and-reliability-roadmap-2026-08-22-09af900243be) states that the old Story Tracker and legacy harness plan is superseded by a chat-first product with NewsCraft-owned durable state and a separate Hermes runtime. The [JIG-176 issue](https://linear.app/jigars-project/issue/JIG-176/create-one-truthful-source-of-truthmd-for-chat-and-hermes) is the acceptance source for this document. Linear evidence was read during this audit. The orchestrator later updated the Phase 0 issue statuses and comments; this document did not make those updates.

### Unverified

The following statements are deliberately not asserted as current facts:

- Vercel is serving this checkout or any particular deployment.
- Supabase Postgres is the current live database or has the repository migration state.
- Contabo is serving the Hermes process described by the repository.
- Exa, Browser Use, local extraction, or Wayback is selected in a live service.
- Any provider key, token, model endpoint, database URL, or deployment environment variable has a particular value.
- Any legacy route or harness deployment is absent, unused, or safe to delete.
- The current production source hash matches the local `HEAD`.
- The current production runtime has passed the historical Linear checks.

## Environment boundary

The repository defines names for the active server-to-Hermes boundary and optional retrieval providers. This document records names only; it does not inspect values.

Active name groups include:

- NewsCraft-to-Hermes: `NEWSCRAFT_HERMES_URL`, `NEWSCRAFT_HERMES_API_TOKEN`, `NEWSCRAFT_HERMES_TENANT_SECRET`, `NEWSCRAFT_HERMES_RUN_API_URL`, and `NEWSCRAFT_HERMES_RUN_API_TOKEN`.
- Hermes service: `HERMES_AGUI_HOST`, `HERMES_AGUI_PORT`, `HERMES_AGUI_SESSION_TOKEN`, `NEWSCRAFT_HERMES_HOME`, `NEWSCRAFT_HERMES_WORKSPACE`, `NEWSCRAFT_HERMES_MODEL_PROVIDER`, `NEWSCRAFT_HERMES_MODEL`, `NEWSCRAFT_HERMES_MODEL_BASE_URL`, `NEWSCRAFT_HERMES_MODEL_API_KEY`, and `NEWSCRAFT_HERMES_MAX_ITERATIONS`.
- Retrieval and providers: `NEWSCRAFT_HERMES_WEB_PROVIDER`, `NEWSCRAFT_HERMES_BROWSER_PROVIDER`, `NEWSCRAFT_RETRIEVAL_ENABLED`, `NEWSCRAFT_RETRIEVAL_LIVE_TIMEOUT_MS`, `NEWSCRAFT_RETRIEVAL_ARCHIVE_TIMEOUT_MS`, `NEWSCRAFT_RETRIEVAL_MAX_URLS`, `NEWSCRAFT_RETRIEVAL_ARCHIVE_FALLBACK`, `EXA_API_KEY`, and `BROWSER_USE_API_KEY`.
- NewsCraft database and storage: `DATABASE_URL`, `NEWSCRAFT_TEST_DATABASE_URL`, `SUPABASE_URL`, and `SUPABASE_SERVICE_ROLE_KEY`.

The legacy names remain in old route, harness, script, and test code. Important examples are `AGENT_GATEWAY_URL`, `AGENT_GATEWAY_API_KEY`, `NEWSROOM_HARNESS_URL`, `NEWSROOM_HARNESS_API_KEY`, `NEWSROOM_HARNESS_DB_PATH`, `NEWSROOM_HARNESS_DATABASE_URL`, `NEWSROOM_MODEL_PROVIDER`, `OPENAI_API_KEY`, `PERPLEXITY_API_KEY`, and `NEWSROOM_UI_INGEST_KEY`. Their repository presence does not prove live use. See the complete disposition in [`docs/legacy-runtime-disposition.md`](docs/legacy-runtime-disposition.md#L186-L228).

## Test and release evidence

The repository contains these test groups:

- 73 TypeScript test files under `src` and `packages/shared`.
- 30 Vitest files under `services/newsroom-harness/tests`.
- 7 Hermes Python test or smoke files under `services/hermes-chat/tests`.
- Playwright browser tests under [`tests/e2e`](tests/e2e).

The root [`package.json`](package.json#L17-L26) defines `pnpm test` as the root Vitest run, shared tests, and the legacy harness test package. The active Hermes groups include service, isolation, product prompt, retrieval, Docker staging, and the separately authorized live smoke file under [`services/hermes-chat/tests`](services/hermes-chat/tests). A test file’s presence is not a test result.

Prior evidence after the accepted JIG-178 canonical integration records that the focused newsroom-harness fixture run from `services/newsroom-harness` passed 46/46. It also records that canonical `corepack pnpm test` exited 0: the root suite had 373 passed and 27 skipped tests, the shared package had 5 passed tests, and the newsroom harness had 343 passed and 2 skipped tests. These are prior results, not rerun results for this document.

No test command was rerun for this document. No browser, check, build, database, deployment, provider, health, or live-system gate was rerun for this document. The JIG-176 verification is limited to read-only repository inspection, read-only Linear inspection, link/path checks, protected-file preservation, and Markdown whitespace checks. The final task report records those commands and results.

## Decision boundary

Hermes and NewsCraft durable state are the only active product runtime boundary described by this document. The old harness, Story Tracker, agent-job routes, legacy tables, gateway names, and old deployment files remain repository surfaces until the separate disposition and live-use gates are complete.

This document does not authorize deletion, migration, deployment, provider changes, credential changes, database changes, schema changes, data changes, Linear changes, or production changes. Historical migration files remain historical records. Any future removal must follow the ordered gates in [`docs/legacy-runtime-disposition.md`](docs/legacy-runtime-disposition.md#L268-L327).
