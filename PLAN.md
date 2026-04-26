# hermes-ui — Plan

Last updated: 2026-04-26 (Wave B merged)

Replacing `newscraft-ai-workspace`. Connects to Hermes gateway at `127.0.0.1:8642`.

---

## Done

- SvelteKit 2 + Svelte 5 (runes) + adapter-node, TypeScript clean (`pnpm check`).
- Argon2id password → signed httpOnly session cookie. Auth gate via `src/hooks.server.ts`.
- SQLite + Drizzle schema (`conversations`, `messages`, `settings`).
- SSE proxy `/api/chat/stream` → Hermes `/v1/chat/completions` with `X-Hermes-Session-Id`. Server-side persistence of user + assistant messages, partial flag on abort.
- Routes: `/`, `/c/[id]`, `/settings`, `/login`.
- NewsCraft AI design system applied: cream/ink/cobalt tokens, dark sidebar + cream main pane, sharp corners, mono metadata, Lucide icons. Light + system-default dark mode.
- 3-dot mono "Drafting reply" pulse + streaming caret.
- Deploy: `/home/jigar/deploy-hermes-ui.sh` (Phase A install on `:3001`, `--cutover` flips Caddy + auto-revert, `--archive` retires old workspace).
- Single point of change for Hermes API: `src/lib/server/hermes/transport.ts`.

---

## Phase 1 — finish the chat (next)

- [x] **Markdown + code rendering** — `marked` + `dompurify` + lazy Shiki per code block, copy buttons. Highlights only after streaming completes to avoid thrash.
- [x] **Tool-call ephemeral strip** — `hermes.tool.progress` SSE events route to a chat-store-backed `ToolStrip` above the composer. Never appended to transcript (per Hermes #6972).
- [x] **Keyboard surface** — `Esc` aborts via shared `AbortController`; `Cmd+Shift+O` new chat; `↑` on empty composer recalls the last user message; `Cmd+[`/`Cmd+]` prev/next thread; `Cmd+/` opens help overlay.
- [x] **Stream abort + actions** — hover-revealed mono action row: copy (everywhere), regenerate (last assistant only). Server endpoint `DELETE /api/messages/[id]/onwards` truncates from a message; stream supports `regenerate: true`.
- [x] **Title auto-summarization** — server fires a non-streaming completion (idempotency-keyed) after the first assistant turn, persists via `setConversationTitle`, emits `event: hermes.title` so the sidebar updates on `invalidateAll`.

---

## Phase 2 — power features

Sequence to taste once Phase 1 is shipped.

- [x] **Conversation actions.** Per-row 3-dot menu: pin, rename (inline), delete (click-twice confirm, no modal), export per-thread (markdown / JSONL). Pinned rows sort to the top.
- [x] **Command palette `Cmd+K`.** Fuzzy on thread titles + commands (new chat, settings, abort, sign out). 200-line in-house component, no third-party. *Toggle-theme command deferred — no class/attr toggle exists yet (CSS uses `prefers-color-scheme: dark` only); revisit when a real toggle ships.*
- [x] **FTS5 search.** External-content FTS5 virtual table mirroring `messages.content`. `POST /api/search` returns ranked snippets. Sidebar search box at the top of the list — results panel replaces the conversation list while a query is active. *Caveat: messages with image attachments are stored as `P:<json>` and the FTS index ingests that raw — image-bearing messages can produce noisy hits. Fix later (filter or dedicated text shadow column).*
- [ ] **Resume-after-disconnect.** When a partial assistant message exists on load, show a yellow banner with `[Resume]` / `[Discard]`. Resume = re-POST with the partial included as a "continue from here" signal.
- [x] **Vision attachments.** Paperclip + drag-drop. Client-side canvas resize: longest-edge 1600→1200→1024→768 with JPEG quality 0.85→0.75→0.6, per-image cap 800 KB, total request cap 950 KB. Multimodal `image_url` data-URI parts. DB column `content` overloaded — plain strings stay verbatim; arrays serialize as `P:<json>`.
- [x] **Real settings surface.** Change password (no SSH — hash now lives in `settings` table, seeded from env on first boot), export all conversations as JSONL, wipe-DB with double-confirm.
- [ ] **Virtualization.** `virtua/svelte` for the message thread once any conversation crosses ~50 messages.

---

## Phase 3 — operator surface

When the foundation feels stable.

- [ ] **`/jobs` route** against `/api/jobs/*` — list, pause/resume/run-now, create cron jobs.
- [ ] **Tool-call inspector.** JSON tree of arguments + results, full streamed transcripts, per-tool duration.
- [ ] **Health badge** in sidebar footer using `/health/detailed` (currently 404 on the gateway — needs a Hermes-side fix or skip).
- [ ] **Conversation-level system prompt override.** Per-thread `systemPrompt` is already in the schema; expose in a per-thread settings slide-over.
- [ ] **Model picker.** Currently locked to `hermes-agent`; surface when there's a real choice.
- [ ] **Cutover.** `sudo bash /home/jigar/deploy-hermes-ui.sh --cutover` swaps Caddy `:3000 → :3001` and rewrites `ORIGIN`. After a week of confidence: `--archive` retires `newscraft-ai-workspace`.

---

## Cross-cutting

- **Performance budget** (from original plan): initial JS < 90 kB gzip < 32 kB; TTI < 350 ms; 0 CLS during streaming; 60 fps token rendering via rAF-batched DOM writes. Wire `bundlesize` + Lighthouse CI before cutover.
- **Tests.** `pnpm check` is clean; nothing else exists yet. Add a smoke test (login → send → receive → persist) before any non-trivial refactor.
- **Accessibility.** `aria-live="polite"` on streaming messages already in place. Add focus-visible rings audit, axe in CI, skip-to-composer link, reduced-motion (caret + pulse already respect it).
- **Backups.** Daily `sqlite3 .backup` to `data/backups/app-YYYYMMDD.db`, keep last 7. Not yet wired.

---

## Open product questions (revisit at any time)

- Branching conversations vs linear-only — currently linear (your call).
- Keep `NewsCraft` as the agent's display name in messages, or rename to a per-conversation "agent name" field?
- Whether to expose Hermes session pinning controls in the UI (currently auto-derived; no user knob).
