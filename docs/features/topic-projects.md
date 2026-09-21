# Topic projects

Projects organize conversations explicitly selected by their owner. They do not monitor topics, move chats automatically, or inject other chats into a conversation's model context.

## Behavior

Open **Projects** in the sidebar to create a named project. The project page lists all its conversations, supports renaming, and has a composer for new chats. The composer keeps a separate draft per project. In a conversation, use **Move to project** in the header or sidebar menu; choose a project or **No project (ungrouped)**. Existing messages, citations, attachments, titles, timestamps, and durable runs are not rewritten. The main chat list still contains all chats.

## Storage and release

Migration `0017_topic_projects.sql` adds `projects` and `project_conversations`, plus a unique conversation/account index. Existing conversations remain ungrouped. Composite foreign keys enforce that each membership belongs to both the conversation's and project's account. Reads and mutations also require authenticated account scope. New conversation and membership creation share one transaction. Direct anonymous/authenticated database-role access is revoked and RLS enabled, matching the server-only storage pattern.

Apply the migration through the existing explicit migration runner before releasing the application. No production database was migrated by this task. The migration creates an index on conversations inside the runner's transaction; an operator should schedule the normal migration window for the table lock. It does not delete or rewrite existing data. Application rollback can leave these additive tables in place.

## Review integration

Implemented from `cb3dec9` on `codex/topic-projects`. The separate Paper redesign worktree was inspected at `50af035` and left untouched. Integration overlaps are small: sidebar project link/move action, Composer's optional project ID, and conversation header project links. Project pages and styles are separate. Reconcile those additions when combining the redesign, then rerun UI checks.

## Validation

All tests use temporary local PostgreSQL data, never real user conversations. Repository integration tests cover account isolation, database foreign-key rejection, atomic creation rollback, moving between projects and ungrouping, message/conversation preservation, and applying the migration to a populated schema. Browser tests cover desktop/mobile creation, rename, membership removal, project chat creation, reload, ownership rejection, validation, failed requests and retry input preservation.

Browser agent calls use fixtures/offline responses. Live Hermes generation and physical iPhone verification are not release evidence from this task. The chat streaming/cancellation implementation is unchanged.

### Review fixes

The existing `POST /api/conversations` empty-body contract is preserved; malformed nonempty JSON is rejected. Ordinary ungrouped conversations retain the original direct insertion path. Only project-bound creation opens a transaction. Membership and project-detail forms are keyed by their conversation/project IDs and ignore delayed completions after unmount. New form controls wait for hydration. Successfully handed-off project prompts explicitly clear their stored draft; failed creation preserves it.

### Check results

- `pnpm check`: zero errors/warnings.
- `pnpm exec vitest run`: 585 passed, 54 skipped (database-dependent suites are opt-in).
- Explicit local-Postgres run of `projects.integration.test.ts`, `conversations-create.test.ts`, and `api/conversations/projects.test.ts`: 8 passed, including 3 real database tests.
- `pnpm build`: passed, with existing optional dependency packaging warnings.
- `pnpm exec playwright test tests/e2e/topic-projects.spec.ts`: five scenarios covering desktop/mobile workflows, current `/api/chat/runs` SSE snapshot contract and persisted fixture answer reload, account isolation/API validation, failure/retry, and stale-route guards. Repeated stability run passed 10/10 before the final draft-clearing assertion was added.
- Wider `app.spec.ts`: 12 passed; three failed. All three failures were independently reproduced on an untouched `cb3dec9` archive: plan timeline, jump-to-latest during streaming, and four answer-format actions. Those tests mock retired `/api/chat/stream`; current code uses `/api/chat/runs`. They are baseline failures, not passed checks. No production rate limit was changed; a combined-run login limit was avoided by rerunning feature checks in their own server process.

Project browser screenshots are in `output/playwright/projects-desktop.png` and `output/playwright/projects-mobile.png` (local ignored artifacts). Live Hermes execution, deployment, production migration, and physical-device checks were not performed.
