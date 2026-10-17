-- Ledger status from evidence: what the model suggested, the best tier among
-- the cited pages and how many independent publishers back the claim are kept
-- as separate fields, alongside the resolved sources themselves. `status`
-- stays the column the API reads. Additive; existing rows keep their status
-- and pick up evidence the next time a turn restates them.
ALTER TABLE story_claims ADD COLUMN IF NOT EXISTS suggested_status text;
--> statement-breakpoint
ALTER TABLE story_claims ADD COLUMN IF NOT EXISTS source_tier text;
--> statement-breakpoint
ALTER TABLE story_claims ADD COLUMN IF NOT EXISTS corroboration integer NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE story_claims ADD COLUMN IF NOT EXISTS evidence jsonb NOT NULL DEFAULT '[]'::jsonb;
--> statement-breakpoint
-- Why the open check was opened (model, contradicted, stale, person); null with no open check.
ALTER TABLE story_claims ADD COLUMN IF NOT EXISTS check_reason text;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE story_claims ADD CONSTRAINT story_claims_source_tier_check
		CHECK (source_tier IS NULL OR source_tier IN ('official', 'wire_major', 'local', 'other', 'aggregator'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
	ALTER TABLE story_claims ADD CONSTRAINT story_claims_evidence_array CHECK (jsonb_typeof(evidence) = 'array');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
UPDATE story_claims SET suggested_status = status WHERE suggested_status IS NULL;
--> statement-breakpoint
UPDATE story_claims s SET check_reason = (
	SELECT e.data->>'reason' FROM story_claim_events e
	WHERE e.claim_id = s.id AND e.kind = 'check_opened' ORDER BY e.seq DESC LIMIT 1
) WHERE s.needs_check AND s.check_reason IS NULL;
