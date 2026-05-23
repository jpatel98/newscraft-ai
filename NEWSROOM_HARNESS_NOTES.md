# Newsroom Harness Notes

Date: 2026-05-02

## Core Idea

We can build a NewsCraft-native, always-running AI harness instead of depending entirely on a generic Agent agent. The harness should be a long-running backend service that owns scheduling, tool access, newsroom workflow, provenance, audit logs, and human review, while the existing SvelteKit app remains the UI and control surface.

The goal is not one giant autonomous agent. The stronger design is an agent harness that coordinates specialized agents and tools for newsroom tasks.

## Why Build This Instead Of Just Using Agent

- News-native workflow: missions, beats, sources, alerts, verification, editor review, CMS packaging, embargoes, and desks can become first-class concepts.
- Purpose-built tools: RSS, wires, court records, SEC filings, public records, archives, transcript search, CMS drafts, Slack alerts, source ledgers, and fact-check queues.
- Better provenance: generated claims can carry source IDs, retrieval paths, timestamps, quotes, confidence, and change history.
- Editorial guardrails: require human approval before publishing, flag legal/privacy risk, separate confirmed facts from leads, enforce two-source rules, and mark AI-assisted material.
- Always-running news behavior: live watches such as "alert me when this materially changes" or "compare this update against the last version."
- Cost and execution control: route simple tasks to cheaper models, reserve stronger models for synthesis, cache retrieval, dedupe sources, batch jobs, and stop runaway tool loops.
- Custom memory: beat memory, source history, prior coverage, corrections history, style preferences, and entity timelines.
- Product differentiation: the custom harness can become NewsCraft's defensible newsroom intelligence layer, not just a generic agent wrapper.

Agent is still useful as a prototype bridge. The practical path is to keep the UI contract stable and gradually replace the generic backend with a NewsCraft-native harness.

## Current Repo Findings

The current repo is a SvelteKit app backed by a local agent gateway.

Important files:

- `package.json`: single SvelteKit app today, with scripts for dev, build, test, deploy, reload, and DB migrations.
- `pnpm-workspace.yaml`: workspace-shaped, but not currently declaring packages.
- `src/lib/server/agent/transport.ts`: centralizes agent gateway URL, auth, chat streaming, responses streaming, completions, and health.
- `src/lib/server/agent/board.ts`: centralizes mission/job/run calls to the gateway and normalizes backend responses.
- `src/lib/server/agent/bridge.ts`: provides local slash commands.
- `src/routes/api/chat/stream/+server.ts`: UI chat streaming route. It forwards to Agent and pipes SSE/tool events back to the browser.
- `src/routes/api/agent/jobs/+server.ts`: UI-facing mission API that delegates to the Agent adapter layer.
- `src/lib/server/db/schema.ts`: app SQLite schema for accounts, conversations, messages, missions, mission sources, mission runs, and mission reports.

The frontend is in a good position for a gradual harness swap because most Agent-specific behavior is behind `src/lib/server/agent/*`.

## Monorepo Recommendation

Yes, this repo can become a monorepo, but the harness should not be embedded inside the SvelteKit server. It should be a sibling service in the same repo.

Low-risk first structure:

```text
newscraft-ai/
  services/
    newsroom-harness/
      src/
        server.ts
        agents/
        tools/
        jobs/
  packages/
    shared/
      src/
        types.ts
        events.ts
```

Later, after the current dirty worktree and mission changes settle, the SvelteKit app could move to:

```text
apps/
  web/
```

But avoid that large move at first.

## OpenAI Agents SDK Direction

The OpenAI Agents SDK is a good fit for the custom harness. Use it as the agent runtime inside our own service, not as the entire product.

Recommended approach:

- Use the TypeScript Agents SDK because the repo is already TypeScript/SvelteKit/pnpm.
- Build the harness as a local HTTP/SSE service on a separate port, for example `127.0.0.1:8650`.
- Implement the current Agent-like gateway contract first so the UI can keep working.
- Use specialized agents rather than one general persona.

Potential specialized agents:

- Assignment desk agent: watches feeds and flags story opportunities.
- Research agent: gathers background, links, timelines, prior coverage, and source material.
- Verification agent: checks claims, weak sourcing, conflicts, and corroboration.
- Production agent: prepares summaries, CMS metadata, headlines, social copy, and packaging.
- Monitoring agent: tracks developing stories and alerts editors when material facts change.

## Compatibility API To Implement First

To swap the UI gradually, the harness should initially imitate the existing local agent gateway shape:

- `GET /health`
- `POST /v1/chat/completions`
- `POST /v1/responses`
- `GET /api/jobs?include_disabled=true`
- `POST /api/jobs`
- `PATCH /api/jobs/:id`
- `POST /api/jobs/:id/run`
- `POST /api/jobs/:id/pause`
- `POST /api/jobs/:id/resume`
- `DELETE /api/jobs/:id`

The current UI should point to:

```env
AGENT_GATEWAY_URL=http://127.0.0.1:8650
```

## Data And Persistence Notes

The UI already uses SQLite via Drizzle. The harness could share that DB, but the safer first step is either:

- Give the harness its own SQLite DB, or
- Clearly partition writes if sharing the existing app DB.

Shared SQLite can work with WAL, but background mission runs, UI edits, report ingestion, and chat writes can create contention if not handled carefully.

Longer term, the harness should own durable tables for:

- Missions
- Runs
- Run steps
- Tool calls
- Sources
- Source snapshots
- Claims
- Reports
- Human review state
- Audit log entries

## Main Risks

- The Python Agent bridge is tightly coupled to local Agent internals. Replace this with harness-native HTTP APIs or shared TypeScript packages.
- Current naming is Agent-specific throughout the server adapter layer. Keep it during compatibility work, then rename to `agent-gateway` once stable.
- The old VPS deploy scripts have been removed. The harness needs hosting-specific production wiring.
- The repo currently has uncommitted mission-related changes. Avoid a big app directory move until that work settles.
- Always-running agents need strict budget limits, tool permissions, retries, cancellation, audit logs, and human approval paths.

## Suggested Build Plan

1. Add `services/newsroom-harness` as a TypeScript service.
2. Update `pnpm-workspace.yaml` to include `services/*` and `packages/*`.
3. Add `packages/shared` for shared types and SSE event contracts.
4. Implement `/health`.
5. Implement a minimal chat streaming endpoint using the Agents SDK.
6. Make the harness emit SSE events compatible with the current UI.
7. Implement mission/job CRUD endpoints.
8. Add a simple scheduler and run table.
9. Add first newsroom tools: RSS/source fetch, URL fetch, source snapshot, and report writer.
10. Add verification/provenance fields before expanding publishing or CMS integrations.

## Product Principle

Keep humans in control. The harness can recommend, summarize, compare, draft, alert, and prepare. Publishing and sensitive editorial judgment should remain explicitly human-approved.
