# NewsCraft owned research worker

NewsCraft owns orchestration, messages, runs, public events, citations and artifacts in ordinary Postgres. `service.py` directly selects `PortableAgentRunner` in `portable.py`; it does not call a managed agent harness. Existing `hermes_chat` and `/api/internal/hermes/runs` identifiers preserve app protocol compatibility.

The model boundary has two concrete HTTP adapters: OpenAI Responses and Anthropic Messages. They translate the same canonical messages/tool definitions into different provider protocols. OpenAI encrypted reasoning continuation stays in private run state, never public history or events. Anthropic thinking blocks are not requested or exposed. Providers/models can change at a clean new turn; an existing run must retain its original adapter and budget policy. There is no arbitrary in-flight provider interchange.

## Research and files

The default public DDGS search adapter needs no model-provider account. An optional OpenAI Responses search adapter is a separate paid request. Both return leads. NewsCraft's bounded public fetcher, archive fallback and exact-excerpt ledger validate retrieved evidence before assigning `[n]` citations. These are fetch/provenance checks, not a claim of independent semantic fact-checking. Source and document text stays untrusted user/tool data.

Public plans, actions/results, short decisions and one clean final answer persist through the existing UI. `publish_markdown` and `publish_csv` render files from content without executing model code. Research files require recorded citations; CSV rows include source URLs. Publication uses the existing leased revision/grant/upload/finalize flow with byte, MIME and SHA-256 checks, then immutable application storage. Reconnect replays Postgres events and artifacts.

`oci_executor.py` implements the rootless Linux computer adapter: terminal/read/write/list use fresh bounded containers, and interactive Chromium uses a separate container retained during a run. Private tenant/conversation snapshots, browser storage and action receipts survive worker restarts on the retained state volume. Admission and receipts bind the run/request/daemon; cleanup is confirmed before cancellation. The controller, RPC, citation and artifact flow have deterministic coverage with both model adapters. **Actual Chromium and kernel isolation still require Linux acceptance.** See [executor/browser setup, security approval and limits](deploy/executor.md). Basic cited research and Markdown/CSV publication work without computer configuration; no host execution fallback exists.

## Durable ownership and bounded work

The worker persists run-scoped canonical state, adapter-private continuation, budget reservations, pending intent and completed receipts in `agent_runtime_checkpoints`. Reads and compare-and-swap writes require account, conversation, tenant and an active lease. Public streams never expose this table. Completed tool outputs are saved before callbacks; receipts/answers replay without repeating their effects. Stale workers cannot begin a new request or publish through current grants. Dispatch checkpoints also lock the durable run row and reject committed cancellation, including before a citation-repair model request. Cleanup reads/writes remain available to the current lease owner, and renew replies reporting cancellation stop the observer. Worker/callback interruption remains recoverable.

A request or non-idempotent tool interrupted after intent is saved has an uncertain outcome. Recovery fails it safely and asks for a new user turn; it does not resubmit inference or rerun an uncertain effect. Artifact retries alone reuse a saved immutable run/call publication identity. Each publication attempt gets at most 60 seconds. Its fixed 240-second recovery window includes a full first attempt, the renewed 90-second lease, recovery polling and a full retry. At most four attempts are admitted, with each admission saved before I/O so a worker death cannot erase it. The deadline and immutable identity never reset. Only that already admitted publication may finalize after the original run deadline; new publications, research and model requests remain blocked after the run budget expires. Completed answers replay after the deadline without new effects.

Defaults: 12 model requests, 180 elapsed seconds, 120,000 cumulative conservatively estimated input tokens, 4,096 output tokens per request, and a $2 local reservation budget. Input accounting includes translated system/tool schemas, history, tool results, adapter-private replay and image allowance. Configure **reviewed positive input/output price ceilings per million tokens** for the selected provider/model; there are no invented price defaults. Optional paid search also requires a reviewed full per-call charge ceiling including search/tool/model costs. Every request reserves its maximum estimated charge before dispatch; reservations are never refunded, even when a response is lost. These are conservative application controls, **not provider-enforced billing guarantees**. Provider pricing and image assumptions must be reviewed before live use. Cancelling an HTTP request does not prove the provider stopped billing that request.

Inputs are limited to 512 KiB, private checkpoint state to 8 MiB, and generated files to 32,000 UTF-8 bytes each, 16 files and 512,000 aggregate bytes per run. Search calls default to five. Global admission defaults to four active/sixteen queued runs, with two active/four queued per tenant. No sandbox/tool side effect is implied by a configuration contract.

Blocking retrieval uses a shared cancellation/deadline signal before subsequent URLs, live/archive/CDX fetches, redirects and resolved-address attempts. Cancellation prevents the next dispatch and waits for the active thread to drain before releasing the worker slot. It cannot forcibly interrupt an already active socket or operating-system DNS call; timeout/cancel completion may therefore wait for that call to return. This limitation is reported rather than hiding active work behind a released capacity slot.

## Setup and verification

Use the root and worker `.env.example` files, then [the provider-neutral setup guide](../../docs/managed-agent-setup.md). Postgres auth and existing VPS object storage are defaults; Supabase Auth/Storage are explicit optional adapters. No Supabase variables are required by the core schema or default auth path. Model credentials remain server-side; existing OpenAI credential reuse is approved, with no key copy or new key creation required.

For this checkout, [the local setup handoff](../../docs/agent-local-handoff.md) uses a separate locked `.venv-owned` and a guarded `.env.agent-local` profile. It preserves the old environment and refuses to inherit the old database target. Preparation/checking never starts a process or contacts a provider.

`GET /ready` reports local configuration only: `orchestration: newscraft`, `apiMode: responses|messages`, `accessVerified: false`, configured terminal/workspace/browser capabilities, and local reservation bounds. Missing reviewed price ceilings or a failed configured executor/browser policy fail readiness. Readiness does not call a paid API or prove live execution/provider/storage access.

The worker requires an existing **CPython 3.11** interpreter. Browser readiness and dispatch also require the stdlib asyncio selector loop; the service entrypoint selects it explicitly. These constraints preserve the audited HTTPS memory bound. Container guest images use Python 3.12 separately. The installer uses locked dependencies without downloading an interpreter or provisioning a sandbox:

```sh
services/hermes-chat/scripts/install-runtime.sh /absolute/private/path/to/venv
```

For the authorized local setup use `node scripts/agent-local.mjs start`; its profile refuses the old database. Generic `pnpm dev:all` and `pnpm dev:agent` remain available with an independently verified environment. Service templates need private app callbacks, provider/public-web HTTPS access and private local staging. The optional executor additionally needs its existing rootless daemon/image, with no privileged Docker group, XFS or custom root broker. No app/worker/Docker service was started or deployed here; only disposable Postgres test instances were started and removed.

Offline checks (from the repository root):

```sh
TMPDIR=/private/tmp PYTHONPATH=services/hermes-chat/src services/hermes-chat/.venv-owned/bin/python \
  -m unittest discover -s services/hermes-chat/tests -p 'test_*.py'
pnpm test
node scripts/agent-local.test.mjs
node scripts/test-agent-postgres-fixture.mjs
pnpm eval:fixture
pnpm check
pnpm build
```

Run the lock check from `services/hermes-chat`: `uv lock --check --offline --no-cache --no-python-downloads`. Use `/tmp` on Linux. Restricted environments may deny the one real Python localhost transport test and the harness HTTP-server suite. `node scripts/test-agent-postgres-fixture.mjs` runs the real database integration suites on a new loopback-only Postgres instance, without reading an existing DB URL or environment secrets. It requires Node 24 and local PostgreSQL binaries (`NEWSCRAFT_FIXTURE_PG_BIN` may select their directory), and removes only its own fixture afterward. It passed 54 tests, including real local signup/session revocation, callback/recovery/cancellation and artifact ownership. Model/OCI fixtures still use mocked transports and do not prove live cloud services.

Historical `managed.py`, old `runtime.py`, the `ComputerSandbox` browser/admission implementation and their fixtures remain unselected; no runtime toggle enables a managed harness. The active runner reuses public tool schemas/local validation from `runtime.py`; the new OCI adapter reuses fixed no-follow file/terminal payloads from `sandbox.py`. The old paid validator CLI exits before execution. See [future live acceptance](../../docs/agent-live-validation-approval.md) for checks still requiring authorization and infrastructure.

## Verification dated 2026-10-07

The [local handoff](../../docs/agent-local-handoff.md#measured-verification-in-this-session) records the freshly measured complete matrix and review fixes. App, shared, historical harness, Python (including localhost HTTP), disposable Postgres, helper, check, build, fixture eval and offline lock gates ran in this session. Playwright needs an explicit database and was skipped under the database-free condition. Configuration still waits on private new-project `DATABASE_URL` entry; paid/provider/object-storage and actual Linux/Chromium acceptance remain blocked. No live deployment claim follows from these results.

Measured on 2026-10-07 after review fixes:

| Check | Result |
| --- | --- |
| App / shared / historical harness tests | 684 / 7 / 343 passed; 51 DB-gated and 2 opt-in live skips |
| Owned Python service | 544 passed, including real loopback HTTP |
| Disposable Postgres / local helper | 54 / 18 passed; fixture stopped and removed |
| Svelte check / build / offline lock | Passed; 0 check errors or warnings |
| Historical fixture eval | 25/25 prompts, 17/17 trust traps |
| Local startup / live acceptance | Blocked on private database entry / separate paid approval |
| Playwright | Skipped: explicit database-backed setup required |
