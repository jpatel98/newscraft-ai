# Orchestration: Claude Phase 2 Findings Remediation

## Execution Rules

- Keep the original objective intact.
- Ask for approval before risky, expensive, external, or destructive actions.
- Keep immediate blocking work local.
- Delegate only bounded, disjoint, materially useful packets.
- Integrate packet results before final verification.

## Branching Rules
- If a finding is confirmed and localized, implement the simplest direct fix with a regression test.
- If a finding overlaps another packet, keep the shared behavior in repository or utility helpers and document the integration decision in `results/`.
- If a proposed fix would require a schema migration or external state change, stop and ask.

## Packet Prompts
- P1: Inspect verification and citation utilities; fix default status, fact-ledger superseding, re-verification after new research, and independent-source counting. Add regression tests for single-source, idempotency, request-more-research, and same-host source rejection.
- P2: Inspect gate queuing and source-health memory; dedupe open gates for same source/draft and consume paused/dropped source-health decisions in crawl paths. Add regression tests for duplicate prevention and enforcement.
- P3: Inspect copy agent, draft selection, and citation graph UI; tighten legal-risk attribution and phrase matching, sort latest drafts by timestamp, surface contradicting claim text, and add accessible selection state. Replace brittle source-only UI tests where practical.
- P4: Run targeted and full checks, record accepted/rejected findings, and verify workflow artifact completeness.

## Completion Audit
- Record packet outcomes in `results/`.
- Update `state.json` to `verified` only after checks pass or skipped checks are explicitly documented.
- Summarize final changes and remaining risks in `final-report.md`.
