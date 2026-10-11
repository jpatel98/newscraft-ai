# NewsCraft producer end-to-end review — 2026-10-10

**Who/what:** one simulated shift by a Toronto 6pm TV news producer, driven through the
real UI in a browser. Local app on `127.0.0.1:3001` (`.claude/launch.json` → `local`)
against the Contabo production database, owned worker on `:8000`, DeepSeek Flash, Exa
fast path (`main` at `898e578`). Test account `jigar-test@newscraft.test`. Six threads,
nine model turns, one "Use answer" action, plus settings, projects, search, export and
mobile checks. No code changed. Spend stayed under the local $0.50/run cap on every run.

**Headline:** the writing layer is already better than ChatGPT for newsroom work. The
research layer underneath it is currently a single Exa search of the raw prompt, and
that one design choice causes most of what went wrong. Fix the research loop, two UI
bugs, and the failure mode, and this becomes a product a producer would open every
morning. Leave them, and the producer learns within two days that it cannot be trusted
on the second question of any thread.

---

## 1. The shift, step by step

| # | What a producer did | What happened | Verdict |
|---|---|---|---|
| 1 | Morning scan: "what should I consider for tonight's 6pm, skip Ontario Line + TTC vote, flag what could move" | ~35 s. Five items, all police/SIU stories, all dated **Oct 9**, one sourced from `the1news.com` (an aggregator) and called "today's strongest story". Honest timestamp caveats. Only **one** search, query = my whole prompt verbatim, 6 results. No weather, no Thanksgiving long-weekend angle, no council/province/economy beats. | **Weak.** Reads like the top of one search page, not a rundown scan. |
| 2 | "Go with the soldier story. Full timeline, confirmed vs alleged, charges per accused, court status. Primary sources only (TPS, DND, CBC, CP24, Star, Global), no aggregators." | ~55 s. Excellent structure: dated timeline, DND-confirmed vs TPS-stated vs court-document-alleged, per-accused charge lists, admitted no court dates. But again **one** search with the raw prompt; never visited tps.ca or canada.ca; still used the1news.com (flagged); offered to "pull the Ontario court docket", which it cannot do. | **Good copy, shallow research.** |
| 3 | "It's 11am. Who can we get on camera, what visuals, 3 must-confirms, is anyone else on this, is any version ours alone?" | ~45 s. The pre-search for that prompt returned five **corporate video-shoot checklist** pages. The model then said it "can't answer any of this from what's in front of me" and asked me to "re-supply" the earlier soldier-story sources. Five junk citations rendered as evidence. | **Fail.** Deadline-killer. |
| 4 | "No new research needed. 15 s anchor intro + 40 s VO/SOT from the timeline above. Keep every alleged/accused." | ~40 s. Searched anyway (ignored "no new research"). Script built only from *this turn's* 2 sources, so it **dropped the third soldier**, which is the actual news hook, and led with the Aug 11 arrests. Citation markers embedded inside broadcast copy. Nice touches: "D-N-D", word counts, timing note. | **Fail on news judgment**, good on craft. |
| 5 | Use answer → Interview questions | ~40 s. Strong: questions grouped by DND / TPS / defence / analyst, publication-ban warning, "realistic gets today" note. But repeats "third accused not established by DND" (it was, two turns earlier). Artifact also posted as a thread message (duplicate). | **Good.** |
| 6 | New chat: "anything new for the OTT show this week?" (clarification trap) | My text was **spliced into the middle of the previous thread's prompt** by a composer-draft bug (see §3). Model noticed "text corruption", answered the old question, and asked about OTT at the end. | **UI bug** masked the trap test; the clarification instinct itself was fine. |
| 7 | New chat: "How are CBC, the Star and Global covering the CPSO safer-supply proposal differently? Who's quoted, who's missing the patient voice?" | ~50 s. App classified it as **no research needed** (regex: starts with "How are"). Model refused, and leaked internals: "this turn is set as no-research", "the requested outlets in context list CBC and Global" (it lost "Toronto Star"). Zero citations. | **Fail.** This is a ROADMAP starter use case. |
| 8 | New chat: "Build me a producer brief as a markdown file on the CPSO proposal; check the CPSO site and two outlets." | Routed to the full agent loop: visible plan, real queries, found `cpso.on.ca` primary page. Ran **~4 minutes, 12 actions, then failed**: "The cumulative input-token reservation budget was reached." No partial answer, no explanation in the UI beyond "Reply failed / Retry". Plan step 1 showed "running 0/5" the entire time. Thread layout collapsed to a 50 px column until reload. | **Fail.** Four minutes of a producer's morning for nothing. |
| 9 | Settings / Projects / Search / Export / Mobile | Settings has timezone, home market, preferred domains (market and domains empty on this account, and per code they never reach the worker). Projects works but is empty. Thread search is full-text and fast. Markdown export is clean with ISO publication dates. Mobile layout is fine. | **OK.** |

Timing: fast-path answers took 35–60 s with nothing on screen but "Writing answer".
No token streaming exists anywhere in the stack (`portable.py` emits one
`newscraft.answer` at the end; `model_adapters.py` does not stream).

---

## 2. Root causes, ranked by producer damage

1. **One search, raw prompt, no plan** (`services/hermes-chat/src/hermes_chat/portable.py:302-425`).
   Every ordinary turn: `exa_pages(query=request[:300], results=6)` → one model call with
   `tools=[]` and "use only the numbered sources below". The model cannot choose a query,
   cannot search twice, cannot visit a named primary source. A conversational follow-up
   ("who can we book", "write the intro") becomes a literal web query. This is the cause
   of rows 1, 3, 4 and the aggregator problem.
2. **Per-turn evidence amnesia.** The fast-path prompt restricts the model to this turn's
   pages. Facts established two turns ago (the third soldier, DND confirmation) vanish from
   scripts and briefs. Citation numbers also restart per message, so "[4]" means different
   things in adjacent answers.
3. **Regex research classifier** (`src/lib/server/conversation-context.ts:690`).
   "How are X, Y and Z covering…" → no research. "No new research needed… write the intro"
   → research anyway (the "don't … research" pattern didn't match my phrasing). "Copy with
   citations" triggers a web search for the literal sentence "Turn this answer into clean
   copy with citations." A producer cannot predict which mode they'll get.
4. **Full loop fails instead of degrading** (`budgets.py` reservations never refunded;
   `model_adapters.py:194` raises on `max_tokens`). After 12 steps the cumulative input
   reservation hit the cap and the run died with no partial brief. The "write the answer
   now" nudge only watches steps and seconds, not the token budget. Separately, any answer
   longer than `max_output_tokens` (2048 locally, 4096 default) fails the whole run rather
   than returning what was written.
5. **Home-page composer draft never clears** (`src/lib/components/Composer.svelte:496-498`).
   `goto()` unmounts the composer before `value = ''` reaches the draft effect, and the
   explicit clear runs only `if (projectId)`. The last sent prompt sits in
   `localStorage['newscraft:composer-draft:new']`; the next click lands mid-text and the new
   question is spliced into the old one. One-line fix: clear `submittedDraftKey`
   unconditionally after a successful send.
6. **Internal context leaks into answers.** "this turn is set as no-research", "requested
   outlets in context". The UI's `currentTurn` JSON is pasted into the user message as
   "Attached context"; the model treats it as something the user can see.
7. **Newsroom profile is decorative.** `homeMarket` and `preferredDomains` are saved and
   sent as JSON text, but no worker code reads them; Exa gets no domain filter, no location.
   A Toronto producer's "what's new" query is a global query.
8. **Source trust is flat.** `sourceType` is hard-coded `news_report`; Exa page text is
   recorded as verified evidence (contradicting the product prompt's "snippets are leads").
   `the1news.com` and `ctvnews.ca` carry identical weight in the UI.
9. **Nothing moves on screen.** 35–60 s of "Writing answer". The plan tool exists but the
   fast path never uses it; the full loop's plan status was never updated by the model.

What held up well: the editorial voice; confirmed/alleged/inference separation; honest
"I don't have court dates"; refusal to claim an exclusive; publication-ban warning;
word-count and timing notes on scripts; interview questions by stakeholder; Markdown
export with publication timestamps; thread search; mobile layout; durable threads.

---

## 3. Game theory: how a producer actually behaves, and what it implies

**The producer's payoff matrix is asymmetric.** A good answer saves 10 minutes. A wrong
fact on air costs a correction, a credibility hit, maybe a job. So producers do not
average their experience; they remember the worst miss. Row 4 (dropping the third soldier
from the script) is the kind of miss that ends adoption, because the producer *knows* the
tool had the fact two messages earlier. **Implication:** consistency across a thread
matters more than peak answer quality. Evidence must accumulate per story, never reset.

**Silence beats confident junk, but only barely.** Row 3 (five video-marketing pages
cited as evidence) is worse than "I need to search again". But row 7 (refusing to compare
coverage at all) is also a loss, because ChatGPT would have just done it. The dominant
strategy for the product is: *always* attempt research when the producer's question is
about the world, *never* cite what you didn't verify, and *say what you're doing* while
you do it. The research classifier should default to "research" and only skip for
transformations the model itself recognises.

**Deadline pressure makes time-to-first-signal the real latency metric.** A producer at
11am will wait 60 s for a brief if they can see "checking cpso.on.ca… reading CBC…". They
will not wait 20 s staring at "Writing answer", and they will never wait 4 minutes for a
failure. Streaming the plan and the first paragraph buys more patience than cutting
median latency.

**Producers test the tool on things they already know.** The first week, every producer
asks about yesterday's lead story to see if the tool gets it right. Row 1 returned
day-old items as "today" and sourced the lead from an aggregator. That is the first-day
trust test, and the current path fails it. **Implication:** date discipline and source
tiering are launch blockers, not polish.

**The adversarial environment is real.** Search is gamed by aggregators (the1news.com),
press releases and SEO farms (the video-checklist pages). A raw-prompt search is the
easiest possible target. Query planning plus a domain allow/deny tier (official bodies >
wire/major outlets > local outlets > everything else) is the cheapest defence, and it is
exactly what the Settings page already pretends to offer.

**Where the competitive equilibrium sits.** ChatGPT will always have more raw capability,
faster streaming, better general knowledge and a bigger model. Competing on "research
assistant" is a losing position. NewsCraft's defensible ground is the thing ChatGPT
structurally does not do: keep a **per-story evidence ledger** with publication dates,
source tier, confirmed/alleged status and what-still-needs-confirming, and render it
into the newsroom's actual deliverables (rundown line, intro, VO/SOT, brief, questions,
booking notes) **without losing a qualifier**. That is also the only thing a tracker could
later be built on. The pitch is not "it researches", it is "it never loses the story".

---

## 4. What to build, in order

**P0 — stop the bleeding (days)**
- Clear the `new` composer draft after a successful home-page send. Also clear per-thread
  drafts on send.
- Full loop: when the token/step/time budget is near, force "write what you have" and
  return a partial answer with a visible "research cut short" note. Never fail a run on
  `max_tokens`; return the truncated text and mark it.
- Strip the internal `currentTurn` context from anything the model could quote, or tell
  it plainly that the user cannot see it.
- Make failures explain themselves in the UI ("Research budget reached after 12 steps.
  Here is what was found so far: …") instead of "Reply failed".

**P1 — a research loop a journalist would recognise (1–2 weeks)**
- Replace the raw-prompt Exa call with a tiny planning step: given the conversation,
  produce 2–5 queries, each tagged with intent (official source / wire / local outlet /
  background) and a date window. Run them in parallel. Keep the fast path's single-model
  write-up afterwards; the latency cost is one short planning call.
- Carry the **thread's recorded sources forward** into every turn's prompt (they are
  already in Postgres) and keep citation numbers stable across the thread. Add the rule:
  "prefer facts already established in this thread; search only for what is new or
  contradicted."
- Default to research for any question about the world; let the model (not a regex)
  decide "no research" for pure transformations, and show that decision in the UI.
- Wire `homeMarket` and `preferredDomains` into query generation and into Exa
  `includeDomains`/boosting. Add a built-in tier list for Canadian official sources
  (tps.ca, canada.ca, ontario.ca, toronto.ca, cpso.on.ca, siu.on.ca, metrolinx.com…).
- Source tiering in the UI: badge official / major outlet / local / aggregator, and never
  let an aggregator be the only source behind a lead.

**P2 — the thing ChatGPT does not have (2–6 weeks)**
- **Story ledger per thread**: a side panel listing each claim with status (confirmed by
  whom / alleged / unverified), publication date, source tier, and open confirmations.
  Scripts and briefs are generated *from the ledger*, so qualifiers survive rewrites.
- **Show memory**: show name, air time, market, audience, what aired this week. The
  morning scan should exclude covered stories automatically and sort by "new since your
  last show".
- **Broadcast deliverables with timing**: intro / VO / VO-SOT / reader / tease at a
  target duration, with the citation markers moved to a footer rather than inside copy.
- **Booking notes**: for each suggested voice, who they are, why, public media-relations
  channel if one exists, and "not confirmed". Already half-present in row 5.
- Stream the plan and the answer text; show "reading cpso.on.ca" while it happens.

**P3 — prove it (ongoing)**
- Log per answer: pursued / used on air / corrected. Run the 15-prompt live eval weekly
  on the fast path, and add the three failure prompts from this review (rows 3, 4, 7)
  as regression traps.

---

## 5. Evidence pointers

- Threads on the test account: `0mv379i257f737d89fce00727` (shift), `0mv37l0i69c214f1dffd80177`
  (spliced OTT prompt), `0mv37nhtgcdd0581d7643434b` (coverage comparison, no research),
  `0mv37pjc431a26cd87d4a68df` (failed Markdown brief).
- Fast path: `services/hermes-chat/src/hermes_chat/portable.py:96-139, 302-425`;
  Exa call `search_adapters.py:57-79`; classifier `src/lib/server/conversation-context.ts:690-722`;
  draft bug `src/lib/components/Composer.svelte:473-498`; budget failure
  `services/hermes-chat/src/hermes_chat/budgets.py:47-61`, `model_adapters.py:194-195`.

---

## 6. Iteration log — 2026-10-11 (branch `producer-loop`)

Built with coding subagents (Sonnet), verified in the same local stack and browser.

| Commit | Change | Verified |
|---|---|---|
| `1a4ac8b` | Worker degrades into a partial answer on step/time/token/cost budget; `max_tokens` returns truncated text; open plan steps closed; hidden-context block framed as invisible. | 601 worker tests. R6 now ends with a cited partial brief instead of "Reply failed". |
| `77a81d8` | Tri-state research routing (regex may force on, explicit "no research" forces off, otherwise planner decides); output actions never search; `aggregator` source tier with amber badge; OC/VO copy has no inline markers and a `SOURCES:` line; failed runs show a plain-language reason; home composer clears its draft; context entries marked invisible to the user. | `pnpm check` 0 errors, 724 app tests. R7 draft check passes. |
| `e571822` | Research loop v2: planner call (≤400 tokens, 12 s cap) writes 1–4 researcher queries; parallel Exa with `includeDomains`; thread sources listed first with stable numbers; new sources recorded with official/aggregator tiers; plan + search events streamed live; identity v3 (producer-first, no lectures, no closers). | 629 worker tests. Planner 1.6 s, searches done 4.2 s, answer 12.8 s in the live log. |
| `5befffd` | Rank by relevance (round-robin across queries) with tier as tie-break; drop index/search/API/obituary pages; outlet-named queries keep an empty slot when the outlet has nothing; retry empty official queries without domain limits; always one plain news query; off-market/off-topic demotion; suppress restated "Taking…" lines; answer from thread when research is off-topic; input-token estimate ~chars/4 (was ~5x too high); multi-beat rundown guidance. | 653 worker tests. |
| `25b005b` | SSE keeps `no-transform` under the auth hook; poll ceiling 500 ms + heartbeat; live label "Planning research" / "Researching" / "Writing answer"; `prestream_ms` diagnostic. | 732 app tests. "Planning research" visible within ~3 s of send. |

### Regression results after `25b005b`

| Prompt | Before | After |
|---|---|---|
| R1 rundown scan | One raw-prompt search, five day-old police items, aggregator lead | 4 planned queries (TPS releases, Ontario Newsroom, weather, "Toronto news top stories"); 8 sources from TPS, CityNews, Global, CP24; sorted into holds / could move / weak; mayoral-campaign angle; no closer. ~15 s. |
| R2 timeline | One search; still cited the aggregator | Finds CityNews, CTV, Global, National Post, CBC, CP24, canada.ca; separates DND-confirmed from police-alleged; pushes back on the "three accused / July" framing with evidence and a safe recommended framing. Gap: the newer National Post "third soldier" piece appeared only as an aggregator repost (dropped) or ranked 5th in a people-name query (outside the top 8). |
| R3 reportability | Five marketing pages, "re-supply the sources" | Realistic gets vs long shots, visuals actually available, three must-confirms with the exact conflict between CP24 and Global charge lists, who else has it. |
| R4 scripts, no research | Searched anyway, dropped the news hook, markers inside copy | No search (thread mode), ~5 s; intro ~38 words, VO ~105 words; no markers in spoken lines; `SOURCES:` line; one specific editorial note. |
| R5 coverage comparison | Classified "no research", refused, leaked routing context | Researches CPSO + each outlet; finds both CBC and Global run the same CP byline; names the quoted spokesperson; identifies the missing patient voice and the Oct 13 board peg. |
| R6 Markdown brief | Failed after 4 min, no answer | Finishes with a partial cited brief after ~4 min. Still too slow and thin: deliverable path now being changed to reuse the planned research before entering the tool loop. |
| R7 composer draft | Old prompt prefilled, new prompt spliced in | Composer empty after send. |
| Producer brief action | n/a | Carries all 8 thread citations, no new research, confirmed/alleged/not-established sections, booking read, must-confirm list. |

### Open items carried forward
- Aggregator-to-original recovery (re-query the dropped aggregator's headline) and "prefer the newest piece from the same outlet" so the newest development is not lost.
- Deliverable requests: planned research first, then a short publish loop (in progress).
- Iteration 3 (show memory, story ledger, rundown line/tease actions) per the scratch design.
- Live eval: add R1–R7 to the weekly prompt set; track pursued/used/corrected per answer.
