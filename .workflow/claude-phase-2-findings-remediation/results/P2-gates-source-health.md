# P2 Gates And Source Health

Accepted:
- M4: Source Health gate creation now dedupes against existing open gates for the same host or URL.
- M5: Source Health `pause` and `drop` resolutions now persist `blocks_fetch`; crawl-plan and beat-monitor paths consult the decision and emit `source.health.skipped` audit events.
- M6: Copy returns the existing open Legal/Style gate for the same draft event instead of queuing duplicates.

Rejected:
- None.

Evidence:
- `services/newsroom-harness/tests/events.test.ts`
- `services/newsroom-harness/tests/gates.test.ts`
- `services/newsroom-harness/tests/crawl-plans.test.ts`
- `services/newsroom-harness/tests/copy-agent.test.ts`
