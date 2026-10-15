-- Reverses 0022_story_claim_events. Run in one transaction:
--   psql -1 -v ON_ERROR_STOP=1 -f drizzle/rollback/0022_story_claim_events.down.sql
-- story_claims is untouched by 0022 (its columns stay the canonical state), so
-- dropping the log loses no claim and the API keeps working.
DROP TABLE IF EXISTS story_claim_variants;
DROP TABLE IF EXISTS story_claim_events;
DROP FUNCTION IF EXISTS story_claim_events_append_only();
DELETE FROM newscraft_schema_migrations WHERE version = '0022_story_claim_events';
