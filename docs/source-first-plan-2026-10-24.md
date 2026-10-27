# Source-first NewsCraft — plan (2026-10-24)

Status: proposal. Written against commit `20e84ec` after a full read of the schema, transcripts, ledger, citations and the Python worker.

## The thesis

A broadcast story is made of raw tape, documents, the wire and the station's own archive. Web search is a small share of it, and generic AI already does that part for free. The hours in a small newsroom go to logging tape, digesting long documents on deadline, rewriting one story for four outputs, and the daily grind nobody monitors.

So the product is not "research + write from a prompt". It is: **raw source material in, a script out where every line is traceable to a timecode, a page, or a URL, and nothing reaches air with an unpinned claim.** The verification layer is the brand. It is also the only honest answer to a newsroom that is hostile to AI: the script gets more defensible, not less.

Where the codebase already is (the good news):

- The ledger is real. `story_claims` + `story_claim_events` + `story_claim_variants`, with `deriveStatus` from evidence tiers, a judge for same/contradicts/different, and air buckets (check / safe / careful / hold). This is the spine; keep it.
- Citations already carry excerpts, source types, archive provenance and `documentPage`. PDF pages are seeded one-citation-per-page in `transport.ts` (`documentCitationContext`). That pattern is exactly what tape needs.
- Transcription works: ElevenLabs `scribe_v2`, diarized, word timestamps, speaker names, SRT/TXT export.
- The broadcast skill (`skills/broadcast/*.md`) is better than the research layer; the e2e review says so.

Where it falls short of the thesis (the gaps, all confirmed in code):

1. **Transcripts are an island.** `transcripts` has no FK to conversations, claims or messages, no `org_id`, and "Use in chat" pastes plain `[m:ss] Speaker: text` into the composer. After that, nothing knows a transcript existed. No `transcript://` citation type, no offset field.
2. **There is no story.** The chat is the story container. No `stories` table, no `scripts` table. Scripts live as message text or a clipboard copy that is never stored. `ledger/copy` output is not persisted.
3. **No computed time.** `WORD_BUDGET` and "2.5 wps" live in prompts. No read-time or duration field anywhere.
4. **Formats are TV-only.** OCVO/SUVO/DVE/SOTVO/intro/tease/headline/banner. No radio reader or wrap, no full PKG script.
5. **No archive as a source.** `newsroom_profiles.recently_covered` is a text blob; past claims are not searchable across chats.
6. **Nothing lands in a rundown.** `rundown_line` is a text action. No NRCS/MOS, no slugs or durations as data.
7. The research layer is one Exa search of the raw prompt, which the review identifies as the main failure cause. Source-first shrinks how often research is the only input, which is the cheapest fix available.

## Build order

Ordered by hours saved per newsroom per day, and by how checkable the output is. Each phase ships on its own.

### Phase 1 — Raw tape → traceable script (the wedge)

Goal: drop an interview, get a timecoded transcript, the three best SOTs, and a draft where every sentence links to a timecode the producer can play.

Data

- Add `org_id` to `transcripts` (roadmap rule: durable tables carry `org_id`).
- New `conversation_transcripts (conversation_id, transcript_id, attached_by, attached_at)`. A transcript can be attached to many chats; it is a source, not a message.
- Citation type for tape. `CitationRecord` (`packages/shared/src/gateway.ts`) gains `transcriptId?`, `startMs?`, `endMs?`, `speaker?`. URL form `transcript://<id>#t=<startMs>,<endMs>`; add the scheme to `isCitationUrl`. `sourceType: "primary"` for on-record interview tape.
- `story_claims.attributed_to` is already free text; a tape-derived claim sets it to the speaker name and `source_tier = "official"` only when the speaker is the official (otherwise `local`/`other` as today). Add `source_kind: "transcript"` to `EvidenceSource` so the ledger can show a play chip instead of a host.

Worker (`services/agent`)

- Seed utterance citations the way PDF pages are seeded: one citation per speaker turn, excerpt = verbatim text, `startMs/endMs` from `utterances`. Cap by duration, not characters (today the paste is cut at 60,000 chars with no warning).
- New tool `pick_sots(transcript_id, n=3, max_seconds=12)` → `{in, out, speaker, verbatim, why}`. Verbatim is the utterance words, never a paraphrase. `sotvo.md` already asks for IN/OUT; make it read real values.
- Quote integrity: when the writer uses a SOT, the script line carries the citation and the verbatim must equal the transcript words. `checkCopy` (`src/lib/utils/ledger-copy.ts`) gets a "paraphrase marked as quote" check.

App

- Composer: accept audio/video (`transcript-media.ts` list) alongside PDF. Upload → existing transcript pipeline → auto-attach to the chat. The 270 s synchronous cutoff must become a job: reuse `agent_runs` durable-run plumbing or `agent-jobs`, poll from the composer.
- `EvidencePreview`: when the citation is `transcript://`, render speaker, timecode, verbatim, and a play button seeking the `/api/transcriptions/[id]/audio` stream to `startMs` (Range request).
- `StoryLedgerPane`: evidence chip for tape shows `▶ 02:14 Mayor Brown` instead of a host.

Done when: a 20-minute raw interview goes in and comes out as a transcript, three SOTs with IN/OUT, and a SOTVO draft in which every quoted line plays the right second of audio. Test: `eval/` fixture with a known interview; assert verbatim equality and offsets within 500 ms.

### Phase 2 — The story record (fix the ledger by giving it a parent)

The ledger feels off because claims hang off a chat, not a story. A story is sources → pinned claims → scripts by show.

- `stories (id, org_id, slug, status, created_by, created_at)`; `story_conversations`, `story_transcripts`, `story_documents` join tables; `story_claims.story_id` (nullable during migration, backfill one story per conversation).
- `scripts (id, story_id, format, show, version, text, word_count, est_seconds, claim_ids jsonb, citations_json, written_by, created_at)`. Every write action (`thirty_second_script`, `ledger/copy`, slash commands) persists a row. `est_seconds = word_count / wps` with `wps` per `newsroom_profiles` (default 2.5, matching `core.md`). Show the clock in the UI next to every draft.
- Project page becomes the story page: sources on the left, ledger in the middle, scripts by show on the right. `ProjectDetailPage.svelte` is the starting point; `projects` can be the migration path to `stories` rather than a new concept.

Done when: opening a story shows every source, every claim with its status, and every script version with its duration, and the ledger context fed to the worker comes from the story, not the chat.

### Phase 3 — Documents, page-pinned

PDF is already page-cited. Promote it from "conditional" to core and extend it:

- Raise limits that block real use (250 pages and 24,000 chars of context excludes a provincial budget). Index pages with the FTS vector already in migration 0013 and retrieve pages by query instead of injecting the whole document.
- Number conflict check: when two sources give different figures for the same quantity, open a `check_opened` event on the claim with both citations. The judge already returns `contradicts`; wire it to numbers.
- Accept DOCX and pasted press releases as documents, not messages, so a release gets a citation and a `sourceType: "official"` or `"commercial"` tag rather than being treated as the producer's own words (today pasted material is trusted as supplied).

### Phase 4 — One story, every render

Same claims, every output, edit the fact once.

- New skills: `radio-reader.md`, `radio-wrap.md` (reader + one SOT), `pkg.md` (full reporter package with SOT and NAT cues), `web.md` (web post with inline citations). Word budgets per format; the clock from Phase 2.
- "Regenerate from ledger": when a claim's status or wording changes, flag every script that cites it (`claim_ids`) as stale and offer a one-click rewrite that keeps everything else. This is the moment the ledger pays for itself.

### Phase 5 — Archive as a source

- Index past `scripts.text` and `story_claims.claim` per org (Postgres FTS, embeddings later).
- Worker tool `search_archive(query)` returning claims with their original citations and air date. Research plan runs it before any web search. Citations to archive use the existing `newsroom://` scheme.
- Replace `newsroom_profiles.recently_covered` text with the result of this query.

### Phase 6 — Land in the rundown

Do this with a pilot newsroom, not before. Day one: a copy-to-NRCS formatter per system (iNews/ENPS/Burli each want a slightly different plain-text shape: slug, format, duration, cues). MOS integration only if a paying station asks.

### Later — the assignment desk

Watch council agendas, court dockets, provincial and police release pages for the station's market and hand the morning meeting a sourced story list. This reuses the frozen Phase B adapters (rss/html/pr-wire) but as *sources into a story*, not as a feed product. Stays frozen until Phases 1–3 are used daily.

## Non-goals

- No autonomous publishing. No wire-feed product. No "AI writes the news" positioning.
- No pivot of the chat UI; the chat stays the workspace, the story becomes its container.
- No MOS/NRCS build without a pilot.

## What to measure

- Minutes from upload to first SOT list (target under 5 for a 20-minute interview).
- Share of script lines with a citation (target 100% for claims; cue lines exempt).
- Verbatim quote integrity (0 paraphrases marked as quotes in eval).
- Scripts regenerated after a ledger change vs. rewritten by hand.
- Clock accuracy: `est_seconds` vs. the producer's own read, within 10%.

## First PR

Phase 1, data and worker only, behind a flag:

1. Migration: `org_id` on `transcripts`; `conversation_transcripts`.
2. `CitationRecord` transcript fields + `transcript://` in `isCitationUrl` + tests in `packages/shared`.
3. Utterance seeding in `transport.ts` next to `documentCitationContext`.
4. `pick_sots` tool in the worker, `sotvo.md` reading real IN/OUT.
5. Eval fixture: one interview, expected SOTs, verbatim and offset assertions.

The composer upload and the audio-seeking preview are the second PR; they are UI and can be reviewed on a phone.
