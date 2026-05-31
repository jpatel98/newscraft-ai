# newscraft-ai phase 3 milestone

## Goal
Implement Linear milestone "Phase 3 - Packaging & delivery" for the Newscraft AI project.

## Success Criteria
- JIG-157: approved/source-backed story drafts can be packaged into brief, web story, feature, broadcast script, social pack, push, and newsletter outputs.
- JIG-158: packaging includes a headline pack with five general headlines, one SEO headline, one social headline, and rationale.
- JIG-159: delivery adapters exist for email digest, generic webhook, and Slack, with results logged and failures visible.
- JIG-160: WordPress REST draft push exists with credentials coming only from environment/config, never story memory or logs.
- JIG-161: package creation queues a Publish gate, and delivery/push actions require a resolved Publish gate.
- Local verification proves the harness API, repository side effects, and UI gate rendering remain stable.

## Current Context
- Linear project: Newscraft AI.
- Milestone: Phase 3 - Packaging & delivery, progress 0%.
- Phase 3 Linear issues: JIG-157, JIG-158, JIG-159, JIG-160, JIG-161.
- Existing repo already has story memory, draft history, fact ledger, gate primitives, draft review gates, legal/style gates, and publish gate type support.

## Constraints
- Preserve `/api/agent/*` UI compatibility routes.
- Keep the harness as the owner of agent/runtime behavior.
- Keep external publishing human-gated; no autonomous send path.
- Keep secrets, tokens, API keys, and raw logs out of memory and workflow artifacts.
- Do not update Linear issue state/comment without explicit approval because that is an external write.

## Risks
- Delivery integrations can accidentally become publishing pathways if gate checks are weak.
- WordPress/Slack/email credentials must not be serialized into events, memory, test snapshots, or errors.
- A broad UI redesign would be unnecessary risk; reuse existing Open Gate and overview patterns.

## Approval Required
- Required before any Linear writes.
- Required before calling real external delivery endpoints outside local test fixtures.
- Required before deploys, destructive DB migrations, or forceful Git operations.

## Work Packets
- Packet A: Harness packaging model and packager agent.
- Packet B: Publish gate side effects and delivery adapters.
- Packet C: API endpoints and tests.
- Packet D: UI/type compatibility and visible publish gate rendering.
- Packet E: Verification and final report.

## Integration Policy
Keep changes small and repo-patterned. Prefer append-only events and story memory over new tables unless tests prove a table is necessary. Delivery should return structured results, append events, and fail closed when the Publish gate is missing or unresolved.

## Verification
- Targeted harness tests for package generation, headline pack, gate requirement, delivery adapters, and WordPress request shape.
- Existing gate/server/drafting tests.
- `corepack pnpm test:harness`.
- Broaden to `corepack pnpm check` if UI/types are touched.
- Workflow artifact completeness check.

## Reusable Artifacts
No reusable recipe unless the final implementation exposes a repeatable milestone pattern worth preserving.
