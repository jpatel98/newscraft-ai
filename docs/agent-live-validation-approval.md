# Owned runtime live acceptance — not run

## DeepSeek update — 2026-10-08

The DeepSeek Messages adapter and owned runtime are merged on main (`4df5b3e`).
The dedicated key check passes; paid approval is still pending. Use the
[current DeepSeek setup and $0.06 approval text](managed-agent-setup.md#deepseek-setup-and-proposed-acceptance)
and [local handoff Status](agent-local-handoff.md#status-as-of-2026-10-08).
Earlier OpenAI pricing/approval proposals below are historical alternatives,
not approval to spend. All infrastructure, storage, deployment and host boundaries
remain in force; no paid provider call has been made during this validation.

Prepared command after the exact approval in the handoff:

```sh
node scripts/agent-deepseek-acceptance.mjs --execute --approved-usd 0.06
```

Run `--check` first with Node 24. The command is a one-shot real DeepSeek/owned-loop
acceptance with synthetic research, local checkpoints and local Markdown/CSV
validation. It contacts only DeepSeek, and blocks a repeat even after failure.
It does not start the app, access Postgres or remote storage, or use a browser,
executor or public retrieval. This scope preserves the Contabo/Hydra prohibition.
It is not the full application acceptance matrix below. That matrix still needs
separate authorization and suitable artifact infrastructure.

The active architecture uses direct interchangeable model adapters and NewsCraft-owned orchestration. Managed Agents and the previous Docker broker validation are superseded. The old `scripts/live-validate-agent.py` CLI is retired and exits before credentials or execution.

Existing OpenAI credential reuse is approved. The authorized new database `ygsiifvjzdazfxflmpjq` was initialized previously; do not rerun initialization. On 2026-10-08 only `0017_topic_projects` was added through the guarded runner: ledger20, schema complete, 35 RLS-enabled public tables and no public/browser grants on the two new tables. The DeepSeek profile passed both local health checks and signup/fresh sign-in/empty-conversation validation with zero chat requests. Private readiness reports `accessVerified: false`. Both listeners stopped and their ports were free. Public deployment and paid calls remain prohibited without their separate authorization. Use [the setup guide](managed-agent-setup.md) and review current model prices and reservations before approving the scoped command. App reservations are not provider billing guarantees.

Acceptance after separate authorization:

1. Verify runtime connectivity to the already initialized target; do not reapply its initial schema. With default Postgres auth, sign up, sign in, refresh, change password and revoke the session. If Supabase is explicitly selected, verify same-browser PKCE confirmation and refresh instead. Confirm a second user cannot access conversations, settings, documents, events, revisions or signed downloads. Inspect optional RLS/bucket permissions in the actual new project.
2. Ask for a recent public announcement, its primary source, a brief answer, Markdown and a CSV with source URLs. Check public plan/actions/results, exact source excerpt provenance and clickable `[n]` citations. Fetch/excerpt checks do not establish independent semantic truth.
3. Verify actual private object upload/finalize/download, bytes, SHA-256, MIME and immutable revision identity. Refresh and reconnect to the saved answer/files.
4. Disconnect the UI, then perform an authorized disposable-worker interruption test. Completed receipts and answers should replay; a saved uncertain model or tool request must fail safely instead of repeating paid input/effects. Verify callback outage and lease replacement cannot give a stale worker publication authority.
5. Cancel active work and confirm no further owned model/tool requests are dispatched. Closing the HTTP request does not prove the provider cancelled billing. Commit cancellation while best-effort worker delivery is unavailable and verify the next dispatch checkpoint rejects it, including citation repair and after lease renewal. Block a retrieval fetch, cancel, then release it: confirm no subsequent URL/archive/CDX request starts and capacity is retained until drain. Test deadline, cumulative input reservations, cost/search ceilings and an interrupted request retaining its charge.
6. Cause a transient artifact storage failure. Allow a full 60-second first attempt and a 91-second renewed-lease wait before reclaim. Retry the same immutable publication inside its fixed 240-second recovery window without repeating model inference; verify at most four persisted attempt admissions. Expire the original run budget during recovery and confirm only the saved publication can finalize, with no fresh model/research call. Check expired-deadline and wrong-account/lease rejection.
7. After the first adapter's clean turn, select the second adapter with its own approved credential/model/prices and repeat the source/file flow. Do not switch a run that is in progress.

Record redacted provider request IDs, local budget reservations, public saved events and verified object checksums. Never collect credentials or private reasoning. Mocked fixtures are not evidence of live provider, storage, email, DB or RLS success.

The rootless OCI terminal/filesystem and interactive browser adapters have deterministic coverage, including a browser → cited answer → Markdown/CSV flow and lost-acknowledgement recovery. Separate synthetic Linux acceptance commands are ready; see [executor/browser acceptance](../services/hermes-chat/deploy/executor.md). They need an authorized suitable Linux host, reviewed immutable images and approval of an existing hash-pinned deny-by-default Chromium seccomp profile with user-namespace allowances. No Docker/Colima/cloud sandbox service was started, image built, policy installed or host provisioned here. Browser resources are bounded at 1 CPU/1 GiB/128 PIDs per active run, in addition to the terminal's 1 CPU/256 MiB. Host cost is not established; no spend was approved. Separately, 53 application database checks passed on a disposable local Postgres fixture, which was stopped and removed; these do not establish Supabase connectivity.

The current evidence is [the 2026-10-08 handoff Status](agent-local-handoff.md#status-as-of-2026-10-08). Earlier counts in this acceptance proposal are historical; none substitutes for the remaining live steps above.
