# Legacy runtime disposition

Status: JIG-179 decision record complete. Implementation and removal remain gated. No runtime, route, schema, deployment, provider, credential, database, or data change is made by this document.

Repository: current isolated checkout

Date: 2026-08-25

Scope: JIG-179. This document covers the legacy newsroom harness, the old NewsCraft agent-job surface, and the references that can keep that runtime alive.

## Decision boundary

The only active product runtime is:

1. The NewsCraft SvelteKit application for auth, approvals, conversations, user-facing data, and durable run state.
2. The Hermes service for agent execution, tools, tenant isolation, and durable worker execution.
3. NewsCraft Postgres tables `hermes_runs` and `hermes_run_events` for durable run state and replay.

The legacy harness is not an active product runtime. It may remain temporarily as a quarantined local or evaluation surface until its consumers are migrated and its live deployment status is verified.

This is a repository audit plus a bounded read-only production check. It does not prove that a live deployment is absent or unused. The earlier local CLI pass did not obtain live deployment data. The later read-only Vercel API evidence below records current deployment metadata and a bounded log result, but it does not prove long-term non-use.

## Acceptance result

| JIG-179 acceptance item | Result | Evidence and limit |
|---|---|---|
| Inventory every legacy route, table, component, service, and test. | Pass | The route, product surface, service/source, table, build/configuration, and test inventories below classify each repository surface. |
| Mark each item keep, migrate, quarantine, or remove. | Pass | Every inventory row has an explicit disposition and a verification or rollback gate. “Remove” remains conditional and is not authorization to delete. |
| Prove whether any production request still depends on it. | Pass: **yes** | Exact source for the current production deployment mounts Composer and issues app-local `GET /api/agent/commands`. This proves a current deployed product dependency on one legacy app route. It does not prove traffic to the separate harness deployment. |
| Keep Hermes as the only product agent runtime. | Pass | Active chat, health, and durable execution paths use NewsCraft-mediated Hermes. The command route returns local metadata and does not execute agent work. Legacy network transport remains fail-closed. |
| Produce a small removal sequence with rollback points. | Pass | The ordered removal sequence and rollback table below keep consumer migration, live-use, data, and rollback-window gates conjunctive. |
| Do not delete anything until dependencies and production usage are proven. | Pass | This record authorizes no deletion. The confirmed command-route dependency and unknown longer-term harness/external traffic keep all removal gates closed. |

## JIG-179 read-only production-dependency evidence

This section records the bounded read-only pass on 2026-08-25 UTC. It does not change the live-state limit above. No production use, production absence, or route retirement is proven.

### Local Vercel scope metadata

The repository has two linked Vercel project records in the shared team scope. These are non-secret local identifiers. The later read-only API evidence below independently confirms the named current production deployments.

| Scope | Project | Project ID | Shared team scope | Evidence |
|---|---|---|---|---|
| NewsCraft app | newscraft-ai | prj_pywLQLbNvNjJQObIjfs2XZIyaT9D | team_51SGoYrM9iWXGMMLmzaumD2c | [.vercel/project.json:1](../.vercel/project.json#L1) |
| Legacy harness | newscraft-harness | prj_6Rx21B0q2AaXmZzFYV7Q5F6zw2i2 | team_51SGoYrM9iWXGMMLmzaumD2c | [services/newsroom-harness/.vercel/project.json:1](../services/newsroom-harness/.vercel/project.json#L1) |

The repository deployment files are [vercel.json:1](../vercel.json#L1) for the app and [services/newsroom-harness/vercel.json:1](../services/newsroom-harness/vercel.json#L1) for the separate harness. They describe local build and routing intent. They do not identify the current production deployment, alias, source hash, or traffic state.

### Candidate production hosts

These are repository-backed host candidates. The later API evidence confirms the named current production domains. Any additional alias not listed there remains unverified.

- agent.newscraftai.com is the historical NewsCraft UI host in [ROADMAP.md:150](../ROADMAP.md#L150), and the later API evidence confirms it as a current NewsCraft production domain.
- newscraft-harness.vercel.app is the fallback host used by the serverless handler in [services/newsroom-harness/src/serverless.ts:29](../services/newsroom-harness/src/serverless.ts#L29). The later API evidence confirms it as the current named harness production domain; the source default alone was not proof of that alias.
- newscraftai.com and www.newscraftai.com are named as a separate landing project in [ROADMAP.md:175-L176](../ROADMAP.md#L175-L176). They are an adjacent production scope, not a repository-confirmed harness host.
- newscraft-harness.test is a test fixture host in [services/newsroom-harness/tests/serverless.test.ts:28](../services/newsroom-harness/tests/serverless.test.ts#L28), not a production candidate.

The exact legacy request patterns that require live checking remain the NewsCraft /api/agent/* routes in the app route inventory and the harness /health, /v1/chat/completions, /v1/responses, and local /api/* surfaces listed below. Dynamic IDs must be checked by path prefix as well as by exact recorded requests.

### Earlier local CLI result (historical)

The local Vercel CLI was 53.1.0. The update check was disabled for the process with NO_UPDATE_NOTIFIER=1 VERCEL=1; no environment value was read.

- NO_UPDATE_NOTIFIER=1 VERCEL=1 vercel whoami ran from 2026-08-25T02:45:37Z to 2026-08-25T02:45:51Z and exited 0, but returned no account identity.
- NO_UPDATE_NOTIFIER=1 VERCEL=1 vercel list newscraft-ai --scope team_51SGoYrM9iWXGMMLmzaumD2c --status READY --format=json ran from 2026-08-25T02:45:52Z to 2026-08-25T02:45:59Z and exited 1 before project lookup: request to https://vercel.com/.well-known/openid-configuration failed, reason: getaddrinfo ENOTFOUND vercel.com.
- NO_UPDATE_NOTIFIER=1 VERCEL=1 vercel list newscraft-harness --scope team_51SGoYrM9iWXGMMLmzaumD2c --status READY --format=json ran from 2026-08-25T02:45:59Z to 2026-08-25T02:46:06Z and exited 1 with the same ENOTFOUND vercel.com failure before project lookup.

Therefore, the earlier CLI pass obtained no production deployment ID, alias, deployment source hash, route inspection, log retention window, log match, or log non-match. vercel inspect and vercel logs did not run because there was no returned deployment or alias and the Vercel endpoint was unreachable. That result remains historical evidence of the CLI blocker. It was later supplemented by the successful read-only API evidence below. The earlier result was not a zero-match result, and it did not prove zero production use.

### Later successful read-only Vercel API evidence

An independently verified read-only Vercel API pass on 2026-08-25 returned the following current READY production deployments. It changed no hosted state and did not read environment-variable values.

| Scope | Project ID | Current READY production deployment | Confirmed domain | Source commit |
|---|---|---|---|---|
| NewsCraft app | prj_pywLQLbNvNjJQObIjfs2XZIyaT9D | dpl_3wMWkU6vjmTvEHEymFuw8QsAhaX1 | agent.newscraftai.com, among the returned domains | 59f409bb60767090e6737db3c4b4852bc216ec29 |
| Legacy harness | prj_6Rx21B0q2AaXmZzFYV7Q5F6zw2i2 | dpl_3Ves42MThwtWvgPz1utuFPG91tp3 | newscraft-harness.vercel.app | 59f409bb60767090e6737db3c4b4852bc216ec29 |

The current-deployment 24-hour log queries found no /api/agent entries for the NewsCraft deployment. They found no harness /health, /v1/chat/completions, or /v1/responses entries for the harness deployment. The request-path groupings were empty for those queries. These are bounded 24-hour non-match results only.

The 3-day and 30-day queries warned that the requested window likely exceeds plan retention. The retained window is therefore incomplete for long-term dependency proof. No long-term zero-use conclusion is allowed, and the separate production harness deployment still exists. Keep all legacy app routes and harness surfaces quarantined or migrate-pending-evidence.

### Exact deployed-commit consumer audit

The read-only deployed-source audit used Git object reads at exact commit `59f409bb60767090e6737db3c4b4852bc216ec29`, which is the source commit recorded for both current READY production deployments above. It did not check out the commit, change `HEAD`, read secret values, or make a live request.

| Caller or path | Exact-commit evidence | Context, trigger, and deployment classification |
|---|---|---|
| Composer command discovery | [`src/lib/components/Composer.svelte:139`](../src/lib/components/Composer.svelte#L139) calls `GET /api/agent/commands` from `onMount`. The handler at [`src/routes/api/agent/commands/+server.ts:4-6`](../src/routes/api/agent/commands/+server.ts#L4-L6) returns local command metadata from [`src/lib/server/agent/bridge.ts:56-58`](../src/lib/server/agent/bridge.ts#L56-L58). | Browser request on every mounted Composer. This is a deployed NewsCraft source dependency. It is not a harness or gateway dependency. |
| Legacy board and job helpers | The helper call sites are grouped in [`src/lib/server/agent/board.ts:333-355`](../src/lib/server/agent/board.ts#L333-L355), [`src/lib/server/agent/board.ts:387-443`](../src/lib/server/agent/board.ts#L387-L443), [`src/lib/server/agent/board.ts:643-703`](../src/lib/server/agent/board.ts#L643-L703), and [`src/lib/server/agent/board.ts:713-788`](../src/lib/server/agent/board.ts#L713-L788). | Deployed NewsCraft server routes can trigger these helpers when authenticated legacy board or job requests arrive. Every network path enters fail-closed `agentFetch`, which throws before HTTP at [`src/lib/server/agent/transport.ts:888-891`](../src/lib/server/agent/transport.ts#L888-L891). Source presence is therefore not proof of an outgoing harness request. |
| Channel-post report ingest | [`src/routes/api/agent/channel-posts/+server.ts:71-100`](../src/routes/api/agent/channel-posts/+server.ts#L71-L100) accepts an authenticated external report post and writes app-owned `mission_reports`. | Deployed NewsCraft server path. The route is a possible external caller target, but this audit did not observe a live request. |
| Vercel harness entry | [`services/newsroom-harness/api/index.js:1-6`](../services/newsroom-harness/api/index.js#L1-L6) imports [`services/newsroom-harness/src/serverless.ts:12-63`](../services/newsroom-harness/src/serverless.ts#L12-L63). The handler exposes only `GET /health`, `POST /v1/chat/completions`, and `POST /v1/responses`. | Deployed harness source. The entry does not expose local `/api/jobs`, `/api/runs`, `/api/reports`, `/api/events`, or memory routes, and it does not import the local `JobRunner`. |
| Harness report sender | [`services/newsroom-harness/src/jobs/report.ts:24-54`](../services/newsroom-harness/src/jobs/report.ts#L24-L54) posts to the configured UI ingest URL. [`services/newsroom-harness/src/jobs/runner.ts:84-109`](../services/newsroom-harness/src/jobs/runner.ts#L84-L109) calls it only when both ingest settings are present. | Local harness job path. The Vercel serverless entry above does not expose this local job runner. The local producer fixture targets `/api/agent/channel-posts` at [`scripts/producer-acceptance.mjs:142-147`](../scripts/producer-acceptance.mjs#L142-L147). |
| Harness, gateway, and evaluation names | Harness configuration reads `NEWSROOM_HARNESS_*` and ingest names in [`services/newsroom-harness/src/config.ts:68-113`](../services/newsroom-harness/src/config.ts#L68-L113) and policy names in [`services/newsroom-harness/src/agents/harness-config.ts:145-149`](../services/newsroom-harness/src/agents/harness-config.ts#L145-L149). `AGENT_GATEWAY_*` and local harness settings occur in [`scripts/producer-acceptance.mjs:127-187`](../scripts/producer-acceptance.mjs#L127-L187), evaluation uses `NEWSROOM_HARNESS_URL` in [`services/newsroom-harness/eval/run-eval.mjs:45-49`](../services/newsroom-harness/eval/run-eval.mjs#L45-L49), and Playwright reads gateway names in [`playwright.config.ts:11-12`](../playwright.config.ts#L11-L12). | These are local scripts, tests, evaluation, or harness configuration consumers. The exact-commit search found no NewsCraft app caller of `AGENT_GATEWAY_URL` or `NEWSROOM_HARNESS_URL`. Values were not inspected. |
| Active NewsCraft runtime paths | Chat and health paths use Hermes settings: [`src/routes/api/chat/stream/+server.ts:1234-1280`](../src/routes/api/chat/stream/+server.ts#L1234-L1280), [`src/routes/api/health/+server.ts:58-75`](../src/routes/api/health/+server.ts#L58-L75), and [`src/routes/api/settings/status/+server.ts:5-17`](../src/routes/api/settings/status/+server.ts#L5-L17). | Active server paths use NewsCraft-mediated Hermes, not the legacy harness or `AGENT_GATEWAY_URL`. |

The later `/health` hit reported during an independent reviewer audit is not used as external dependency evidence. It has no caller attribution, so it is recorded only as an audit-time positive-control candidate. It does not override the bounded 24-hour log result or prove production use.

### Exact-commit live-use conclusion

The JIG-179 acceptance question “whether any production request still depends on it” is answered **YES** for the legacy app route set. The exact source commit used by the current READY production deployment mounts Composer and unconditionally issues app-local `GET /api/agent/commands`. The route returns local command metadata. It does not call the harness or execute agent work, so Hermes remains the only product agent runtime.

The separate question “whether product or external traffic still reaches the hosted legacy harness or the other legacy app routes” remains **UNKNOWN**. The current-deployment 24-hour log result and the later 7-day grouped recheck were non-matches, but retained history and caller attribution are incomplete. The audit-time `/health` request is not external dependency evidence.

Keep NewsCraft and Hermes as the only active product runtime. Keep the Composer route consumer, legacy app routes, channel-post ingest, harness deployment, harness environment names, and local evaluation surfaces quarantined or migrate-pending-evidence under the existing gates. No deletion or migration is authorized by this audit.

### Minimum read-only evidence before removal

Before any route, harness surface, environment name, deployment file, or legacy table can move to removal, an authorized read-only pass must:

1. Use a network-reachable, authenticated read-only Vercel API or CLI session and record the query time, project scope, and retention response.
2. List current production deployments for both linked project IDs in team_51SGoYrM9iWXGMMLmzaumD2c. Record every deployment ID, URL, alias, status, target, source or artifact hash, and deployment timestamp.
3. Inspect every current production deployment and confirm the deployed route rewrites, function artifact, project scope, and all aliases. Include any confirmed custom host in the search scope.
4. Query request logs for every current production deployment or alias. Search every legacy path pattern and candidate host for the maximum available retention window. Record the actual oldest and newest log timestamps, timezone, pagination or limit, query method, matches, and non-matches.
5. If Vercel logs do not cover the required period, obtain a separately authorized read-only access-log or observability export for the missing interval. A partial retention window cannot prove no dependency.
6. Complete the replacement, consumer, data, rollback-window, and release-gate checks in this document. Keep the old artifact available through the approved rollback window.

No legacy app route, harness route, harness project, script, environment name, provider setting, table, or deployment file is reclassified as removable by this evidence pass. Existing Quarantine, Migrate, and Migrate, then remove dispositions remain pending complete live evidence. For this pass, Migrate and Migrate or remove mean migrate-pending-evidence; they do not authorize migration or removal. No deletion or migration is authorized.

## Evidence rules

- **Verified** means the current repository contains the cited route, table, consumer, script, or configuration.
- **Inference** means the disposition follows from the verified code structure. It is not a live-traffic claim.
- **Live unknown** means production use requires an authorized deployment, DNS, log, or request check.
- **Production-dependency confidence** describes repository evidence only:
  - **High**: an active app route, migration contract, build script, or test imports the item.
  - **Medium**: a local, evaluation, or deployment reference exists, but no active app call site is visible.
  - **Low**: only stale documentation or an isolated fixture reference remains.
  - None of these levels proves current live use.

## Active runtime evidence

| Component | Disposition | Source evidence | Current consumer | Confidence | Gate and rollback point |
|---|---|---|---|---|---|
| NewsCraft chat route | Keep | [`src/routes/api/chat/stream/+server.ts:1166`](../src/routes/api/chat/stream/+server.ts#L1166) creates or reuses durable Hermes runs. The non-durable path still calls Hermes at [`src/routes/api/chat/stream/+server.ts:1265`](../src/routes/api/chat/stream/+server.ts#L1265). | Browser chat and app conversations | High | Keep app tests, auth tests, and durable replay tests green. Roll back the routing change before any legacy removal if chat persistence or replay regresses. |
| Hermes transport | Keep | [`src/lib/server/agent/transport.ts:888`](../src/lib/server/agent/transport.ts#L888) disables `agentFetch`. Hermes stream and durable start/cancel are at [`src/lib/server/agent/transport.ts:893`](../src/lib/server/agent/transport.ts#L893) and [`src/lib/server/agent/transport.ts:957`](../src/lib/server/agent/transport.ts#L957). | NewsCraft chat routes | High | Run transport, readiness, account-binding, and failure-path tests. Restore the prior app transport revision if Hermes readiness or error handling regresses. |
| Hermes service | Keep | Durable start, cancel, recovery, callbacks, lease renewal, and `/ready` are implemented in [`services/hermes-chat/src/hermes_chat/service.py:1393`](../services/hermes-chat/src/hermes_chat/service.py#L1393) and [`services/hermes-chat/src/hermes_chat/durable.py:271`](../services/hermes-chat/src/hermes_chat/durable.py#L271). | NewsCraft durable worker requests | High | Run the Hermes service, isolation, retrieval, staging, and recovery gates. Roll back the service artifact and systemd unit together if a verified deployment gate fails. |
| NewsCraft durable state | Keep | `hermes_runs` and `hermes_run_events` are defined in [`drizzle/0015_durable_hermes_runs.sql:1`](../drizzle/0015_durable_hermes_runs.sql#L1) and [`src/lib/server/db/schema.ts:224`](../src/lib/server/db/schema.ts#L224). | App durable run repository and reconnect route | High | Require idempotency, cursor replay, cancellation, lease recovery, and account isolation tests. Never replace this state with the harness SQLite or mirror. |

## Legacy route inventory

### NewsCraft app routes

| Route | Product surface and consumer | Source evidence | Disposition | Confidence | Verification gate | Rollback point |
|---|---|---|---|---|---|---|
| `GET /api/agent/board` | Legacy producer board. The route calls `boardData` and requires a session. | [`src/routes/api/agent/board/+server.ts:1`](../src/routes/api/agent/board/+server.ts#L1) | Quarantine, then migrate or remove | High | Find all UI and external callers. Verify no live requests. Replace any retained producer workflow with Hermes durable runs. | Keep the route and board code available until the caller inventory and rollback window close. |
| `GET /api/agent/jobs` | Legacy mission/job listing. | [`src/routes/api/agent/jobs/+server.ts:14`](../src/routes/api/agent/jobs/+server.ts#L14) | Quarantine, then migrate or remove | High | Route test, UI search, live request check, and durable producer replacement. | Revert the route removal before the table migration if a verified consumer remains. |
| `POST /api/agent/jobs` | Creates a legacy job, mission configuration, and app job state. | [`src/routes/api/agent/jobs/+server.ts:26`](../src/routes/api/agent/jobs/+server.ts#L26) | Migrate, then remove | High | Prove that producer creation uses Hermes-backed state and that approvals and durable runs remain account-bound. | Restore the old route only as an explicitly approved emergency bridge. |
| `DELETE /api/agent/jobs` | Deletes all legacy jobs and app job state. | [`src/routes/api/agent/jobs/+server.ts:72`](../src/routes/api/agent/jobs/+server.ts#L72) | Quarantine, then remove | High | Confirm no supported product flow depends on bulk deletion. Test account-scoped deletion in the replacement flow. | Keep the route until the data-retention and account-wipe gates pass. |
| `PATCH /api/agent/jobs/:id` | Updates legacy mission and job configuration. | [`src/routes/api/agent/jobs/[id]/+server.ts:17`](../src/routes/api/agent/jobs/[id]/+server.ts#L17) | Migrate, then remove | High | Migrate name, schedule, prompt, source, and output settings to the approved Hermes producer design. | Revert the route layer if migrated settings cannot round-trip. |
| `DELETE /api/agent/jobs/:id` | Deletes one legacy mission/job and hides the channel ID. | [`src/routes/api/agent/jobs/[id]/+server.ts:109`](../src/routes/api/agent/jobs/[id]/+server.ts#L109) | Quarantine, then remove | High | Verify deletion, hidden-channel behavior, and report retention in the replacement flow. | Restore the old handler before deleting any dependent data. |
| `POST /api/agent/jobs/:id/run` | Starts a legacy job action. | [`src/routes/api/agent/jobs/[id]/run/+server.ts:1`](../src/routes/api/agent/jobs/[id]/run/+server.ts#L1) | Migrate, then remove | High | Prove that a producer request creates one Hermes durable run with idempotency and replay. | Keep the old action until duplicate-run and recovery tests pass. |
| `POST /api/agent/jobs/:id/pause` | Pauses a legacy job. | [`src/routes/api/agent/jobs/[id]/pause/+server.ts:1`](../src/routes/api/agent/jobs/[id]/pause/+server.ts#L1) | Migrate, then remove | High | Define the Hermes-compatible schedule pause contract and test it with account isolation. | Restore the old action if pause state is lost. |
| `POST /api/agent/jobs/:id/resume` | Resumes a legacy job. | [`src/routes/api/agent/jobs/[id]/resume/+server.ts:1`](../src/routes/api/agent/jobs/[id]/resume/+server.ts#L1) | Migrate, then remove | High | Test resume, recovery, and duplicate submission behavior. | Restore the old action until the new resume path is verified. |
| `GET /api/agent/reports/:id` | Reads a legacy mission report. | [`src/routes/api/agent/reports/[id]/+server.ts:1`](../src/routes/api/agent/reports/[id]/+server.ts#L1) | Migrate, then remove | High | Map report access to NewsCraft durable run snapshots and account ownership. | Keep reads until report export and retention are verified. |
| `POST /api/agent/channel-posts` | Legacy harness-to-app report ingest. It authenticates with `NEWSROOM_UI_INGEST_KEY` and writes `mission_reports`. | [`src/routes/api/agent/channel-posts/+server.ts:71`](../src/routes/api/agent/channel-posts/+server.ts#L71) | Quarantine, then remove | High | Stop the harness producer sender only after a Hermes callback or app-owned report path is verified. Check live request logs before removal. | Re-enable the ingest route only as an approved rollback bridge; do not restore it as the active runtime. |
| `GET /api/agent/commands` | Composer command discovery. | [`src/routes/api/agent/commands/+server.ts:1`](../src/routes/api/agent/commands/+server.ts#L1) and [`src/lib/components/Composer.svelte:139`](../src/lib/components/Composer.svelte#L139) | Migrate | High | Move command metadata to the active NewsCraft/Hermes contract and test the Composer. | Keep the route until the Composer no longer requests it. |
| `GET /api/agent/skills` | Legacy agent skill listing. | [`src/routes/api/agent/skills/+server.ts:1`](../src/routes/api/agent/skills/+server.ts#L1) | Migrate or remove | Medium | Search current UI consumers and compare with Hermes skill tools. | Retain the endpoint until the consumer search is complete. |
| `GET /api/agent/skills/:slug` | Legacy agent skill detail. | [`src/routes/api/agent/skills/[slug]/+server.ts:1`](../src/routes/api/agent/skills/[slug]/+server.ts#L1) | Migrate or remove | Medium | Verify no UI or external caller needs this response. | Keep the route until the skill consumer gate passes. |

### Local newsroom-harness routes

The local harness server exposes both chat and legacy persistence routes. The route table is in [`services/newsroom-harness/src/server.ts:130`](../services/newsroom-harness/src/server.ts#L130).

| Route pattern | Disposition | Current consumer and evidence | Confidence | Verification gate and rollback |
|---|---|---|---|---|
| `GET /health` | Quarantine | Local harness health and producer acceptance startup check. | Medium | Keep until all local/eval callers move to Hermes health. Roll back by restoring the local command only. |
| `POST /v1/chat/completions` | Quarantine | Harness-compatible chat transport used by harness tests and old gateway assumptions. | High | Prove no app runtime calls it. Migrate tests and evals to Hermes or a local fixture adapter. |
| `POST /v1/responses` | Quarantine | Harness-compatible response transport in [`services/newsroom-harness/src/server.ts:138`](../services/newsroom-harness/src/server.ts#L138). | Medium | Run response contract tests, search all callers, and remove only after eval migration. |
| `GET /api/jobs` and `POST /api/jobs` | Quarantine | Harness-local job persistence and creation. | High | Prove no supported producer flow uses the local job API. Restore the local server only if an authorized eval requires it. |
| `GET /api/runs` | Quarantine | Harness-local run listing. | High | Compare any retained report workflow with Hermes run listing and account scoping. |
| `GET /api/reports` | Quarantine | Harness-local report listing. | High | Verify report consumers use NewsCraft durable snapshots. |
| `GET /api/events` | Quarantine | Harness append-only event feed. | High | Verify no UI, eval, or delivery consumer depends on it. |
| `GET` and `POST /api/memory/stories/:id` and `/inspect` | Quarantine | Harness story memory API. | Medium | Map any retained memory requirement to Hermes tenant-scoped memory. Do not move data without a separate authorization. |
| `PATCH` and `DELETE /api/jobs/:id` | Quarantine | Harness job mutation. | High | Verify local eval and producer callers are migrated. |
| `POST /api/jobs/:id/run` | Quarantine | Harness manual execution. | High | Replace with an idempotent Hermes durable start. |
| `POST /api/jobs/:id/pause` and `/resume` | Quarantine | Harness local scheduler state. | Medium | Define replacement schedule semantics and test pause/resume recovery. |

The deployed serverless handler is narrower. It exposes only `/health`, `/v1/chat/completions`, and `/v1/responses`, and returns `404` for the local persistence routes. This is verified in [`services/newsroom-harness/src/serverless.ts:27`](../services/newsroom-harness/src/serverless.ts#L27) and [`services/newsroom-harness/src/serverless.ts:88`](../services/newsroom-harness/src/serverless.ts#L88). This repository fact does not prove the current hosted deployment has the same artifact.

## Product surface inventory

| Product surface | Current consumer | Disposition | Confidence | Gate and rollback |
|---|---|---|---|---|
| Producer board and mission list | `/api/agent/board`, `/api/agent/jobs`, legacy board helpers in [`src/lib/server/agent/board.ts`](../src/lib/server/agent/board.ts) | Migrate, then remove | High | Browser and API consumer inventory; producer workflow acceptance on Hermes; retain old route until replacement is verified. |
| Scheduled mission/job controls | Job create, update, run, pause, resume, and delete routes | Migrate, then remove | High | Define durable Hermes scheduling and account-scoped controls. Roll back route changes before removing tables. |
| Mission reports and channel posts | `/api/agent/reports/:id` and `/api/agent/channel-posts` | Migrate, then remove | High | Verify report persistence, display, export, and account ownership. Keep legacy ingest during a bounded rollback window. |
| Composer command menu | [`src/lib/components/Composer.svelte:139`](../src/lib/components/Composer.svelte#L139) requests `/api/agent/commands`. | Migrate | High | Replace the command source and run Composer tests. Roll back the UI consumer before removing the route. |
| Legacy agent skill browser | `/api/agent/skills` and `/api/agent/skills/:slug` | Migrate or remove | Medium | Search browser and API callers; compare with Hermes skill tools. |
| Harness CLI `agent:ask` | [`services/newsroom-harness/src/agent-ask.ts`](../services/newsroom-harness/src/agent-ask.ts) | Quarantine | Medium | Keep for local debugging only until an Hermes CLI or fixture runner exists. |
| Harness golden-prompt evaluation | [`services/newsroom-harness/eval/run-eval.mjs`](../services/newsroom-harness/eval/run-eval.mjs) and `golden-prompts.json` | Migrate | Medium | Port prompts to Hermes fixtures. Preserve comparison results before retiring the old runner. |
| Harness source-monitor and scheduled research | Harness `src/jobs/**`, `src/tools/**`, and source adapters | Quarantine, then migrate only needed behavior | Medium | Identify exact producer requirements. Do not copy the harness scheduler or persistence model into Hermes. |
| Harness evidence and answer utilities | Harness `src/agents/**`; the app test directly imports `grounded-conversation.ts` and `evidence.ts` at [`src/lib/server/conversation-context.test.ts:11`](../src/lib/server/conversation-context.test.ts#L11). | Migrate | High for test coupling; live unknown for runtime use | Move only required shared contracts/utilities to an app-owned or shared location. Keep behavior tests before changing imports. |

## Service and source inventory

| Service or source set | Disposition | Source evidence and consumers | Confidence | Verification gate | Rollback point |
|---|---|---|---|---|---|
| `services/hermes-chat` | Keep | Python service, durable worker, isolation, retrieval, and service tests. [`services/hermes-chat/src/hermes_chat/service.py:1307`](../services/hermes-chat/src/hermes_chat/service.py#L1307) | High | Hermes unit, isolation, staging, readiness, callback, and restart tests. | Restore the previous Hermes artifact and unit as one release. |
| `services/newsroom-harness/src/server.ts` | Quarantine | Local server exposes legacy jobs, reports, events, memory, and scheduler dependencies. | High | Prove no active app or producer caller starts this server. | Keep the local entrypoint until eval and producer migration gates close. |
| `services/newsroom-harness/src/serverless.ts` | Quarantine | Vercel handler creates the legacy runtime and exposes compatibility chat endpoints. | High | Verify hosted deployment artifact and request logs before retirement. | Repoint a verified non-production eval to the last artifact if needed. |
| `services/newsroom-harness/src/chat.ts` and `src/util/openai-*.ts` | Quarantine | Legacy OpenAI/Perplexity-compatible chat and stream implementation. | High | Prove no active app request reaches the harness provider path. | Restore the old local/eval package only for an approved rollback. |
| `services/newsroom-harness/src/agents/**` | Quarantine, migrate selected contracts | Router, planner, runtime, answer, evidence, policy, and stream code. Direct app test imports are present. | High | Migrate only required shared utilities and preserve evidence tests. | Keep the directory intact until consumer imports are removed. |
| `services/newsroom-harness/src/jobs/**` | Quarantine, then remove | Job runner, scheduler, schedule parsing, and report generation support local legacy jobs. | High | Producer and scheduler consumer inventory; Hermes replacement tests. | Keep code and local database until the schedule migration gate passes. |
| `services/newsroom-harness/src/db/database.ts`, `repository.ts`, `factory.ts` | Quarantine, then remove | SQLite schema and repository are used by local job, run, report, event, and memory routes. | High | No runtime imports outside the quarantined service; data-retention signoff. | Do not delete until a backup and restore plan is approved. |
| `services/newsroom-harness/src/db/supabase-mirror.ts` | Remove after migration | Optional local SQLite to Postgres `harness` mirror. [`services/newsroom-harness/src/db/factory.ts:15`](../services/newsroom-harness/src/db/factory.ts#L15) selects it only when `NEWSROOM_HARNESS_DATABASE_URL` is set. | High static; live unknown | Verify no deployment environment uses the variable and no data is authoritative there. | Retain the mirror package until the live-variable gate closes. |
| `services/newsroom-harness/src/tools/**` | Quarantine, migrate selected retrieval behavior | RSS, Atom, HTML, PDF, sitemap, PR-wire, Bluesky, web-search, fetch, and extraction adapters. | Medium | Map each needed capability to Hermes or NewsCraft retrieval. Run source and citation regression tests. | Keep old adapters until equivalent tests pass. |
| `services/newsroom-harness/src/config.ts`, `agents/model-policy.ts`, provider utilities | Quarantine | Own legacy OpenAI/Perplexity selection, model aliases, and scheduled spend controls. | High | Verify no Hermes environment or app runtime reads these settings. | Restore only for local harness evaluation. |
| `services/newsroom-harness/prompts/**` | Quarantine, migrate selected text | `newsroom-charter.md` and `newsroom-report.md` are copied by the harness build and used by the legacy runtime. | Medium | Compare retained newsroom behavior with Hermes product prompt tests. | Keep prompt files until comparison evidence is stored. |
| `packages/shared` | Keep; migrate stale harness health contract | Shared package is built by app and harness. [`packages/shared/src/health.ts:1`](../packages/shared/src/health.ts#L1) still names `newsroom-harness`. | High package use; medium stale-contract risk | Update consumers in a separate change after confirming the Hermes health contract. | Keep the current contract until all readers accept the Hermes service name. |

## Table inventory

### Legacy harness SQLite and mirror tables

The local harness creates the following tables in [`services/newsroom-harness/src/db/database.ts:16`](../services/newsroom-harness/src/db/database.ts#L16). The optional mirror creates the same logical set in the Postgres `harness` schema.

| Table | Use | Disposition | Confidence | Gate and rollback |
|---|---|---|---|---|
| `jobs` | Legacy scheduled story/job definition | Quarantine, then remove | High | No active producer consumer; schedule migration; preserve a recoverable export before any drop. |
| `runs` | Legacy job execution state | Quarantine, then remove | High | Replace with `hermes_runs`; test idempotency, recovery, and cancellation. |
| `run_steps` | Legacy planner/job step state | Quarantine, then remove | High | Map only required progress data to Hermes events or NewsCraft snapshots. |
| `tool_calls` | Legacy tool execution ledger | Quarantine, then remove | High | Confirm Hermes callback/tool snapshots cover required observability. |
| `source_snapshots` | Legacy fetched-page cache | Quarantine, then remove | Medium | Compare with NewsCraft provenance and Hermes retrieval storage. Do not delete source history without retention approval. |
| `sources` | Legacy run source records | Quarantine, then remove | High | Map to durable citations and provenance. |
| `reports` | Legacy generated report storage | Quarantine, then remove | High | Verify report display/export migration. |
| `events` | Append-only legacy event feed | Quarantine, then remove | High | Compare event consumers with `hermes_run_events`; preserve replay semantics. |
| `usage_ledger` | Legacy provider/model usage and cost records | Quarantine, then remove | Medium | Define the active usage ledger owner before removal. |
| `memory_entries` | Legacy story memory | Quarantine, then migrate selected behavior | Medium | Verify Hermes tenant-scoped memory requirements and data policy. |

`ensureLegacyWorkspaceColumns()` also mutates the legacy SQLite schema by adding `workspace_id` to `jobs`, `events`, and `memory_entries` when missing. This is further evidence that the harness database is an independently evolving runtime, not the Hermes durable state model.

### NewsCraft app legacy tables

These tables remain in the Drizzle schema and migration contract. They have active static consumers in the legacy route and board code, so they are not safe to remove from code or data based on repository inspection alone.

| Table | Source evidence | Current consumers | Disposition | Confidence | Gate and rollback |
|---|---|---|---|---|---|
| `agent_channel_posts` | [`src/lib/server/db/schema.ts:355`](../src/lib/server/db/schema.ts#L355); created in [`drizzle/0002_calm_juggernaut.sql:1`](../drizzle/0002_calm_juggernaut.sql#L1) | Legacy report compatibility in `mission-reports.ts` and channel-post ingest | Quarantine, then remove | High static; live unknown | Confirm no legacy ingest requests and migrate report reads. Use a forward migration only after data signoff. |
| `agent_channel_configs` | [`src/lib/server/db/schema.ts:499`](../src/lib/server/db/schema.ts#L499); created in `drizzle/0004_lowly_mikhail_rasputin.sql` | Legacy mission configuration fallback in `missions.ts` | Quarantine, then remove | High static; live unknown | Prove all configuration reads use the replacement. Roll back before removing the table. |
| `agent_channel_sources` | [`src/lib/server/db/schema.ts:509`](../src/lib/server/db/schema.ts#L509) | Legacy source configuration fallback | Quarantine, then remove | High static; live unknown | Migrate source configuration and test ordering/account scope. |
| `missions` | [`src/lib/server/db/schema.ts:381`](../src/lib/server/db/schema.ts#L381); created and populated in `drizzle/0005_missions.sql` | Legacy job route, board, reports, account wipe, and mission helpers | Migrate, then remove | High static; live unknown | Complete producer migration and account-wipe tests. Never rewrite applied migration history. |
| `mission_sources` | [`src/lib/server/db/schema.ts:402`](../src/lib/server/db/schema.ts#L402) | Legacy mission source configuration | Migrate, then remove | High static; live unknown | Prove source configuration parity and account isolation. |
| `mission_runs` | [`src/lib/server/db/schema.ts:423`](../src/lib/server/db/schema.ts#L423) | Legacy mission run compatibility | Migrate, then remove | Medium static; live unknown | Map needed run history to Hermes durable state and reports. |
| `mission_reports` | [`src/lib/server/db/schema.ts:443`](../src/lib/server/db/schema.ts#L443) | Legacy reports, channel-post ingest, board data, and account wipe | Migrate, then remove | High static; live unknown | Verify report retention, display, export, and account deletion. |
| `agent_jobs` | [`src/lib/server/db/schema.ts:475`](../src/lib/server/db/schema.ts#L475); created in [`drizzle/0011_agent_jobs.sql:1`](../drizzle/0011_agent_jobs.sql#L1) | Legacy runtime state helpers and job routes | Migrate, then remove | High static; live unknown | Replace state transitions with the approved Hermes producer contract. |

The migrations in [`drizzle/0005_missions.sql`](../drizzle/0005_missions.sql) copy older channel data into mission tables. The migration files are historical records and must not be deleted or rewritten. Any table removal must use a new, separately approved forward migration after the data gate.

### Active durable tables

| Table | Disposition | Source evidence | Rule |
|---|---|---|---|
| `hermes_runs` | Keep | [`drizzle/0015_durable_hermes_runs.sql:1`](../drizzle/0015_durable_hermes_runs.sql#L1) | Only active durable run record. |
| `hermes_run_events` | Keep | [`drizzle/0015_durable_hermes_runs.sql:43`](../drizzle/0015_durable_hermes_runs.sql#L43) | Only active durable replay/event record. |

## Script, build, and deployment inventory

| File or command | Current consumer | Disposition | Confidence | Verification gate | Rollback point |
|---|---|---|---|---|---|
| [`scripts/dev-all.mjs`](../scripts/dev-all.mjs#L10) | Starts the UI and Hermes. It does not start the harness. | Keep | High | Keep Hermes health and local isolation checks green. | Restore the prior dev launcher if local startup regresses. |
| [`scripts/check-health.mjs`](../scripts/check-health.mjs#L1) | Checks UI and Hermes health. | Keep | High | Run both expected service contracts. | Revert only the checker change if health parsing changes. |
| [`scripts/producer-acceptance.mjs`](../scripts/producer-acceptance.mjs#L116) | Starts the harness on port 8650, sets `AGENT_GATEWAY_URL`, calls legacy job routes, and checks harness reports. | Migrate, then remove | High | Port producer acceptance to Hermes durable start/replay and NewsCraft report state. | Keep the script until the replacement acceptance suite passes. |
| [`scripts/run-db-migrations.ts`](../scripts/run-db-migrations.ts#L1) | Root `db:migrate` invokes it through the newsroom-harness package filter. | Migrate | High | Remove the package coupling while preserving the NewsCraft migration runner and migration contract. | Restore the current command before changing migration ownership. |
| [`services/newsroom-harness/eval/run-eval.mjs`](../services/newsroom-harness/eval/run-eval.mjs#L1) | Fixture/full harness evaluation. | Migrate, then quarantine | Medium | Port the 25-prompt evaluation to Hermes fixtures and compare results. | Keep the old runner until comparison evidence is stored. |
| [`services/newsroom-harness/eval/golden-prompts.json`](../services/newsroom-harness/eval/golden-prompts.json#L1) | Legacy evaluation inputs. | Migrate | Medium | Preserve prompt IDs and expected safety/citation assertions in the Hermes suite. | Retain the source file until parity is verified. |
| [`services/newsroom-harness/src/agent-ask.ts`](../services/newsroom-harness/src/agent-ask.ts#L1) | Harness CLI entrypoint. | Quarantine, then remove | Medium | Find local users and replace with an approved Hermes fixture or CLI. | Keep the CLI during the local evaluation window. |
| [`services/newsroom-harness/src/index.ts`](../services/newsroom-harness/src/index.ts#L1) | Local harness process entrypoint. | Quarantine, then remove | High | No active `dev:all`, production, or acceptance caller remains. | Keep until the harness service is retired. |
| [`services/newsroom-harness/package.json`](../services/newsroom-harness/package.json#L9) | Defines harness dev, build, start, agent, and test commands. | Quarantine, then remove | High | Remove root package references first and run the replacement test commands. | Retain package metadata until all imports and scripts are gone. |
| [`package.json`](../package.json#L19) | Root `test` includes the harness; `db:migrate` filters through it. | Migrate | High | Split active app/Hermes gates from the quarantined suite without hiding failures. | Restore the old gate if the replacement omits a required active test. |
| [`services/newsroom-harness/vercel.json`](../services/newsroom-harness/vercel.json#L1) | Builds and rewrites the separate harness serverless deployment. | Quarantine, then remove | High static; live unknown | Inspect the authorized hosted project, deployment hash, routes, env names, and request logs. | Keep the last artifact available until live absence is verified. |
| [`services/newsroom-harness/api/index.js`](../services/newsroom-harness/api/index.js#L1) | Vercel handler for the harness serverless runtime. | Quarantine, then remove | High static; live unknown | Verify no hosted route points to it. | Restore the previous deployment artifact only as an approved emergency rollback. |
| [`services/newsroom-harness/public/index.txt`](../services/newsroom-harness/public/index.txt#L1) | Static output placeholder for the harness deployment. | Quarantine, then remove | Low | Confirm the deployment no longer uses the harness project. | Retain until deployment retirement is verified. |
| [`services/newsroom-harness/vitest.config.ts`](../services/newsroom-harness/vitest.config.ts#L1) | Harness test discovery and aliases. | Quarantine, then remove | High static | Retain while the harness tests remain in the gate. | Keep until the final harness suite disposition is approved. |
| [`services/newsroom-harness/tsconfig.json`](../services/newsroom-harness/tsconfig.json#L1) | Harness build configuration. | Quarantine, then remove | High static | Remove only with the package and build entrypoint. | Keep while any local harness build remains. |
| [`services/newsroom-harness/HARNESS_REPOSITORY.md`](../services/newsroom-harness/HARNESS_REPOSITORY.md#L1) | Documents SQLite-first and optional Postgres mirror behavior. | Migrate documentation, then remove | Medium | Replace with the active Hermes durable-state contract. | Keep as historical reference until the replacement document is accepted. |
| [`vercel.json`](../vercel.json#L1) | Root UI deployment headers. | Keep | High | Keep UI deployment checks separate from harness retirement. | Revert only if UI deployment behavior changes. |
| [`services/hermes-chat/deploy/newscraft-hermes-chat.service`](../services/hermes-chat/deploy/newscraft-hermes-chat.service#L1), `.user.service`, and `Caddyfile.example` | Hermes service and reverse-proxy deployment references. | Keep | High | Run authorized Hermes readiness, service, isolation, and deployment checks. | Restore the prior Hermes unit and proxy configuration together. |
| [`services/hermes-chat/tests/fixtures/Dockerfile.staging`](../services/hermes-chat/tests/fixtures/Dockerfile.staging#L1) | Hermes staging smoke fixture. | Keep as test-only | Medium | Keep staging isolation and durable callback tests. | Restore the previous fixture image definition if staging tests regress. |
| [`ROADMAP.md`](../ROADMAP.md#L148) | Contains historical harness topology and a future Phase C cleanup plan. | Migrate documentation | Medium | Mark historical production statements and align the roadmap with this disposition. | Keep the original roadmap until an approved documentation update replaces it. |
| [`docs/durable-hermes-streaming.md`](../docs/durable-hermes-streaming.md#L18) | Defines the active durable run ownership and replay contract. | Keep | High | Use as the active contract for producer and runtime migrations. | Revert only an approved contract revision. |

## Environment-variable inventory

Values were not inspected. The names below come from tracked templates and code references.

### Legacy harness names

| Names | Disposition | Source and current consumer | Confidence | Gate and rollback |
|---|---|---|---|---|
| `NEWSROOM_HARNESS_HOST`, `NEWSROOM_HARNESS_PORT`, `NEWSROOM_HARNESS_DB_PATH` | Quarantine | Harness local server and SQLite configuration in [`services/newsroom-harness/.env.example:1`](../services/newsroom-harness/.env.example#L1). | High | Prove no supported local or hosted harness consumer remains. Restore only for approved local evaluation. |
| `NEWSROOM_HARNESS_DATABASE_URL` | Remove after mirror gate | Optional SQLite-to-Postgres mirror selector in [`services/newsroom-harness/src/config.ts:90`](../services/newsroom-harness/src/config.ts#L90). | High static; live unknown | Verify deployment metadata and logs show no use. Do not inspect secret values. Keep the name during rollback window. |
| `NEWSROOM_HARNESS_API_KEY`, `NEWSROOM_HARNESS_DEPLOYED` | Quarantine, then remove | Harness private endpoint and deployment validation. | High | Verify no hosted harness endpoint requires the key and no deployment sets the flag. Restore only for a quarantined artifact. |
| `NEWSROOM_MODEL_PROVIDER`, `OPENAI_API_KEY`, `PERPLEXITY_API_KEY` | Quarantine in harness; keep shared app/provider names only where independently owned | Harness provider selection in [`services/newsroom-harness/src/config.ts:71`](../services/newsroom-harness/src/config.ts#L71). | High for harness use; live unknown | Verify Hermes uses only its explicit `NEWSCRAFT_HERMES_*` settings. Do not change provider values in this task. |
| `NEWSROOM_UI_INGEST_URL`, `NEWSROOM_UI_INGEST_KEY` | Quarantine, then migrate | Harness report delivery to `/api/agent/channel-posts` in [`services/newsroom-harness/.env.example:22`](../services/newsroom-harness/.env.example#L22). | High static; live unknown | Prove no report sender uses the route. Replace with app-owned Hermes callback/report persistence. |
| `NEWSROOM_HARNESS_RUN_TIMEOUT_MS`, `NEWSROOM_SOURCE_FETCH_TIMEOUT_MS`, `NEWSROOM_HARNESS_MAX_TOOL_CALLS`, `NEWSROOM_HARNESS_MAX_CUSTOM_TOOL_CALLS`, `NEWSROOM_HARNESS_MAX_WEB_SEARCHES`, `NEWSROOM_HARNESS_MAX_BROWSER_TASKS`, `NEWSROOM_HARNESS_RETRY_LIMIT` | Quarantine | Harness runtime safety limits. | High | Preserve equivalent bounds in Hermes before deleting these names. |
| `NEWSROOM_HARNESS_SCHEDULER_ENABLED`, `NEWSROOM_HARNESS_SCHEDULER_INTERVAL_MS` | Quarantine, then remove | Harness process-local scheduler. | High | Prove no scheduled job depends on the harness ticker. Test Hermes scheduling replacement and restart recovery. |
| `NEWSROOM_HARNESS_RUN_TIMEOUT_SECONDS` | Remove after source migration | Legacy agent config reads this alternate timeout name in [`services/newsroom-harness/src/agents/harness-config.ts:149`](../services/newsroom-harness/src/agents/harness-config.ts#L149). | Medium | Search all env consumers and remove only after the agent config is retired. |
| `NEWSROOM_AGENT_ENABLED_TOOLS`, `NEWSROOM_AGENT_SOURCE_PRIORITY`, `NEWSROOM_AGENT_SOURCE_MONITORS_JSON` | Quarantine, migrate selected policy only | Harness agent configuration in `.env.example` and `src/agents/harness-config.ts`. | Medium | Map required source policy to Hermes or NewsCraft retrieval. |
| `NEWSROOM_MODEL_POLICY_MODE`, `NEWSROOM_ALLOW_SCHEDULED_MODEL_CALLS`, `NEWSROOM_ALLOW_SCHEDULED_WEB_SEARCH` | Quarantine | Harness scheduled cost and provider controls. | High | Do not carry them into Hermes. Verify Hermes has explicit model and tool readiness gates. |
| `NEWSROOM_MODEL_NANO`, `NEWSROOM_MODEL_MINI`, `NEWSROOM_MODEL_STANDARD`, `NEWSROOM_MODEL_PREMIUM`, `NEWSROOM_WEB_SEARCH_MODEL` | Quarantine | Harness model policy aliases. | High | Verify no active Hermes configuration reads these names. |
| `NEWSROOM_EMAIL_DIGEST_WEBHOOK_URL`, `NEWSROOM_SLACK_WEBHOOK_URL` | Quarantine until delivery ownership is verified | Listed in the harness template as Phase 3 delivery channels. | Medium | Identify an active delivery consumer before changing or removing names. Preserve any required delivery data. |

### Legacy gateway, producer, and evaluation names

| Names | Disposition | Source and current consumer | Confidence | Gate and rollback |
|---|---|---|---|---|
| `AGENT_GATEWAY_URL`, `AGENT_GATEWAY_API_KEY` | Migrate, then remove | Producer acceptance sets them for the old app-to-harness gateway at [`scripts/producer-acceptance.mjs:150`](../scripts/producer-acceptance.mjs#L150). | High static; live unknown | Search deployment metadata and app code; replace with NewsCraft-to-Hermes server calls. Restore only for a temporary, approved test bridge. |
| `PRODUCER_ACCEPTANCE_DATABASE_URL`, `PRODUCER_ACCEPTANCE_REQUIRE_OPENAI`, `PRODUCER_ACCEPTANCE_SOURCE_MODE` | Migrate | Producer acceptance setup and fixture modes. | High static | Port acceptance to Hermes durable fixtures and keep the test database isolated. |
| `NEWSROOM_HARNESS_URL`, `NEWSROOM_EVAL_MODE`, `NEWSROOM_EVAL_COMPARE_PLANNER`, `NEWSROOM_EVAL_PROMPT_ID` | Migrate, then quarantine | Legacy evaluation runner at [`services/newsroom-harness/eval/run-eval.mjs:40`](../services/newsroom-harness/eval/run-eval.mjs#L40). | Medium | Preserve prompt IDs and evaluation results in an Hermes-owned runner. |
| `NEWSROOM_HARNESS_LIVE_OPENAI_SMOKE`, `NEWSROOM_HARNESS_SMOKE_MODEL`, `NEWSROOM_HARNESS_LIVE_RESEARCH_SMOKE` | Quarantine, then remove | Opt-in live harness smoke tests in `services/newsroom-harness/tests/runtime.test.ts`. | Medium | Do not run against production without explicit authorization. Retire after Hermes smoke coverage exists. |
| `DATABASE_URL` | Keep for NewsCraft app DB; migrate the producer fallback consumer | Root app uses it for server-only Supabase Postgres. Producer acceptance also falls back to it when selecting a test DB. | High for app; medium legacy coupling | Keep app ownership. Require `NEWSCRAFT_TEST_DATABASE_URL` or an isolated producer DB for tests. |

### Active Hermes names

These names are active runtime configuration and must not be removed as part of legacy cleanup:

`NEWSCRAFT_HERMES_URL`, `NEWSCRAFT_HERMES_API_TOKEN`, `NEWSCRAFT_HERMES_TENANT_SECRET`, `NEWSCRAFT_HERMES_PUBLIC_HOST`, `NEWSCRAFT_HERMES_HOME`, `NEWSCRAFT_HERMES_WORKSPACE`, `NEWSCRAFT_HERMES_WEB_PROVIDER`, `NEWSCRAFT_HERMES_BROWSER_PROVIDER`, `NEWSCRAFT_HERMES_MODEL_PROVIDER`, `NEWSCRAFT_HERMES_MODEL`, `NEWSCRAFT_HERMES_MODEL_BASE_URL`, `NEWSCRAFT_HERMES_MODEL_API_KEY`, `NEWSCRAFT_HERMES_MODEL_API_MODE`, `NEWSCRAFT_HERMES_MAX_ITERATIONS`, `NEWSCRAFT_HERMES_RUN_API_URL`, `NEWSCRAFT_HERMES_RUN_API_TOKEN`, `NEWSCRAFT_RETRIEVAL_ENABLED`, `NEWSCRAFT_RETRIEVAL_LIVE_TIMEOUT_MS`, `NEWSCRAFT_RETRIEVAL_ARCHIVE_TIMEOUT_MS`, `NEWSCRAFT_RETRIEVAL_MAX_URLS`, `NEWSCRAFT_RETRIEVAL_ARCHIVE_FALLBACK`, `NEWSCRAFT_CHAT_STREAM_MAX_MS`, `NEWSCRAFT_CHAT_STREAM_IDLE_MS`, `HERMES_AGUI_HOST`, `HERMES_AGUI_PORT`, `HERMES_AGUI_SESSION_TOKEN`, `AGENT_BROWSER_ENGINE`, `AGENT_BROWSER_HEADED`, `AGENT_BROWSER_DEFAULT_TIMEOUT`, `AGENT_BROWSER_EXECUTABLE_PATH`, `EXA_API_KEY`, and `BROWSER_USE_API_KEY`.

The active Hermes names are defined in [`services/hermes-chat/.env.example:1`](../services/hermes-chat/.env.example#L1) and used by the Hermes service. Their values and live deployment state were not inspected.

## Test-group inventory

### Legacy harness test groups

The harness contains 30 tracked Vitest files. They are grouped below for disposition; every file is listed.

| Group | Test files | Disposition | Gate |
|---|---|---|---|
| Agent routing, answer, and regression behavior | `agent-harness.test.ts`, `bounded-loop.test.ts`, `general-agent-regressions.test.ts`, `grounded-answer.test.ts`, `grounded-conversation.test.ts`, `multi-requirement-research.test.ts`, `producer-research-architecture.test.ts`, `report-quality.test.ts`, `temporal-grounding.test.ts`, `trust-regressions.test.ts` | Quarantine; migrate selected behavior | Keep the three JIG-178 fixture fixes separate from Hermes release gates. Port required answer, evidence, and producer assertions to Hermes before removal. |
| Agent planning and policy | `model-policy.test.ts`, `planner.test.ts`, `runtime.test.ts` | Quarantine; migrate selected policy tests | Prove Hermes model/tool policy covers the required safety behavior without importing harness provider configuration. |
| Chat and streaming transport | `chat.test.ts`, `streaming-chat.test.ts`, `http.test.ts` | Quarantine | Replace harness protocol tests with Hermes/App transport tests. |
| Server and serverless routes | `server.test.ts`, `serverless.test.ts` | Quarantine | Verify no app or hosted deployment uses local harness persistence routes. |
| SQLite, repository, mirror, and events | `database.test.ts`, `factory.test.ts`, `repository-table-spec.test.ts`, `events.test.ts`, `memory.test.ts`, `usage-ledger.test.ts` | Quarantine, then remove | Preserve only data and event behavior required by Hermes durable state. No schema deletion until the data gate passes. |
| Retrieval and source adapters | `citation-source-quality.test.ts`, `fetch-evidence-urls.test.ts`, `polite-fetch.test.ts`, `source-adapters.test.ts`, `source-fetch.test.ts` | Migrate selected behavior | Port retrieval/provenance requirements to NewsCraft/Hermes tests. |
| Configuration | `config.test.ts` | Quarantine | Retain while harness env and mirror migration is in progress. |

### NewsCraft legacy-coupling tests

| Test group | Evidence | Disposition | Gate |
|---|---|---|---|
| Legacy job route tests | [`src/routes/api/agent/jobs/routes.test.ts`](../src/routes/api/agent/jobs/routes.test.ts#L1) and [`src/routes/api/agent/jobs/job-id-routes.test.ts`](../src/routes/api/agent/jobs/job-id-routes.test.ts#L1) | Migrate, then remove | Replace with Hermes producer route and state tests before deleting routes. |
| Channel-post ingest test | [`src/routes/api/agent/channel-posts/channel-posts.test.ts`](../src/routes/api/agent/channel-posts/channel-posts.test.ts#L1) | Migrate, then remove | Replace with callback/report persistence tests. |
| Legacy board tests | [`src/lib/server/agent/board.test.ts`](../src/lib/server/agent/board.test.ts#L1) | Quarantine, then remove | Preserve only tests for any migrated producer behavior. |
| Disabled transport test | [`src/lib/server/agent/transport.test.ts:662`](../src/lib/server/agent/transport.test.ts#L662) | Keep during migration; then replace | Retain the assertion that no legacy transport fallback exists. |
| Direct harness utility import | [`src/lib/server/conversation-context.test.ts:11`](../src/lib/server/conversation-context.test.ts#L11) | Migrate | Remove direct imports from the harness service and test the app-owned/shared contract. |
| E2E fixture model label | [`tests/e2e/app.spec.ts:125`](../tests/e2e/app.spec.ts#L125) and line 216 | Migrate fixture naming | Confirm it is only an intercepted fixture label, then rename it to the active Hermes contract. |

### Active Hermes test groups

Keep these groups as the active runtime gates:

- `services/hermes-chat/tests/test_service.py`: service configuration, readiness, durable start/cancel, and route contracts.
- `services/hermes-chat/tests/test_isolation.py`: tenant paths, account separation, browser profiles, and restart isolation.
- `services/hermes-chat/tests/test_product_prompt.py`: product identity and prompt contract.
- `services/hermes-chat/tests/test_retrieval.py`: retrieval and lead verification behavior.
- `services/hermes-chat/tests/test_docker_staging_smoke.py` and `tests/docker_staging_smoke.py`: isolated staging runtime.
- `services/hermes-chat/tests/live_production_smoke.py`: authorized live gate only. Its presence is not live evidence, and it must not run against production without explicit authorization.
- `services/hermes-chat/tests/durable_fixture_server.py` and fixture models: local durable and isolation fixtures.

## Verification gates

The following gates are conjunctive. Passing one gate does not prove the others.

1. **Static consumer gate**
   - Search the repository for all route paths, table names, package names, script names, and environment-variable names in this document.
   - Confirm no active app route, browser surface, build script, deployment file, or test imports a quarantined runtime unless the reference is explicitly classified as a migration fixture.
   - Confirm `agentFetch` remains disabled until all legacy route consumers are gone.

2. **Replacement behavior gate**
   - Producer creation, update, run, pause, resume, report display, and account deletion must use NewsCraft-owned state and Hermes durable runs.
   - Verify idempotency, cancellation, lease recovery, reconnect replay, source/citation persistence, and account isolation.
   - Verify browser disconnect does not cancel the worker.

3. **Test gate**
   - Run the active app and shared tests.
   - Run the Hermes service, isolation, retrieval, staging, and durable tests.
   - Run the migrated producer/evaluation suite.
   - Run the quarantined harness suite only as a compatibility signal. Do not use it as proof that Hermes is healthy.

4. **Deployment and live-use gate**
   - With explicit authorization, inspect the current hosted deployment project, deployed source/build hash, domains, route rewrites, environment-variable names, request logs, and health responses.
   - Verify whether `newscraft-harness`, `AGENT_GATEWAY_URL`, `NEWSROOM_HARNESS_*`, or `/api/agent/*` receive live traffic.
   - Do not infer live absence from [`ROADMAP.md:148`](../ROADMAP.md#L148) or from the serverless source. Those are repository or historical claims.

5. **Data gate**
   - With explicit database authorization, identify row counts, retention needs, account ownership, foreign-key consumers, backups, and restore evidence for all legacy tables.
   - Do not drop, copy, rewrite, or migrate data as part of this documentation task.
   - Do not rewrite applied migration files. Use a new forward migration only after approval.

6. **Removal gate**
   - Keep the old code and deployment artifact through one approved rollback window after the replacement is verified.
   - Confirm the final repository search has no unclassified legacy reference.
   - Confirm the active release gate no longer depends on the quarantined harness package.

## Rollback points

| Change stage | Rollback point |
|---|---|
| Consumer migration | Revert the route or caller change while retaining the legacy implementation. Do not change Hermes durable state ownership. |
| Producer migration | Restore the previous producer acceptance path only as an approved temporary bridge. Record the run IDs and avoid duplicate execution. |
| Harness deployment quarantine | Restore the last verified harness artifact only if live evidence identifies a required consumer. This does not make the harness the active product runtime. |
| Environment retirement | Restore only the exact quarantined environment names required by the verified rollback. Do not expose secret values or copy them into new providers. |
| App table migration | Revert application reads/writes before any table drop. Keep a verified backup and restore procedure. |
| Forward schema removal | Restore from the approved database backup or apply an approved forward repair migration. Never edit historical migration files. |
| Test-gate migration | Restore the old test command if a required active test was omitted. Do not silence a failing active Hermes or app gate. |

## Ordered removal sequence

1. Freeze the active boundary: NewsCraft owns durable state; Hermes owns execution; the harness and legacy app agent routes are quarantined.
2. Complete the static consumer search for all routes, tables, source paths, scripts, deployment files, and environment-variable names listed here.
3. Migrate the producer acceptance script and golden-prompt evaluation to Hermes durable fixtures. Preserve results and prompt IDs.
4. Migrate shared evidence and conversation-context test imports out of `services/newsroom-harness`.
5. Migrate producer UI and API behavior: job creation, schedule controls, reports, channel posts, commands, and skills where they are still supported.
6. Verify the migrated producer behavior with account isolation, idempotency, replay, cancellation, recovery, and report persistence tests.
7. With explicit live authorization, verify whether any hosted harness deployment, gateway URL, legacy route, or legacy environment name receives traffic.
8. Quarantine the harness deployment and remove it from active release gates. Retain the artifact for the approved rollback window.
9. Retire legacy environment names and provider configuration only after the live-use and rollback gates pass. Do not change provider values in this task.
10. Remove app runtime consumers of `agent_channel_*`, `missions*`, `mission_reports`, and `agent_jobs`. Keep historical migration files unchanged.
11. Apply a separately approved forward database migration for legacy table removal only after the data gate passes.
12. Remove the harness package, local server, mirror, routes, legacy scripts, eval runner, prompts, and deployment files after the source search is clean.
13. Run the final app, Hermes, durable, isolation, producer, build, and release checks. Record live source hash, deployment, restart, and isolation evidence separately.

No step above authorizes deletion, migration, deployment, credential changes, provider changes, database changes, or production changes. Those actions require a separate implementation request and explicit authorization.
