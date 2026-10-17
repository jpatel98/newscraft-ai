-- Story ledger as an append-only event log (asserted, status changed,
-- contradicted, retracted, check opened, check closed), plus every wording the
-- model has used for a claim. story_claims stays the canonical record the API
-- reads: its columns are the fold of the events. Additive only; the rollback is
-- drizzle/rollback/0022_story_claim_events.down.sql.
CREATE TABLE IF NOT EXISTS story_claim_events (
	seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
	id text NOT NULL UNIQUE,
	conversation_id text NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
	claim_id text NOT NULL REFERENCES story_claims(id) ON DELETE CASCADE,
	kind text NOT NULL,
	actor text NOT NULL,
	actor_name text NOT NULL DEFAULT '',
	message_id text,
	data jsonb NOT NULL DEFAULT '{}'::jsonb,
	created_at bigint NOT NULL,
	CONSTRAINT story_claim_events_kind_check CHECK (kind IN ('asserted', 'status_changed', 'contradicted', 'retracted', 'check_opened', 'check_closed')),
	CONSTRAINT story_claim_events_actor_check CHECK (actor IN ('model', 'person', 'system')),
	CONSTRAINT story_claim_events_data_object CHECK (jsonb_typeof(data) = 'object')
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS story_claim_events_conversation_seq_idx ON story_claim_events (conversation_id, seq);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS story_claim_events_claim_seq_idx ON story_claim_events (claim_id, seq);
--> statement-breakpoint
-- Events are never edited. A delete is allowed only as part of removing the
-- claim or the whole chat (the parent row is already gone by then).
CREATE OR REPLACE FUNCTION story_claim_events_append_only() RETURNS trigger LANGUAGE plpgsql AS $story_events$
BEGIN
	IF TG_OP = 'UPDATE' THEN
		RAISE EXCEPTION 'story_claim_events is append-only';
	END IF;
	IF EXISTS (SELECT 1 FROM story_claims WHERE id = OLD.claim_id)
		AND EXISTS (SELECT 1 FROM conversations WHERE id = OLD.conversation_id) THEN
		RAISE EXCEPTION 'story_claim_events is append-only';
	END IF;
	RETURN OLD;
END
$story_events$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS story_claim_events_append_only ON story_claim_events;
--> statement-breakpoint
CREATE TRIGGER story_claim_events_append_only BEFORE UPDATE OR DELETE ON story_claim_events
	FOR EACH ROW EXECUTE FUNCTION story_claim_events_append_only();
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS story_claim_variants (
	id text PRIMARY KEY,
	conversation_id text NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
	claim_id text NOT NULL REFERENCES story_claims(id) ON DELETE CASCADE,
	text text NOT NULL,
	message_id text,
	created_at bigint NOT NULL,
	CONSTRAINT story_claim_variants_text_length CHECK (char_length(text) <= 240),
	CONSTRAINT story_claim_variants_claim_text_unique UNIQUE (claim_id, text)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS story_claim_variants_conversation_idx ON story_claim_variants (conversation_id);
--> statement-breakpoint
ALTER TABLE story_claim_events ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE story_claim_variants ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
-- Backfill: each existing claim becomes one assertion (its stored state), an
-- open check when flagged, and the person's call when someone reviewed it.
INSERT INTO story_claim_events (id, conversation_id, claim_id, kind, actor, actor_name, message_id, data, created_at)
SELECT 'bf-a-' || c.id, c.conversation_id, c.id, 'asserted', 'model', '', c.first_seen_message_id,
	jsonb_build_object('text', c.claim, 'status', c.status, 'attributed_to', c.attributed_to,
		'citations', c.citation_numbers, 'date', c.publication_date, 'backfill', true),
	c.created_at
FROM story_claims c
WHERE NOT EXISTS (SELECT 1 FROM story_claim_events e WHERE e.id = 'bf-a-' || c.id)
ORDER BY c.created_at, c.id;
--> statement-breakpoint
INSERT INTO story_claim_events (id, conversation_id, claim_id, kind, actor, actor_name, message_id, data, created_at)
SELECT 'bf-c-' || c.id, c.conversation_id, c.id, 'check_opened', 'model', '', c.first_seen_message_id,
	jsonb_build_object('reason', 'model', 'backfill', true), c.created_at
FROM story_claims c
WHERE c.needs_check AND c.reviewed_at IS NULL
	AND NOT EXISTS (SELECT 1 FROM story_claim_events e WHERE e.id = 'bf-c-' || c.id)
ORDER BY c.created_at, c.id;
--> statement-breakpoint
INSERT INTO story_claim_events (id, conversation_id, claim_id, kind, actor, actor_name, message_id, data, created_at)
SELECT 'bf-r-' || c.id, c.conversation_id, c.id,
	CASE WHEN c.status = 'retracted' THEN 'retracted' ELSE 'status_changed' END, 'person', coalesce(c.reviewed_by, ''), NULL,
	jsonb_build_object('to', c.status, 'backfill', true), c.reviewed_at
FROM story_claims c
WHERE c.reviewed_at IS NOT NULL
	AND NOT EXISTS (SELECT 1 FROM story_claim_events e WHERE e.id = 'bf-r-' || c.id)
ORDER BY c.reviewed_at, c.id;
--> statement-breakpoint
INSERT INTO story_claim_events (id, conversation_id, claim_id, kind, actor, actor_name, message_id, data, created_at)
SELECT 'bf-k-' || c.id, c.conversation_id, c.id, 'check_opened', 'person', coalesce(c.reviewed_by, ''), NULL,
	jsonb_build_object('reason', 'person', 'backfill', true), c.reviewed_at
FROM story_claims c
WHERE c.reviewed_at IS NOT NULL AND c.needs_check
	AND NOT EXISTS (SELECT 1 FROM story_claim_events e WHERE e.id = 'bf-k-' || c.id)
ORDER BY c.reviewed_at, c.id;
--> statement-breakpoint
INSERT INTO story_claim_variants (id, conversation_id, claim_id, text, message_id, created_at)
SELECT 'bf-v-' || c.id, c.conversation_id, c.id, c.claim, c.first_seen_message_id, c.created_at
FROM story_claims c
ON CONFLICT DO NOTHING;
