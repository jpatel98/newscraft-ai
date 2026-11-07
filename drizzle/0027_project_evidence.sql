-- Project evidence library: PDFs and CSVs that belong to a project (not to one
-- chat), sealed by server-computed hash, with extracted pages / normalized rows
-- and deterministic findings that cite them. Every row carries account_id and
-- project_id and is bound to projects(id, account_id) so an id from one
-- project cannot be attached to another. Storage keys are opaque; the display
-- name lives only in project_documents.display_name.
CREATE TABLE IF NOT EXISTS project_documents (
 id text PRIMARY KEY,
 account_id text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
 project_id text NOT NULL,
 org_id text REFERENCES organizations(id) ON DELETE SET NULL,
 kind text NOT NULL CHECK (kind IN ('pdf', 'csv')),
 display_name text NOT NULL CHECK (length(btrim(display_name)) BETWEEN 1 AND 255),
 mime_type text NOT NULL,
 declared_size_bytes bigint NOT NULL CHECK (declared_size_bytes > 0),
 declared_sha256 text NOT NULL CHECK (declared_sha256 ~ '^[a-f0-9]{64}$'),
 storage_bucket text NOT NULL,
 storage_path text NOT NULL,
 state text NOT NULL DEFAULT 'uploading' CHECK (state IN ('uploading', 'processing', 'ready', 'failed')),
 sealed_sha256 text CHECK (sealed_sha256 IS NULL OR sealed_sha256 ~ '^[a-f0-9]{64}$'),
 sealed_size_bytes bigint,
 sealed_at bigint,
 extraction_version integer NOT NULL DEFAULT 0,
 page_count integer,
 row_count integer,
 column_count integer,
 failure_code text,
 failure_message text,
 processing_started_at bigint,
 processed_at bigint,
 created_at bigint NOT NULL,
 updated_at bigint NOT NULL,
 CONSTRAINT project_documents_project_owner_fk FOREIGN KEY (project_id, account_id) REFERENCES projects(id, account_id) ON DELETE CASCADE,
 CONSTRAINT project_documents_scope_key UNIQUE (id, account_id, project_id)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS project_documents_scope_created_idx ON project_documents(account_id, project_id, created_at);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS project_document_pages (
 id text PRIMARY KEY,
 document_id text NOT NULL,
 account_id text NOT NULL,
 project_id text NOT NULL,
 page_number integer NOT NULL CHECK (page_number > 0),
 page_text text NOT NULL,
 char_count integer NOT NULL,
 search_vector tsvector GENERATED ALWAYS AS (to_tsvector('simple', coalesce(page_text, ''))) STORED,
 created_at bigint NOT NULL,
 CONSTRAINT project_document_pages_document_fk FOREIGN KEY (document_id, account_id, project_id)
  REFERENCES project_documents(id, account_id, project_id) ON DELETE CASCADE,
 CONSTRAINT project_document_pages_page_key UNIQUE (document_id, page_number)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS project_document_pages_scope_idx ON project_document_pages(account_id, project_id, document_id, page_number);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS project_document_pages_search_idx ON project_document_pages USING gin (search_vector);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS project_datasets (
 document_id text PRIMARY KEY,
 account_id text NOT NULL,
 project_id text NOT NULL,
 delimiter text NOT NULL,
 has_header boolean NOT NULL,
 encoding text NOT NULL,
 parser_version text NOT NULL,
 columns jsonb NOT NULL CHECK (jsonb_typeof(columns) = 'array'),
 row_count integer NOT NULL CHECK (row_count >= 0),
 rejected_rows integer NOT NULL DEFAULT 0,
 created_at bigint NOT NULL,
 CONSTRAINT project_datasets_document_fk FOREIGN KEY (document_id, account_id, project_id)
  REFERENCES project_documents(id, account_id, project_id) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS project_dataset_rows (
 document_id text NOT NULL,
 account_id text NOT NULL,
 project_id text NOT NULL,
 ordinal integer NOT NULL CHECK (ordinal > 0),
 source_line integer NOT NULL,
 cells text[] NOT NULL,
 PRIMARY KEY (document_id, ordinal),
 CONSTRAINT project_dataset_rows_document_fk FOREIGN KEY (document_id, account_id, project_id)
  REFERENCES project_documents(id, account_id, project_id) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS project_dataset_rows_scope_idx ON project_dataset_rows(account_id, project_id, document_id);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS project_analysis_runs (
 id text PRIMARY KEY,
 account_id text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
 project_id text NOT NULL,
 status text NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'cancelled')),
 trigger text NOT NULL CHECK (trigger IN ('manual', 'auto')),
 analyzer_version text NOT NULL,
 input_documents jsonb NOT NULL CHECK (jsonb_typeof(input_documents) = 'array'),
 finding_count integer NOT NULL DEFAULT 0,
 error_code text,
 error_message text,
 started_at bigint NOT NULL,
 finished_at bigint,
 CONSTRAINT project_analysis_runs_project_fk FOREIGN KEY (project_id, account_id) REFERENCES projects(id, account_id) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS project_analysis_runs_scope_idx ON project_analysis_runs(account_id, project_id, started_at);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS project_findings (
 id text PRIMARY KEY,
 account_id text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
 project_id text NOT NULL,
 run_id text REFERENCES project_analysis_runs(id) ON DELETE SET NULL,
 kind text NOT NULL,
 rank integer NOT NULL DEFAULT 0,
 title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
 claim text NOT NULL CHECK (length(claim) BETWEEN 1 AND 2000),
 evidence jsonb NOT NULL CHECK (jsonb_typeof(evidence) = 'array'),
 calculation jsonb NOT NULL CHECK (jsonb_typeof(calculation) = 'object'),
 limitations text NOT NULL DEFAULT '',
 next_question text NOT NULL DEFAULT '',
 fingerprint text NOT NULL,
 status text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'saved', 'reviewed', 'dismissed', 'stale')),
 review_note text NOT NULL DEFAULT '',
 dismissal_reason text NOT NULL DEFAULT '',
 reviewed_by text REFERENCES accounts(id) ON DELETE SET NULL,
 reviewed_at bigint,
 created_at bigint NOT NULL,
 updated_at bigint NOT NULL,
 CONSTRAINT project_findings_project_fk FOREIGN KEY (project_id, account_id) REFERENCES projects(id, account_id) ON DELETE CASCADE,
 CONSTRAINT project_findings_fingerprint_key UNIQUE (project_id, fingerprint)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS project_findings_scope_idx ON project_findings(account_id, project_id, status, created_at);
--> statement-breakpoint
-- Server-owned rows: RLS stays enabled with no policies, like every other
-- public table. The newscraft_app runtime role receives CRUD on new tables
-- through the default privileges in infra/newscraft-postgres/init/01-roles.sh.
ALTER TABLE project_documents ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE project_document_pages ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE project_datasets ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE project_dataset_rows ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE project_analysis_runs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE project_findings ENABLE ROW LEVEL SECURITY;
