-- Reverses 0025_conversation_transcripts. Run in one transaction:
--   psql -1 -v ON_ERROR_STOP=1 -f drizzle/rollback/0025_conversation_transcripts.down.sql
-- Drops the attachment table and the org column; transcripts and audio stay.
DROP TABLE IF EXISTS conversation_transcripts;
DROP INDEX IF EXISTS transcripts_org_created_idx;
ALTER TABLE transcripts DROP COLUMN IF EXISTS org_id;
DELETE FROM newscraft_schema_migrations WHERE version = '0025_conversation_transcripts';
