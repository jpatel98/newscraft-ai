# NewsCraft release and rollback checklist

Status: reusable checklist and record template. This document does not claim a
release, a deployment, a rollback, or live-system state.

## Scope

The active product runtime is the NewsCraft SvelteKit app, NewsCraft durable
state, and the isolated Hermes service. The browser calls NewsCraft. It does
not call Hermes directly. The repository evidence for this boundary is in the
[source of truth](../SOURCE_OF_TRUTH.md#L18-L22) and the [durable streaming
release gates](durable-hermes-streaming.md#L71-L74).

Hydra is outside scope. It is a separate personal Hermes process, user, home,
and state. This checklist does not verify, change, restart, deploy, or roll
back Hydra.

Local and static checks prove repository behavior only. Remote NewsCraft,
Vercel, Hermes, database, provider, traffic, service-PID, and browser checks
need separate authorization and current evidence. Do not put secret values in
this record. Record only non-secret metadata, hashes, statuses, timestamps,
and evidence identifiers.

## One fail-closed release gate

The release decision is `RELEASE` only when every required gate has state
`PASS`, the evidence is current, the recorded hashes identify the same
candidate, and the rollback record is complete. A missing, stale, failed,
blocked, or skipped required gate means `BLOCK RELEASE`.

`UNRELATED-FAILURE` can describe a failure outside the release path. It does
not turn a missing or failed required gate into `PASS`. If the operator cannot
prove that a failure is outside the candidate, its artifacts, its requests,
its data, and its providers, classify it as `FAIL` or `BLOCKED`.

Use these states exactly:

- `PASS`: the required check ran for the recorded scope and candidate. The
  expected result is in the evidence record.
- `FAIL`: the check ran and the expected result was not met. Release is
  blocked.
- `BLOCKED`: the check could not run because authority, a dependency, an
  environment, an artifact, or required live access was missing. Release is
  blocked.
- `SKIPPED`: the operator chose not to run the check. A required gate marked
  `SKIPPED` blocks release.
- `UNRELATED-FAILURE`: a documented failure with proof of no release-path
  impact. It remains visible and needs an owner. It cannot hide a release
  failure.

Do not use `UNVERIFIED` as a release state. Use `BLOCKED` for a required claim
that lacks current evidence.

## Repository evidence and derived commands

The root scripts define [test, check, build, browser, health, and database
commands](../package.json#L6-L26). CI uses the pinned pnpm version and Node 24
and runs [check and test](../.github/workflows/ci.yml#L15-L39). The browser suite
uses one Chromium worker, a local server on port 4174, and the test database
environment in the [Playwright configuration](../playwright.config.ts#L1-L46).

### Required local or static gates

Each command must record start time, end time, exit code, test counts, failed
tests, skipped tests, and the candidate hash.

1. **Focused tests**

   ```text
   corepack pnpm exec vitest run \
     'src/routes/c/[id]/chat-failure-retry.test.ts' \
     'src/routes/c/[id]/page-server.test.ts' \
     src/lib/client/stream.test.ts \
     src/routes/api/internal/hermes/runs/runs-routes.test.ts \
     src/lib/server/db/hermes-runs.integration.test.ts \
     src/lib/server/agent/transport.test.ts
   ```

   The focused sources cover refresh recovery, cursor replay, duplicate
   submission, cancellation, account and tenant binding, and Hermes readiness.
   The refresh and retry assertions are in the [conversation route tests](<../src/routes/c/[id]/chat-failure-retry.test.ts#L8-L42>)
   and [conversation load tests](<../src/routes/c/[id]/page-server.test.ts#L1-L68>).
   The durable repository and callback assertions are in the [run repository
   tests](../src/lib/server/db/hermes-runs.integration.test.ts#L75-L115) and
   [run route tests](../src/routes/api/internal/hermes/runs/runs-routes.test.ts#L141-L169).

   `NEWSCRAFT_TEST_DATABASE_URL` is required for the durable repository
   integration group. If that variable is absent, the test file uses
   `skipIf`; that result is `BLOCKED`, not `PASS`.

2. **Full tests**

   ```text
   corepack pnpm test
   python -m unittest discover -s services/hermes-chat/tests -p 'test_*.py'
   ```

   The first command runs the root Vitest suite, shared package tests, and the
   newsroom-harness test package. The second command covers the Hermes Python
   test files already named `test_*.py`. Record separate counts for each
   command. A missing Python runner or missing import is `BLOCKED`; it is not an
   unrelated failure.

3. **Check**

   ```text
   corepack pnpm check
   ```

   This is the repository type-check path. A successful test run does not
   replace this gate.

4. **Build**

   ```text
   corepack pnpm build
   ```

   Record the exit code and generated build summary. The root build uses the
   shared package and `vite build`, with the Vercel adapter in
   [`svelte.config.js`](../svelte.config.js#L1-L16). Do not call a build a
   deployment.

5. **Packaging for the active candidate**

   The required packaging gate covers only the active NewsCraft/Hermes
   candidate:

   - **NewsCraft/Vercel artifact:** record the exact Vercel deployment or
     artifact identifier, deployed source hash, build-output manifest, and
     non-secret checksum.
   - **Hermes source or service artifact:** record the exact clean source
     checkout hash or service-artifact identifier, pinned runtime commit, and
     non-secret checksum.

   The repository has no generic `pack`, `release`, or `deploy` command. A
   successful `corepack pnpm build` is not packaging evidence. Keep this gate
   `BLOCKED` until the separately authorized release system records both active
   artifact identifiers and checksums. Do not infer a remote artifact from a
   local build or a Git hash.

   The quarantined `@newscraft/newsroom-harness` build and its Vercel files are
   not required for a normal NewsCraft/Hermes release. They may be recorded as
   an optional compatibility artifact only when a separately approved release
   explicitly includes that legacy surface. In that case, record it in a
   separate optional row and do not use it to satisfy this active packaging
   gate. The optional files are described by its [package scripts](../services/newsroom-harness/package.json#L9-L16)
   and [Vercel configuration](../services/newsroom-harness/vercel.json#L1-L13).

6. **CI command parity**

   The CI file calls `corepack pnpm eval:fixture` at
   [`.github/workflows/ci.yml#L33-L39`](../.github/workflows/ci.yml#L33-L39).
   The root package scripts define that command with explicit fixture mode at
   [`package.json`](../package.json). Run it and record the prompt count, trust-
   trap count, exit code, and result artifact. A missing command or failed
   fixture result is `BLOCKED`.

### Required browser and behavior gates

7. **Real-browser checks and console results**

   The local gate must use the dedicated [JIG-181 matrix runner](../scripts/jig-181-ui-matrix.mjs)
   and [isolated Playwright configuration](../playwright.jig181.config.ts). Neither
   configuration loads `.env.local` or accepts a database value from an implicit
   fallback. The runner requires a separately supplied disposable-local authority
   document and `JIG181_E2E_DATABASE_URL`; without both, the browser cases are
   `BLOCKED` and the release command exits nonzero. Before running an authorized
   local suite, set both database variables explicitly to the same isolated test
   database and set both NewsCraft and legacy gateway endpoints to loopback or an
   intentionally unreachable local endpoint:

   ```text
   isolated_e2e_database_url="${E2E_DATABASE_URL:?set an isolated test database URL}"
   export E2E_DATABASE_URL="$isolated_e2e_database_url"
   export DATABASE_URL="$isolated_e2e_database_url"
   export JIG181_E2E_DATABASE_URL="$isolated_e2e_database_url"
   export JIG181_CANDIDATE_SHA="$(git rev-parse HEAD)"
   export NEWSCRAFT_HERMES_URL='http://127.0.0.1:9'
   export AGENT_GATEWAY_URL='http://127.0.0.1:9'
   test "$E2E_DATABASE_URL" = "$DATABASE_URL" && test "$E2E_DATABASE_URL" = "$JIG181_E2E_DATABASE_URL"
   corepack pnpm ui:matrix:jig181 \
     --source-sha "$JIG181_CANDIDATE_SHA" \
     --candidate-sha "$JIG181_CANDIDATE_SHA" \
     --run-browser \
     --database-authority .tmp/jig-181/database-authority.json
   ```

   The disposable-local authority file is JSON with exactly this schema; it
   must be created under `.tmp/jig-181` and must never contain a production
   value or credential:

   ```json
   {
     "schema_version": 1,
     "scope": "disposable-local",
     "candidate_sha": "<exact local candidate SHA>",
     "database_name": "newscraft_e2e_<lowercase-local-suffix>",
     "loopback": true,
     "allows_test_mutation": true,
     "expires_at": "<UTC ISO-8601 timestamp within the next 24 hours>"
   }
   ```

   All fields are required and additional fields are rejected. `candidate_sha`
   must equal the clean checkout's candidate SHA, `database_name` must match
   the explicitly supplied loopback database URL, and `expires_at` must be a
   valid timestamp strictly in the future and no more than 24 hours from the
   runner's clock. Expired, malformed, or longer-lived authority is
   `BLOCKED`; the runner does not infer authority from environment or
   `.env.local`.

   The value assigned to `isolated_e2e_database_url` must be an approved
   isolated test database value. Do not record that value. The explicit
   `NEWSCRAFT_HERMES_URL` and `AGENT_GATEWAY_URL` assignments prevent a
   `.env.local` remote endpoint from controlling the browser run. If either
   database variable is absent, differs, or points outside the isolated test
   scope, or either endpoint is remote, this gate is `BLOCKED`.

   Record browser, viewport, test counts, screenshots or trace identifiers,
   failed requests, `pageerror` events, console results, cumulative layout shift,
   and duplicate durable-start requests. The matrix requires every named case,
   zero unexpected errors or failed requests, CLS no greater than `0.1`, and zero
   duplicate requests. Its machine-readable record is redacted and written below
   `.tmp/jig-181`; it contains only aggregate evidence identifiers and counts. A
   browser-side stream fixture is still a browser UI test, but it is not proof of
   a live Hermes request. Mark the live request check separately.

   The mobile release gate additionally requires a current, exact-candidate
   evidence document for the named physical device **iPhone 17 Pro / Safari**.
   It must declare `execution: physical_device`, `emulation: false`, a screenshot
   or trace identifier, zero console/page/request/duplicate errors, and CLS no
   greater than `0.1`. Desktop emulation never satisfies this gate. Missing,
   stale, mismatched, duplicate, skipped, or blocked evidence is `BLOCK RELEASE`
   and the public command exits nonzero.

   A separately authorized live browser check must use the candidate NewsCraft
   URL with no route interception. Record the URL, deployment identifier,
   authenticated test scope, visible result, network failures, console errors,
   console warnings, and screenshot or trace identifier. Missing console data
   is `BLOCKED`.

8. **Refresh/replay**

   Confirm that a refresh subscribes to the existing durable run, sends the
   saved cursor or `Last-Event-ID`, restores the snapshot, and does not start a
   second run. Record run ID, assistant message ID, cursor before refresh,
   cursor after replay, and terminal state. The client replay assertion is in
   [`src/lib/client/stream.test.ts#L277-L315`](../src/lib/client/stream.test.ts#L277-L315).

9. **Two-tab behavior**

   Open two real browser tabs for the same account and conversation. Submit
   one request. Confirm both tabs converge on one durable run and one answer.
   Refresh one tab and confirm replay does not create another run. Then repeat
   with two separate accounts and confirm that neither tab can read, cancel,
   or receive the other account's events. Record both account scopes, tab
   identifiers, run IDs, and cursors. The repository has a concurrent browser
   key assertion in the [durable repository test](../src/lib/server/db/hermes-runs.integration.test.ts#L99-L115)
   and a second-browser settings example in
   [`tests/e2e/settings.spec.ts#L82-L115`](../tests/e2e/settings.spec.ts#L82-L115).

10. **Duplicate submission**

    Submit the same request twice at the same time and retry it with the same
    idempotency key. Confirm one durable user turn, one assistant message, one
    run, and no duplicated answer text. Record the idempotency key, run ID,
    assistant message ID, and persisted event count. The repository evidence is
    in [`src/lib/server/db/hermes-runs.integration.test.ts#L75-L115`](../src/lib/server/db/hermes-runs.integration.test.ts#L75-L115).

11. **Cancellation**

    Cancel an active run from the browser. Confirm NewsCraft records
    `cancel_requested`, Hermes receives cancellation for the same run, the
    terminal state becomes `cancelled`, and a late callback cannot append an
    event. Record run ID, cancel request time, terminal event cursor, and
    browser result. The server contract is tested in
    [`runs-routes.test.ts#L155-L169`](../src/routes/api/internal/hermes/runs/runs-routes.test.ts#L155-L169)
    and the durable repository state is tested in
    [`hermes-runs.integration.test.ts#L370-L383`](../src/lib/server/db/hermes-runs.integration.test.ts#L370-L383).

12. **Tenant isolation**

    Confirm that account A cannot read, cancel, callback into, or receive the
    events of account B. Confirm that Hermes state roots, browser profiles,
    process handles, memory, and scheduled state remain tenant-scoped. Record
    the test account labels, tenant-key fingerprints only, denied operations,
    and evidence IDs. Never record the tenant key itself. The NewsCraft
    cross-account assertions are in
    [`hermes-runs.integration.test.ts#L316-L340`](../src/lib/server/db/hermes-runs.integration.test.ts#L316-L340),
    and Hermes isolation evidence is in
    [`test_isolation.py#L81-L124`](../services/hermes-chat/tests/test_isolation.py#L81-L124)
    and [`test_isolation.py#L695-L715`](../services/hermes-chat/tests/test_isolation.py#L695-L715).

13. **Service restart**

    Test the repository recovery path, then perform a separately authorized
    restart of the candidate Hermes service. Confirm that queued or expired
    runs recover with the same run ID and saved input, that no tenant state
    crosses accounts, and that a new readiness check passes. Record the old and
    new PID, service unit, run ID, lease transition, readiness response, and
    browser result. The repository recovery assertions are in
    [`hermes-runs.integration.test.ts#L401-L415`](../src/lib/server/db/hermes-runs.integration.test.ts#L401-L415)
    and [`test_service.py#L989-L1013`](../services/hermes-chat/tests/test_service.py#L989-L1013).

### Required live evidence gates

These checks are not run by this task. They are required for a release that
uses a remote deployment. They need separate authorization.

14. **Readiness response**

    Local check:

    ```text
    corepack pnpm health:hermes
    ```

    Authorized remote form:

    ```text
    node scripts/check-health.mjs --url <authorized-https-hermes-ready-url> --expect hermes
    ```

    Record HTTP status, response time, service name, toolset, endpoint mode,
    capability flags, reported runtime/source commit, and provider names. Store
    only a redacted response. The checker validates the Hermes response shape in
    [`scripts/check-health.mjs#L85-L119`](../scripts/check-health.mjs#L85-L119).

15. **Service PID and unit**

    For the Contabo systemd unit, record the unit name from
    [`newscraft-hermes-chat.service`](../services/hermes-chat/deploy/newscraft-hermes-chat.service#L1-L19),
    the active PID, active state, restart count, and the artifact or source
    hash used by that process. A separately authorized operator may use:

    ```text
    systemctl is-active newscraft-hermes-chat.service
    systemctl show newscraft-hermes-chat.service --property=MainPID --value
    ```

    Do not paste the environment file or its values. The service unit uses a
    private environment file and `Restart=on-failure`; that is configuration
    evidence, not proof that the remote unit is active.

16. **Vercel deployment and rollback identity**

    Record the Vercel project or app scope, deployment identifier, alias or
    target, deployed NewsCraft source hash, and rollback identifier. The root
    repository contains only the adapter and service-worker header config in
    [`svelte.config.js`](../svelte.config.js#L1-L16) and [`vercel.json`](../vercel.json#L1-L13);
    it does not prove a live Vercel project, deployment, alias, traffic, or
    rollback. A missing deployment identifier or source-hash match is
    `BLOCKED`.

17. **Hermes source and pinned runtime**

    Record both values. `Hermes source hash` is the actual clean checkout hash
    used by the candidate service. `Pinned runtime commit` is the expected
    reviewed commit `5370d535ab926da41abe3ba4d9d975f1f94875d5`, enforced by the
    [runtime installer](../services/hermes-chat/scripts/install-runtime.sh#L1-L5)
    and its clean-checkout guard at
    [`install-runtime.sh#L69-L85`](../services/hermes-chat/scripts/install-runtime.sh#L69-L85).
    A mismatch, dirty checkout, or missing evidence is `BLOCKED`.

18. **Database migration boundary**

    Record the last applied migration, the release's required migration, the
    baseline, the forward-compatibility decision, and the migration result
    identifier. The repository migration command reports `latest`, `applied`,
    and `baseline` in [`scripts/run-db-migrations.ts#L1-L23`](../scripts/run-db-migrations.ts#L1-L23).
    The durable Hermes schema boundary is the
    [`0015_durable_hermes_runs.sql` migration](../drizzle/0015_durable_hermes_runs.sql#L1-L54).
    Running migrations changes database state and is outside this task. Do not
    mark this gate `PASS` without separately authorized database evidence.

19. **Authorized live production smoke**

    If the release includes live production verification, use the repository's
    separately authorized smoke path and record its exact output, including
    `LIVE_PRODUCTION_MATRIX_PASS` or the failure output. The source file is
    [`services/hermes-chat/tests/live_production_smoke.py#L263-L264`](../services/hermes-chat/tests/live_production_smoke.py#L263-L264)
    and its terminal result is defined at
    [`live_production_smoke.py#L634-L642`](../services/hermes-chat/tests/live_production_smoke.py#L634-L642).
    Do not run this path without explicit live authorization.

## Reusable release record

Copy this section for each candidate. Do not enter keys, tokens, passwords,
database URLs, provider credentials, or private environment contents.

### Candidate identity

Verification time:

Operator:

Scope:

Release decision: `RELEASE` or `BLOCK RELEASE`

Local NewsCraft hash:

Remote NewsCraft hash:

Vercel deployment identifier:

Vercel rollback identifier:

Hermes source hash:

Pinned runtime commit:

Hermes artifact or runtime identifier:

Service PID:

Service unit:

Readiness response:

Database migration boundary:

### Required gate results

| Gate | State | Command or observation | Counts, result, or evidence ID | Candidate hash and time | Notes |
| --- | --- | --- | --- | --- | --- |
| Focused tests |  |  |  |  |  |
| Full tests |  |  |  |  |  |
| Check |  |  |  |  |  |
| Build |  |  |  |  |  |
| Packaging |  |  |  |  |  |
| CI command parity |  |  |  |  |  |
| Real-browser checks |  |  |  |  |  |
| Console results |  |  |  |  |  |
| Refresh/replay |  |  |  |  |  |
| Two-tab behavior |  |  |  |  |  |
| Duplicate submission |  |  |  |  |  |
| Cancellation |  |  |  |  |  |
| Tenant isolation |  |  |  |  |  |
| Service restart |  |  |  |  |  |
| Readiness response |  |  |  |  |  |
| Database migration boundary |  |  |  |  |  |
| Vercel deployment identity |  |  |  |  |  |
| Hermes source and pinned runtime |  |  |  |  |  |
| Authorized live production smoke |  |  |  |  |  |

### Rollback record

Rollback decision:

Rollback trigger:

Rollback result:

Previous known-good NewsCraft hash:

Previous known-good Hermes source hash:

Previous known-good pinned runtime commit:

Previous Vercel deployment or rollback identifier:

Rollback operator and verification time:

Post-rollback readiness response:

Post-rollback browser and console result:

Post-rollback refresh/replay, cancellation, tenant-isolation, and restart
result:

### Rollback procedure

1. Set the release decision to `BLOCK RELEASE` and stop promotion.
2. Preserve the candidate hashes, deployment identifiers, logs, screenshots,
   traces, test counts, and redacted readiness response.
3. Select a known-good NewsCraft deployment and source hash. Select the paired
   known-good Hermes source hash, pinned runtime commit, artifact, unit, and
   environment metadata. Do not copy secret values into this record.
4. Roll back the Vercel deployment through the separately authorized release
   operator. Roll back the Hermes artifact and unit together. Record both
   identifiers before the change.
5. Treat the database migration boundary as a compatibility boundary. Do not
   reverse or delete migrations as an emergency action. If the candidate
   changed schema or data compatibility, use the approved forward-compatible
   recovery plan and record it as `BLOCKED` until verified.
6. Restart or verify the Hermes unit only under the approved live procedure.
   Record the new PID and the redacted readiness response.
7. Re-run the focused checks and the authorized browser, replay, duplicate,
   cancellation, tenant-isolation, and restart checks. Record the result.
8. Set `Rollback result` to the observed result. A missing post-rollback
   result leaves the release `BLOCK RELEASE`.

## Failure classification

Classify an error as `UNRELATED-FAILURE` only when the record names the failed
component, shows that it does not share the candidate artifact, release path,
request path, database boundary, provider, or service unit, and names an owner
and follow-up. For example, a separate historical harness-only check can be
unrelated only when no active product request or release artifact uses it.

A failure in NewsCraft, Hermes, the Vercel candidate, durable state, migrations,
readiness, browser behavior, console output, replay, duplicate handling,
cancellation, tenant isolation, or restart recovery is release-related. A
failure with uncertain ownership is `BLOCKED`. Never use `UNRELATED-FAILURE` to
permit a release when a required gate is missing, stale, skipped, blocked, or
failed.

## Current limits

- No live or external check is performed by this checklist task.
- No current Vercel deployment, remote NewsCraft hash, Hermes PID, remote unit,
  readiness response, traffic state, provider selection, database state, or
  rollback identifier is asserted here.
- The CI workflow and root package scripts both define `eval:fixture`. Each
  release must still run the command and record its result; command parity does
  not replace execution evidence.
- The repository defines build outputs but no generic packaging, release, or
  rollback script. The packaging and rollback identifiers must come from the
  separately authorized release system.
- The [legacy runtime disposition](legacy-runtime-disposition.md#L268-L327)
  remains planning evidence. It does not authorize deletion or migration.
