-- Reverses 0026_rename_agent_runs. Run in one transaction:
--   psql -1 -v ON_ERROR_STOP=1 -f drizzle/rollback/0026_rename_agent_runs.down.sql
-- Renames only; no rows are touched apart from the artifact producer key.
ALTER TABLE IF EXISTS agent_runs RENAME TO hermes_runs;
ALTER TABLE IF EXISTS agent_run_events RENAME TO hermes_run_events;
ALTER TABLE IF EXISTS agent_run_artifact_refs RENAME TO hermes_run_artifact_refs;
DO $rename$
DECLARE
	item record;
BEGIN
	FOR item IN
		SELECT con.conname AS name, rel.relname AS tbl
		FROM pg_constraint con
		JOIN pg_class rel ON rel.oid = con.conrelid
		JOIN pg_namespace ns ON ns.oid = rel.relnamespace
		WHERE ns.nspname = current_schema() AND con.conname ~ '^agent_runs?_'
	LOOP
		EXECUTE format('ALTER TABLE %I RENAME CONSTRAINT %I TO %I',
			item.tbl, item.name, 'hermes_' || substr(item.name, 7));
	END LOOP;
	FOR item IN
		SELECT c.relname AS name
		FROM pg_class c
		JOIN pg_namespace ns ON ns.oid = c.relnamespace
		WHERE ns.nspname = current_schema() AND c.relkind = 'i' AND c.relname ~ '^agent_runs?_'
	LOOP
		EXECUTE format('ALTER INDEX %I RENAME TO %I', item.name, 'hermes_' || substr(item.name, 7));
	END LOOP;
END $rename$;
UPDATE artifact_upload_grants SET producer_key = 'hermes-publish-artifact' || substr(producer_key, 23)
WHERE producer_key LIKE 'agent-publish-artifact%';
DELETE FROM newscraft_schema_migrations WHERE version = '0026_rename_agent_runs';
