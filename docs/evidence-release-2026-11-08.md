# Evidence workspace release — 2026-11-08

## Approved rollout progress

Jigar explicitly approved the private server-side backup on November 8. This
section supersedes the pre-approval snapshot below; no paid acceptance was approved.

- **Backup complete:** private directory
  `/home/jigar/services/newscraft-infra/newscraft-postgres/backups/release-20261108-XZUIt1`
  is mode 0700; `database.dump` is mode 0600, 14,721,723 bytes, SHA-256
  `c92ac1208f739515b7987fff7d83abec0d2ff0e23ff586588e32f4f47f915eef`.
  Archive listing and full decode to `/dev/null` pass on the server. It was not
  downloaded, displayed or restored into a second database. Only checksum-proven
  public gateway source and the prior image were additionally retained; no private
  environment file was copied.
- **Migration complete:** only checksum-guarded `0027_project_evidence` was
  committed, producing the exact 29-version ledger on PostgreSQL 17.11. The six
  new evidence tables have RLS enabled, all four application privileges and no
  PUBLIC grants. Production has **47 public tables / 22 with RLS**, not the local
  fixture's 46-table schema; do not claim every older table has RLS. Older data,
  grants and the additional pre-existing `mission_crawl_plans` table were not
  rewritten. The tracker remains frozen.
- **Storage complete:** existing `newscraft-storage` runs image
  `sha256:9ca9ab330f1fedc1602107438ab0515ee4289b31e50f03f1d488f48cb9b81602`.
  Health and both private policies advertise upload revocation. The image overlays
  only reviewed server code on the retained immutable image, keeping Node 22.23.3
  and all dependencies. The legacy builder required preserving mode 0444 in the
  build context instead of using BuildKit's unsupported `COPY --chmod` flag.
- **Worker held safely:** 52 deployed source files verified and Python syntax
  passed under the unchanged remote 3.11.15 environment. Readiness rejected the
  first new-worker attempt; the previous `7a39b01` source was restored and is
  active/ready. Working directory, private state, unit environment and venv were
  retained. No unfinished runs existed before cutover.
- **Confirmed configuration gate:** Exa was already selected, but had no paid
  search reservation ceiling. The new fail-closed guard correctly refuses this
  combination. The proposed non-secret override reserves **$0.02 per bounded
  call** inside existing run limits, without changing credentials or making a
  paid validation request. [Exa's current pricing](https://exa.ai/pricing), checked
  November 8, lists Auto at $7 per 1,000 searches with up to ten results; this
  adapter requests six results and no summaries. The chosen reserve is
  conservative, not a provider billing guarantee.
- **Approval pending:** auto-review rejected installing that persistent public
  budget override before execution as a cost-bearing provider configuration.
  Neither policy nor drop-in was installed. The user has been asked to approve
  retaining Exa with the reserve or explicitly choose free public search instead.
  Do not bypass this gate by altering code defaults, injecting the value through
  another path or disabling the guard. No source push or app promotion has run.
- Protected staged app health remains **200 / ready** against the updated schema
  and gateway. The latest public health recheck also returned **200**, without
  changing the original app alias; earlier database timeouts remain recorded
  below rather than assigned an unproved root cause. The public alias remains on
  the original deployment until the worker gate is resolved. No model or Exa API
  request was made by validation.
- The complete matrix passed again after extending the exact $0.02 reservation
  regression: two calls reserve 40,000 microusd, a third is blocked at that budget
  without dispatch or refund. Fresh log:
  `/private/tmp/newscraft-release-post-approval-matrix.log`; counts remain
  1,074 app, 37 shared, 343 harness, 32 ledger, 71 scripts, 797 Python,
  94 Postgres and 21 desktop/mobile checks, with check 0 errors/warnings.

## Historical pre-approval snapshot

Status: corrected implementation and final local matrix pass, including repeated
desktop/mobile confirmation and guarded migration/rollback regressions.
Production source/traffic remain unchanged; the explicit private-backup approval
is pending. The staged build is READY and its protected health check passes, but
the existing public build has a subsequently observed database timeout.
This is not a completed production deployment receipt.

## Candidate

- Preserve production main `7a39b01`, the five local reviewed commits
  `9532c23..1860f69`, and the original main/evidence worktrees.
- Prepare a corrected evidence implementation in an isolated release worktree;
  do not merge PR #17 as-is or rewrite either existing branch.
- Keep the product chat-first and the tracker frozen.
- Local feature merge: `517430e50dc0f9b9d478d143d14ec9ce1ba00a31`, with
  parents `7a39b01` and `1860f69`; final packaging also removes imported trailing
  blank lines. Original main and Claude worktrees remain unchanged.
- Parent confirms the candidate contains no private `.env` files and the original
  worktrees remain untouched by candidate edits.

## Work packets

1. Reconcile runtime/package renames and existing safety fixes.
2. Make evidence lifecycle operations transactional, fenced and recoverable.
3. Bound parsing/analysis work and preserve exact source cells/calculations.
4. Revoke deleted upload capabilities and prevent late-object resurrection.
5. Share citation capacity across evidence and explicitly attached tape.
6. Repair UI request ownership and verify routes with real disposable Postgres.
7. Run the full local matrix, stage the exact candidate, verify deployment and
   rollback identity, then release only after required gates pass.

## Authority and limits

The user requested checking the work, making changes and releasing production.
No paid model calls, new cloud resources, unrelated services, credential display
or private profile inspection is authorized. Jigar explicitly authorized the
existing NewsCraft-only Contabo migration/deploy path on November 8 after the
earlier no-Contabo restriction was clarified.
Original private files and untracked work stay outside commits and deploys.
Paid-provider, executor and physical-device live behavior remain unverified.
Fixture suites and desktop/mobile browser checks do not establish those results
or expand authorization to perform them.

## Verification

The final sequential check/test/build/eval/lock/database/browser command exited
**0**, recorded in `/private/tmp/newscraft-release-complete-matrix.log`. It ran
after all code corrections. Infrastructure totals come from the fresh
`/private/tmp/newscraft-release-infra.log`; the earlier full browser confirmation
also passed. Original PR/main counts are historical, not candidate measurements.
The complete sequence passed again in
`/private/tmp/newscraft-release-packaging-matrix.log` after EOF normalization and
the updated reviewed SQL digest. The cumulative patch has no whitespace errors.

Toolchain: Node **24.21.0**, pnpm **9.15.9**, CPython **3.11.16**.

| Gate | Measured result | Qualification |
| --- | --- | --- |
| `pnpm check` | **0 errors, 0 warnings** | Passed. |
| `pnpm test`: application | **1,074 passed; 84 skipped** | 145 passing files, 11 skipped files; database-gated skips run separately below. Includes the final seed, policy-capability and CSV-label corrections. |
| `pnpm test`: shared | **37 passed** | 4 files. |
| `pnpm test`: legacy newsroom harness | **343 passed; 2 skipped** | 30 files; opt-in skips remain explicit. |
| `pnpm test`: ledger | **32 passed** | 7 files. |
| `pnpm test`: scripts | **71 passed; 0 failed; 0 skipped** | Read from Unicode `ℹ tests/pass/fail/skipped` summaries, not an ASCII-only TAP match. |
| `pnpm test`: Python agent | **797 tests, OK** | Full recorded Python suite passed. |
| Production build | **Passed** | Optional-platform native-dependency resolution and large-chunk warnings remain; a local build is not deployed-platform verification. |
| Fixture evaluation | **25/25 passed; trust traps 17/17** | Fixture gate passed; no paid/live model evaluation is claimed. |
| UV dependency resolution | **30 packages resolved** | Dependency resolution, not 30 tests. |
| Infrastructure fixtures | **3 shell fixtures + 20 Node tests passed** | Node suite sum is **5 + 1 + 1 + 10 + 3 = 20**; 0 failures/skips. Shell fixtures cover layout, role/bootstrap, and backup/restore plus storage reconciliation. |
| Real disposable Postgres | **94 tests / 12 files; 46 public tables** | Passed again in the final sequential matrix. Separate from the default suite's DB skips; overlapping migration tests are not additional unique coverage. |
| Guarded migration sequence | **28 → 29; reapply refused; empty rollback; reapply passed** | Fresh confirmation also passes shadow-schema isolation and populated rollback refusal on a second disposable database; the parent confirms the retained row and ledger were preserved. |
| Desktop and mobile browser | **21 checks passed; 0 provider calls** | Fresh confirmation reports loopback-only network and both desktop/mobile runs. Upload/seal, inspection/close, exact download, analysis/save, nonempty-folder protection, foreign-account denial, withdrawal and overflow checks passed. No page errors reported. |
| Latest migration correction | **Shadow-schema isolation and populated rollback refusal passed; 7 helper guard unit tests passed** | Helper pins `search_path = public`; rollback uses `public`-qualified names and the schema advisory lock. Unit-test count is parent-reported; disposable regression sequence is in the fresh confirmation log. |
| Dev-only E2E seed guard | **4 targeted regression tests passed** | Parent-reported compile-time `dev === false` guard disables the unauthenticated production test-seed endpoint even when an E2E secret is configured. This is a source/local-test receipt, not a deployed-endpoint claim. No rejected live probe was retried. |
| Original-worktree passive agent-local check | **18/18 passed** | Parent-reported separate original-worktree observation, with no secrets displayed; neither candidate verification nor live-production verification. |
| Strict upload-revocation policy prerequisite | **49 focused tests passed; included in final root suite** | Both evidence buckets must explicitly advertise support before either upload is signed. Legacy conversation-PDF policies remain compatible; exact delete acknowledgements remain mandatory. |
| CSV visible-row citation wiring | **56 focused tests passed; included in final root suite** | Noncontiguous/partial-source coverage and real-CSV-to-transport assertions require row-labelled titles without fictitious `documentPage` provenance. |
| Final all-matrix plus browser | **Exit 0** | Check, full tests, build, eval, offline lock, 94 Postgres tests, migration regressions and 21 desktop/mobile checks completed sequentially after the last code edits. |
| Generic `pnpm test:e2e` | **Not run** | Requires explicit database-backed auth/seed setup; it is not database-free. The dedicated evidence browser fixture creates and validates its own loopback database rather than using a live target. Physical Safari and production-authenticated flows remain unverified. |

The browser log includes failed `/css2` requests and aborted inspector requests;
these are not page-error receipts or evidence of successful external access. Its
summary explicitly reports **loopback-only** network and **0 provider calls**.
The confirmation run stopped its own disposable fixture and removed its own
temporary directory. No existing database or production cleanup is implied.

Targeted test counts overlap the final full-suite counts and are not added to
them. No assertions were relaxed to obtain these results. Browser synchronization
now waits for hydration and checks the actual DELETE response, UI removal,
database count and withdrawn source, instead of awaiting a discarded browser
response body after navigation.

The Python test output also contains fixture `BLOCK RELEASE` decisions for
unmet release gates. Successful local suites do not override those gates or
authorize production work.

## Corrected implementation versus Claude's first slice

Claude's first slice supplied the useful product flow: project-owned PDF/CSV
evidence, browser-declared/server-verified hashes, extracted source inspection,
deterministic leads, human review and project chat context. This candidate keeps
that flow, rather than merging PR #17 unchanged. It replaces check-then-write
lifecycle decisions with transactional reservations and processing/publication
fences, tracks incomplete deletion, revokes upload authority, bounds parser and
analysis work, and owns asynchronous inspector responses. Chat now shares finite
citation capacity with attached tape and stops on unexpected evidence retrieval
failure. The source-backed register below distinguishes implemented corrections
from remaining gaps; it is not a blanket claim that the release is ready.

## Running findings and correction register

Paths and line anchors refer to the release worktree source inspected for this
packet, not the original evidence worktree or old main.

| Condition | Current implementation and status | Source |
| --- | --- | --- |
| Concurrent upload intents could pass independent quota checks. | **Implemented:** quota read and all reservations share a project-row lock and transaction; tracked deleting rows still consume quota. | `src/lib/server/evidence/repository.ts:26` |
| Abandoned processing needed recovery without an older attempt overwriting a replacement. | **Implemented:** stale claims receive a fresh token; seal/failure paths check token ownership under locks before changing extraction. | `src/lib/server/evidence/repository.ts:69`; `src/lib/server/evidence/repository.ts:80`; `src/lib/server/evidence/repository.ts:352` |
| Analysis could overlap or publish after its input was deleted. | **Implemented:** start and publication serialize on the project; publication checks running state, expiry and stored input hashes/extraction versions. A partial unique index permits only one running run per scope. | `src/lib/server/evidence/repository.ts:248`; `src/lib/server/evidence/repository.ts:266`; `drizzle/0027_project_evidence.sql:109` |
| Failed storage cleanup must remain retryable; retrying deletion must not cancel unrelated newer analysis. | **Implemented:** mark `deleting`, withdraw findings and remove extraction before external cleanup; remove the catalog row only after storage success. Cancellation now selects runs whose input snapshot actually contains the deleted document. | `src/lib/server/evidence/service.ts:176`; `src/lib/server/evidence/repository.ts:159`; `src/lib/server/evidence/repository.ts:169` |
| An unused or in-flight upload could recreate a deleted object. | **Implemented:** evidence removal requests upload revocation; gateway deletion and final write commit serialize per canonical key, with persisted revocation checked before commit. The client requires HTTP 204 and the explicit revocation acknowledgement before allowing catalog cleanup. | `src/lib/server/evidence/storage.ts:70`; `infra/newscraft-storage/server.mjs:195`; `infra/newscraft-storage/server.mjs:241`; `infra/newscraft-storage/server.mjs:294`; `src/lib/server/storage/vps-client.ts:122` |
| Older gateways could still admit evidence uploads without durable revocation support. | **Implemented and retested:** both authenticated bucket policies must explicitly advertise revocation before either evidence upload is signed; legacy conversation-PDF behavior remains compatible. | `src/lib/server/evidence/storage.ts:44`; `src/lib/server/evidence/storage.test.ts:38`; `src/lib/server/storage/vps-client.ts:132` |
| A mistakenly configured test secret could expose the account-seed route in production. | **Implemented and retested:** the compile-time development guard rejects production before body parsing or account access, independent of secret configuration. | `src/routes/api/e2e/seed/+server.ts:20`; `src/routes/api/e2e/seed/seed-route.test.ts:25` |
| Parser limits were too late and ragged rows could lose trailing cells; analysis needed bounded aggregate and combinatorial work. | **Implemented:** tokenizer checks cell/column/record ceilings while building records; width derives from all records and shorter rows are padded without truncating wider rows. Analysis checks source/cell/page/extracted-text budgets and an explicit work/join budget; identifier sampling states its limit. | `src/lib/server/evidence/csv.ts:42`; `src/lib/server/evidence/csv.ts:126`; `src/lib/server/evidence/constants.ts:34`; `src/lib/server/evidence/repository.ts:363`; `src/lib/server/evidence/analysis.ts:42`; `src/lib/server/evidence/analysis.ts:450` |
| A late inspector response could overwrite a newer selection or reopen a closed/deleted source. | **Implemented:** abort plus request/project/target identity checks gate result application; close, removal and component destruction invalidate requests. **Fresh desktop/mobile browser confirmation passed** inspection/close and deleted-excerpt withdrawal checks. | `src/lib/components/evidence-inspector.ts:11`; `src/lib/components/ProjectEvidencePanel.svelte:16`; `src/lib/components/ProjectEvidencePanel.svelte:69`; `src/lib/components/ProjectEvidencePanel.svelte:75` |
| Independent citation allocation could exceed capacity or crowd out explicitly attached tape. | **Implemented:** validate inherited numbers, reuse source identities, reserve new tape slots and enforce a shared 100-citation ceiling; omitted material is explicitly disclosed in context. | `src/lib/server/agent/transport.ts:298`; `src/lib/server/agent/transport.ts:376`; `src/lib/server/agent/transport.ts:440` |
| CSV sample/row semantics must not imply query matches or real PDF pages. | **Implemented and retested:** `buildChatContext` emits labels for actual visible rows, discloses partial excerpts and omits unseen row ordinals. Fallback text distinguishes samples from query matches. Noncontiguous/partial-source and real-CSV-to-transport tests assert row-labelled titles with no `documentPage`. | `src/lib/server/evidence/service.ts:245`; `src/lib/server/agent/transport.ts:322` |
| Unexpected evidence retrieval failure silently allowed an answer without the folder evidence. | **Implemented:** unexpected failures raise a folder-evidence error and return a local stopped response before agent dispatch. Missing evidence tables remain the explicit pre-migration compatibility exception. | `src/routes/api/chat/stream/+server.ts:391`; `src/routes/api/chat/stream/+server.ts:1179` |
| Project deletion could race with evidence reservation or discard incomplete cleanup tracking. | **Implemented:** project deletion takes the same project lock and refuses any remaining evidence row, including `deleting`; the route uses that repository operation. | `src/lib/server/evidence/repository.ts:38`; `src/routes/api/projects/[id]/+server.ts:13` |
| Migration/rollback object resolution could depend on a caller's shadowing search path. | **Corrected and disposable regression measured:** helper pins `search_path = public`, requires the reviewed migration SHA, exact prior ledger and expected database/role/grants; rollback pins the path, takes the schema advisory lock, and qualifies locked/dropped tables and the ledger as `public`. Shadow-schema isolation and populated rollback refusal passed; the retained row and ledger were preserved. Seven helper guard unit tests also passed, per parent. | `scripts/prepare-evidence-migration.mjs:10`; `scripts/prepare-evidence-migration.mjs:20`; `scripts/prepare-evidence-migration.mjs:29`; `scripts/prepare-evidence-migration.mjs:55`; `drizzle/rollback/0027_project_evidence.down.sql:5`; `drizzle/rollback/0027_project_evidence.down.sql:22` |

## Production state and remaining gates

**Production is unchanged.** The parent reports the existing read-only target as
`7a39b01`, with Vercel login and `/api/health` returning HTTP 200; Contabo worker,
storage and Postgres are active, with **28 migration-ledger entries**. These are
existing-target observations, not receipts for this candidate. This documentation
update made no live infrastructure calls or production changes.

The user's release authority above does not mean every operational approval has
completed. **The explicit backup-approval question has been sent; approval remains
pending at the safety layer.** No backup, migration, gateway deployment or
application deployment is claimed approved or completed by this packet. The local
backup/restore fixture is not a production backup.

The final matrix is complete. Before promotion, bind the reviewed commit to an
exact staged build and complete the specifically approved server-side backup,
guarded 0027 migration and NewsCraft-only backend deployment. Paid-provider,
executor and physical-device live behavior remain unverified. A passing local
matrix, passive checker or browser fixture is not a production deployment claim.

## Staged artifact

- **Vercel build READY, not promoted:**
  `dpl_BXpTc8C3mV2x3VAsCeSbiYqxZK7i`,
  [protected deployment](https://newscraft-k5bcha9fu-jigar-patels-projects.vercel.app).
  It targets the existing production environment with `--skip-domain`; the
  management API reports no aliases. Authenticated `vercel curl /api/health`
  against this exact deployment returns **200**, `ok: true`, `state: ready`.
- Source: `ca2053d37cae9b0f244c637dd9d0fe4e49331330`. The source archive contains
  only committed files, excluding environment files, logs, state and virtual
  environments; the Vercel dry-run lists 904 files. Archive SHA-256:
  `a25e6ba7ce749a5cd9b6454a64f7ab47cd899d8cc01a817684f7e87a5c12fbfe`.
  Source/hash metadata was supplied to the CLI; the normalized deployment
  inspection does not expose those custom fields, so no independent remote
  source-hash comparison is claimed.
- The public app alias still resolves to
  `dpl_F9BCUpszwhQwcQW6UN4LWQXKT4Br` (`7a39b01`), verified after staging.
  No source push, alias promotion, backup, migration or Contabo update occurred.
- **Observed live issue:** subsequent public health checks returned 503 and
  timed out; bounded Vercel diagnostics identify database `ETIMEDOUT`. The
  existing worker is active with loopback readiness 200, both NewsCraft
  containers are healthy, and the dedicated database TLS route verifies from
  system DNS and both public IPv4 answers without authentication. The new
  staged runtime is ready; the latest old-production recheck still returns 503.
  No shared Funnel routing or personal service was changed.

## Reviewed deployment and rollback inputs

- Existing Vercel project: `prj_pywLQLbNvNjJQObIjfs2XZIyaT9D`, team
  `team_51SGoYrM9iWXGMMLmzaumD2c`; production rollback deployment
  `dpl_F9BCUpszwhQwcQW6UN4LWQXKT4Br` at source `7a39b01`.
- Existing worker: user unit `newscraft-agent.service`, code under
  `/home/jigar/services/newscraft-agent/service`, retained CPython environment.
  The selected pyproject and lock match the deployed dependency inputs:
  `cb8140efaf693ebe6d292c0bc1bd4b66f237ffca31109f0d5759da4c0d63a6b6`
  and `acf2756feca3a1a9802b68550ebc20ac4543ff3b8ba5e68bfdcadafade16e47b`.
- Existing storage image:
  `sha256:54cd9e93b1af5e99e71947352ddcb3b3c9227ed8fac45a734f8d1ccd39c143fc`.
  Keep it and the prior public source available before rebuilding the existing
  `storage` compose service; do not replace private environment files or volumes.
- Only authorized pending schema version: `0027_project_evidence`; reviewed SQL
  SHA-256 `239d7ad3302cc87970abe4af52b65dbd1b21458716dcb2261e40259f2d05db54`.
  The helper requires that digest, the exact 28-version baseline and the expected
  `newscraft` database, and verifies RLS and each application CRUD grant before
  recording the new version atomically. It does not initialize a database.
- **Rollback limitation:** old code does not manage the new evidence-cleanup
  contract. Do not assume an app-only rollback preserves evidence through older
  project-deletion routes. The tested down migration refuses any retained
  evidence data and only reverses an empty schema. If evidence exists, preserve
  it and choose an explicit recovery plan; never drop it automatically. Health
  checks alone do not prove schema compatibility. Keep revocation-aware storage
  while revoked upload grants may still exist.

Safe preparation (no database connection or migration):

```sh
node scripts/prepare-evidence-migration.mjs --expect-sha256 \
  239d7ad3302cc87970abe4af52b65dbd1b21458716dcb2261e40259f2d05db54 \
  > /private/tmp/newscraft-reviewed-evidence.sql
```
