-- Saved transcriptions. Audio lives in the private newsroom-audio bucket under
-- audio_key; the transcript itself (speaker turns with word timings) is kept
-- here so the library, search and exports never touch the audio.
CREATE TABLE IF NOT EXISTS transcripts (
 id text PRIMARY KEY,
 account_id text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
 title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 200),
 status text NOT NULL DEFAULT 'uploading'
  CHECK (status IN ('uploading', 'queued', 'processing', 'complete', 'failed')),
 source_kind text NOT NULL CHECK (source_kind IN ('upload', 'recording', 'link')),
 source_name text,
 source_url text,
 audio_key text,
 audio_bytes bigint,
 content_type text,
 duration_ms integer,
 language_code text,
 engine text NOT NULL,
 model text NOT NULL,
 keyterms jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(keyterms) = 'array'),
 text text NOT NULL DEFAULT '',
 utterances jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(utterances) = 'array'),
 speaker_names jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(speaker_names) = 'object'),
 error_code text,
 error_message text,
 processing_started_at bigint,
 completed_at bigint,
 created_at bigint NOT NULL,
 updated_at bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS transcripts_account_created_idx ON transcripts(account_id, created_at);
--> statement-breakpoint
ALTER TABLE transcripts ENABLE ROW LEVEL SECURITY;
