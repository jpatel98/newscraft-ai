# NewsCraft AI — Source of Truth

Last updated: 2026-05-31

This is the single canonical reference for the NewsCraft AI project. It answers:
what are we building, what does it do today, what are we cutting, and what are
we building next. If this file conflicts with any other document, this file wins.

---

## The Honest Vision

NewsCraft AI is a solo news producer tool. Not a team editorial system. Not a
publishing pipeline. Not a multi-agent verification workflow. It is:

**1. A story tracker** — throw a topic, region, or story at it, and a research
agent (with sub-agents) goes and builds up what it knows over time. Web search,
social media, configured sources. You check back and see what's new.

**2. A chat agent** — general-purpose but newsroom-smart. Ask it things. Get
clean, formatted answers — a text blurb and links, not a system log. It has
access to the same research tools as the story tracker.

That is the entire product. Everything else is cut.

---

## What We Are Cutting

The following were built for a team editorial workflow. They are not needed for
a solo producer tool and are being removed:

- Gates and editor decision queues
- Verification agent
- Copy review agent
- Packaging agent (brief, web, feature, broadcast, social, push, newsletter, headline-pack)
- Delivery adapters (email digest, webhook, Slack, WordPress REST)
- Crawl plan system and UI
- Story workspace / story drafts
- Beat monitor pitching complexity
- House memory / editorial memory
- Citation graph
- Source health gates
- Source chips and source tags in the chat UI
- Duplicate source display (sources shown as tags AND in agent output)
- Publishing/CMS workflows
- All `/board`, `/channels`, `/mission-control` routes

These are not deferred — they are removed. If they are needed later for a real
multi-user newsroom product, they can be rebuilt with that product in mind.

---

## What We Are Keeping

**Harness (backend service):**
- Node HTTP service on `127.0.0.1:8650`
- Agent runtime (OpenAI Agents SDK)
- Source fetch pipeline and source adapters (RSS, Atom, HTML, Bluesky, sitemap, PDF)
- SQLite persistence + optional Postgres mirroring
- Process-local scheduler (simple is fine — no BullMQ, no Redis)
- Chat completion endpoint
- Research agent

**SvelteKit app:**
- Auth (session cookies, Argon2id passwords)
- Chat streaming infrastructure
- Supabase Postgres app DB via Drizzle
- Multi-account support
- Conversation/message persistence

**Source adapters stay backend-only.** They are never exposed in the UI. The user
sees "From BBC World Service" or a link — not adapter names, not technical fetch
metadata.

---

## Architecture

```
Browser
  |
  | SvelteKit pages
  v
SvelteKit app (3001)
  |
  +-- Supabase Postgres (accounts, conversations, messages, stories)
  |
  +-- Newsroom harness (8650)
        |
        +-- Research agent
        |     +-- Web search sub-agent (OpenAI web_search)
        |     +-- Social sub-agent (Bluesky)
        |     +-- Source monitor sub-agent (configured URLs)
        |
        +-- Chat agent
        +-- SQLite (runs, sources, reports, story evidence)
```

The harness owns model execution, source fetching, and research. The SvelteKit
app owns UI, auth, and persistence of user-facing data. The two talk through
`AGENT_GATEWAY_URL`.

---

## The Two Surfaces

### Surface 1 — Story Tracker (`/`)

The home screen. A list of stories you are tracking. Each story has:
- A topic, region, or specific subject you set
- A research status (last run, next run)
- A feed of what the agent has found — headlines, summaries, links, dates
- An on-demand "research now" button
- A scheduled background run (configurable interval)

Creating a story kicks off the research agent immediately. The agent spawns
sub-agents, collects evidence, and stores it. Results are displayed as clean
story cards — headline, 2-sentence summary, publication date (never retrieval
date), source link.

No source configuration required. Sources are optional — you can pin specific
URLs to a story, but the agent always does broad discovery regardless.

### Surface 2 — Chat (`/chat` or `/c/[id]`)

Clean conversational interface. The agent is newsroom-smart:
- Knows how to find recent stories on a topic
- Knows how to check what major outlets are covering
- Knows how to compare coverage across sources
- Knows not to report old stories as new

Response format is human: a short paragraph and links. Not a system output, not
source tags, not tool steps. If the agent searches the web, the user sees
"Searching..." not a tool trace.

Chat threads are persisted. Sidebar shows recent conversations.

---

## Step 1 Before Anything Else: Date Accuracy Fix

The agent is currently using run timestamps or retrieval timestamps when
reporting story dates, instead of article publication dates. This makes the tool
untrustworthy for a news producer.

**The fix:** In `services/newsroom-harness/src/agents/`, all source metadata
passed to the model must use `publishedAt` (or equivalent parsed from the source)
as the authoritative date. `fetchedAt`, run start time, and accessed time are
retrieval metadata only — they must never be presented to the user as a story's
publication date.

**Where to look:**
- `services/newsroom-harness/src/agents/runtime.ts`
- `services/newsroom-harness/src/tools/article-extraction.ts`
- `services/newsroom-harness/src/tools/sources.ts`
- `services/newsroom-harness/src/jobs/report.ts`
- `services/newsroom-harness/prompts/newsroom-report.md` (already has guidance; enforce at data layer too)

This fix ships before any UI work begins.

---

## Step 2: Response Formatting

The agent currently leaks technical output into responses. Fix:
- No source tag UI elements in chat (inline links only)
- No raw tool steps shown to user (just a subtle "Searching..." indicator)
- "Task completed" step count must reflect actual steps or be hidden
- When asked "latest Toronto stories" → short paragraph + links, nothing else
- No job IDs, file paths, HTTP status codes, adapter names, or harness
  internals in any user-facing output

---

## Step 3: UI Reset

Strip the SvelteKit app to the two surfaces. Remove:
- `/missions` and all mission-specific pages
- `/board`, `/channels`, `/mission-control` redirects
- Gates UI
- Crawl plan UI
- Story workspace UI
- Source configuration complexity (keep a simple URL input in story settings)
- Source chips/tags in chat messages
- Duplicate source display
- Any reference to "agent channels", "jobs", "runs" in user-facing text

Rename user-facing concepts:
- "Mission" → "Story" or "Topic"
- "Job" → hidden (harness internal)
- "Run" → hidden (harness internal)
- "Report" → "Research update" or just the content itself

---

## Step 4: Story Tracker (Build)

**Story creation:**
- Name / topic / region / keywords
- Optional: pin specific source URLs
- Schedule: hourly / every few hours / daily (default: every 4 hours)

**Research agent behavior:**
- On story creation: run immediately
- On schedule: run in background
- Sub-agents spawned per run: web search, social, source monitors
- All results normalized: title, publication date, source name, URL, snippet
- Deduplicated by URL + publication date
- Stored in harness DB under story/job scope

**Story feed display:**
- Chronological, most recent first
- Each item: headline + 2-sentence summary + publication date + source link
- "Last updated: X minutes ago" indicator
- "Research now" button

---

## Step 5: Chat Polish

- Newsroom-aware system prompt: the agent knows it is helping a news producer,
  knows to prioritize recency and accuracy, knows to flag uncertainty
- Slash commands: `/briefing` (what's the top news right now), `/search [topic]`,
  `/trending`
- No special source tags — citations are inline markdown links
- Streaming responses with a subtle activity indicator
- Thread management: rename, pin, delete (already exists, keep it)

---

## Agent Architecture

The research agent is the core. It:
1. Receives a topic/region/story description
2. Plans a search strategy
3. Spawns sub-agents in parallel:
   - **Web search sub-agent**: uses OpenAI `web_search` for broad coverage
   - **Social sub-agent**: Bluesky search for social coverage
   - **Source monitor sub-agent**: fetches configured URL watchlist items
4. Collects and normalizes all results
5. Deduplicates
6. Ranks by recency and relevance
7. Writes evidence to the story's memory
8. Generates a concise research update

Date accuracy is enforced at normalization: `publishedAt` from source metadata
is the only date that gets reported. If `publishedAt` is unavailable, the item
is flagged as "date unknown" — it is never substituted with a retrieval time.

---

## Data Model

### App DB (Supabase Postgres via Drizzle)

Keep:
- `accounts`
- `conversations`
- `messages`
- `settings`

Rename/simplify:
- `missions` → `stories` (or keep `missions` as internal name, rename in UI)
- `mission_sources` → `story_sources`

Remove or archive:
- `mission_crawl_plans`
- `agent_channel_configs`
- `agent_channel_sources`
- `agent_channel_posts` (keep only for ingest compatibility until removed)

### Harness DB (SQLite)

Keep:
- `jobs` (backing store for stories; internal name stays)
- `runs`
- `sources`
- `source_snapshots`
- `reports`
- `events` (simplified — strip gate/verification event types)

Remove:
- `gates`
- `house_memory`
- `memory_entries` (story-level memory can be simplified to report history)

---

## Environment Variables

### Keep

```sh
# App
APP_SESSION_SECRET=
DATABASE_URL=

# Harness
NEWSROOM_HARNESS_HOST=127.0.0.1
NEWSROOM_HARNESS_PORT=8650
NEWSROOM_HARNESS_DB_PATH=.data/newsroom-harness.db
NEWSROOM_HARNESS_DATABASE_URL=
NEWSROOM_HARNESS_API_KEY=
NEWSROOM_HARNESS_RUN_TIMEOUT_MS=90000
NEWSROOM_HARNESS_MAX_TOOL_CALLS=6
NEWSROOM_HARNESS_MAX_WEB_SEARCHES=3
NEWSROOM_HARNESS_SCHEDULER_INTERVAL_MS=30000

# AI
OPENAI_API_KEY=

# Gateway wiring
AGENT_GATEWAY_URL=http://127.0.0.1:8650
AGENT_GATEWAY_API_KEY=
NEWSROOM_UI_INGEST_URL=
NEWSROOM_UI_INGEST_KEY=
```

### Remove

```sh
NEWSROOM_EMAIL_DIGEST_WEBHOOK_URL=
NEWSROOM_DELIVERY_WEBHOOK_URL=
NEWSROOM_SLACK_WEBHOOK_URL=
WORDPRESS_REST_URL=
WORDPRESS_USERNAME=
WORDPRESS_APP_PASSWORD=
```

---

## What We Are Not Building Yet

These are explicitly out of scope until the two core surfaces are solid and
being used daily:

- Publishing to CMS or WordPress
- Email digests
- Slack delivery
- Multi-user roles and permissions
- Paywall handling
- Source credibility scoring
- Distributed scheduler (Redis, BullMQ)
- Real-time push notifications
- Mobile app
- API access for external tools

---

## Phases

### Phase 0 — Fix Trust (current)
Fix date accuracy bug. Fix response formatting. Nothing ships until this is done.

### Phase 1 — Strip
Delete all the complexity from the UI and harness. Remove gates, packaging,
delivery, crawl plans, story workspaces, beat monitor pitching. Leave the two
surfaces and the agent infrastructure only.

### Phase 2 — Story Tracker
Build the story tracker surface from scratch: story creation, research agent
with sub-agents, clean story card display, scheduling.

### Phase 3 — Chat Polish
Clean up the chat surface. Newsroom system prompt, slash commands, no
technical leakage, proper formatting.

### Phase 4 — Daily Use
Use it every day. Track real stories. Identify what is actually broken or
missing from daily producer workflow. Fix those things. Add nothing that is not
demanded by daily use.

---

## Success Criteria

- Ask "latest Toronto FIFA World Cup stories" → accurate publication dates,
  clean paragraph summary, source links
- Create a story to track → research agent runs, finds recent coverage,
  stores it cleanly
- Check back on a tracked story the next day → new coverage has been added
- Chat works without any technical jargon in the response
- Source information is never shown twice
- Tool steps are not raw-dumped to the user
- The UI has exactly two sections: stories and chat

---

## Repository Layout

```
newscraft-ai/
  src/                         SvelteKit web app
  services/newsroom-harness/   Agent harness service
  packages/shared/             Shared DTOs and SSE helpers
  drizzle/                     App DB migrations
  scripts/                     Utility scripts
  tests/e2e/                   Playwright smoke tests
```

## Key Files

### Chat and streaming
- `src/routes/api/chat/stream/+server.ts`
- `src/lib/server/agent/transport.ts`
- `src/lib/client/stream.ts`
- `src/lib/stores/chat.svelte.ts`
- `src/routes/c/[id]/+page.svelte`

### Auth
- `src/hooks.server.ts`
- `src/lib/server/auth/cookie.ts`
- `src/lib/server/db/accounts.ts`

### Harness agent
- `services/newsroom-harness/src/agents/runtime.ts`
- `services/newsroom-harness/src/agents/editor-command.ts`
- `services/newsroom-harness/src/tools/sources.ts`
- `services/newsroom-harness/src/tools/article-extraction.ts`
- `services/newsroom-harness/src/jobs/runner.ts`
- `services/newsroom-harness/src/db/repository.ts`
