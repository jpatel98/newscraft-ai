# Status as of 2026-11-08

**Staged, not released.** The corrected candidate reconciles production
`7a39b01` and the five local review commits; PR #17 was not merged unchanged.
See [the release receipt](evidence-release-2026-11-08.md) for findings and artifacts.

- **Green:** check **0 errors / 0 warnings**; **1074 app, 37 shared, 343 historical
  harness, 32 ledger, 71 script and 797 Python tests**. Default DB-gated skips run
  separately: **94 Postgres tests / 12 files / 46 tables**. Desktop/mobile
  evidence flows pass **21 checks**, with no page errors or provider calls.
  Build, **25/25** fixture prompts, **17/17** trust traps, offline lock and infra
  fixtures pass. Fixtures stop and remove their own services/directories.
- **Changed:** transactional evidence lifecycle and cleanup; durable upload
  revocation; bounded parsing/analysis; abort-safe inspectors; accurate CSV rows
  and shared citation capacity; honest evidence-load failure; development-only
  account seeding. Product remains chat-first; tracker remains frozen.
- **Staged:** source `ca2053d`, Vercel `dpl_BXpTc8C3mV2x3VAsCeSbiYqxZK7i`,
  **READY**, no aliases, protected health **200 / ready**. Production still uses
  `7a39b01`; later public health checks return **503** or time out with database
  `ETIMEDOUT`. Host containers, worker readiness and verified database TLS are
  healthy. No source push, backup, migration, Contabo update or promotion occurred.
- **Blocked on Jigar:** specifically approve the private server-side NewsCraft
  database backup before migration/cutover. The safety layer refused it before
  execution. Revalidate public health after promotion. Paid acceptance (separate
  **$4.23** proposal) and Linux executor host/image/seccomp selection remain
  separate human gates, not live-verified capabilities.
- **Preserved:** original main/Claude worktrees and branches, two public-template
  edits and four unrelated untracked files. The original passive local checker
  passes **18/18**; a blank `DATABASE_URL` is no longer the entry gate. Do not
  copy that old local Supabase profile into the Contabo production candidate.

**Next:** answer the explicit backup-approval question, then continue the guarded
release. No credential should be pasted, displayed or guessed. These exact safe
commands only prepare reviewed SQL and probe readiness; they do not migrate:

```sh
cd /Users/macserver/Development/newscraft-ai/.tmp/release-20261108
export PATH="/Users/macserver/.local/share/fnm/node-versions/v24.21.0/installation/bin:$PATH"
export TMPDIR=/private/tmp
node scripts/prepare-evidence-migration.mjs --expect-sha256 \
  239d7ad3302cc87970abe4af52b65dbd1b21458716dcb2261e40259f2d05db54 \
  > /private/tmp/newscraft-reviewed-evidence.sql
VERCEL_PROJECT_ID=prj_pywLQLbNvNjJQObIjfs2XZIyaT9D \
VERCEL_ORG_ID=team_51SGoYrM9iWXGMMLmzaumD2c \
vercel curl /api/health --deployment dpl_BXpTc8C3mV2x3VAsCeSbiYqxZK7i \
  -- --max-time 30 --fail --silent --show-error
curl -fsS --max-time 30 https://agent.newscraftai.com/api/health
```

The final command currently may fail on the old build; do not count it as green.
Generic `pnpm test:e2e` requires explicit database-backed setup; the evidence
fixture instead creates its own loopback database. Physical Safari and paid model
quality remain unverified. Do not use ordinary worker startup as a health probe:
it can recover saved paid work; use `--health-only` for passive local startup.
Earlier dated sections below are historical, not current deployment receipts.

## Status as of 2026-11-07

**Working / measured this session:** reviewed existing local main starting at
`1b36d21`; the original replacement already landed. The newer
`claude/script-intent-router` branch and four pre-existing untracked files remain
outside these local commits. No push, deployment, production mutation or paid
provider call occurred. Product remains chat-first; tracker remains frozen.

| Check | Fresh result |
| --- | --- |
| Node / pnpm / owned Python | 24.21.0 / 9.15.9 / CPython 3.11.16; existing locked environment, no reinstall/upgrade |
| `pnpm check` | **0 errors / 0 warnings** |
| `pnpm test` | **948 app + 31 shared + 343 historical harness + 32 ledger eval passed**; 63 DB-gated app and 2 opt-in harness skips |
| Full owned Python suite | **803 passed**, including real synthetic localhost HTTP |
| Local setup / launcher / production-helper safety tests | **30 / 9 / 6 passed**; production-helper tests use synthetic injected dependencies only |
| Editor launch tests | **3 passed** |
| Additional infra suite | **3 shell fixtures + 10 Node tests passed**, including the 3 editor tests; synthetic bootstrap, backup/restore and storage only |
| Disposable PostgreSQL fixture | **73 passed / 11 files**, current **26 migrations / 39 public tables**; its own process and directory stopped/removed |
| `pnpm build` | Passed; existing optional-platform dependency tracing/chunk warnings, no deploy |
| `pnpm eval:fixture` | **25/25 prompts, 17/17 trust traps**; historical harness fixture, not live owned-model acceptance |
| Offline `uv lock --check --offline --no-cache --no-python-downloads` | Passed, 30 packages, no sync/install |
| `node scripts/agent-local.mjs check` | Passed, **18/18** passive checks; credentials not shown or copied |
| Authorized health-only startup | Worker `/ready` **200**; app `/api/health` **503** due to database connectivity failure (gateway failure false); execution endpoint **503** as intended |
| Shutdown | SIGINT launcher exit **0**; ports **3001/8000 free** |
| Playwright | Skipped: config requires explicit `E2E_DATABASE_URL`, auth/seed setup and a database; not database-free |

All counts come from commands run on November 7, not prior `/tmp` receipts.
Restricted socket/shared-memory tests were rerun with permission for their own
loopback fixtures. Assertions were not relaxed. Ledger replay now uses the same
12-claim extraction bound as production; three missing judge verdicts derive from
existing reviewed golden labels and two copy cases preserve original recorded
responses with unused input tails removed. Provenance tests verify those offline
updates; they are not new model recordings. Normal evals no longer overwrite the
pre-existing untracked reports; use `LEDGER_EVAL_REPORT_DIR=/private/tmp/<directory>`
only when fresh reports are wanted.

**Changed:** account-scoped title context; transcript processing fences and safe
logs; conservative ledger cursors; bounded paid search/auxiliary calls and byte-based
token reservations; checkpointed fast-path dispatch and no uncertain replay;
OCI preflight cancellation and retryable browser cleanup; citation/source/date
integrity, replay and microphone cleanup; safe health-only launch and eval guards.
The full file:line findings and limits are in [the review](agent-review-2026-11-07.md).
Public `.env.example` changes intentionally remain uncommitted under the `.env*`
exclusion. Existing migration SQL and initial Supabase artifact are unchanged.

**Blocked / human-owned next steps:**

- **Database:** the former blank `DATABASE_URL` entry is resolved—the passive
  checker passes. Connectivity is not: app health reports unavailable. Jigar must
  verify the authorized new project's availability and private connection entry
  without posting/copying credentials. No cloud schema or grants were re-audited,
  no migrations were run remotely, and the old project was not contacted.
- **Paid acceptance:** Jigar must explicitly approve the separate **$4.23 OpenAI**
  run after current provider pricing is reviewed. None was attempted. The historical
  October 8 synthetic DeepSeek one-shot is already consumed, not reusable approval.
- **Linux executor:** Jigar must choose/authorize the host, immutable images and
  reviewed seccomp policy. No Docker/Colima/Lima reinstall, Contabo SSH, new cloud
  resource or Linux/Chromium acceptance was performed.

Exact safe next commands (after privately resolving database connectivity):

```sh
cd /Users/macserver/Development/newscraft-ai
export PATH="/Users/macserver/.local/share/fnm/node-versions/v24.21.0/installation/bin:$PATH"
export TMPDIR=/private/tmp
export NODE_EXTRA_CA_CERTS="$PWD/config/certs/supabase-prod-ca-2021.crt"
node scripts/agent-local.mjs check
node scripts/agent-local.mjs start --health-only
```

In another terminal, run `curl -fsS http://127.0.0.1:3001/api/health` and
`curl -fsS http://127.0.0.1:8000/ready`; then Ctrl-C the launcher. Health-only mode
disables worker recovery and denies all execution endpoints. Do **not** replace
it with ordinary startup under a no-paid-call restriction: ordinary startup can
claim saved work. Do not use the production helper or rerun initialization.

## Status as of 2026-10-08

**Historical receipt:** retained unchanged below; the November 7 status supersedes
its configuration, counts and next steps.

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

**Executed once on 2026-10-08 (approved):** Jigar approved the one-shot paid
acceptance with the exact sentence below, and
`node scripts/agent-deepseek-acceptance.mjs --execute --approved-usd 0.06` was
run once from this checkout with Node 24 and `TMPDIR=/private/tmp`. It
exercised the real DeepSeek adapter and owned portable loop with synthetic
research, local checkpoints and validated local Markdown/CSV artifacts. Only
DeepSeek received network requests.

| Measure | Result |
| --- | --- |
| Outcome | `accepted`, `passed: true`, `provider_access_verified: true`, `repeat_allowed: false`. |
| Model requests | **5 admitted / 5 completed** of the 8 allowed; `deepseek-flash`, Messages, thinking disabled. |
| Reservations | **105,560** input tokens of 120,000; **10,240** output tokens (5 × 2,048); reserved cost **$0.043958** of the $0.06 cap. Application reservation, not a provider bill. |
| Research | Synthetic fixture source, publication date `2026-01-15T12:00:00Z` taken from page metadata, not the retrieval date. |
| Artifacts | `artifacts/1-brief.md` (856 bytes) and `artifacts/2-evidence.csv` (262 bytes) with the exact supporting sentence, source URL, publication date and `[1]` citation; digests recorded in `report.json`. |
| Model behaviour | First `record_newscraft_source` call used an invalid source type and was rejected; the model retried with a valid type. The final answer labels the material synthetic. |

Private evidence is retained, git-ignored, under
`.data/deepseek-acceptance-20261008/` (`admission.json`, `checkpoint.json`,
`report.json`, `request-1..5.json`, `artifacts/`). The exclusive one-shot
admission is now consumed; a second run needs a new identity and a new approval.
This scoped acceptance did not verify app callback durability, public retrieval,
remote storage, download grants, Linux isolation or browser execution.

Approval sentence that was given:

> I approve one synthetic DeepSeek acceptance run using deepseek-flash through the Messages API with thinking disabled, synthetic research, local checkpoints and local files only, capped at 8 model requests, 120,000 cumulative reserved input tokens, 2,048 output tokens per request, 180 seconds, and a $0.06 application reservation budget at peak ceilings of $0.30/M input and $1.20/M output; no automatic retries or repeat run.

**Still separate:** the Linux executor host/image/seccomp decision. Remote
artifacts, public retrieval and Linux acceptance remain **Unverified**. Nothing
was deployed.

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
`services/agent/.venv-owned`. Final counts below are updated after review
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
relaxed and no third-party agent package or upgraded dependency was installed.
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

The preserved [initial schema artifact](../services/agent/deploy/newscraft-new-project-schema.sql)
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

See [executor commands](../services/agent/deploy/executor.md) and the
[dated deployment decision](agent-deployment-decision.md). No host is selected by
this session. Do not reinstall Docker/Colima/Lima on this Mac, SSH into Contabo,
touch personal Hydra, create cloud resources, change DNS or deploy production.
