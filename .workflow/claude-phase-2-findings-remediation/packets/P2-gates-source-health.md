Packet ID: P2
Objective: Fix duplicate gate behavior and source-health enforcement.
Context: Claude confirmed M4, M5, and M6.
Files / sources: `services/newsroom-harness/src/db/repository.ts`, `services/newsroom-harness/src/crawl-plans/executor.ts`, `services/newsroom-harness/src/agents/beat-monitor.ts`, `services/newsroom-harness/src/agents/copy.ts`, related tests.
Ownership: Gate deduplication and source-health policy consumption.
Do: Dedupe open gates for same unresolved issue; make pause/drop block crawl fetches with audit events.
Do not: Change gate API shape in a breaking way.
Expected output: One open Source Health gate per host/URL, one open Legal/Style gate per draft event, source-health decisions affect crawl behavior.
Verification: Events, gates, crawl-plan, and copy-agent tests pass.
