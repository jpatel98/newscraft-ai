# Audit: Logic Holes, Confusing Copy & Dead Code

## Context

A hole-poking pass across `newscraft-ai`: logic bugs, confusing words/buttons, and fix recommendations. Findings cover four categories:

1. **Authorization & security** — found real account-takeover vector via setup-link endpoint.
2. **Confusing UI copy** — audience is **external newsroom users (non-technical)**, so jargon ("operator", "harness", "channel", "job") needs to leave producer-facing surfaces.
3. **Logic holes & race conditions** — `'unknown'` fallback IDs, empty-string IDs passed through to backends, double-submit guards.
4. **Dead code / stale routes** — orphaned redirects, inconsistent mutation returns, inconsistent error shapes.

Findings are grouped by severity (P0 → P3). Estimated effort per item shown as **S/M/L** (S = <30 min, M = ~1–2 hr, L = half day+).

---

## P0 — Security & Authorization (ship before any multi-user usage)

**Status, 2026-05-25:** Closed by the P0 auth/security pass. The current code
loads `accounts.role` into `locals.user`, gates account-management routes with
`requireAdmin`, rejects missing channel-post `jobId`, and trims
`systemPrompt` at the route boundary before validation/storage. Regression
coverage now locks those paths.

### 1. Account takeover via setup-link endpoint — **S**
**File:** `src/routes/api/settings/accounts/[id]/setup-link/+server.ts:4-19`
**Issue:** Any authenticated user can POST `/api/settings/accounts/{anyone-elses-id}/setup-link`, receive a valid setup token URL, then claim that account's password via `/account-setup/[token]`. There is no admin/role check and no ownership check.
**Fix:** Add an admin/role gate. Minimum viable today (no role model): only the *first-created* account, or only when there is exactly one account, can mint setup links. Better: introduce `accounts.role` (`admin` | `member`) and gate on `locals.user.role === 'admin'`. The same gate must apply to:
- `src/routes/api/settings/accounts/+server.ts` (POST — create accounts)
- `src/routes/api/settings/accounts/[id]/+server.ts` (PATCH/DELETE)

### 2. Account deletion has no ownership/admin check — **S**
**File:** `src/routes/api/settings/accounts/[id]/+server.ts:4-16`
**Issue:** Blocks deleting own account but lets any authenticated user delete any other account. Combined with #1, full account takeover loop.
**Fix:** Same admin gate as #1.

### 3. `setConversationSystemPrompt` accepts whitespace strings that the writer then nulls — **S**
**File:** `src/routes/api/conversations/[id]/+server.ts:49-50` vs `src/lib/server/db/conversations.ts:148-149`
**Issue:** API accepts a 4001-char whitespace-only string under `MAX_SYSTEM_PROMPT_CHARS`, writer trims then stores `null`. Not exploitable but causes silent confusion: client thinks prompt was set, server stored nothing.
**Fix:** Trim before length-checking in the route handler. Mirror the writer's semantics at the boundary.

### 4. `/api/agent/channel-posts` accepts `'unknown'` as jobId — **S**
**File:** `src/routes/api/agent/channel-posts/+server.ts:46-47`
**Issue:** When `jobId` is missing, fallback string `'unknown'` is used. `getMissionAccountId('unknown')` returns `null` and 404s — so not exploitable today — but a future code path that touches this string as if it were a real ID will silently misroute reports.
**Fix:** Reject the request when both `body.jobId` and the markdown-parsed `jobId` are empty: `throw error(400, 'jobId is required')`. Remove the `|| 'unknown'` fallbacks entirely.

---

## P1 — Logic holes that corrupt data or surprise users

**Status, 2026-05-25:** Closed by the PR2 logic-safety pass. Agent job
routes reject blank IDs with 400s, title generation now logs failures and has
a sidebar retry path for stale automatic titles, `setConversationTitle`
matches the mutation-return pattern, mission Run-now stays locked until the run
is observed or resolved, future timestamps render absolutely, and 0x0 image
input is rejected.

### 5. Empty-string job IDs threaded through Agent job endpoints — **S**
**Files:**
- `src/routes/api/agent/jobs/[id]/+server.ts:15` — `const id = params.id ?? '';`
- `src/routes/api/agent/jobs/[id]/pause/+server.ts:7`, `…/resume/+server.ts`, `…/run/+server.ts` — same pattern
**Issue:** SvelteKit always populates `params.id` for `[id]` routes, so `?? ''` is dead defense — but if it ever fires, the downstream `JOB_ID_RE.test('')` throws a generic "Invalid job id" 500. Better to validate explicitly.
**Note:** `runJobAction` in `src/lib/server/agent/board.ts:507` does scope by `getMissionConfig(accountId, id)`, so cross-account access is not actually possible here — only an ugly error path.
**Fix:** Replace `params.id ?? ''` with `if (!params.id) throw error(400, 'job id is required');` and use `params.id` directly.

### 6. Title generation failures are silently swallowed — **S**
**File:** `src/routes/api/chat/stream/+server.ts:505-520`
**Issue:** `try { …setConversationTitle… } catch { /* best-effort */ }`. If the model errors *after* a partial title is computed, or if the DB write fails, no telemetry — user sees a permanent "New chat" with no recovery path.
**Fix:** Log the error (`console.warn`) at minimum. Surface a "retry title" affordance in the sidebar row menu when `title === 'New chat'` or `title === null` and conversation is older than 60s.

### 7. `setConversationTitle` does not return the updated row — **S**
**File:** `src/lib/server/db/conversations.ts:120-125`
**Issue:** Inconsistent with sibling `renameConversation` (line 127) which returns the row. Any caller that wanted to verify the write must re-read.
**Fix:** Return `getConversation(accountId, id)` to match the sibling.

### 8. Double-submit unguarded on mission Run-now — **M**
**File:** `src/routes/missions/+page.svelte:472-508` (`jobAction()`)
**Issue:** `actionBusy = action` is set before the fetch, but the button's disabled state depends only on `actionBusy`. Clicking "Run now" twice rapidly across keystrokes can fire two requests if `actionBusy` toggles between them; also, `finally { actionBusy = null }` re-enables the button immediately, before Agent has confirmed the job actually started.
**Fix:** Disable the button while `actionBusy` is set *and* keep it disabled until next `boardData` refresh shows the run started. Add `aria-busy` for assistive tech.

### 9. `formatRelativeTime` masks client clock skew — **S**
**File:** `src/lib/utils/time.ts:22-29`
**Issue:** `Math.max(0, now - d.getTime())` silently clamps negative diffs to zero, displaying "just now" for future timestamps. If a server-rendered timestamp is in the future due to clock skew, it stays "just now" forever.
**Fix:** When `diff < 0`, render the absolute timestamp (e.g., "May 19, 10:42") instead of pretending it's now.

### 10. `image-resize` divides by zero on 0×0 images — **S**
**File:** `src/lib/utils/image-resize.ts:79`
**Issue:** `const scale = long > maxLong ? maxLong / long : 1;` — if `long === 0`, scale is `1`, but `srcW * 1` then `Math.round` is `0`, and the subsequent canvas draw with `Math.max(1, …)` produces a 1×1 image silently. Better to refuse the input.
**Fix:** `if (srcW === 0 || srcH === 0) throw new Error('Invalid image dimensions');`

---

## P2 — Confusing UI copy & buttons (audience: external newsroom users)

> Audience decision: non-technical newsroom users. Internal terms like "channel", "job", "operator", "harness" should leave producer-facing surfaces. Settings/operator dashboard can keep technical terms.

### 11. Three names for the same concept: Mission / Channel / Job — **M**
**Files:** Throughout `src/routes/+layout.svelte`, `src/routes/missions/+page.svelte`, `src/lib/server/agent/board.ts`, all `/api/agent/jobs/*` endpoints, type names (`AgentJob`, `BoardChannel`, `Mission*`).
**Issue:** UI says "Mission". Code says `job`, `channel`, `jobId`. Error toasts surface raw backend strings like `Mission run requested` mixed with `Job failed` from Agent — non-technical users will be confused.
**Fix:**
- **User-facing copy:** standardize on **"Mission"** in every visible string, including aria-labels, toasts, and error envelopes.
- **Internal code:** keep `job`/`agent` names where they reflect the upstream Agent API contract, but rename `BoardChannel` → `BoardMission` and `channelSlug` → `missionSlug` since "channel" leaks nowhere meaningful.
- **Error passthroughs:** in `src/routes/api/agent/jobs/+server.ts:52` and friends, wrap Agent errors before re-throwing: `throw error(502, 'Mission service is unavailable')` and log the raw message server-side.

### 12. "Click again to confirm" is an invisible state — **S**
**Files:** `src/routes/+layout.svelte:770` (delete mission), `:883` (delete chat)
**Issue:** First click silently arms a delete; second click destroys. No countdown, no color change beyond label swap, no undo. Risk of data loss on a fast double-click.
**Fix:** Replace with a small inline confirm UI: red background, explicit text `Delete "{name}"?` and two side-by-side buttons (`Cancel`, `Delete`). Or use a modal dialog like the wipe-DB flow already does (`src/routes/settings/+page.svelte:579`).

### 13. Schedule placeholder shows cron with no help — **S**
**File:** `src/routes/missions/+page.svelte:1124`
**Issue:** Placeholder `every 180m or 0 */3 * * *` assumes users know cron. Non-technical newsroom audience won't.
**Fix:** Replace placeholder with `every 3 hours` only. Below the field add a `details` disclosure: "Advanced: cron syntax (e.g. `0 */3 * * *`)" linking to a one-screen cron primer or accepting `every Nh`/`every Nm` shortcuts.

### 14. "Operator" infrastructure jargon in producer UI — **S**
**File:** `src/routes/+layout.svelte:895` — `aria-label="Operator health status"` plus class names `operator-footer__*`.
**Issue:** Aria text is read aloud by screen readers; "operator" means nothing to a journalist.
**Fix:** Change aria-label to `"System status"` or `"Newsroom service status"`. CSS class names can stay as-is.

### 15. "Edit name" vs "Edit mission" are not parallel — **S**
**File:** `src/routes/+layout.svelte:758-763`
**Issue:** Two menu items differ by what they edit, but the labels imply different *actions*. Conversation sidebar uses "Rename" — be consistent.
**Fix:** Rename → `"Rename"` and `"Edit mission settings"`.

### 16. `System prompt •` bullet is unexplained — **S**
**File:** `src/routes/+layout.svelte:868-869`
**Issue:** A trailing `•` means "a custom prompt is set" but the user has no way to know that.
**Fix:** Replace with explicit suffix: `System prompt` vs `System prompt (custom)`. Or use a tiny pill: `<span class="badge">custom</span>`.

### 17. "Reset link" / "Setup link" terminology — **S**
**File:** `src/routes/settings/+page.svelte:363`
**Issue:** "Reset link" sounds destructive (resets the account?). It actually mints a new invite token.
**Fix:** Rename button to `"Generate setup link"` for unclaimed accounts and `"Send password reset link"` for claimed accounts.

### 18. "No response body captured" passive jargon — **S**
**File:** `src/routes/missions/+page.svelte:1449, 1496`
**Issue:** Engineer-speak. A producer sees this and has no idea whether the report failed or is empty.
**Fix:** `"This mission ran but didn't produce a report."` and add a "Retry" action.

### 19. `jobsError` raw string surfaced in notice bar — **S**
**File:** `src/routes/missions/+page.svelte:1081`
**Issue:** `"Saved reports loaded. Live mission controls are unavailable: {jobsError}"` will render raw Agent error text including HTTP codes.
**Fix:** Strip details: `"Live mission controls are unavailable — saved reports are still readable."` Log `jobsError` to console for debugging.

### 20. `Fetching reports…` vs `Loading reports…` inconsistency — **S**
**File:** `src/routes/missions/+page.svelte:1231` vs `:1418`
**Fix:** Standardize on `"Loading reports…"` (the more common, less technical verb).

### 21. "Recurring mission" eyebrow on every mission — **S**
**File:** `src/routes/missions/+page.svelte:1016-1018`
**Issue:** Not every mission is recurring (one-offs exist). The label is wrong for those.
**Fix:** Conditional eyebrow: `"Recurring mission"` only when `mission.schedule` is set; otherwise just hide the eyebrow.

### 22. Signup error claims passwords must be globally unique — **S**
**File:** `src/routes/signup/+page.server.ts:54-56`
**Issue:** `"choose a password that is not already in use"` implies a Big Brother password registry. Actually, the auth model uses *password as the account identifier* (no email), which is a structural choice worth flagging separately.
**Fix:**
- **Short term:** rewrite error to `"That password is already linked to another account. Choose a different password."`
- **Long term (out of scope here):** consider whether identifying users by password alone is acceptable; this is a known anti-pattern (collision → lockout, reuse → bypass). Track as a separate spike.

### 23. "Jump to new report" — **S**
**File:** `src/routes/missions/+page.svelte:1356`
**Fix:** `"View new report"`.

### 24. Run-now button text doesn't convey it's locked — **S**
**File:** `src/routes/missions/+page.svelte:1288`
**Issue:** Label cycles `Run now` → `Starting` → `Running`. While "Running", the button looks tappable but is disabled. No affordance to cancel.
**Fix:** While running, swap to a secondary "Cancel run" button (if cancel is supported by Agent), or visually convert to a status pill: a non-button `<span class="pill pill--live">Running…</span>`. Don't keep a button that looks clickable but isn't.

---

## P3 — Dead code & stale routes (cleanup, low risk)

### 25. Orphaned redirect-only routes — **S**
**Files:** `src/routes/mission-control/+page.ts` (redirects to `/missions`), `src/routes/channels/+page.ts` (→ `/board`), `src/routes/reports/+page.ts` (→ `/missions`).
**Issue:** Three routes exist only to redirect. If they're shipped to backstop old bookmarks, fine — but verify they're actually referenced.
**Fix:** Either keep one quarter and then delete, or replace with `+layout.server.ts` redirects scoped to a known-bookmark window. If no external links point here, delete now.

### 26. Inconsistent error envelopes across `/api/*` — **M**
**Issue:** Some routes `throw error(…)` (SvelteKit Response), some return `{error: '…'}`, some return `json({ok: false})`. Client code in `+page.svelte` has to handle three shapes.
**Fix:** Pick one — recommend `throw error(status, message)` everywhere — and update callers. Audit candidates:
- `src/routes/api/agent/jobs/+server.ts:52` ✓ uses throw
- `src/routes/api/agent/board/+server.ts` — returns `{error}` on partial failures
- `src/routes/api/settings/wipe-db/+server.ts` — returns `{ok}`
Standardize and document in `README.md` under "API conventions".

### 27. `/api/health` public, `/api/settings/status` private — **S**
**Files:** `src/hooks.server.ts:10` (PUBLIC_PREFIXES) vs `src/routes/api/settings/status/+server.ts`.
**Issue:** Likely intentional (health is a load-balancer probe; status is operator detail). But name collision invites mistakes.
**Fix:** Document the split in `src/routes/api/health/+server.ts` with a one-line comment: `// Public liveness probe. Detailed status lives under /api/operator/status (auth required).`

### 28. `/account-setup/[token]/+page.server.ts` re-validates token in action but `load` doesn't expose it — **S**
**File:** `src/routes/account-setup/[token]/+page.server.ts:11-37`
**Issue:** Not a TOCTOU exploit (the token re-check in the action prevents misuse) but the empty `load` return `return {}` is suspicious — there's nothing for the page to render about *which* account is being claimed. User sets a password without ever confirming which email/account they're claiming.
**Fix:** Return `{ email: account.email }` from `load` and display "Set a password for `{email}`" on the page. Hides nothing security-relevant since the user already has the token.

---

## Critical files (touched by this plan)

**Authorization (P0):**
- `src/routes/api/settings/accounts/+server.ts`
- `src/routes/api/settings/accounts/[id]/+server.ts`
- `src/routes/api/settings/accounts/[id]/setup-link/+server.ts`
- `src/lib/server/db/schema.ts` (add `role` column on `accounts`)
- `src/lib/server/db/accounts.ts` (expose `role` on `AccountRow`/`AccountSummary`)
- `src/hooks.server.ts` (load role into `locals.user`)
- `drizzle/` (new migration for `role` column)

**Logic holes (P1):**
- `src/routes/api/agent/channel-posts/+server.ts`
- `src/routes/api/agent/jobs/[id]/+server.ts` and `/run|pause|resume/+server.ts`
- `src/routes/api/chat/stream/+server.ts`
- `src/routes/api/conversations/[id]/+server.ts`
- `src/lib/server/db/conversations.ts`
- `src/lib/utils/time.ts`
- `src/lib/utils/image-resize.ts`
- `src/routes/missions/+page.svelte`

**UI copy (P2):**
- `src/routes/+layout.svelte`
- `src/routes/missions/+page.svelte`
- `src/routes/settings/+page.svelte`
- `src/routes/signup/+page.server.ts`
- `src/lib/types.ts` (rename `BoardChannel` → `BoardMission` etc.)

**Cleanup (P3):**
- `src/routes/mission-control/`, `src/routes/channels/`, `src/routes/reports/`
- `src/routes/api/health/+server.ts`
- `src/routes/account-setup/[token]/+page.server.ts`
- `README.md` (document API error envelope convention)

---

## Reusable utilities already in the codebase

Where a fix needs new logic, reuse what's already there before adding:
- **Role/admin gate:** when adding the role column, model after `findAccountByPassword` pattern in `src/lib/server/db/accounts.ts`. Session loading is in `src/hooks.server.ts`.
- **Confirm dialog:** the wipe-DB modal at `src/routes/settings/+page.svelte:579` is the template for replacing "Click again to confirm".
- **Cron syntax help:** `parseCronMarkdown` in `src/lib/utils/board.ts` already does some normalization — extend it to accept `every Nh` / `every Nm` shortcuts instead of building a new parser.
- **Error wrapping:** `describeGatewayError` in `src/lib/server/agent/transport.ts` already exists for upstream error normalization — use it consistently in `/api/agent/*`.

---

## Verification

To validate findings *before* implementing:

1. **Reproduce the P0 account-takeover (5 minutes, requires two accounts):**
   - Create accounts A and B via `/setup` then `/api/settings/accounts` POST.
   - Log in as A. `curl -X POST -b "session=…" http://localhost:5173/api/settings/accounts/{B-id}/setup-link`
   - Expect: 200 with `setupUrl`. Open it in a private window, set a new password, claim B.
   - After fix: expect 403.

2. **Reproduce double-submit (P1 #8):**
   - Throttle network in DevTools to "Slow 3G".
   - Click Run-now twice within 200ms. Watch `/api/agent/jobs/{id}/run` fire twice in the Network tab.
   - After fix: only one request.

3. **Sanity-check copy changes (P2):**
   - Spin up dev (`pnpm dev`) and click through: home → /board → /missions → mission detail → settings → signup.
   - Grep for any remaining `Job` / `Channel` / `Operator` strings in producer-facing files: `grep -rn 'Job\|Channel\|Operator' src/routes/ --include='*.svelte'`.

4. **Migration (P0):** after adding `role` column, run `pnpm drizzle-kit generate` then `pnpm drizzle-kit migrate`. Verify with `sqlite3 .data/app.db '.schema accounts'`.

5. **E2E:** existing Playwright suite under `tests/` should still pass. If you add the role gate, add a test that asserts a non-admin gets 403 on `/api/settings/accounts/*`.

---

## Suggested shipping order

1. **PR 1 — security:** items #1, #2, #3, #4 (P0). Completed 2026-05-25.
2. **PR 2 — logic safety nets:** items #5–#10 (P1). 1–2 hours, all small.
3. **PR 3 — copy refresh:** items #11–#24 (P2). Half day; #11 is the bulk of it.
4. **PR 4 — cleanup:** items #25–#28 (P3). 1 hour.

Recommend doing PR 1 next regardless of UX decisions, since the takeover hole is real.
