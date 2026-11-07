-- Reverses 0027_project_evidence. Run in one transaction:
--   psql -1 -v ON_ERROR_STOP=1 -f drizzle/rollback/0027_project_evidence.down.sql
-- Drops the project evidence tables. Stored objects in the storage gateway are
-- NOT removed by this script; list project_documents.storage_bucket/storage_path
-- before running it if those bytes must be purged too.
DROP TABLE IF EXISTS project_findings;
DROP TABLE IF EXISTS project_analysis_runs;
DROP TABLE IF EXISTS project_dataset_rows;
DROP TABLE IF EXISTS project_datasets;
DROP TABLE IF EXISTS project_document_pages;
DROP TABLE IF EXISTS project_documents;
DELETE FROM newscraft_schema_migrations WHERE version = '0027_project_evidence';
