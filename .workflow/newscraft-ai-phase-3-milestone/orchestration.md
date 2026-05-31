# Orchestration: newscraft-ai phase 3 milestone

## Execution Rules

- Keep the original objective intact.
- Ask for approval before risky, expensive, external, or destructive actions.
- Keep immediate blocking work local.
- Delegate only bounded, disjoint, materially useful packets.
- Integrate packet results before final verification.

## Branching Rules
- If the current code already has a Phase 3 feature, verify it and wire only the missing acceptance behavior.
- If delivery needs a secret, implement the adapter/config path and test with local fixtures, not real credentials.
- If packaging cannot find an approved draft, return a blocked/precondition result and do not queue a Publish gate.
- If delivery is requested before a Publish gate is resolved, fail closed and append no external send.

## Packet Prompts
- Packet A: Inspect `drafting.ts`, story memory, and repository gate logic. Add a packager agent that reads the latest approved or draft-reviewed story draft and source-backed fact ledger entries.
- Packet B: Add delivery adapter functions for email digest, webhook, Slack, and WordPress REST. Gate all sends behind a resolved Publish gate.
- Packet C: Expose package and delivery endpoints in `server.ts`, following existing error handling and auth patterns.
- Packet D: Keep shared/UI types compatible with existing gate and command-result handling. Add only narrow UI affordances if needed.
- Packet E: Run focused tests, then harness tests, and update workflow results.

## Completion Audit
- Linear milestone scope captured.
- Local implementation completed.
- Tests run and summarized.
- External writes either approved and completed, or left as explicit next step.
