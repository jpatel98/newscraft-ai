CREATE TABLE IF NOT EXISTS story_claims (
	id text PRIMARY KEY,
	conversation_id text NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
	claim text NOT NULL,
	status text NOT NULL,
	attributed_to text NOT NULL DEFAULT '',
	citation_numbers jsonb NOT NULL DEFAULT '[]'::jsonb,
	publication_date text NOT NULL DEFAULT '',
	needs_check boolean NOT NULL DEFAULT false,
	first_seen_message_id text,
	last_updated_message_id text,
	superseded_by text,
	created_at bigint NOT NULL,
	updated_at bigint NOT NULL,
	CONSTRAINT story_claims_claim_length CHECK (char_length(claim) <= 240),
	CONSTRAINT story_claims_status_check CHECK (status IN ('confirmed', 'alleged', 'reported', 'unverified', 'retracted')),
	CONSTRAINT story_claims_citation_numbers_array CHECK (jsonb_typeof(citation_numbers) = 'array')
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS story_claims_conversation_updated_idx ON story_claims (conversation_id, updated_at);
--> statement-breakpoint
-- Ledger rows are server-owned (the browser reads them through the owner-checked
-- API). RLS stays enabled with no policies, like every other public table. The
-- newscraft_app runtime role already receives CRUD on new tables through the
-- default privileges set in infra/newscraft-postgres/init/01-roles.sh.
ALTER TABLE story_claims ENABLE ROW LEVEL SECURITY;
