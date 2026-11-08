# Local main review — 2026-11-07

## Scope and evidence

**Repository verified:** the starting checkout was `claude/script-intent-router`
at `d6aaf0d`, not the original dirty replacement. At Jigar's explicit direction,
the review switched to existing local main `1b36d21` without fetching, pulling,
resetting, stashing or deleting work. The newer branch remains intact. The original
replacement is already in `2eb12e2`, `bf3a398`, `7e68dd7`, `6974134`, `7643417`
and `dd5bfeb`; it was not committed again.

The broader `cb3dec9..1b36d21` diff contains 443 paths. Five independent scoped
reviewers covered server/auth/database/routes, worker/runtime, computer isolation,
shared/client/UI, and infra/evals. Parent review covered the requested documents
in order, root configuration, scripts, public certificate/template changes,
reviewer patches and integration. This is a changed-file review with targeted
full-source tracing, not a claim to audit every unchanged line or prove prompt
injection immunity. The security workbench's source-focused inventory has 332
items; its count differs from Git's all-file inventory.

Four pre-existing untracked files remain outside commits: the cloud proposal,
two ledger reports and the October 21 broadcast example output. They are historical
context, not authorization to pivot the chat-first product or deploy anything.
The first baseline test invocation could regenerate the report files before the
preservation guard was added; byte identity to task entry is not claimed. Later
runs default to no report writes. Private environment values, `.data`, venvs and
existing raw logs were not reviewed or staged. Public `.env.example` edits are
deliberately left uncommitted under the explicit `.env*` exclusion.

## Findings fixed

Locations refer to the repaired working tree; each row has regression coverage.

| Area | Defect and repair | Source location | Regression evidence |
| --- | --- | --- | --- |
| Account isolation | Organization-only recent-title enrichment exposed another account's private titles; require account and organization. | `src/lib/server/db/conversations.ts:74` | `conversations-subjects.test.ts` SQL predicate assertions. |
| Storage | Download redirect validation disagreed with selected storage provider; share provider precedence and reject inactive origins. | `src/lib/server/documents/storage.ts:208` | Document route default/explicit/invalid-origin cases. |
| Transcription fencing | Stale completions/failures could overwrite later processing; monotonic claim identity and terminal CAS. | `src/lib/server/db/transcripts.ts:129` | Unit plus real disposable-Postgres stale-result tests. |
| Request limits | Processing retries and ledger-copy requests bypassed creation throttles; add account-level admission before provider calls. | `src/routes/api/transcriptions/[id]/process/+server.ts:10`; `src/routes/api/conversations/[id]/ledger/copy/+server.ts:28` | Auth/ownership/rate-limit route tests. Existing limiter is process-local, not a distributed quota. |
| Cursor durability | Ledger pagination and parallel snapshot reads acknowledged unseen changes; cursor/event read precedes claims snapshot and cursor covers only delivered events. | `src/routes/api/conversations/[id]/ledger/+server.ts:14` | Baseline ordering, paginated and empty-page tests. |
| Secret logging | Raw transcription transport errors could include credentials/signed URLs; log fixed categories only. | `src/lib/server/transcripts/service.ts:161` | Synthetic-secret logging regressions. |
| Request validation | Non-object transcript PATCH JSON caused server errors; reject with 400. | `src/routes/api/transcriptions/[id]/+server.ts:19` | Null, array, string, number cases. |
| Dispatch durability | Fast planner/search/writer effects bypassed checkpoint cancellation and uncertain-replay controls; persist intent/reservations before every dispatch, serialize saves, save finishing answers before cleanup. | `services/hermes-chat/src/hermes_chat/portable.py:1026` | Fast-path interruption, cancelled checkpoint, budget and finishing recovery tests. |
| Paid search | Exa and fallback requests escaped cost/search accounting; require reviewed ceilings, persist each admission and bind provider during recovery. | `services/hermes-chat/src/hermes_chat/portable.py:1049` | Budget/search retry and fallback tests; no provider contacted. |
| Auxiliary budgets | Ledger judge/copy calls bypassed model budgets; enforce per-request cumulative token/cost/step/time limits and output clamp. | `services/hermes-chat/src/hermes_chat/budgets.py:85` | `test_budgets.py` and service endpoint tests. Not an account-wide durable spending cap. |
| Token ceilings | English-prose estimates undercounted dense/multibyte input; reserve translated UTF-8 bytes plus framing/image allowance. | `services/hermes-chat/src/hermes_chat/budgets.py:45` | Nonprose/multibyte tests. Growing-history fixture now stops after two requests, not seven; safety assertions remain intact. |
| Response bounds | SSE line buffering and Exa responses could grow before checks; bound bytes before parsing and cap result/text sizes. | `services/hermes-chat/src/hermes_chat/model_adapters.py:110`; `services/hermes-chat/src/hermes_chat/search_adapters.py:78` | Oversized/unterminated/multibyte response fixtures. |
| Cancellation cleanup | Cancelled staging could orphan copied private files; drain copier and remove its result before returning cancellation. | `services/hermes-chat/src/hermes_chat/artifact_publish.py:426` | Controlled blocked-copy cancellation regression. |
| Deliverable completeness | One successful file incorrectly satisfied a request for both Markdown and CSV; track successful receipts by requested format and request only missing formats within the original budgets. | `services/hermes-chat/src/hermes_chat/portable.py:1134` | Four dual-format/failed-receipt/replay cases; no duplicate successful publication. |
| OCI cancellation | Cancellation during daemon preflight acknowledged success before later execution; durable `preparing` admission fences cancellation, capacity and workspace ownership. | `services/hermes-chat/src/hermes_chat/oci_executor.py:390`; `services/hermes-chat/src/hermes_chat/executor_state.py:150` | Five preflight/admission/replay regressions; primary reproduction failed before repair. |
| Browser cleanup | Clearing the close handle before awaiting lost retry ownership; retain until close completes, including historical wrappers. | `services/hermes-chat/src/hermes_chat/browser_controller.py:111` | Three new interruption tests plus strengthened retry test; pre-fix reproduction failed. |
| Source authority | Police/court-like names and broad provincial suffixes were promoted to official; use reviewed domain/suffix boundaries. | `src/lib/utils/source-tiers.ts:131`; `services/hermes-chat/src/hermes_chat/source_tiers.py:107` | Adversarial domain/URL cases in both languages. |
| Citation identity | Last-write-wins duplicate numbers selected conflicting sources; ambiguous citations do not resolve, and ledger UI ignores other-chat activity. | `src/lib/utils/claim-evidence.ts:49`; `src/routes/c/[id]/+page.svelte:212` | Conflicting citation/document-page and UI source-contract cases. |
| Evidence dates | Malformed provider dates, citation arrays and planner modes could crash or become misleading evidence; normalize valid dates and bounded positive citation numbers. | `services/hermes-chat/src/hermes_chat/retrieval.py:578`; `services/hermes-chat/src/hermes_chat/portable.py:232` | Invalid/unhashable/overflow/date cases. Access dates never substitute for publication dates. |
| Editorial integrity | Model tags bypassed withheld-claim/attribution checks; inspect the sentence even when tags exist. | `src/lib/utils/ledger-copy.ts:82` | Tagged withholding and attribution regressions. |
| Claim identity | Judge-outage similarity merged affirmative/negated statements; preserve negation/number merge guards. | `src/lib/utils/claim-matcher.ts:132` | Outage negation tests. |
| Browser replay | Failed/cancelled terminals reconnected; repeated cursors/snapshots duplicated text; mark terminals and seed reducer from snapshots. | `src/lib/client/stream.ts:156` | Terminal, duplicate cursor, snapshot/completion tests. |
| Public presentation | Failure text, hidden ledger blocks and dropped tool kinds leaked/degraded output; sanitize banners, strip final overlays and preserve public kinds. | `src/lib/utils/durable-run-presentation.ts:43`; `src/routes/c/[id]/+page.svelte:774`; `src/lib/utils/tool-metadata.ts:239` | Presentation, component and store tests. |
| Microphone lifecycle | Navigation could retain microphone tracks or submit abandoned recordings; abort-aware recorder ownership and cleanup. | `src/lib/client/recording.ts:1` | Synthetic recorder lifecycle tests; no real microphone accessed. |
| Titles | Greeting stripping removed topic prefixes such as Highway; require word boundary. | `src/lib/server/conversation-title.ts:54` | Topic-title regressions. |
| Mobile controls | Later desktop styles overrode the folder button's mobile touch size; restore the 44px override after the desktop rule. | `src/lib/styles/components.css:2893` | `artifact-layout.test.ts` source-order regression fails before repair; browser rendering not exercised. |
| Safe setup | Ordinary startup can recover paid work; health-only mode skips recovery and denies execution. Guarded setup rejects paid page-search inheritance. | `scripts/agent-local.mjs:254`; `services/hermes-chat/src/hermes_chat/service.py:380` | Helper and startup/endpoint tests. |
| Launcher privacy | Occupied-port diagnostics printed arbitrary process command lines; emit only service/port/PID and reject credential-bearing worker URLs. | `scripts/dev-all.mjs:90` | Synthetic credential/connection-string cases. |
| Editor defaults | Default editor launcher used production helper; select guarded health-only startup and correct port. | `.claude/launch.json:9` | `infra/editor-launch.test.mjs`. |
| Explicit production helper | Invalid local setup was ignored before applying production overrides; fail closed and make imports side-effect-free. The helper was never executed. | `scripts/agent-local-prod.mjs:10` | Six injected-dependency tests, including zero profile reads/spawns on import or failed guards. |
| Eval isolation | Ambient endpoint/env settings could trigger paid recording; require explicit recording opt-in, no dotenv, opt-in report output. | `eval/ledger/replay.ts:17`; `vitest.eval.config.ts:6` | Eval isolation/report-output fixtures. |
| Backfill integrity | Contradictions created links without persistent open checks; synchronize events, snapshots and in-memory state without undoing human review. | `eval/ledger/dedupe.ts:103` | Contradiction plus subsequent-duplicate regressions. |
| Eval fidelity | Replay processed more than production's 12 claims; reuse production extraction and preserve original golden indexes. | `eval/ledger/replay.ts:63` | Cap/malformed-input tests and offline-cassette provenance checks. Existing metric thresholds and original responses remain unchanged. |
| Test determinism | Denied loopback listener errors left socket tests hanging; reject promptly and clean listeners without weakening assertions. | `src/lib/server/db/socket.test.ts:564` | Explicit denied-listener regression. |
| Disposable Postgres startup | Sanitized macOS startup failed with PostgreSQL's multithreaded-startup/locale error; pin C locale, selected binaries, loopback/mmap settings and bounded lifecycle waits, and expose only synthetic fixture failure logs before cleanup. | `infra/newscraft-postgres/test-bootstrap.sh:3`; `infra/newscraft-postgres/test-backup-restore.sh:3` | Full infra suite plus runtime isolation-setting assertions; no existing database used. |

## Verification and limits

### Local reviewed slices

Each code slice was exported from the Git index and tested with existing locked
dependencies, without the following unstaged changes or private profiles. No
branch was rebased and no commit was pushed.

| Local commit | Scope | Exact-index validation before commit |
| --- | --- | --- |
| `9532c23` | Runtime dispatch, budgets and executor/browser cleanup | `pnpm check` 0/0; full Python 803 passed |
| `b23d2bd` | Private context, transcription and ledger fencing | `pnpm check` 0/0; app/shared/harness/ledger 914/31/343/9; disposable Postgres 73 |
| `8fca2af` | Editorial/citation/replay integrity and offline eval | `pnpm check` 0/0; app/shared/harness/ledger 948/31/343/32 |
| `fff0bca` | Guarded setup, launcher and fixture safety | `pnpm check` 0/0; 48 helper/editor tests; 3 shell fixtures and 10 infra Node tests (3 editor tests overlap) |

The final documentation slice records these receipts, architecture and limits;
public environment templates remain outside all commits as requested.

The [current handoff](agent-local-handoff.md#status-as-of-2026-11-07) is the
measured matrix and next-command authority. Earlier `/tmp` claims are not evidence
for this run. Restricted-shell socket/shared-memory failures were rerun with
permission for synthetic loopback fixtures, not bypassed by skipping assertions.

No production deployment, push, paid inference/search/transcription, hosted
migration, old Supabase access, Contabo/Hydra access, Docker/Colima/Lima reinstall,
image build or cloud resource creation occurred. Read-only health startup found
worker readiness HTTP 200 but app health HTTP 503, with fixed diagnostics
identifying database connectivity failure rather than a gateway failure. Both
launchers exited 0 after SIGINT and ports 3001/8000 were free. Credentials were
neither displayed nor changed; external database availability remains unverified.

Linux/Chromium, remote artifacts, full application paid acceptance and real-model
editorial reliability remain separate human-controlled gates. The historically
recorded October 8 DeepSeek one-shot approval is consumed; no repeat is authorized.
