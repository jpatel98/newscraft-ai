# NewsCraft AI: The Agentic Newsroom

Plan date: 2026-05-23
Owner: Jigar
Status: Proposed direction

## Thesis

NewsCraft AI is not a project-management tool for journalism. It is a **newsroom of agents** that a single human editor runs. The agents are modeled after real newsroom roles — monitor, research, verification, drafting, copy, packaging — and they work continuously against beats. The human's job is to **direct, approve, and ship**, not to fill in a Trello board.

The product loop is:

> **Agents notice → propose → execute → present → human approves → ship.**

Everything below serves that loop. Anything that doesn't is out of scope.

## What this is NOT

To stay honest about the differentiation:

- **Not a CMS-lite.** No story columns to drag, no Kanban, no calendar grid. If the human is moving cards, we've built the wrong thing.
- **Not a chat wrapper.** Chat is one input channel into the agents, not the product.
- **Not a scheduled-prompt runner.** Cron + RSS + a markdown dump is what NewsCraft is today; it is the floor, not the ceiling.
- **Not autonomous publishing.** Every externally-facing artifact passes a human gate. Always.
- **Not a project tracker.** Stories exist only as scopes for agent work; they are not the unit the user manipulates.

## The mental model for the editor

The editor opens NewsCraft and sees three things, in this order of priority:

1. **The Pitch Queue** — proposals from the Beat Monitor agents. Each pitch has a confidence, a why-now, a source set, a suggested angle, and a "spawn workspace" button. This is the first thing the editor reads in the morning. It is the new front door.
2. **Active Story Workspaces** — one per accepted pitch. Inside each: the live agent team, the fact ledger, the draft canvas, the editor command bar.
3. **The Wire** — a continuous stream of agent activity across all beats (what's being fetched, verified, flagged), in the style of a newsroom slack channel. Always visible, low-noise.

There is no "missions tab." Missions become **Standing Briefs** that configure the Beat Monitors. The user doesn't manage missions; the user configures beats.

## Architecture

### Sources & scraping (the bloodstream)

Beats are not defined by what RSS feeds exist. They are defined by **what the editor wants to watch**, and the system figures out how to watch it. Three layered modes:

**Mode 1 — Source Adapters (typed, known good).** Plug-ins for sources we understand. Each adapter exposes a uniform interface — `discover() → fetch() → extract() → diff()` — and produces normalized `SourceItem`s with the same provenance shape (URL, content hash, fetched-at, snapshot, extracted text, structured metadata) regardless of where it came from.

Initial adapter set, in rough priority order:

| Adapter | Use case |
|---|---|
| `rss` / `atom` | Wires, feeds we have URLs for |
| `sitemap` | XML sitemap polling, follow `<lastmod>` for new articles |
| `html_index` | A homepage/section page listing articles; pattern-match link discovery |
| `html_article` | Single-article fetch + Readability-style extraction |
| `web_search` | Google News / Bing / OpenAI web_search for query-driven discovery |
| `pr_wire` | PR Newswire, Business Wire, GlobeNewswire (HTML index + structured extract) |
| `api_x` / `api_bluesky` / `api_mastodon` | Social posts from beat reporters / official accounts |
| `api_reddit` | Subreddit watching + Reddit search |
| `pdf` | Fetch + text extract for press releases / filings delivered as PDF |
| `sec_edgar` | SEC filings by company/CIK (markets beat) |
| `email_imap` | Read-only mailbox for press-release subscriptions (later phase) |

Adapters are the **only** thing in the system that knows how to talk to an external surface. Every agent fetch goes through one.

**Mode 2 — Crawl Plans (agent-authored, editor-approved).** When no adapter fits, agents author a **Crawl Plan**: a structured config the system can run repeatedly against any site. Plans are *proposed by the Monitor, gated by the editor, then executed.* The editor never writes XPath.

A plan contains:
- Seed URL(s)
- Link-follow rules — regex *or* a natural-language condition ("follow links to articles published in the last 24h on this section")
- Article-body strategy — `auto` (Readability + JSON-LD), `selector` (CSS path the agent picked), or `agent-extract` (LLM summarization as last resort)
- Polling cadence + jitter
- Change-detection mode — hash, structured diff, or semantic similarity
- Polite-fetch overrides

Authoring loop: editor says *"watch this site for transit announcements"* → Monitor fetches the page, inspects structure (JSON-LD, headings, repeating link patterns), drafts a Crawl Plan, opens it as a **Crawl Plan gate** → editor previews the candidate links the plan would surface, approves or edits → plan joins the beat. Editing a plan later goes through the same gate.

Crawl Plans are stored as JSON in beat memory and are human-readable. Versioned; old versions kept in story memory if they ever produced a fact still in a draft.

**Mode 3 — Ad-hoc scrapes (editor command).** Editor pastes a URL in the command bar: *"read this and add anything relevant to claim 3"* or just a bare URL. One-shot fetch through the right adapter (or `html_article` fallback), extract, ledger update. No plan, no schedule. The result lands in the event log with full provenance just like any other fetch.

**Polite-fetch primitives (shared by all three modes).** Implemented once, used everywhere:
- `robots.txt` respected by default; per-source override only when the editor explicitly opts in
- ETag / If-Modified-Since for cheap re-polls
- Per-host rate limit with jitter
- Per-host content-addressable cache (extends what `tools/sources.ts` already hashes)
- User-agent identifies NewsCraft with a contact URL
- Backoff on 429 / 503
- web.archive.org snapshot on first fetch of any URL touched by a draft
- Failure budgets: a flaky source surfaces as a **Source health gate**, not silent rot

**Article extraction pipeline.** Cascading, fastest-wins:
1. **Structured-data fast path** — JSON-LD `NewsArticle`, OpenGraph, Twitter Cards, schema.org microdata
2. **Readability-style boilerplate removal** — for sites without good metadata
3. **PDF text extraction** — for press releases / filings
4. **Agent-driven summary** — current behavior, kept as last resort

**Change detection.** Different events for different changes — agents react accordingly:
- `source.hash_changed` — anything at all changed
- `source.links_added` — index page surfaced new links
- `source.body_substantive_change` — semantic similarity below threshold (typo edits don't fire this)
- `source.removed` — 404 or content vanished (Verification cares; auto-cite the archive)

**The point:** agents decide *what to watch*; the source layer decides *how to watch it*. The editor says *"watch transit, watch council, watch this one Bluesky reporter, read this PDF I just got"* — never writes a scraper.

### Agents (named, role-bound, long-lived)

Each agent is a typed process with a clear contract. None of them are autonomous — every external action crosses a gate.

| Agent | Lifetime | Scope | Produces | Consumes |
|---|---|---|---|---|
| **Beat Monitor** | Persistent (one per beat) | A beat (e.g. politics, markets, local) | Pitches, hot-list updates, **Crawl Plan proposals**, **Source health flags** | **Adapters + Crawl Plans + ad-hoc fetches**, beat memory, peer-coverage signals |
| **Assignment Desk** | Persistent (one global) | All pitches | Triage decisions, workspace spawn | Pitch queue + editor preferences |
| **Research** | Per workspace | One story | Fact ledger entries (claims + sources) | Source fetches, archives |
| **Verification** | Per workspace | One story | Verified/disputed/needs-more flags | Research output + cross-source checks |
| **Drafting** | Per workspace, per format | One story, one format variant | Drafts with inline citations | Verified fact ledger only |
| **Copy** | Per workspace | One story | Style/legal/sensitivity findings | Drafts + house style memory |
| **Packager** | Per workspace | One story | Headlines, social, push, broadcast variants | Approved draft |

Two rules every agent obeys:

1. **Cite or stay silent.** No draft sentence appears without a backing claim in the fact ledger. No claim in the ledger appears without a fetched, hashed source.
2. **Surface, don't decide.** Confidence scores and unresolved conflicts are shown to the editor, not papered over.

### Memory (three tiers, all explicit)

| Tier | Scope | Contents | Persistence |
|---|---|---|---|
| **House** | Global | Style guide, banned phrases, libel patterns, person/place gazetteer, model preferences, beat list | App DB, slowly changing |
| **Beat** | Per beat | What we've covered, our angle, source quality history, peer-coverage tracker, editor's spike/accept patterns | Harness DB, append-only log + rolling summary |
| **Story** | Per workspace | Fact ledger, draft history, agent event log, editor decisions on this story | Harness DB, full audit trail |

Memory is **inspectable**. The editor can read any tier. The editor can edit House memory directly (style guide is just a markdown file). Beat and Story memory are append-only, with periodic agent-written summaries.

### The Event Log (the actual coordination primitive)

Inter-agent coordination is not RPC. It is a **per-story append-only event log** that all agents in that workspace subscribe to.

```
event {
  workspace_id,
  agent,                  // beat_monitor | research | verification | drafting | copy | packager | editor
  kind,                   // claim.proposed | claim.verified | claim.disputed | draft.produced | gate.required | …
  payload,                // structured per kind
  sources[],              // source IDs grounding this event
  parent_event_id,        // for threading
  created_at,
  cost_tokens,            // for budget tracking
}
```

This log is:

- **The audit trail** newsrooms need (who/what/when/with-what-sources).
- **The live activity feed** rendered to the editor.
- **The coordination bus** — Verification reacts to `claim.proposed`; Drafting reacts to `claim.verified`; Copy reacts to `draft.produced`.
- **The replay log** — if an agent crashes, it resumes from the last event.

### Gates (the editorial spine)

A gate is a checkpoint where an agent produces output but cannot proceed until a human acts. Gates are first-class objects, queued and resolvable from anywhere in the UI.

| Gate | Triggered by | Resolves to |
|---|---|---|
| **Pitch** | Beat Monitor proposes a story | Accept (spawn workspace) / Hold / Spike |
| **Verification needed** | Verification flags a disputed/single-sourced claim | Mark Verified / Mark Disputed / Request more research |
| **Draft review** | Drafting completes a format | Approve / Return with notes / Spike |
| **Legal/style review** | Copy finds high-risk language | Approve / Edit / Block |
| **Publish** | Packager finishes a publish-ready package | Approve / Hold / Send to CMS |

Gates are the user's primary interaction. The entire product is "resolve the next gate."

### The Editor Command Bar

A single natural-language input, always available, that routes to the right agent based on what the editor is looking at:

- In a draft: *"tighten the lede"* → Drafting.
- On a claim: *"find a counter-source"* → Research.
- Anywhere: *"why did you spike the Reuters tariff pitch?"* → Assignment Desk replies from beat memory.
- On a beat: *"raise the threshold for politics for the next 2 hours, I'm in a meeting"* → Beat Monitor adjusts.

This is not a chatbot. It is a command surface that explicitly names which agent it routed to and shows its action in the event log.

## What we keep from today's codebase

The bones are good. Specifically:

- **`services/newsroom-harness/`** — already has roles (`assignment_desk | research | verification | production | monitoring | assistant`), tool budgets, source fetching with provenance/hashing, scheduler, run lifecycle. This is the substrate the new agents run on.
- **`services/newsroom-harness/src/tools/sources.ts`** — already does URL fetch + RSS/Atom detection + lightweight HTML extract + content hashing. This becomes the seed for the first two adapters (`rss`/`atom` and `html_article`) and the polite-fetch baseline. It grows into the Adapter framework rather than being replaced.
- **`packages/shared/`** — DTOs and SSE framing for streaming agent activity to the UI.
- **`src/lib/server/db/missions*`** — repurpose `missions` as Standing Briefs (Beat config); repurpose `mission_runs` as the agent event log seed.
- **Inline source chips, partial-response resume, streaming SSE** — the rendering primitives for the Wire and the Workspace live activity panel are already there.

What we leave behind:

- **The `/missions` page as the product front door.** It becomes a settings surface for Standing Briefs / Beat configuration.
- **The regex-based role chooser in `roles.ts`.** Replaced by an explicit assignment-desk agent.
- **The Hermes-named API surface.** Already in flight per existing migration notes; this plan accelerates it.

## Phased plan

Each phase ends in a shippable, demoable state. No phase requires the next to be valuable.

### Phase 0 — Foundations (1–2 weeks)

Goal: have the substrate the agentic layer needs.

- [ ] Close AUDIT.md P0 (auth / `accounts.role`). Required because gates and roles assume real identity.
- [ ] Per-story append-only event log in the harness DB. Schema, write API, subscribe API.
- [ ] Three memory stores (`house`, `beat`, `story`) with read/write helpers and inspect endpoints.
- [ ] Gate primitive: table, queue API, resolve API, UI primitive for "Open Gate" cards.
- [ ] **Source Adapter interface** + first four implementations: `rss`, `atom`, `sitemap`, `html_article`. Polite-fetch wrapper (robots, rate limit + jitter, ETag, content cache, archive snapshot).
- [ ] **Crawl Plan schema** + executor. Plans persist in beat memory; one execution = one fetch pass = one batch of source events.
- [ ] Replace `roles.ts` regex chooser with an explicit Assignment Desk stub that just emits events (to validate the substrate).

**Demo:** open a story workspace, see a placeholder gate, resolve it, see the event written to the log and visible in a live feed.

### Phase 1 — One beat, end to end (2–3 weeks)

Goal: one beat with one Monitor + one Drafting agent produces real pitches and real drafts. No team yet.

- [ ] Beat Monitor agent: persistent process, configured by a Standing Brief. Reads sources via the Adapter layer + any Crawl Plans assigned to the beat. Maintains rolling working memory. Emits **Pitches** as gates (not reports).
- [ ] Beat Monitor can **propose a Crawl Plan** as a gate when the editor names a site that has no adapter. Editor sees a preview of the candidate links the plan would surface, then approves / edits / rejects.
- [ ] Pitch Queue UI: the new front door. Confidence, why-now, source list, "Spawn Workspace" button.
- [ ] Story Workspace UI: split view — fact ledger (left), draft canvas (right), event Wire (bottom).
- [ ] Drafting agent (one format: 300-word web story) that drafts only from the fact ledger.
- [ ] Inline citation markers `[3]` clickable to source (with archive-snapshot fallback link).
- [ ] Editor command bar (v1: routes to Monitor / Drafting), with **ad-hoc scrape** support — paste a URL or `read this: <url>` triggers a one-shot fetch + extract via the right adapter (or `html_article` fallback).
- [ ] Article extraction: JSON-LD / OpenGraph fast path + Readability boilerplate removal.

**Demo:** point at a real RSS beat, walk in the next morning, accept a pitch, watch a draft assemble with citations, approve.

### Phase 2 — The team forms (3–4 weeks)

Goal: split Research and Verification into separate agents that talk through the event log. Add Copy.

- [ ] Research agent: owns fact ledger growth. Listens to editor commands like "find a counter-source on claim 3." Can request an ad-hoc scrape of any URL.
- [ ] Verification agent: subscribes to `claim.proposed`, cross-checks, emits `claim.verified | claim.disputed | claim.needs_more`. Two-source rule, conflict detection.
- [ ] Copy agent: house style guide as a markdown file in House memory. Lint pass on draft produces a Legal/Style gate when risk is high.
- [ ] Citation graph view per claim: hover shows all sources, contradictions highlighted.
- [ ] **Adapter expansion:** `web_search`, `pr_wire`, `pdf`, and one social adapter (`api_x` or `api_bluesky` — whichever the editor uses).
- [ ] **Source health gates:** flaky source surfaces as a gate ("Council site has returned 503 for 6h — pause, retry, or drop?").

**Demo:** a single disputed claim flows from Research → Verification → flagged on the draft → editor resolves → draft updates.

### Phase 3 — Packaging & delivery (2–3 weeks)

Goal: an approved draft becomes everything a newsroom needs to ship.

- [ ] Packager agent: produces from one approved draft — brief (60w), web (300w), feature (800w), broadcast script, social pack (X/Bluesky/LinkedIn), push (≤120 chars), newsletter blurb.
- [ ] Headline pack: 5 headlines, 1 SEO, 1 social, with rationale.
- [ ] Delivery channels: email digest, generic webhook, Slack. CMS push (WordPress REST as the first integration).
- [ ] Publish gate: the final human checkpoint before anything leaves the building.

**Demo:** approve a draft, hit Package, get every format ready to ship, send to webhook.

### Phase 4 — The learning loop (ongoing)

Goal: editor decisions train the agents over time, without ML infra.

- [ ] Structured logging of every gate decision (spike reason, return notes, approve).
- [ ] Beat Monitor reads beat memory's recent decisions to adjust pitch thresholds and angle preferences.
- [ ] Assignment Desk drafts a weekly "what I learned about your taste" summary the editor can edit.
- [ ] Per-account / per-beat cost caps and a Budget gate when exceeded.
- [ ] Provenance manifest per published artifact (model, prompt, sources, gates resolved) — toward C2PA.

**Demo:** spike five politics pitches in a row, watch the threshold rise; approve a feature angle, watch it surface again next week.

## Out of scope (for now, on purpose)

- Multi-tenant SaaS for many newsrooms. Single-newsroom deployment first.
- Reporter accounts as distinct from editor (one human role for v1; multi-role after Phase 3).
- Mobile/field input. Desktop editor surface is enough to prove the loop.
- Voice/audio/video pipelines. Text only.
- Real-time collaboration between multiple humans. Single editor at a time.
- Localization/translation as an agent. Can be a Packager output later.

## Open questions (decide before Phase 1)

1. **Beat scope:** which beat does the editor actually want to run first? It does not need to have an RSS feed — the Adapter + Crawl Plan stack means any mix of homepages, social accounts, PR wires, or PDFs becomes a beat. Pick the one the editor will read every morning anyway. The configurator emerges from doing this twice.
2. **Standing Brief format:** YAML, form, or natural language? Recommendation: natural language brief that an LLM compiles into a structured config + an initial set of seed URLs / adapter assignments / proposed Crawl Plans, which the editor reviews as a gate.
3. **Pitch threshold:** how does the Monitor decide a story is worth pitching vs. just noting? Start with a heuristic (N independent sources + recency + beat keywords), let the learning loop adjust later.
4. **Where does the fact ledger live visually:** inside the draft (footnotes) or alongside it (sidebar)? Recommendation: sidebar with hover-to-highlight in draft; collapse on small screens.
5. **Approval modality:** modal dialogs, inline accept/reject buttons, or a dedicated Gates page? Recommendation: inline on the artifact, with a Gates page as the cross-workspace overview.
6. **Model strategy:** one model for all agents, or different models per role? Recommendation: cheap model for Monitor and Copy, strong model for Research/Verification/Drafting, configurable in House memory.

## Why this is defensible

If we ship this loop well, the product is not "a Trello board with AI" or "a chat with sources." It is:

- **A newsroom you run as one person.** That is a category, not a feature list.
- **Editorially honest.** Every claim cites a fetched source; every artifact crosses a human gate; every action is in the log.
- **Composable.** Beat Monitors, House style, and Packager outputs are all configurable text. A new newsroom configures itself in an hour, not a month.
- **Aligned with where journalism is going.** Provenance manifests, claim-level citations, and human-in-the-loop are increasingly required, not optional.

The competitive answer to "but ChatGPT can write a news brief" is: *yes, and it can't run a beat for six months, remember what you've spiked, cite back to a hashed snapshot of a press release, and route a libel-risk sentence to your legal queue. We do all of that.*

## Next action

Pick the first beat and decide between the two starting points:

- **Start at Phase 0 cleanly** — build the substrate first, then layer agents.
- **Vertical slice** — build a hardcoded Beat Monitor + Drafting agent end-to-end against one RSS source, then refactor into the substrate once the loop is proven.

Recommendation: **vertical slice**, because the substrate decisions get sharper after one real loop runs against real sources.
