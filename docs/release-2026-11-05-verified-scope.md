# Verified worker safeguards release — November 5, 2026

This release is intentionally narrower than the preserved newsroom-writing experiment.

## Included

- Tape candidates group reporter identity by transcript and exclude unplayable candidates.
- SOT quote/cue checks reject malformed clocks, invalid ranges and unsupported partial-turn timing.
- The selected final copy is rechecked after repair and output trimming; unresolved tape problems receive a producer-visible `TAPE CHECK: NOT VERIFIED` note.
- OCVO drafts retaining measurable house-rule failures after repair receive a bounded `CHECK` note. Final rechecks dispatch no model calls and never declare factual verification. Stricter initial tape validation can invoke the existing one-shot repair more often.
- Existing tests are consolidated without removing distinct failure scenarios. The root test command now runs the worker and builds shared dependencies before JS tests, with CI command parity and fail-closed Python selection.

## Excluded and preserved

No changes to writing prompts, core/OCVO guides, one-click UI prompts, model/provider settings, database schema, dependencies or frontend runtime source. Source-anchored draft/review code, source-first experiments, paid recorders and new evaluation artifacts remain in the separate local research worktree/patch. Accepted A/B examples establish style preference only; this release does not claim the production writer reproduces them.

The baseline exact-prompt broadcast cassette and its required replay test are unchanged and passing. The experimental cassette failure was not skipped or rekeyed: the unvalidated prompt changes were excluded entirely. Existing general AI factuality limitations still require editorial review.

## Verification and scope

- Full root JS tests passed: app 896, shared 37, historical harness 343, ledger 9, script 54. Explicit DB/live cases report 66 skips in that run.
- Disposable-local Postgres separately passed 74/74 over 40 tables and removed its own cluster. No production DB operation occurred.
- Final worker suite: 755/755, including exact-prompt broadcast replay and final-selection tape-warning regressions.
- Type check: zero errors/warnings. Build passed with the existing optional native-binding diagnostics.
- Independent Claude subscription static review found no unresolved blocker; its final-trim finding was fixed and tested. Upstream transcript parsing explicitly normalizes transcript IDs to strings and all quick-path variables are bound.
- This is a worker/test-tooling release with byte-identical frontend source and unchanged request/event schemas. Mobile layout, authenticated live generation and paid provider-quality tests are not claimed by these checks. No UI interaction redesign is released; the broad mobile-layout matrix is outside this release scope.

Remote deployment/version/health and rollback evidence is recorded separately only after observation. Never infer a successful deployment from this document or the local build.

## Remaining limits

Whole-turn cues are verified, not word-level clip timing or speaker identity. Short/implicit SOT quotes and broader semantic source fidelity are not proven by deterministic checks. The warning is producer copy, not a guarantee a clip or claim is correct. Future newsroom-quality integration requires actual-provider evidence and user review; it stays outside this release.
