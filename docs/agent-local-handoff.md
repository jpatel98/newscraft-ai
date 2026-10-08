# Status as of 2026-10-07

**Working locally:** the owned portable runtime passes the verification matrix
below. This session reviewed the replacement against base `cb3dec9`, fixed the
listed defects and committed the replacement locally in reviewed slices. Nothing was pushed or deployed.

**Blocked on Jigar:** privately enter the new project's `DATABASE_URL`; separately
approve the single $4.23 paid acceptance run; select an authorized Linux executor
host and its reviewed images/seccomp policy. These are independent gates. The
passive checker still reports only absent database configuration. No app/worker
startup or live health result is claimed while that check fails.

Next commands on the Mac mini:

```sh
cd /Users/macserver/Development/newscraft-ai
export PATH="/Users/macserver/.local/share/fnm/node-versions/v24.21.0/installation/bin:$PATH"
open -e /Users/macserver/Development/newscraft-ai/.env.agent-local
# Privately fill the existing DATABASE_URL entry, then save and close the editor.
node scripts/agent-local.mjs check
# After every configuration check passes, local startup is already authorized:
node scripts/agent-local.mjs start
```

Stop the foreground launcher with Ctrl-C. A passing checker permits a loopback
startup/health check; it does not approve paid research. The assistant can resume
that already authorized startup without requesting permission again. Do not send
or paste the connection string into chat or terminal commands.

## Measured verification in this session

Run with Node **24.21.0**, pnpm **9.15.9**, and the locked **CPython 3.11**
`services/hermes-chat/.venv-owned`. Final counts below are updated after review
fixes; no result depends on a previous session's `/tmp` claims.

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
| `node scripts/agent-local.mjs check` | Expected exit 1: missing new-project `DATABASE_URL` causes both target/project diagnostics. Other checks pass. |
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
  remain marked historical. The two `.env.example` templates are updated locally
  but excluded from commits to honor the instruction never to commit `.env*`.

The [dated review ledger](agent-review-2026-10-07.md) records findings, regression
evidence and isolated commit verification.

## Already initialized database — do not repeat

The user/previous handoff reports **newscraft-agent**, project
**`ygsiifvjzdazfxflmpjq`**, initialized with migrations `0000`–`0018`, all **33**
public tables RLS-enabled and no table grants to `PUBLIC`, `anon` or
`authenticated`. No browser row policies are intended; authenticated app routes
own authorization. The narrow platform auto-RLS function execution revoke was
also previously applied and verified. This session did not reverify cloud state.

The preserved [initial schema artifact](../services/hermes-chat/deploy/newscraft-new-project-schema.sql)
has SHA256 `ee09d4123aa040bcdae115694220852e20a892a4666aa3c05f5410945358e1be`.
Do not rerun it, initialize another project, or touch the old project. The local
Postgres fixture is separate and supplies no runtime cloud credential.

Use this project's actual **Connect** panel and enter its session-pooler URL
privately (port 5432, project-scoped username); never guess its hostname. The
guarded profile also accepts that project's direct connection when reachable.
It permits only `sslmode=verify-full` as a URL query option, rejects transaction
pooler port 6543 and other projects, and never falls back to the root environment's
old database. Extra public CA trust, if required, uses `NODE_EXTRA_CA_CERTS` before
Node starts. No Auth/Storage key or credential copying is needed for the default
Postgres auth/VPS storage configuration.

## Local and paid acceptance boundaries

The passive helper reports only names/statuses. It does not connect to the
database, storage or model service. Startup performs normal database recovery;
this initialized new target is the only authorized target. `/api/health` and
`/ready` may then be checked on loopback before clean shutdown. `/ready` reports
configuration with `accessVerified: false`; it is not a model/storage proof.

The proposed separate paid test is one public/synthetic source-to-cited-answer
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
