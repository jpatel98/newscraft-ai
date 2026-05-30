Packet ID: P1
Objective: Fix verification integrity and citation-status defaults.
Context: Claude confirmed M1, M2, M3, M9, and L7 against Phase 2 verification and citation graph code.
Files / sources: `services/newsroom-harness/src/agents/verification.ts`, `services/newsroom-harness/src/db/repository.ts`, `src/lib/utils/citations.ts`, related tests.
Ownership: Verification event-log semantics, fact-ledger current state, citation graph status fallback.
Do: Preserve append-only history while exposing effective current ledger state; add regression tests.
Do not: Add migrations or external dependencies.
Expected output: Missing statuses are proposed, gate resolutions supersede verification events, request-more-research can reprocess new evidence, same-host URLs do not pass two-source verification.
Verification: Harness verification tests and citation utility tests pass.
