# Claude Phase 2 Findings Remediation

## Goal
Remediate Claude's Phase 2 review findings in the NewsCraft repo without broad refactors, preserving the Phase 2 agent/event-log shape while closing the editorial-integrity gaps.

## Success Criteria
- Missing citation verification status never renders as `verified`.
- Verification gate resolution records a clear superseding ledger entry and `request_more_research` can be reprocessed once new evidence arrives.
- Two-source verification counts independent publishers/hosts, not two URLs from the same outlet.
- Source Health and Legal/Style gates are idempotent for the same unresolved issue.
- Source Health `pause`/`drop` resolutions are consumed by crawl paths before refetching.
- Copy legal-risk checks are scoped to the sentence/claim and phrase matching is word-bounded.
- Draft citation graph exposes contradicting source framing and selection state to assistive tech.
- Targeted tests and repo-wide checks pass.

## Current Context
The worktree already contains Phase 2 implementation files for verification, copy, source-health gates, and citation graph UI. Claude's findings are in `/Users/jigar/.codex/attachments/3d9fae75-9b1e-447c-8061-eca491ea90a1/pasted-text.txt`.

## Constraints
- Keep edits scoped to files implicated by Claude's findings.
- Do not rewrite existing agent architecture or event schemas beyond additive payload fields and small repository helpers.
- Preserve append-only event and memory semantics.
- Do not touch Linear or external systems in this remediation pass.

## Risks
- Fact-ledger semantics are shared by verification, drafting, and editor-command tests.
- Source-health enforcement must not silently drop all source processing without an audit event.
- UI changes must remain Svelte 5-compatible and pass `svelte-check`.

## Approval Required
No destructive, external, migration, deploy, or credential-touching action is planned. Ask before any of those become necessary.

## Work Packets
- P1 Verification integrity: M1, M2, M3, M9, L7.
- P2 Gate idempotency and source-health enforcement: M4, M5, M6.
- P3 Copy and citation UX: M7, M8, L3, L4, L5, L6.
- P4 Verification: targeted harness/UI tests, `pnpm check`, full test suite, workflow artifact validation.

## Integration Policy
Integrate packet changes directly only after reading the affected module and its current tests. Prefer additive helpers and precise test coverage over broad rewrites.

## Verification
- `corepack pnpm --filter @newscraft/newsroom-harness test`
- Targeted root Vitest tests for citations and gate UI
- `corepack pnpm check`
- `corepack pnpm test`
- `python3 /Users/jigar/.codex/skills/codex-dynamic-workflows/scripts/verify_workflow.py .workflow/claude-phase-2-findings-remediation`

## Reusable Artifacts
Keep only this workflow run directory; no reusable recipe is needed unless the remediation pattern becomes repeated.
