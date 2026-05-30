Packet ID: P3
Objective: Tighten copy heuristics and citation UI behavior.
Context: Claude confirmed M7, M8, L3, L4, L5, and L6.
Files / sources: `services/newsroom-harness/src/agents/copy.ts`, `src/lib/utils/citations.ts`, `src/lib/components/OpenGateCard.svelte`, `src/routes/+page.svelte`, related tests.
Ownership: Copy risk detection and citation graph rendering/accessibility.
Do: Scope legal attribution by claim-like segment, bound phrase matching, sort drafts by timestamp, keep source framing, expose marker state.
Do not: Redesign the UI.
Expected output: Fewer legal/style false negatives and false positives, richer contradiction display, accessible marker state.
Verification: Copy-agent tests and root UI/citation tests pass.
