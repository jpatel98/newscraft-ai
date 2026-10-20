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
