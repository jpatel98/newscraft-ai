-- Transcripts become sources a chat can cite. Two changes:
--   1. transcripts.org_id so the library follows the org rule every other
--      durable table follows (nullable; backfilled from the owner's
--      organization membership, newest membership wins).
--   2. conversation_transcripts: which transcripts are attached to which
--      conversation. A transcript is a source, not a message, so one
--      transcript can back many chats and attaching never copies the audio.
-- Attached transcripts are seeded into the worker as one citation per speaker
-- turn (transcript://<id>#t=<startMs>,<endMs>), the same way PDF pages are.
ALTER TABLE transcripts ADD COLUMN IF NOT EXISTS org_id text REFERENCES organizations(id) ON DELETE SET NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS transcripts_org_created_idx ON transcripts(org_id, created_at);
--> statement-breakpoint
UPDATE transcripts t SET org_id = (
	SELECT m.org_id FROM organization_members m
	WHERE m.account_id = t.account_id
	ORDER BY m.created_at DESC LIMIT 1
) WHERE t.org_id IS NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS conversation_transcripts (
 conversation_id text NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
 transcript_id text NOT NULL REFERENCES transcripts(id) ON DELETE CASCADE,
 account_id text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
 attached_at bigint NOT NULL,
 PRIMARY KEY (conversation_id, transcript_id)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS conversation_transcripts_transcript_idx ON conversation_transcripts(transcript_id);
--> statement-breakpoint
ALTER TABLE conversation_transcripts ENABLE ROW LEVEL SECURITY;
