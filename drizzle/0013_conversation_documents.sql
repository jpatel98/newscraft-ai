CREATE TABLE IF NOT EXISTS conversation_documents (
	id text PRIMARY KEY,
	org_id text NOT NULL REFERENCES organizations(id) ON DELETE cascade,
	account_id text NOT NULL REFERENCES accounts(id) ON DELETE cascade,
	conversation_id text NOT NULL REFERENCES conversations(id) ON DELETE cascade,
	original_filename text NOT NULL,
	storage_path text NOT NULL,
	mime_type text NOT NULL DEFAULT 'application/pdf',
	size_bytes bigint NOT NULL,
	checksum_sha256 text NOT NULL,
	processing_state text NOT NULL DEFAULT 'uploading',
	page_count integer,
	failure_code text,
	failure_message text,
	processing_started_at bigint,
	processed_at bigint,
	created_at bigint NOT NULL,
	updated_at bigint NOT NULL,
	CONSTRAINT conversation_documents_storage_path_unique UNIQUE (storage_path),
	CONSTRAINT conversation_documents_pdf_only CHECK (mime_type = 'application/pdf'),
	CONSTRAINT conversation_documents_size_limit CHECK (size_bytes > 0 AND size_bytes <= 20971520),
	CONSTRAINT conversation_documents_checksum_sha256 CHECK (checksum_sha256 ~ '^[0-9a-f]{64}$'),
	CONSTRAINT conversation_documents_processing_state CHECK (
		processing_state IN ('uploading', 'processing', 'ready', 'failed')
	),
	CONSTRAINT conversation_documents_page_limit CHECK (page_count IS NULL OR (page_count >= 0 AND page_count <= 250))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS conversation_documents_owner_idx
	ON conversation_documents (account_id, conversation_id, created_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS conversation_documents_org_idx
	ON conversation_documents (org_id, updated_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS conversation_documents_state_idx
	ON conversation_documents (processing_state, updated_at);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS conversation_document_pages (
	id text PRIMARY KEY,
	document_id text NOT NULL REFERENCES conversation_documents(id) ON DELETE cascade,
	org_id text NOT NULL REFERENCES organizations(id) ON DELETE cascade,
	account_id text NOT NULL REFERENCES accounts(id) ON DELETE cascade,
	conversation_id text NOT NULL REFERENCES conversations(id) ON DELETE cascade,
	page_number integer NOT NULL,
	page_text text NOT NULL,
	char_count integer NOT NULL,
	search_vector tsvector GENERATED ALWAYS AS (to_tsvector('simple', coalesce(page_text, ''))) STORED,
	created_at bigint NOT NULL,
	updated_at bigint NOT NULL,
	CONSTRAINT conversation_document_pages_number_positive CHECK (page_number > 0),
	CONSTRAINT conversation_document_pages_char_count_nonnegative CHECK (char_count >= 0),
	CONSTRAINT conversation_document_pages_document_number_unique UNIQUE (document_id, page_number)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS conversation_document_pages_owner_idx
	ON conversation_document_pages (account_id, conversation_id, document_id, page_number);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS conversation_document_pages_org_idx
	ON conversation_document_pages (org_id, document_id, page_number);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS conversation_document_pages_search_idx
	ON conversation_document_pages USING gin (search_vector);
