CREATE TABLE IF NOT EXISTS artifact_families (
	 id text PRIMARY KEY,
	 account_id text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
	 org_id text REFERENCES organizations(id) ON DELETE SET NULL,
	 conversation_id text NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
	 source_message_id text NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
	 kind text NOT NULL CHECK (kind IN ('chart', 'table', 'image', 'markdown', 'map')),
	 title text NOT NULL,
	 latest_revision_id text,
	 created_at bigint NOT NULL,
	 updated_at bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS artifact_families_owner_message_idx
	ON artifact_families (account_id, conversation_id, source_message_id, updated_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS artifact_families_conversation_idx
	ON artifact_families (account_id, conversation_id, updated_at);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS artifact_revisions (
	 id text PRIMARY KEY,
	 family_id text NOT NULL REFERENCES artifact_families(id) ON DELETE CASCADE,
	 revision integer NOT NULL,
	 status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'publishing', 'ready', 'failed', 'cancelled', 'missing')),
	 spec_json text NOT NULL,
	 spec_sha256 text NOT NULL,
	 base_revision_id text,
	 error_code text,
	 error_message text,
	 created_at bigint NOT NULL,
	 updated_at bigint NOT NULL,
	 ready_at bigint
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS artifact_revisions_family_revision_unique
	ON artifact_revisions (family_id, revision);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS artifact_revisions_family_status_idx
	ON artifact_revisions (family_id, status, updated_at);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS artifact_assets (
	 id text PRIMARY KEY,
	 revision_id text NOT NULL REFERENCES artifact_revisions(id) ON DELETE CASCADE,
	 role text NOT NULL CHECK (role IN ('source', 'preview', 'data')),
	 object_key text NOT NULL,
	 object_version text NOT NULL,
	 mime_type text NOT NULL,
	 size_bytes bigint NOT NULL,
	 checksum_sha256 text NOT NULL,
	 width integer,
	 height integer,
	 created_at bigint NOT NULL,
	 verified_at bigint NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS artifact_assets_revision_role_unique
	ON artifact_assets (revision_id, role);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS artifact_assets_object_version_unique
	ON artifact_assets (object_key, object_version);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS artifact_assets_revision_idx
	ON artifact_assets (revision_id, created_at);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS artifact_upload_grants (
	 id text PRIMARY KEY,
	 revision_id text NOT NULL REFERENCES artifact_revisions(id) ON DELETE CASCADE,
	 run_id text REFERENCES hermes_runs(id) ON DELETE SET NULL,
	 role text NOT NULL CHECK (role IN ('source', 'preview', 'data')),
	 producer_key text NOT NULL,
	 token_hash text NOT NULL,
	 staging_key text NOT NULL,
	 final_key text NOT NULL,
	 uploaded_object_version text,
	 allowed_mime text NOT NULL,
	 max_bytes bigint NOT NULL,
	 exact_bytes bigint,
	 expected_sha256 text,
	 expires_at bigint NOT NULL,
	 state text NOT NULL DEFAULT 'issued' CHECK (state IN ('issued', 'uploaded', 'consumed', 'expired', 'revoked')),
	 created_at bigint NOT NULL,
	 uploaded_at bigint,
	 consumed_at bigint
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS artifact_upload_grants_producer_unique
	ON artifact_upload_grants (revision_id, role, producer_key);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS artifact_upload_grants_staging_key_unique
	ON artifact_upload_grants (staging_key);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS artifact_upload_grants_run_idx
	ON artifact_upload_grants (run_id, state, expires_at);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS artifact_verifications (
	 id text PRIMARY KEY,
	 grant_id text REFERENCES artifact_upload_grants(id) ON DELETE SET NULL,
	 object_key text NOT NULL,
	 object_version text NOT NULL,
	 status text NOT NULL CHECK (status IN ('verified', 'rejected')),
	 mime_type text,
	 size_bytes bigint,
	 checksum_sha256 text,
	 width integer,
	 height integer,
	 reason_code text,
	 details_json text NOT NULL DEFAULT '{}',
	 created_at bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS artifact_verifications_object_version_idx
	ON artifact_verifications (object_key, object_version, created_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS artifact_verifications_grant_idx
	ON artifact_verifications (grant_id, created_at);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS hermes_run_artifact_refs (
	 run_id text NOT NULL REFERENCES hermes_runs(id) ON DELETE CASCADE,
	 revision_id text NOT NULL REFERENCES artifact_revisions(id) ON DELETE CASCADE,
	 cursor integer NOT NULL,
	 created_at bigint NOT NULL,
	 PRIMARY KEY (run_id, revision_id)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS hermes_run_artifact_refs_cursor_idx
	ON hermes_run_artifact_refs (run_id, cursor);
