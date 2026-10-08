# Status as of 2026-10-08

**Working locally:** owned orchestration and DeepSeek support are merged on
`main` via PR #7, merge `4df5b3e`. Jigar saved the dedicated key privately;
`node scripts/agent-local.mjs check --provider deepseek` exits **0**, every row
OK. No key or connection string was displayed, copied into commands, or committed.

Measured with Node **24.21.0**, pnpm **9.15.9**, and locked CPython **3.11**:

| Check | Measured result |
| --- | --- |
| Authorized new database | Guarded repo runner applied **only `0017_topic_projects`**, with no baseline/initialization. Exact migration contract **20/20**, schema status `ok: true`. |
| Table protections | **35/35** public tables have RLS enabled. Both new project tables have no PUBLIC/`anon`/`authenticated` table grants. Older grants were not re-audited. |
| UI `/api/health` and worker `/ready` | Both HTTP **200**, `ok: true`, `state: ready`. Private worker readiness: provider `deepseek`, model `deepseek-flash`, `apiMode: messages`, owned orchestration, **`accessVerified: false`**. |
| Signup / fresh sign-in | Passed through loopback forms in isolated headless Chrome. |
| Empty conversation | Create/list/reopen passed; creation and history HTTP **200**, **0 messages / 0 chat requests**. |
| Shutdown | Launcher exited **0** after SIGINT. Exclusive bind/close confirmed ports **3001/8000 free**. |
| `pnpm check` | **0 errors / 0 warnings**. |
| Setup / launcher fixtures | **28 / 7 passed**. |
| `pnpm test` | App **708 passed / 54 DB-gated skips**, shared **7 passed**, historical harness **343 passed / 2 opt-in live skips**. |
| Disposable Postgres fixture | **64 tests / 9 files passed**, **20 migrations / 35 tables**; its own fixture stopped and removed. |
| Full owned Python suite | **588 passed**, including **18** standalone acceptance fixtures and the real localhost HTTP test. Run with `TMPDIR=/private/tmp` on this Mac; the default symlinked temp path is intentionally rejected by isolation. |
| Standalone acceptance `--check` | Exit **0**, credential reference exists, one-shot scope unused, **0 network requests**. This check reads only path metadata; the separate setup checker validates key shape. |

Retained disposable account: `local-smoke-20261008-fa6dc0de@example.invalid`;
conversation: `0muzpp56m7fdbf9777a33c814`. Password and cookies were not saved.
No database records were deleted. Browser requests to chat, optional storage
capability probes and external origins were blocked during this smoke check.

Local migration commit: `770b2e3` (`Guard the local topic migration and verify the exact schema contract`).

**Changed:** added an exact pending-migration guard under the runner's advisory
lock, portable role revocations for the topic migration, and a shared schema
checker that requires the exact version set instead of accepting a row count.
The narrow local database command uses the existing guarded target and verified
TLS; historical SQL and the initial schema artifact remain unchanged. Regression
coverage preserves populated topic-upgrade data. The prepared acceptance command
has exclusive admission, retained uncertain-request reservations, honest access
reporting, exact CSV/header/row validation and a deterministic deadline test.

To repeat safe configuration/schema checks or local startup:

```sh
cd /Users/macserver/Development/newscraft-ai
export PATH="/Users/macserver/.local/share/fnm/node-versions/v24.21.0/installation/bin:$PATH"
export NODE_EXTRA_CA_CERTS="$PWD/config/certs/supabase-prod-ca-2021.crt"
node scripts/agent-local.mjs check --provider deepseek
pnpm --filter @newscraft/newsroom-harness exec tsx ../../scripts/agent-local-db.ts inspect
# Optional authorized startup; Ctrl-C stops both listeners:
node scripts/agent-local.mjs start --provider deepseek
```

The already completed migration used the same command with `apply-topic` in
place of `inspect`. It refuses any pending set other than the one topic migration;
an already complete ledger is a verified no-op. Do not reinitialize the project.

**Prepared, not executed:** `node scripts/agent-deepseek-acceptance.mjs --check`
checks the standalone acceptance configuration without a provider call. The paid
command below exercises the real DeepSeek adapter and owned portable loop with
synthetic research, local checkpoints and validated local Markdown/CSV artifacts.
Only DeepSeek receives network requests. This deliberately scoped acceptance
does not verify app callback durability, public retrieval, remote storage,
download grants, Linux isolation or browser execution. The existing app storage
profile remains outside this run because Contabo/Hydra access is prohibited.

Pre-run checklist:

1. Obtain Jigar's separate sentence below; no paid execution is authorized yet.
2. Use the Node/Python versions above; the passive setup and acceptance checks
   must pass. Recheck current provider pricing against the fixed peak ceilings.
3. Keep `deepseek-flash`, Messages, thinking disabled, **8** model requests,
   **120,000** cumulative reserved input tokens, **2,048** output tokens/request,
   **180 seconds**, and **$0.06** reservation cap. No paid search.
4. Keep `.data/deepseek-acceptance-20261008` unused. The command's exclusive
   one-shot admission blocks a repeat even after failure; do not remove/reset it.
5. Keep app services stopped. No database, app storage, executor, deployment,
   old project or prohibited host is involved. Retain the private local
   `.data/deepseek-acceptance-20261008/report.json` and generated artifacts for review.

Exact approval sentence:

> I approve one synthetic DeepSeek acceptance run using deepseek-flash through the Messages API with thinking disabled, synthetic research, local checkpoints and local files only, capped at 8 model requests, 120,000 cumulative reserved input tokens, 2,048 output tokens per request, 180 seconds, and a $0.06 application reservation budget at peak ceilings of $0.30/M input and $1.20/M output; no automatic retries or repeat run.

After that approval, from this checkout with Node 24 on PATH, execute **once**:

```sh
node scripts/agent-deepseek-acceptance.mjs --execute --approved-usd 0.06
```

The unrounded maximum is **$0.0556608**; reservations round upward and are never
refunded for lost responses. This is an application reservation, not a provider
billing guarantee. **Blocked on Jigar:** that paid approval and the separate
Linux executor host/image/seccomp decision. Provider access, answer quality,
remote artifacts and Linux acceptance remain **Unverified**. Nothing was pushed,
deployed, or sent to a paid provider during this validation.

## Historical DeepSeek implementation verification — 2026-10-07

**DeepSeek provider update:** the owned runtime now supports
`NEWSCRAFT_AGENT_MODEL_PROVIDER=deepseek` with a dedicated `DEEPSEEK_API_KEY`
reference and `DEEPSEEK_BASE_URL=https://api.deepseek.com/anthropic`. It reuses
Messages tool encoding, explicitly disables thinking, omits provider-incompatible
fields, and keeps the existing durable checkpoints and reservations. Current
official docs list `deepseek-flash` and `deepseek-v4-pro`; the requested historical
`deepseek-chat`/`deepseek-reasoner` names are retired and rejected locally. DeepSeek
now also supports Responses, but this implementation selects Messages. See
[verified sources, prices and setup](managed-agent-setup.md#deepseek-setup-and-proposed-acceptance).

The new guarded selection is `check --provider deepseek` or
`start --provider deepseek`. It preserves `.env.agent-local` and applies Flash,
public search, peak **$0.30/M input / $1.20/M output**, 8 model requests,
120,000 cumulative reserved input tokens, 2,048 output tokens per request,
180 seconds and a **$0.06** application cap in memory. The maximum token charge
is **$0.0556608** before conservative per-request rounding. Cache discounts and
lost responses do not refund reservations; this is not a provider billing cap.

The dedicated key was absent during this historical implementation check.
That gate is resolved by the 2026-10-08 validation above.

No DeepSeek key was invented, copied or exposed. The following historical broader
proposal was not approved; the prepared synthetic-only command above has the
current approval sentence:

> I approve one public/synthetic DeepSeek acceptance run using deepseek-flash through the Messages API with thinking disabled and public search only, capped at 8 model requests, 120,000 cumulative reserved input tokens, 2,048 output tokens per request, 180 seconds, and a $0.06 application reservation budget at peak ceilings of $0.30/M input and $1.20/M output; no automatic retries or repeat run.

Provider access and live artifact delivery remain unverified. The Linux executor
host/images/seccomp decision remains separate. Existing prohibitions on
Contabo/Hydra, old Supabase, paid calls without approval, deployment and pushes
remain in effect. The test evidence below distinguishes the new provider fixtures
from the earlier successful local startup.

Measured for this DeepSeek update with Node **24.21.0**, pnpm **9.15.9** and
the locked **CPython 3.11** environment:

| Check | Result |
| --- | --- |
| Full owned Python suite | **570 passed**, including the real localhost HTTP test; 12 dedicated DeepSeek adapter cases and durable research/citation/artifact/replay fixtures. |
| Local setup / launcher fixtures | **28 / 7 passed** (**35 total**). |
| `pnpm test` | App **684 passed / 51 DB-gated skips**, shared **7 passed**, historical harness **343 passed / 2 opt-in live skips**. |
| `pnpm check` | **0 errors / 0 warnings**. |
| `pnpm build` | Passed; nonfatal chunk/tracing warnings. |
| Offline locked dependency check | Passed; **30 packages** resolved, no install or upgrade. |
| `node scripts/agent-local.mjs check --provider deepseek` | Expected exit **1**, **only the missing dedicated credential is blocked**; database, TLS target, budgets and other configuration checks pass. No network request or service start. |

Review caught and fixed Pro image dispatch (Pro has no vision), mismatched model
and budget selection, malformed selected-key declarations, and an Anthropic
credential-file fallback regression. Flash images retain the conservative image
allowance. All provider requests in these tests used synthetic transports;
actual DeepSeek availability, answer quality and billing remain unverified.

During implementation, another process moved the shared checkout from `main`
to `deepseek-provider-support` and committed the main provider slice as
`cc869a3`. This session preserved it and made the remaining review/documentation
commit locally on that branch. No push or branch-change command was run by this
session; do not infer remote state from the local checks.

## Earlier local startup validation (2026-10-07)

**Working locally:** Jigar saved the new project's database configuration. The
passive checker exits **0**. Node **24.21.0** startup initially reproduced UI
HTTP **503**, `ok: false`, `state: unavailable`, while the worker was ready.
The database connection failed with `SELF_SIGNED_CERT_IN_CHAIN` during TLS,
before SQL. Adding Supabase's verified public CA through `NODE_EXTRA_CA_CERTS`
resolved it with `sslmode=verify-full` and hostname verification intact.

Measured follow-up results on 2026-10-07:

| Check | Result |
| --- | --- |
| `GET http://127.0.0.1:3001/api/health` | HTTP **200**, `ok: true`, `state: ready`. |
| `GET http://127.0.0.1:8000/ready` | HTTP **200**, `ok: true`, `state: ready`. Provider access remains unverified. |
| Signup and sign-in | Isolated headless Chrome submitted the loopback signup form, cleared browser cookies, then signed in through the login form successfully. |
| Empty conversation | Authenticated `POST /api/conversations` returned HTTP **200**; the new conversation appeared in the UI list after reload and reopened successfully. History returned HTTP **200** with **0 messages**; **0 chat requests**. |
| Shutdown | Launcher exited **0** after SIGINT; both children exited. Exclusive loopback bind/close confirmed ports **3001** and **8000** free. |
| Follow-up checks | `pnpm check`: **0 errors / 0 warnings**; setup helper: **18 passed**; passive setup check: exit **0**. |

Retained disposable account: `local-smoke-20261007-c71e047a@example.invalid`
(display name `Local validation 2026-10-07`). Retained conversation:
`0muyvlw9fd744bdccd5e9a6d3`. Signup and sign-in created their normal database
records; no database cleanup or deletion was performed. The generated test
password and session cookies were not recorded. Optional storage capability
probes and chat endpoints were blocked in this isolated browser check, keeping
storage and paid providers outside the validation scope.

**Changed:** committed the public CA with provenance and fingerprints, documented
the verified launch configuration, and included both reviewed `.env.example`
templates under Jigar's explicit follow-up authorization. The earlier six local
replacement commits and their full verification matrix remain below. No private
environment file was changed or committed. Nothing was pushed or deployed.

**Original remaining gates:** the earlier **$4.23 OpenAI acceptance proposal**
was never approved or run; the new **$0.06 DeepSeek proposal** above is now the
requested route. Select an authorized **Linux executor host** with reviewed images
and seccomp policy separately. The database-entry and local startup gates are resolved. No paid
model call, storage acceptance, migration or production change was performed.

Next commands on the Mac mini:

```sh
cd /Users/macserver/Development/newscraft-ai
export PATH="/Users/macserver/.local/share/fnm/node-versions/v24.21.0/installation/bin:$PATH"
export NODE_EXTRA_CA_CERTS="$PWD/config/certs/supabase-prod-ca-2021.crt"
node scripts/agent-local.mjs check --provider deepseek
# After every configuration check passes, local startup is already authorized:
node scripts/agent-local.mjs start --provider deepseek
```

In another terminal, `curl --fail http://127.0.0.1:3001/api/health` and
`curl --fail http://127.0.0.1:8000/ready` repeat the health checks. Stop the
foreground launcher with Ctrl-C. Startup is already authorized; paid research
still needs separate approval. Do not send or paste the connection string into
chat or terminal commands. See [public CA details](../config/certs/README.md).

## Earlier replacement-review verification (2026-10-07)

Run with Node **24.21.0**, pnpm **9.15.9**, and the locked **CPython 3.11**
`services/hermes-chat/.venv-owned`. Final counts below are updated after review
fixes. This is the earlier complete matrix, not a claim that the narrow startup
follow-up reran every suite; its fresh results are recorded above.

| Check | Result |
| --- | --- |
| `pnpm check` | Passed: 0 errors / 0 warnings. |
| `pnpm test` | App **684 passed / 51 DB-gated skips**; shared **7 passed**; legacy harness **343 passed / 2 opt-in live skips**. |
| Python `unittest` service suite | **544 passed**, including loopback HTTP and socket lifecycle/deadline regressions. |
| `node scripts/agent-local.test.mjs` | 18 passed after setup guard regressions. |
| `node scripts/test-agent-postgres-fixture.mjs` | **54 integration checks passed** across 8 files, including concurrent conversation-key collision; 19 migrations, 33 tables; stopped/removed its own fixture. |
| `pnpm build` | Passed. Nonfatal chunk/plugin timing and optional native/OpenTelemetry tracing warnings. |
| `pnpm eval:fixture` | 25/25 prompts, 17/17 trust traps. Historical harness fixture evaluation, not owned live-model acceptance. |
| `uv lock --check --offline --no-cache --no-python-downloads` | Passed; 30 packages resolved, no installation/upgrade. |
| `node scripts/agent-local.mjs check` | Earlier: exit 1 for absent `DATABASE_URL`. Resolved in the follow-up above: exit **0**. |
| `pnpm test:e2e` | Skipped: Playwright requires a running database for auth/seed/conversation tests and explicit `E2E_DATABASE_URL`; it cannot run database-free. No cloud database substituted. |

The sandbox initially denied Postgres shared memory and loopback sockets. Scoped
local-test execution then passed. Python uses `TMPDIR=/private/tmp` to avoid
macOS `/var` symlink rejection by the real private-path guard. No assertions were
relaxed and no upstream `hermes-agent` package or upgraded dependency was installed.
Session command output is under `/tmp/newscraft-review-20261007/`; only aggregate
results belong in commits and memory.

## Review fixes

- Stable account/conversation workspace identity across prompt changes and output
  transforms; the worker retains its original saved input for existing runs.
- Durable input admission aligned with the 512 KiB worker bound, separately from
  the smaller event bound; chat admission checks actual bytes before DB work.
- Subscription disconnect stops subscriber DB polling without cancelling the run;
  concurrent idempotency replay rechecks conversation binding under transaction.
- Public retrieval rejects non-global/transition addresses and preserves
  cancellation/deadline checks while reading source bodies and redirects.
- Publication and update timestamps stay distinct in recorded citations.
- Recovery binds request endpoints and complete budget policy; Anthropic requests
  explicitly select the standard service tier.
- Fixed exception and HTTP transport logging excludes raw provider details and
  signed artifact URLs, and the prompt
  accurately describes conditional browser tools.
- Ordinary activity renders public research details and outcomes, without raw
  commands, exit codes, workspace paths or browser element IDs.
- Guarded local setup rejects inherited computer configuration and a non-3.11
  Python library tree; generic local startup defaults to `.venv-owned`.
- Disposable Postgres fixes its locale to C, avoiding a reproduced macOS startup
  failure when caller locale was absent/invalid.
- ROADMAP and SOURCE_OF_TRUTH now describe the owned runtime; historical records
  remain marked historical. The two `.env.example` templates were initially
  excluded from commits; Jigar explicitly authorized their follow-up commit.

The [dated review ledger](agent-review-2026-10-07.md) records findings, regression
evidence and isolated commit verification.

## Already initialized database — do not repeat

The user/previous handoff reports **newscraft-agent**, project
**`ygsiifvjzdazfxflmpjq`**, initialized with migrations `0000`–`0018`, all **33**
public tables RLS-enabled and no table grants to `PUBLIC`, `anon` or
`authenticated`. No browser row policies are intended; authenticated app routes
own authorization. The narrow platform auto-RLS function execution revoke was
also previously applied and verified. The follow-up verified connectivity and
account/conversation operations, but did not repeat the migration/RLS/grant audit.

The preserved [initial schema artifact](../services/hermes-chat/deploy/newscraft-new-project-schema.sql)
has SHA256 `ee09d4123aa040bcdae115694220852e20a892a4666aa3c05f5410945358e1be`.
Do not rerun it, initialize another project, or touch the old project. The local
Postgres fixture is separate and supplies no runtime cloud credential.

Use this project's actual **Connect** panel and enter its session-pooler URL
privately (port 5432, project-scoped username); never guess its hostname. The
guarded profile also accepts that project's direct connection when reachable.
It permits only `sslmode=verify-full` as a URL query option, rejects transaction
pooler port 6543 and other projects, and never falls back to the root environment's
old database. This Mac requires the checked-in public CA through
`NODE_EXTRA_CA_CERTS` before Node starts, as shown above. No Auth/Storage key or
credential copying is needed for the default
Postgres auth/VPS storage configuration.

## Local and paid acceptance boundaries

The passive helper reports only names/statuses. It does not connect to the
database, storage or model service. Startup performs normal database recovery;
this initialized new target is the only authorized target. `/api/health` and
`/ready` may then be checked on loopback before clean shutdown. The measured
public readiness response reports service state; it is not a model/storage proof.

The historical OpenAI proposal below has not been approved or run; use the
DeepSeek-priced proposal in the Status section for the newly requested route.

That proposed separate paid test was one public/synthetic source-to-cited-answer
and Markdown/CSV run: OpenAI `gpt-6-astra`, default tier, public search, 180 seconds,
at most 8 model requests, 120,000 cumulative reserved input tokens and 2,048
output tokens per request. Configured price ceilings are $25/$75 per million,
with arithmetic `(120000 × 25 + 8 × 2048 × 75) / 1000000 = $4.2288` and a **$4.23**
application reservation cap. This is a proposed configuration, not current pricing
verification or a provider billing guarantee. Review actual prices before the
separate approval; no paid call or automatic repeat is authorized here.

Suggested task after approval: “Find one short primary-source public announcement,
verify the exact supporting excerpt, give a concise cited answer, and produce a
short Markdown brief and one-row CSV containing the source URL.” Validate saved
citations, both downloads/checksums and reconnect. See
[live acceptance](agent-live-validation-approval.md) for the remaining gates.

## Linux executor remains separate

Research and Markdown/CSV do not need a computer backend. Actual terminal and
interactive Chromium acceptance require an approved non-root Linux host, existing
private rootless daemon/socket, cgroup v2/systemd delegation, reviewed immutable
images and a hash-pinned deny-by-default Chromium seccomp policy. Private snapshots,
browser storage and receipts require a retained worker volume independently of
Postgres. Synthetic fixtures do not prove the kernel/container boundary.

See [executor commands](../services/hermes-chat/deploy/executor.md) and the
[dated deployment decision](agent-deployment-decision.md). No host is selected by
this session. Do not reinstall Docker/Colima/Lima on this Mac, SSH into Contabo,
touch personal Hydra, create cloud resources, change DNS or deploy production.
