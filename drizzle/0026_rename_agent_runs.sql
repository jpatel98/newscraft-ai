-- Drop the retired "hermes" naming from the durable run tables. Renames only:
-- no column, row or type changes. Postgres keeps foreign keys from other
-- tables (artifacts, checkpoints, sessions) pointing at the renamed tables.
-- Indexes and constraints that carried the old prefix are renamed too, so the
-- schema has no hermes_* objects left.
ALTER TABLE IF EXISTS hermes_runs RENAME TO agent_runs;
--> statement-breakpoint
ALTER TABLE IF EXISTS hermes_run_events RENAME TO agent_run_events;
--> statement-breakpoint
ALTER TABLE IF EXISTS hermes_run_artifact_refs RENAME TO agent_run_artifact_refs;
--> statement-breakpoint
DO $rename$
DECLARE
	item record;
BEGIN
	FOR item IN
		SELECT con.conname AS name, rel.relname AS tbl
		FROM pg_constraint con
		JOIN pg_class rel ON rel.oid = con.conrelid
		JOIN pg_namespace ns ON ns.oid = rel.relnamespace
		WHERE ns.nspname = current_schema() AND con.conname LIKE 'hermes\_%'
	LOOP
		EXECUTE format('ALTER TABLE %I RENAME CONSTRAINT %I TO %I',
			item.tbl, item.name, 'agent_' || substr(item.name, 8));
	END LOOP;
	FOR item IN
		SELECT c.relname AS name
		FROM pg_class c
		JOIN pg_namespace ns ON ns.oid = c.relnamespace
		WHERE ns.nspname = current_schema() AND c.relkind = 'i' AND c.relname LIKE 'hermes\_%'
	LOOP
		EXECUTE format('ALTER INDEX %I RENAME TO %I', item.name, 'agent_' || substr(item.name, 8));
	END LOOP;
END $rename$;
--> statement-breakpoint
-- New artifact grants use the agent producer key; keep existing rows consistent.
UPDATE artifact_upload_grants SET producer_key = 'agent-publish-artifact' || substr(producer_key, 24)
WHERE producer_key LIKE 'hermes-publish-artifact%';
