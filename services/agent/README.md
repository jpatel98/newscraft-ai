# NewsCraft owned research worker

NewsCraft owns orchestration, messages, runs, public events, citations and artifacts in ordinary Postgres. `service.py` directly selects `PortableAgentRunner` in `portable.py`; it does not call a managed agent harness.

The model boundary has three concrete provider adapters: OpenAI Responses, Anthropic Messages, and DeepSeek's Messages-compatible endpoint. They translate the same canonical messages/tool definitions. DeepSeek selects a dedicated key/base URL, disables thinking explicitly, omits unsupported OpenAI fields and Anthropic service-tier selection, and rejects retired/unknown model names before dispatch. OpenAI encrypted reasoning continuation stays in private run state, never public history or events. Anthropic thinking blocks are not requested or exposed. Providers/models can change at a clean new turn; an existing run must retain its original adapter and budget policy. There is no arbitrary in-flight provider interchange.

## Research and files

The default public DDGS search adapter needs no model-provider account. An optional OpenAI Responses search adapter is a separate paid request. Both return leads. NewsCraft's bounded public fetcher, archive fallback and exact-excerpt ledger validate retrieved evidence before assigning `[n]` citations. These are fetch/provenance checks, not a claim of independent semantic fact-checking. Source and document text stays untrusted user/tool data.

Public plans, actions/results, short decisions and one clean final answer persist through the existing UI. `publish_markdown` and `publish_csv` render files from content without executing model code. Research files require recorded citations; CSV rows include source URLs. Publication uses the existing leased revision/grant/upload/finalize flow with byte, MIME and SHA-256 checks, then immutable application storage. Reconnect replays Postgres events and artifacts.

`oci_executor.py` implements the rootless Linux computer adapter: terminal/read/write/list use fresh bounded containers, and interactive Chromium uses a separate container retained during a run. Private tenant/conversation snapshots, browser storage and action receipts survive worker restarts on the retained state volume. Admission and receipts bind the run/request/daemon; cleanup is confirmed before cancellation. The controller, RPC, citation and artifact flow have deterministic coverage with all three model adapters. **Actual Chromium and kernel isolation still require Linux acceptance.** See [executor/browser setup, security approval and limits](deploy/executor.md). Basic cited research and Markdown/CSV publication work without computer configuration; no host execution fallback exists.

## Durable ownership and bounded work

The worker persists run-scoped canonical state, adapter-private continuation, budget reservations, pending intent and completed receipts in `agent_runtime_checkpoints`. Reads and compare-and-swap writes require account, conversation, tenant and an active lease. Public streams never expose this table. Completed tool outputs are saved before callbacks; receipts/answers replay without repeating their effects. Stale workers cannot begin a new request or publish through current grants. Dispatch checkpoints also lock the durable run row and reject committed cancellation, including before a citation-repair model request. Cleanup reads/writes remain available to the current lease owner, and renew replies reporting cancellation stop the observer. Worker/callback interruption remains recoverable.

A request or non-idempotent tool interrupted after intent is saved has an uncertain outcome. Recovery fails it safely and asks for a new user turn; it does not resubmit inference or rerun an uncertain effect. Artifact retries alone reuse a saved immutable run/call publication identity. Each publication attempt gets at most 20 seconds, with at most 45 seconds of publication waiting per worker pass. Its fixed 240-second recovery window includes the renewed 90-second lease and recovery polling. At most four attempts are admitted, with each admission saved before I/O so a worker death cannot erase it. The deadline and immutable identity never reset. Only that already admitted publication may finalize after the original run deadline; new publications, research and model requests remain blocked after the run budget expires. Completed answers replay after the deadline without new effects.

Defaults: 12 model requests, 180 elapsed seconds, 120,000 cumulative conservatively estimated input tokens, 4,096 output tokens per request, and a $2 local reservation budget. Input accounting includes translated system/tool schemas, history, tool results, adapter-private replay and image allowance. Configure **reviewed positive input/output price ceilings per million tokens** for the selected provider/model; there are no invented price defaults. Optional paid search also requires a reviewed full per-call charge ceiling including search/tool/model costs. Every request reserves its maximum estimated charge before dispatch; reservations are never refunded, even when a response is lost. These are conservative application controls, **not provider-enforced billing guarantees**. Provider pricing and image assumptions must be reviewed before live use. Cancelling an HTTP request does not prove the provider stopped billing that request.

Inputs are limited to 512 KiB, private checkpoint state to 8 MiB, and generated files to 32,000 UTF-8 bytes each, 16 files and 512,000 aggregate bytes per run. Search calls default to five. Global admission defaults to four active/sixteen queued runs, with two active/four queued per tenant. No sandbox/tool side effect is implied by a configuration contract.

Blocking retrieval uses a shared cancellation/deadline signal before subsequent URLs, live/archive/CDX fetches, redirects and resolved-address attempts. Cancellation prevents the next dispatch and waits for the active thread to drain before releasing the worker slot. It cannot forcibly interrupt an already active socket or operating-system DNS call; timeout/cancel completion may therefore wait for that call to return. This limitation is reported rather than hiding active work behind a released capacity slot.

## Setup and verification

Use the root and worker `.env.example` files, then [the provider-neutral setup guide](../../docs/managed-agent-setup.md). Postgres auth and existing VPS object storage are defaults; Supabase Auth/Storage are explicit optional adapters. No Supabase variables are required by the core schema or default auth path. Model credentials remain server-side; existing OpenAI credential reuse is approved, with no key copy or new key creation required.

For this checkout, [the local setup handoff](../../docs/agent-local-handoff.md) uses a separate locked `.venv-owned` and a guarded `.env.agent-local` profile. It preserves the old environment and refuses to inherit the old database target. Preparation/checking never starts a process or contacts a provider. Select DeepSeek with `node scripts/agent-local.mjs check --provider deepseek` (or `start --provider deepseek --health-only` after configuration passes). This applies the reviewed Flash model, Messages endpoint, peak prices and $0.06 reservation cap in memory without rewriting the private profile. Only `DEEPSEEK_API_KEY` in the approved credential file can enable that profile; no other provider key is substituted.

`GET /ready` reports local configuration only: `orchestration: newscraft`, `apiMode: responses|messages`, `accessVerified: false`, configured terminal/workspace/browser capabilities, and local reservation bounds. Missing reviewed price ceilings or a failed configured executor/browser policy fail readiness. Readiness does not call a paid API or prove live execution/provider/storage access.

For no-paid health checks use `node scripts/agent-local.mjs start --health-only`.
`NEWSCRAFT_AGENT_HEALTH_ONLY=1` disables startup recovery and rejects every worker
request except `GET /ready` before dispatch; authenticated readiness marks the
mode explicitly. Ordinary startup can resume existing runs and is not a passive
check. The guarded local profile also pins page search to `none` and clears Exa
credentials, preventing inherited paid page-search configuration.

The worker requires an existing **CPython 3.11** interpreter. Browser readiness and dispatch also require the stdlib asyncio selector loop; the service entrypoint selects it explicitly. These constraints preserve the audited HTTPS memory bound. Container guest images use Python 3.12 separately. The installer uses locked dependencies without downloading an interpreter or provisioning a sandbox:

```sh
services/agent/scripts/install-runtime.sh /absolute/private/path/to/venv
```

For no-paid local setup use `node scripts/agent-local.mjs start --provider deepseek --health-only` after its key check passes; the guarded profile refuses the old database. Preserve the documented `NODE_EXTRA_CA_CERTS` setting. Generic `pnpm dev:all` and `pnpm dev:agent` remain available with an independently verified environment and explicit execution authorization. Service templates need private app callbacks, provider/public-web HTTPS access and private local staging. The optional executor additionally needs its existing rootless daemon/image, with no privileged Docker group, XFS or custom root broker. **Historical:** the 2026-10-08 loopback validation used the DeepSeek profile: both health endpoints returned 200/ready, private readiness named DeepSeek Messages with `accessVerified: false`, and signup/sign-in/empty-conversation checks passed. Both listeners stopped cleanly; no provider or storage call was made during that health check.

Offline checks (from the repository root):

```sh
TMPDIR=/private/tmp PYTHONPATH=services/agent/src services/agent/.venv-owned/bin/python \
  -m unittest discover -s services/agent/tests -p 'test_*.py'
pnpm test
node scripts/agent-local.test.mjs
node scripts/test-agent-postgres-fixture.mjs
pnpm eval:fixture
pnpm check
pnpm build
```

Run the lock check from `services/agent`: `uv lock --check --offline --no-cache --no-python-downloads`. Use `/tmp` on Linux. Restricted environments may deny the one real Python localhost transport test and the harness HTTP-server suite. `node scripts/test-agent-postgres-fixture.mjs` runs the real database integration suites on a new loopback-only Postgres instance, without reading an existing DB URL or environment secrets. It requires Node 24 and local PostgreSQL binaries (`NEWSCRAFT_FIXTURE_PG_BIN` may select their directory), and removes only its own fixture afterward. On 2026-10-08 it passed **64 tests** across 9 files with 20 migrations and 35 tables, including real local signup/session revocation, callback/recovery/cancellation and artifact ownership. Model/OCI fixtures still use mocked transports and do not prove live cloud services.

The historical managed harness has been removed; no runtime toggle enables it. The active runner reuses public tool schemas/local validation from `runtime.py`; the OCI adapter reuses fixed no-follow file/terminal payloads from `sandbox.py`. The historical `ComputerSandbox` browser/admission implementation remains unselected. The old paid validator CLI exits before execution. `node scripts/agent-deepseek-acceptance.mjs --check` is passive. Its historical $0.06 execution approval is already consumed: a repeat requires a new identity and explicit approval, not reuse of the handoff sentence. That fixture tests real DeepSeek inference with synthetic research and local checkpoints/files, without app/database/storage/browser access. See [future live acceptance](../../docs/agent-live-validation-approval.md) for checks still requiring authorization and infrastructure.

## Release-worktree Python verification — 2026-11-08

The renamed `services/agent` package (`newscraft_agent`) passes the full
**797-test** discovery suite, including the synthetic localhost HTTP transport
test and mocked local capacity-harness unit tests, using the existing locked
CPython 3.11.16 interpreter. Tests ran with a sanitized environment, no credentials
and `TMPDIR=/private/tmp`; no modules were excluded in the final matrix.
Five new classifier/repair regression tests pass; broadcast routing,
tape checks, durable recovery and dual-format publication coverage remain green.
This is a local release-worktree result, not worker deployment or live-provider
acceptance. The earlier 803-test result below belongs to the pre-rename checkout.
The offline lock check resolves 30 packages without installing or upgrading any.
See [the complete candidate/release receipt](../../docs/evidence-release-2026-11-08.md)
for app, database, storage and browser measurements and rollout gates.

## Historical verification — 2026-11-07

See the [fresh measured matrix](../../docs/agent-local-handoff.md#status-as-of-2026-11-07)
and [review findings](../../docs/agent-review-2026-11-07.md). This session uses local
main starting at `1b36d21`, Node 24.21.0, pnpm 9.15.9 and the locked owned CPython
3.11 environment. The disposable schema contract now has 26 migrations and 39
public tables. No hosted migration, paid inference or Linux acceptance is implied.

| Fresh local check | Measured result |
| --- | --- |
| App / shared / historical harness / ledger eval | 948 / 31 / 343 / 32 passed; 63 DB-gated and 2 opt-in skips |
| Full owned Python service | 803 passed including synthetic localhost HTTP |
| Disposable Postgres / setup / launcher | 73 / 30 / 9 passed; disposable fixture stopped and removed |
| Production-helper safety / editor launch | 6 / 3 synthetic tests passed; production helper not executed |
| Additional infra fixtures | 3 shell fixtures + 10 Node tests, including the 3 editor tests; disposable databases only |
| Svelte check / build / offline lock | Passed; 0 check errors or warnings |
| Historical fixture eval | 25/25 prompts, 17/17 trust traps |
| Passive setup / no-dispatch readiness | Setup passes; worker 200; app 503 (database connectivity), both listeners stopped |
| Playwright | Skipped: explicit database-backed setup required |

## Historical verification dated 2026-10-08

The [historical handoff](../../docs/agent-local-handoff.md#status-as-of-2026-10-08) records the DeepSeek fixture checks, local startup/auth follow-up, and earlier replacement matrix. It also records one approved synthetic DeepSeek acceptance; that one-shot approval is consumed. Object-storage and actual Linux/Chromium acceptance remain separate. No current live deployment claim follows from these dated results.

Historical replacement matrix measured on 2026-10-07, before the DeepSeek update:

| Check | Result |
| --- | --- |
| App / shared / historical harness tests | 684 / 7 / 343 passed; 51 DB-gated and 2 opt-in live skips |
| Owned Python service | 544 passed, including real loopback HTTP |
| Disposable Postgres / local helper | 54 / 18 passed; fixture stopped and removed |
| Svelte check / build / offline lock | Passed; 0 check errors or warnings |
| Historical fixture eval | 25/25 prompts, 17/17 trust traps |
| Local startup / live acceptance | Database-entry gate resolved by the recorded follow-up; one approved synthetic DeepSeek acceptance run passed on 2026-10-08 (5 requests, $0.043958 reserved of $0.06), see docs/agent-local-handoff.md |
| Playwright | Skipped: explicit database-backed setup required |
