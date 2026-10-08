# Owned runtime replacement review — 2026-10-07

Reviewed the deliberate uncommitted replacement on `main` above `cb3dec9` on the
Mac mini. Three independent review assignments covered app/auth/database, Python
orchestration, and executor/browser boundaries; the integration review covered
shared contracts, client replay, product output, local setup and documentation.
All original modified/untracked files, including deletions, were reviewed.
No existing work was stashed, reverted or discarded.

## Findings fixed

Locations identify the repaired code. Regression tests assert the required
behavior; assertions were not relaxed to obtain passing results.

| Finding | Code location | Regression / outcome |
| --- | --- | --- |
| Conversation workspace identity changed with system prompts and output transforms | `src/lib/server/agent/transport.ts:354` | Account/conversation identity stable across prompt changes; separated across owners and conversations. Existing persisted inputs retained. |
| Durable input reused the smaller event limit | `src/lib/server/db/hermes-runs.ts:45` | Valid 200 KiB image input accepted within the worker's 512 KiB cap; event cap remains 128 KiB. |
| Missing/false Content-Length bypassed admission; non-object JSON reached state mutation | `src/routes/api/chat/stream/+server.ts:114` | Count actual streamed bytes, cancel above 950 KiB, reject null/string/array before database access. |
| Disconnected response readers left subscription polling alive | `src/lib/server/hermes-subscription.ts:82` | Reader cancellation stops timers/DB polls without cancelling the durable run. |
| Concurrent idempotency replay could return another conversation's run | `src/lib/server/db/hermes-runs.ts:458` | Recheck conversation under transaction; unit and real concurrent Postgres tests. Same-account integrity issue, not cross-account disclosure. |
| Extraction admitted CGNAT and IPv6 transition/non-global destinations | `services/hermes-chat/src/hermes_chat/retrieval.py:226` | Reuse browser public-IP policy for URL literals and pinned DNS answers. |
| Slow response headers/body or redirect drains could outlast fetch budgets | `services/hermes-chat/src/hermes_chat/retrieval.py:279` | Absolute deadline on every socket read; close redirects; TLS cancellation cleanup; deterministic clocks and socketpair tests. |
| Updated/Last-Modified timestamp became publication date | `services/hermes-chat/src/hermes_chat/retrieval.py:1512` | Publication uses publishedAt only; updated-only/Last-Modified evidence keeps publication unknown. |
| Anthropic service tier was implicit | `services/hermes-chat/src/hermes_chat/model_adapters.py:184` | Requests explicitly select standard_only; two-provider fixture asserts it. |
| Recovery could change request endpoints or expand time/step/search bounds | `services/hermes-chat/src/hermes_chat/budgets.py:12`, `portable.py:154` | Persist complete policy/transport identity; reject each mismatch before dispatch and close cleanup clients. |
| Exception tracebacks could include provider/transport secrets | `services/hermes-chat/src/hermes_chat/service.py:387`, `durable.py:1510` | Fixed safe messages, synthetic credential-like exception regressions. |
| HTTPX INFO logging exposed signed artifact URL queries | `services/hermes-chat/src/hermes_chat/service.py:336` | WARNING transport logger level; real mocked HTTPX request proves signed-query sentinel absent. |
| Prompt denied browsing even when browser tools were configured | `services/hermes-chat/src/hermes_chat/product_prompt.py:32` | Conditional browser tools and accepted evidence receipts described accurately; prompt tests extended. |
| Public activity/plan notes exposed commands, paths, exit codes and browser references | `src/lib/utils/tool-labels.ts:116`, `src/lib/components/PlanTimeline.svelte:37` | Public research details and controlled outcomes; saved/reconnected SSE replay regression. |
| Guarded Mac setup accepted wrong Python tree or inherited computer activation | `scripts/agent-local.mjs:106`, `:175` | Reject non-3.11 trees and inherited executor/browser settings before startup; 18 helper tests. |
| Disposable Postgres inherited locale and could fail macOS startup | `scripts/test-agent-postgres-fixture.mjs:23` | Set C locale explicitly; integration run from an invalid caller locale verifies startup and cleanup. |
| Generic launcher selected the prior environment | `scripts/dev-all.mjs:125` | Defaults to .venv-owned and the locked installer guidance. |
| Active architecture/setup documents contradicted selected runtime | `ROADMAP.md`, `SOURCE_OF_TRUTH.md`, service/setup/handoff docs | Owned portable runtime, conditional OCI/browser, measured evidence labels; historical material preserved. |

Anthropic tier semantics were checked against the [official service-tier documentation](https://platform.claude.com/docs/en/api/service-tiers).
This was documentation access, not an API or pricing verification.

## Verification and scope limits

The [handoff matrix](agent-local-handoff.md#measured-verification-in-this-session)
records the complete post-fix results: app 684, shared 7, historical harness 343,
Python 544, disposable Postgres 54, helper 18; check/build/lock and 25/25 fixture
eval passed. Fifty-one app DB-gated tests are skipped by ordinary `pnpm test`;
the separate disposable database command runs the database suites. Two harness
live tests remain opt-in. Playwright requires explicit database-backed setup.

Review traced account/org checks, signed revocable sessions, issuer/subject auth
mapping, tenant HMAC, callback leases/cursors, checkpoint CAS/fencing, cancellation
under the run-row lock, finishing → confirmed cleanup → finished ordering,
uncertain-request no-replay, immutable SQLite receipts, lease renewal, the fixed
240-second artifact-only retry window, reservations and configured price ceilings.
No additional confirmed defect remains from this review. This is not proof of
absence of vulnerabilities or live infrastructure correctness.

The initialized schema artifact remains byte-identical (19 migration hashes,
33 tables). Its SHA256 is
`ee09d4123aa040bcdae115694220852e20a892a4666aa3c05f5410945358e1be`.
Cloud initialization/RLS/grants are prior user/handoff evidence, not reverified.
The preexisting `docker_staging_smoke.py` change remains 24 additions/0 deletions.

OS DNS resolution can still delay cancellation until the resolver returns.
Stable new conversation IDs do not migrate earlier experimental content-hash
workspaces. Actual Linux rootless/Chromium isolation, retained-volume recovery,
cloud storage/auth and paid provider behavior remain unverified. The database
credential, separate $4.23 paid allowance and Linux host decision remain human gates.

Codex Security's local workbench report records resolved candidates and no
outstanding confirmed finding. Its snapshot was captured during this authorized
changing-tree repair, so it explicitly warns that the tree changed. The final
regressions and isolated staged-tree checks below are the evidence for repaired
source. Daybreak protected findings were unavailable; no claim of that coverage
is made.

## Local commit verification

Each slice was exported from the Git index into a disposable directory, with
installed dependencies linked and the shared workspace package redirected to its
own snapshot build. The main checkout's unstaged files and ignored configuration
were not copied. Checks exercise the staged source, not later uncommitted code.
The shared preparation slice retains the old toolset name until the integrated
runtime cutover. No branch/worktree, dependency install, push or deployment is used.
A draft durable slice failed six DB tests because its old transport lacked the
owned environment aliases. The compatible aliases were moved into that slice
before re-exporting and rerunning it; no failing slice was committed.

| Slice | Isolated verification |
| --- | --- |
| Shared contracts (`2eb12e2`) | Check 0 errors/warnings; app 577, shared 7, harness 343 passed. |
| Auth/schema/storage (`bf3a398`) | Check 0 errors/warnings; app 598, shared 7, harness 343; 54 Postgres tests across 7 staged test files; fixture removed. |
| Durable app (`7e68dd7`) | Check 0 errors/warnings; app 683, shared 7, harness 343; 54 Postgres tests across 8 staged files; fixture removed. |
| Runtime/UI cutover (`6974134`) | Check 0 errors/warnings; app 684, shared 7, harness 343; snapshot Python imports confirmed, 544 passed; build and offline lock passed. |
| Local helper/fixture (`7643417`) | Check 0 errors/warnings; 18 helper tests; 54 Postgres tests despite invalid caller locale; fixture stopped and removed. |
| Documentation | Check 0 errors/warnings; 216 current/local Markdown links resolve; preserved historical text and schema hash; whitespace check passed. |

## Reviewed file inventory

Final changed/new scope contains 191 files (including this ledger and the two
uncommitted public environment templates). Deletions were reviewed as diffs.

<details>
<summary>Complete file inventory</summary>

- `.env.example`
- `ROADMAP.md`
- `SOURCE_OF_TRUTH.md`
- `docs/agent-deployment-decision.md`
- `docs/agent-live-validation-approval.md`
- `docs/agent-local-handoff.md`
- `docs/agent-replacement-workflow.md`
- `docs/agent-review-2026-10-07.md`
- `docs/durable-hermes-streaming.md`
- `docs/legacy-runtime-disposition.md`
- `docs/managed-agent-setup.md`
- `docs/release-and-rollback-checklist.md`
- `drizzle/0017_managed_agent_sessions.sql`
- `drizzle/0018_portable_agent_core.sql`
- `package.json`
- `packages/shared/src/hermes.test.ts`
- `packages/shared/src/hermes.ts`
- `pnpm-lock.yaml`
- `scripts/agent-local.mjs`
- `scripts/agent-local.test.mjs`
- `scripts/check-health.mjs`
- `scripts/dev-all.mjs`
- `scripts/test-agent-postgres-fixture.mjs`
- `services/hermes-chat/.env.example`
- `services/hermes-chat/README.md`
- `services/hermes-chat/deploy/Caddyfile.example`
- `services/hermes-chat/deploy/browser.Dockerfile`
- `services/hermes-chat/deploy/executor.Dockerfile`
- `services/hermes-chat/deploy/executor.md`
- `services/hermes-chat/deploy/newscraft-agent.service`
- `services/hermes-chat/deploy/newscraft-agent.user.service`
- `services/hermes-chat/deploy/newscraft-hermes-chat.service`
- `services/hermes-chat/deploy/newscraft-hermes-chat.user.service`
- `services/hermes-chat/deploy/newscraft-new-project-schema.sql`
- `services/hermes-chat/deploy/production-admission.md`
- `services/hermes-chat/deploy/sandbox.Dockerfile`
- `services/hermes-chat/deploy/supabase-adapter.sql`
- `services/hermes-chat/deploy/supabase-auto-rls-execute-review.sql`
- `services/hermes-chat/deploy/supabase-database-private.sql`
- `services/hermes-chat/deploy/workspace-quota.md`
- `services/hermes-chat/pyproject.toml`
- `services/hermes-chat/scripts/install-runtime.sh`
- `services/hermes-chat/scripts/live-validate-agent.py`
- `services/hermes-chat/scripts/validate-oci-browser.py`
- `services/hermes-chat/scripts/validate-oci-executor.py`
- `services/hermes-chat/src/hermes_chat/__init__.py`
- `services/hermes-chat/src/hermes_chat/artifact_publish.py`
- `services/hermes-chat/src/hermes_chat/browser_controller.py`
- `services/hermes-chat/src/hermes_chat/browser_evidence.py`
- `services/hermes-chat/src/hermes_chat/browser_executor.py`
- `services/hermes-chat/src/hermes_chat/browser_network.py`
- `services/hermes-chat/src/hermes_chat/browser_rpc.py`
- `services/hermes-chat/src/hermes_chat/browser_state.py`
- `services/hermes-chat/src/hermes_chat/browser_store.py`
- `services/hermes-chat/src/hermes_chat/budgets.py`
- `services/hermes-chat/src/hermes_chat/contracts.py`
- `services/hermes-chat/src/hermes_chat/docker_boundary.py`
- `services/hermes-chat/src/hermes_chat/durable.py`
- `services/hermes-chat/src/hermes_chat/executor_payloads.py`
- `services/hermes-chat/src/hermes_chat/executor_state.py`
- `services/hermes-chat/src/hermes_chat/input_messages.py`
- `services/hermes-chat/src/hermes_chat/isolation.py`
- `services/hermes-chat/src/hermes_chat/live_validation_fixture.py`
- `services/hermes-chat/src/hermes_chat/managed.py`
- `services/hermes-chat/src/hermes_chat/model_adapters.py`
- `services/hermes-chat/src/hermes_chat/oci_executor.py`
- `services/hermes-chat/src/hermes_chat/portable.py`
- `services/hermes-chat/src/hermes_chat/product_prompt.py`
- `services/hermes-chat/src/hermes_chat/production_admission.py`
- `services/hermes-chat/src/hermes_chat/quota.py`
- `services/hermes-chat/src/hermes_chat/retrieval.py`
- `services/hermes-chat/src/hermes_chat/runtime.py`
- `services/hermes-chat/src/hermes_chat/sandbox.py`
- `services/hermes-chat/src/hermes_chat/sandbox_adapter.py`
- `services/hermes-chat/src/hermes_chat/search_adapters.py`
- `services/hermes-chat/src/hermes_chat/service.py`
- `services/hermes-chat/src/hermes_chat/validation_sandbox.py`
- `services/hermes-chat/tests/docker_staging_smoke.py`
- `services/hermes-chat/tests/test_artifact_publish.py`
- `services/hermes-chat/tests/test_browser_controller.py`
- `services/hermes-chat/tests/test_browser_network.py`
- `services/hermes-chat/tests/test_browser_rpc.py`
- `services/hermes-chat/tests/test_browser_state.py`
- `services/hermes-chat/tests/test_docker_boundary.py`
- `services/hermes-chat/tests/test_durable_transport.py`
- `services/hermes-chat/tests/test_executor_payloads.py`
- `services/hermes-chat/tests/test_input_messages.py`
- `services/hermes-chat/tests/test_isolation.py`
- `services/hermes-chat/tests/test_jig_183_canary.py`
- `services/hermes-chat/tests/test_jig_185_load.py`
- `services/hermes-chat/tests/test_jig_197_load.py`
- `services/hermes-chat/tests/test_live_validation_contract.py`
- `services/hermes-chat/tests/test_managed.py`
- `services/hermes-chat/tests/test_oci_executor.py`
- `services/hermes-chat/tests/test_owned_runtime_dependencies.py`
- `services/hermes-chat/tests/test_portable.py`
- `services/hermes-chat/tests/test_product_prompt.py`
- `services/hermes-chat/tests/test_production_admission.py`
- `services/hermes-chat/tests/test_prompt_path_stability.py`
- `services/hermes-chat/tests/test_quota.py`
- `services/hermes-chat/tests/test_retrieval.py`
- `services/hermes-chat/tests/test_retrieval_cancellation.py`
- `services/hermes-chat/tests/test_runtime.py`
- `services/hermes-chat/tests/test_sandbox.py`
- `services/hermes-chat/tests/test_service.py`
- `services/hermes-chat/tests/test_validation_sandbox.py`
- `services/hermes-chat/uv.lock`
- `src/hooks.server.behavior.test.ts`
- `src/hooks.server.ts`
- `src/lib/client/stream.test.ts`
- `src/lib/client/stream.ts`
- `src/lib/components/PlanTimeline.svelte`
- `src/lib/components/Thread.svelte`
- `src/lib/components/ToolActivity.svelte`
- `src/lib/server/agent/fixtures/owned-readiness.json`
- `src/lib/server/agent/transport.test.ts`
- `src/lib/server/agent/transport.ts`
- `src/lib/server/artifacts/storage.ts`
- `src/lib/server/auth/backend.test.ts`
- `src/lib/server/auth/backend.ts`
- `src/lib/server/auth/postgres.ts`
- `src/lib/server/auth/supabase.test.ts`
- `src/lib/server/auth/supabase.ts`
- `src/lib/server/conversation-title.test.ts`
- `src/lib/server/conversation-title.ts`
- `src/lib/server/db/accounts.ts`
- `src/lib/server/db/agent-core.integration.test.ts`
- `src/lib/server/db/agent-runtime.test.ts`
- `src/lib/server/db/agent-runtime.ts`
- `src/lib/server/db/artifacts.ts`
- `src/lib/server/db/auth-identities.test.ts`
- `src/lib/server/db/conversations.atomic-replacement.integration.test.ts`
- `src/lib/server/db/hermes-runs-activity.test.ts`
- `src/lib/server/db/hermes-runs-recovery.test.ts`
- `src/lib/server/db/hermes-runs.integration.test.ts`
- `src/lib/server/db/hermes-runs.ts`
- `src/lib/server/db/index.ts`
- `src/lib/server/db/managed-agent.test.ts`
- `src/lib/server/db/managed-agent.ts`
- `src/lib/server/db/migration-contract.ts`
- `src/lib/server/db/migration-runner.test.ts`
- `src/lib/server/db/migration-runner.ts`
- `src/lib/server/documents/service.test.ts`
- `src/lib/server/documents/service.ts`
- `src/lib/server/documents/storage.ts`
- `src/lib/server/hermes-durable.ts`
- `src/lib/server/hermes-subscription.test.ts`
- `src/lib/server/hermes-subscription.ts`
- `src/lib/server/storage/provider-selection.test.ts`
- `src/lib/stores/chat.svelte.test.ts`
- `src/lib/stores/chat.svelte.ts`
- `src/lib/utils/stream-events.test.ts`
- `src/lib/utils/stream-events.ts`
- `src/lib/utils/tool-labels.test.ts`
- `src/lib/utils/tool-labels.ts`
- `src/lib/utils/tool-metadata.test.ts`
- `src/lib/utils/tool-metadata.ts`
- `src/routes/account-setup/[token]/+page.server.ts`
- `src/routes/api/chat/runs/+server.ts`
- `src/routes/api/chat/runs/[id]/cancel/+server.ts`
- `src/routes/api/chat/runs/create-route.test.ts`
- `src/routes/api/chat/stream/+server.ts`
- `src/routes/api/chat/stream/durable-route.test.ts`
- `src/routes/api/chat/stream/output-actions.test.ts`
- `src/routes/api/chat/stream/regenerate-context.test.ts`
- `src/routes/api/chat/stream/timeout-terminal-contract.test.ts`
- `src/routes/api/chat/stream/title-generation.test.ts`
- `src/routes/api/internal/hermes/runs/[runId]/artifacts/revisions/+server.ts`
- `src/routes/api/internal/hermes/runs/[runId]/managed-state/+server.ts`
- `src/routes/api/internal/hermes/runs/[runId]/runtime-state/+server.ts`
- `src/routes/api/internal/hermes/runs/runs-routes.test.ts`
- `src/routes/api/messages/[id]/onwards/+server.ts`
- `src/routes/api/messages/[id]/onwards/onwards.test.ts`
- `src/routes/api/settings/accounts/+server.ts`
- `src/routes/api/settings/accounts/[id]/+server.ts`
- `src/routes/api/settings/accounts/[id]/setup-link/+server.ts`
- `src/routes/api/settings/accounts/admin-routes.test.ts`
- `src/routes/api/settings/password/+server.ts`
- `src/routes/auth/callback/+server.ts`
- `src/routes/c/[id]/+page.svelte`
- `src/routes/login/+page.server.ts`
- `src/routes/login/+page.svelte`
- `src/routes/login/login-auth.test.ts`
- `src/routes/logout/+server.ts`
- `src/routes/settings/+page.svelte`
- `src/routes/settings/settings-page.test.ts`
- `src/routes/setup/+page.server.ts`
- `src/routes/setup/+page.svelte`
- `src/routes/signup/+page.server.ts`
- `src/routes/signup/+page.svelte`
- `src/routes/signup/signup-redirect.test.ts`

</details>
