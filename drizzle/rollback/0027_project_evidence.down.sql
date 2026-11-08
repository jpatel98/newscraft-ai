-- Reverses 0027_project_evidence only when all evidence tables are empty.
--   psql -X -v ON_ERROR_STOP=1 -f drizzle/rollback/0027_project_evidence.down.sql
-- The script owns its transaction. It never removes stored objects.
BEGIN;
SET LOCAL search_path = public;
SET LOCAL lock_timeout = '15s';
SELECT pg_advisory_xact_lock(hashtext('newscraft-ai:schema'));
LOCK TABLE public.project_documents, public.project_document_pages, public.project_datasets, public.project_dataset_rows, public.project_analysis_runs, public.project_findings IN ACCESS EXCLUSIVE MODE;
DO $evidence_rollback$
DECLARE
 relation_name text;
 populated boolean;
BEGIN
 FOREACH relation_name IN ARRAY ARRAY['project_documents', 'project_document_pages', 'project_datasets', 'project_dataset_rows', 'project_analysis_runs', 'project_findings'] LOOP
  EXECUTE format('SELECT EXISTS (SELECT 1 FROM public.%I)', relation_name) INTO populated;
  IF populated THEN
   RAISE EXCEPTION 'Refusing evidence rollback with retained data; preserve it before choosing a rollback plan.';
  END IF;
 END LOOP;
END
$evidence_rollback$;
DROP TABLE IF EXISTS public.project_findings;
DROP TABLE IF EXISTS public.project_analysis_runs;
DROP TABLE IF EXISTS public.project_dataset_rows;
DROP TABLE IF EXISTS public.project_datasets;
DROP TABLE IF EXISTS public.project_document_pages;
DROP TABLE IF EXISTS public.project_documents;
DELETE FROM public.newscraft_schema_migrations WHERE version = '0027_project_evidence';
COMMIT;
