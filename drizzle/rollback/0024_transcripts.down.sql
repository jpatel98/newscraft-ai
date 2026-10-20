-- Reverses 0024_transcripts. Run in one transaction:
--   psql -1 -v ON_ERROR_STOP=1 -f drizzle/rollback/0024_transcripts.down.sql
-- Drops saved transcripts. Audio objects in newsroom-audio are left on disk.
DROP TABLE IF EXISTS transcripts;
DELETE FROM newscraft_schema_migrations WHERE version = '0024_transcripts';
