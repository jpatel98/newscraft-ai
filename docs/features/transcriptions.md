# Transcriptions

A library of saved transcripts, opened from **Transcriptions** in the sidebar.

- **In:** upload audio or video (up to 1 GB), record in the browser, or paste a
  link (a direct media URL or a YouTube-style page). Optional names and terms are
  sent as keyterms so the engine spells them right (ElevenLabs bills keyterms at
  +20%).
- **Out:** speaker turns with word timings, click-to-seek, speaker names, inline
  corrections, search, copy as quote, TXT/SRT export and "Use in chat", which puts
  the transcript in the new-chat composer (cut at 60,000 characters).

## How it runs

```text
Browser --PUT--> storage gateway (newsroom-audio bucket, signed upload)
Browser --POST /api/transcriptions/:id/process--> SvelteKit (Vercel)
SvelteKit --source_url=signed download--> ElevenLabs speech-to-text (scribe_v2)
SvelteKit --> Postgres transcripts row (utterances jsonb)
Player --GET /api/transcriptions/:id/audio--> 302 to a fresh signed link (byte ranges)
```

The Python worker is not involved. A run is synchronous inside the 300-second
function limit (the engine call is cut at 270 s). A row left in `processing` for
10 minutes can be claimed again, and the transcript page retries a run that never
started.

The engine sits behind `TranscriptionEngine` in
`src/lib/server/transcripts/engine.ts`; swapping provider is that one file.

## Switching it on

1. Apply migration `0024_transcripts` before the app deploy that includes it.
2. Redeploy the storage gateway (`infra/newscraft-storage`) so the
   `newsroom-audio` bucket and byte-range downloads exist.
3. Set `ELEVENLABS_API_KEY` in Vercel. Without it the page shows that
   transcription is off and nothing is sent anywhere.

Rollback: `drizzle/rollback/0024_transcripts.down.sql`. Audio files stay on the
gateway disk under `newsroom-audio/` until removed by hand.

## Attaching tape to a chat (migration 0025)

A transcript can be attached to a conversation as a source. Attaching copies
nothing; on every later turn the chat seeds one citation per speaker turn,
`transcript://<id>#t=<startMs>,<endMs>`, with the turn's verbatim words as the
excerpt (`src/lib/server/transcripts/context.ts`, then
`transcriptCitationContext` in `src/lib/server/agent/transport.ts`). The worker
treats those citations as private tape: never fetched, only quoted
(`services/agent/src/newscraft_agent/tape.py`). In a SOTVO turn the worker
computes clip candidates from the turns and checks that every quoted SOT is
word-for-word from one turn, repairing the script once if it is not.

- `GET /api/conversations/[id]/transcripts` → attached transcripts.
- `POST /api/conversations/[id]/transcripts { transcriptId }` → attach (202 while
  transcription is still running; the tape is seeded once it completes).
- `DELETE /api/conversations/[id]/transcripts/[transcriptId]` → detach.

Budget: at most 100 turns and 90,000 characters of tape per run across all
attached transcripts, oldest attachment first; the tail is dropped and logged as
`chat.transcript_context_truncated`. Consecutive fragments by one speaker are
merged into a turn (gap under 1.5 s, turn under 20 s and 400 characters) before
the count, so a 20-minute interview is usually 40 to 80 turns. The worker caps
seeded citations at 100 numbers in total (documents and prior sources included),
so a long interview is better attached alone.

Rollback: `drizzle/rollback/0025_conversation_transcripts.down.sql`.

Not yet built (see `docs/source-first-plan-2026-10-24.md`, phase 1): dropping
audio into the composer, the attach button on the chat, and playing a
`transcript://` citation at its offset from `EvidencePreview`.
