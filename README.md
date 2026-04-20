# NewsCraft AI

NewsCraft AI is a newsroom collaboration workspace built with Next.js 16 and the OpenAI Agents SDK. A Slack-style environment where producers chat in channels and summon specialized AI agents via slash-commands or @mentions. Agents are editable: click one in the sidebar to change its system prompt, model, or which tools it can reach for.

## What's built

- **Three agents** in the registry:
  - `Expertise Finder` — books credible experts with citations + reach-out angle.
  - `Story Scout` — scopes a story: angles, background, related coverage, interview questions.
  - `News Monitor` — manages a watchlist of sources and produces a daily digest.
- **Streaming chat** — token-level streaming from the Agents SDK, with live "searching the web…" / "inspecting…" tool pills.
- **Structured renderers** — expert shortlist card, story-brief card, daily-digest card.
- **Editable agents** — org + workspace-scoped agent config (with workspace override precedence), persisted in SQLite and applied at runtime.
- **Persistence** — threads, messages, agent runs, sources, digests all in local SQLite via Drizzle ORM.
- **Multi-tenant accounts** — organizations, org memberships, workspace memberships, invites, and tenant-scoped routing (`/o/:org/w/:workspace`).
- **Scheduled digests** — `/api/digest/run` endpoint + `node-cron` sibling script.
- **Quality gates** — schema validation, one-shot repair attempt, verifier pass, and `agent_output_audits` telemetry.

## Stack

- Next.js 16 App Router · React 19 · TypeScript 5
- Tailwind CSS 4 (v4 inline theme)
- `@openai/agents` 0.8 (TypeScript Agents SDK)
- Drizzle ORM + `better-sqlite3`
- Zod 4 for structured output validation
- Cheerio for public webpage parsing
- `node-cron` for scheduled digests
- `react-markdown` + `remark-gfm` for free-form replies

## Local setup

```bash
cp .env.example .env.local          # then edit OPENAI_API_KEY, OPENAI_MODEL, CRON_SECRET

npm install
npm run db:generate                  # only needed if schema changes
npm run db:migrate                   # applies migrations to ./data/newscraft.db
npm run db:seed                      # seeds the default workspace + agents + topic channels + local admin

npm run dev                          # http://localhost:3000
npm run evals                        # offline eval suite + quality gate
```

Optional for scheduled digests (keep running in a second terminal):

```bash
npm run cron:dev                     # loads .env.local and schedules /api/digest/run
```

## How to use

Chat happens in **channels** (`#general`, `#research`, `#news-digest`). Summon an agent with a slash-command or @mention:

```text
/expert labor economist in Canada who can react to inflation data today
/scan-site brookings.edu AI policy expert who can explain copyright fights
/scout AI copyright fights in news
/sources add https://www.nytimes.com/section/politics
/digest
@news-monitor add https://www.reuters.com/world
```

Include `site:domain.com` or paste a URL in any message to scope the run.

Click an agent in the sidebar to edit its **system prompt**, **model** (overrides `OPENAI_MODEL`), and which **tools** it can reach for. Changes take effect on the next run.

Sign-in flow:

- `GET /login` shows the standard newsroom sign-in button (general account).
- `GET /auth/special/<token>` signs in as admin via a hidden link.
- Admin is never listed in the UI; the only admin entry point is the special link token.

## Project structure

- `src/app/o/[orgSlug]/w/[workspaceSlug]/` — tenant-scoped workspace routes.
  - `layout.tsx` — loads channels + agents for a tenant workspace.
  - `page.tsx` — redirects to the first channel.
  - `channel/[slug]/page.tsx` — chat view.
  - `agent/[id]/page.tsx` — agent config editor.
- `src/app/api/chat/route.ts` — POST endpoint, streams Agents SDK events as SSE.
- `src/app/api/digest/run/route.ts` — scheduled-digest endpoint, secured by `x-cron-secret`.
- `src/app/api/admin/organizations/route.ts` — creates a new org/workspace from template.
- `src/app/api/admin/organizations/[orgId]/invites/route.ts` — creates invite links.
- `src/app/api/invites/accept/route.ts` — accepts invite + grants memberships.
- `src/components/workspace/` — shell, sidebar, agent + channel lists.
- `src/components/chat/` — message list, streaming bubble, composer, command palette.
- `src/components/agent/agent-config-editor.tsx` — editable form for per-agent settings.
- `src/components/renderers/` — `ExpertResultCard`, `ScoutBriefCard`, `DigestCard`, `Markdown`.
- `src/lib/agents/` — registry + each agent (`expertise-finder`, `story-scout`, `news-monitor`).
- `src/lib/commands.ts` — registry-driven slash-command / @mention parser.
- `src/lib/stream/` — SSE encoding + Agents SDK → wire-event mapper.
- `src/lib/hooks/use-agent-stream.ts` — client hook that consumes the SSE stream.
- `src/lib/actions/save-agent.ts` — Server Action for saving agent config.
- `src/db/` — Drizzle client, schema, queries, migrations.
- `scripts/` — `migrate.ts`, `seed.ts`, `digest-cron.ts`.
- `scripts/evals.ts` + `evals/*.jsonl` — regression metrics and release gate.

## Environment

- `OPENAI_API_KEY` — required.
- `OPENAI_MODEL` — fallback model id.
- `OPENAI_MODEL_STRONG` — default strong model for higher-stakes runs (default `gpt-5.4`).
- `OPENAI_MODEL_FAST` — default fast model for lower-risk runs (default `gpt-5.4-mini`).
- `VERIFIER_MODEL` — model used for output verification.
- `VERIFIER_MIN_SCORE` — numeric verifier cutoff (default `0.70`).
- `DATABASE_URL` — SQLite file path. Defaults to `./data/newscraft.db`.
- `CRON_SECRET` — shared secret required by `/api/digest/run`. Also passed by `scripts/digest-cron.ts`.
- `NEWSCRAFT_GENERAL_USER_EMAIL` — email for the seeded general account used by `/auth/general`. Defaults to `producer@newscraft.local`.
- `NEWSCRAFT_ADMIN_USER_EMAIL` — email for the seeded admin account used by the hidden admin link. Defaults to `admin@newscraft.local`.
- `NEWSCRAFT_ADMIN_SIGNIN_TOKEN` — token embedded in the hidden admin URL `/auth/special/<token>`. Defaults to `local-admin-link` for local development.
- `DIGEST_CRON` — cron expression for the scheduled digest (default `0 7 * * *`).
- `NEWSCRAFT_BASE_URL` — base URL the cron script hits (default `http://localhost:3000`).
- `EVALS_LIVE_VERIFY` — set `1` to run live verifier checks in `npm run evals`.
- `EVAL_MAX_REGRESSION` — allowed pass-rate drop vs baseline (default `0.03`).

## Notes

- The three agents are registered in `src/lib/agents/registry.ts`. To add a new one: write `src/lib/agents/your-agent.ts` exporting a `createYourAgent(config?)` + defaults, add an entry to `AGENT_REGISTRY`, and rerun `npm run db:seed`.
- Base agent definitions still live in the registry, but workspace-specific behavior now comes from `workspace_agent_settings`, which is the seam for future per-workspace admin controls and user accounts.
- Scheduled cron runs as a sibling script rather than inside `next dev` to avoid HMR double-firing.
