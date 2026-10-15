-- Reverses 0023_story_claim_evidence. Run in one transaction:
--   psql -1 -v ON_ERROR_STOP=1 -f drizzle/rollback/0023_story_claim_evidence.down.sql
-- Drops only the evidence fields; status, the event log and the API shape stay.
ALTER TABLE story_claims DROP CONSTRAINT IF EXISTS story_claims_evidence_array;
ALTER TABLE story_claims DROP CONSTRAINT IF EXISTS story_claims_source_tier_check;
ALTER TABLE story_claims DROP COLUMN IF EXISTS check_reason;
ALTER TABLE story_claims DROP COLUMN IF EXISTS evidence;
ALTER TABLE story_claims DROP COLUMN IF EXISTS corroboration;
ALTER TABLE story_claims DROP COLUMN IF EXISTS source_tier;
ALTER TABLE story_claims DROP COLUMN IF EXISTS suggested_status;
DELETE FROM newscraft_schema_migrations WHERE version = '0023_story_claim_evidence';
