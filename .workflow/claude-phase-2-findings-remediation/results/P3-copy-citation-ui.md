# P3 Copy And Citation UI

Accepted:
- M7: legal-risk attribution is checked per claim-like segment instead of whole-document scope.
- M8: banned/libel phrase matching now uses bounded phrase regexes instead of raw substring includes.
- L3: copy chooses the latest draft by timestamp and dedupes duplicate draft records.
- L4: citation graph source entries retain each source's own claim framing.
- L5: citation marker controls expose `aria-pressed`, and citation inspectors are focusable/focus-managed after marker selection.
- L6: the reusable gate-card citation test renders the Svelte component with real payload data instead of only checking source substrings.

Rejected:
- None.

Evidence:
- `services/newsroom-harness/tests/copy-agent.test.ts`
- `src/lib/components/open-gate-card.test.ts`
- `src/routes/overview-gates.test.ts`
