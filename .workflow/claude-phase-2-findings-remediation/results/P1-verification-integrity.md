# P1 Verification Integrity

Accepted:
- M1: citation graph status now defaults missing status to `proposed`, not `verified`.
- M2: verification gate resolutions now carry `proposed_event_id`, `verification_event_id`, and superseding metadata; story memory `current.fact_ledger` exposes the effective latest claim state.
- M3: `request_more_research` no longer permanently closes a claim; story-wide verification can reprocess when new evidence appears.
- M9: verification groups same-text proposed claims and counts independent sources by host/publisher, so same-host URLs do not satisfy the two-source rule.
- L7: story-wide idempotency is covered by regression tests.

Rejected:
- None.

Evidence:
- `services/newsroom-harness/tests/verification-agent.test.ts`
- `src/lib/utils/citations.test.ts`
