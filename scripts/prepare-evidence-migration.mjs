#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MIGRATION_VERSIONS } from '../src/lib/server/db/migration-contract.ts';

const version = '0027_project_evidence';
const relations = ['project_documents', 'project_document_pages', 'project_datasets', 'project_dataset_rows', 'project_analysis_runs', 'project_findings'];

export function prepareEvidenceMigration(contents, expectedHash, databaseName = 'newscraft') {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(databaseName)) throw new Error('Invalid reviewed database identity.');
  const digest = createHash('sha256').update(contents).digest('hex');
  if (!expectedHash || !/^[a-f0-9]{64}$/.test(expectedHash) || digest !== expectedHash) {
    throw new Error('Evidence migration checksum did not match the reviewed candidate.');
  }
  const quoted = values => values.map(value => "'" + value + "'").join(', ');
  const baseline = MIGRATION_VERSIONS.filter(item => item !== version).sort();
  return `-- reviewed migration sha256: ${digest}
BEGIN;
SET LOCAL search_path = public;
SET LOCAL lock_timeout = '15s';
SET LOCAL statement_timeout = '120s';
SELECT pg_advisory_xact_lock(hashtext('newscraft-ai:schema'));
DO $evidence_guard$
DECLARE
  recorded text[];
  relation_name text;
BEGIN
  IF current_database() <> '${databaseName}' OR pg_is_in_recovery() THEN
    RAISE EXCEPTION 'Refusing evidence migration on an unexpected database.';
  END IF;
  IF to_regclass('public.newscraft_schema_migrations') IS NULL THEN
    RAISE EXCEPTION 'Refusing evidence migration without an existing ledger.';
  END IF;
  SELECT array_agg(version ORDER BY version) INTO recorded FROM public.newscraft_schema_migrations;
  IF recorded IS DISTINCT FROM ARRAY[${quoted(baseline)}]::text[] THEN
    RAISE EXCEPTION 'Refusing evidence migration: only the exact 0027 pending set is authorized.';
  END IF;
  FOREACH relation_name IN ARRAY ARRAY[${quoted(relations)}] LOOP
    IF to_regclass('public.' || relation_name) IS NOT NULL THEN
      RAISE EXCEPTION 'Refusing unrecorded pre-existing evidence tables.';
    END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'newscraft_app' AND rolcanlogin AND rolbypassrls AND NOT rolsuper) THEN
    RAISE EXCEPTION 'Unexpected NewsCraft application role configuration.';
  END IF;
END
$evidence_guard$;
${contents}
DO $evidence_grants$
DECLARE
  relation_name text;
  privilege_name text;
BEGIN
  FOREACH relation_name IN ARRAY ARRAY[${quoted(relations)}] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_class JOIN pg_namespace ON pg_namespace.oid = pg_class.relnamespace
      WHERE nspname = 'public' AND relname = relation_name AND relrowsecurity) THEN
      RAISE EXCEPTION 'Evidence row protections are missing.';
    END IF;
    FOREACH privilege_name IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'] LOOP
      IF NOT has_table_privilege('newscraft_app', 'public.' || relation_name, privilege_name) THEN
        RAISE EXCEPTION 'Evidence application grants are incomplete.';
      END IF;
    END LOOP;
  END LOOP;
END
$evidence_grants$;
INSERT INTO public.newscraft_schema_migrations (version) VALUES ('${version}');
COMMIT;
SELECT count(*) AS migration_count, max(version) AS latest_migration FROM public.newscraft_schema_migrations;
`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 4 || process.argv[2] !== '--expect-sha256') {
    throw new Error('Use --expect-sha256 with the reviewed 0027 migration digest.');
  }
  const contents = readFileSync(new URL('../drizzle/0027_project_evidence.sql', import.meta.url), 'utf8');
  process.stdout.write(prepareEvidenceMigration(contents, process.argv[3]));
}
