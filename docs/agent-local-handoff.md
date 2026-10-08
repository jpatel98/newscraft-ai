# Status as of 2026-10-07

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

**Blocked on Jigar:** privately add the real key to
`services/newsroom-harness/.env.local` as exactly one line (replace the placeholder):

```dotenv
DEEPSEEK_API_KEY=<YOUR_REAL_DEEPSEEK_API_KEY>
```

No DeepSeek key was invented, copied or exposed. Its paid acceptance still needs
this separate approval sentence:

> I approve one public/synthetic DeepSeek acceptance run using deepseek-flash through the Messages API with thinking disabled and public search only, capped at 8 model requests, 120,000 cumulative reserved input tokens, 2,048 output tokens per request, 180 seconds, and a $0.06 application reservation budget at peak ceilings of $0.30/M input and $1.20/M output; no automatic retries or repeat run.

Provider access and live artifact delivery remain unverified. The Linux executor
host/images/seccomp decision remains separate. Existing prohibitions on
Contabo/Hydra, old Supabase, paid calls without approval, deployment and pushes
remain in effect. The test evidence below distinguishes the new provider fixtures
from the earlier successful local startup.

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
