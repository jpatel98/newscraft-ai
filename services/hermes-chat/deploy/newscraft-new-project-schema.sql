-- REVIEWABLE INITIALIZATION ARTIFACT. PREPARED ONLY; NOT EXECUTED.
-- Intended target: newscraft-agent / ygsiifvjzdazfxflmpjq (Supabase, us-east-2).
-- The operator MUST select and verify this exact project in the connector.
-- SQL itself cannot prove a Supabase project reference from a connection.
-- Source: the explicit NewsCraft migration contract, versions 0000 through 0018.
-- This one transaction refuses any existing public tables/views/sequences,
-- records all migration versions, and disables browser access BEFORE commit.
-- No legacy APP_PASSWORD_HASH, user account, Auth/Storage bucket or key is added.
-- Do not use this artifact for an existing database or rerun after success.
BEGIN;
SET LOCAL search_path = public, pg_catalog;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SELECT pg_advisory_xact_lock(hashtext('newscraft-ai:schema'));
DO $fresh$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class AS c
    JOIN pg_namespace AS n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
  ) THEN
    RAISE EXCEPTION 'Refusing initialization: the public schema is not empty';
  END IF;
END
$fresh$;
CREATE TABLE public.newscraft_schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

-- Source: drizzle/0000_init.sql; SHA256 e5a79cd9b88149e71ac76064d5e5fb714c0d2afa14a04c2dcafa79c87a820d44
CREATE TABLE conversations (
	id text PRIMARY KEY NOT NULL,
	title text DEFAULT '' NOT NULL,
	system_prompt text,
	created_at bigint NOT NULL,
	updated_at bigint NOT NULL,
	pinned integer DEFAULT 0 NOT NULL
);

CREATE TABLE messages (
	id text PRIMARY KEY NOT NULL,
	conversation_id text NOT NULL,
	role text NOT NULL,
	content text NOT NULL,
	tool_calls text,
	partial integer DEFAULT 0 NOT NULL,
	created_at bigint NOT NULL,
	CONSTRAINT messages_conversation_id_conversations_id_fk
		FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE cascade
);

CREATE INDEX messages_convo_created_idx ON messages (conversation_id, created_at);

CREATE TABLE settings (
	key text PRIMARY KEY NOT NULL,
	value text NOT NULL
);
INSERT INTO public.newscraft_schema_migrations (version) VALUES ('0000_init');

-- Source: drizzle/0001_fts.sql; SHA256 3f649b9bc09a0637b60a06706096374bbeb795c93ac1467db398ea4ebf7490bb
CREATE INDEX messages_content_search_idx
	ON messages USING gin (to_tsvector('simple', content));
INSERT INTO public.newscraft_schema_migrations (version) VALUES ('0001_fts');

-- Source: drizzle/0002_calm_juggernaut.sql; SHA256 ee2ffe5d3c8f82dab6b7505a1735438397d16e79c29641a9dcd7bed6c4248a0a
CREATE TABLE agent_channel_posts (
	id text PRIMARY KEY NOT NULL,
	job_id text NOT NULL,
	channel text NOT NULL,
	run_time text,
	schedule text,
	filename text NOT NULL,
	file_path_display text NOT NULL,
	response_markdown text NOT NULL,
	preview text NOT NULL,
	source_mtime_ms bigint DEFAULT 0 NOT NULL,
	created_at bigint NOT NULL,
	updated_at bigint NOT NULL
);

CREATE INDEX agent_posts_job_run_idx ON agent_channel_posts (job_id, run_time);

CREATE INDEX agent_posts_path_idx ON agent_channel_posts (file_path_display);
INSERT INTO public.newscraft_schema_migrations (version) VALUES ('0002_calm_juggernaut');

-- Source: drizzle/0003_mushy_vertigo.sql; SHA256 c7132f358e05573fd7b5dcd9c73f0ec08b05b3cbf55829d9c99e578c7f940d85
CREATE TABLE accounts (
	id text PRIMARY KEY NOT NULL,
	email text NOT NULL,
	name text DEFAULT '' NOT NULL,
	role text DEFAULT 'member' NOT NULL,
	password_hash text,
	setup_token_hash text,
	setup_token_expires_at bigint,
	created_at bigint NOT NULL,
	updated_at bigint NOT NULL,
	last_login_at bigint
);

CREATE UNIQUE INDEX accounts_email_unique ON accounts (email);

CREATE INDEX accounts_setup_token_idx ON accounts (setup_token_hash);
INSERT INTO public.newscraft_schema_migrations (version) VALUES ('0003_mushy_vertigo');

-- Source: drizzle/0004_lowly_mikhail_rasputin.sql; SHA256 62a9d212d2ab8bc99859917c04dbc4243f68085236e453d9a5533971626851e5
CREATE TABLE agent_channel_configs (
	job_id text PRIMARY KEY NOT NULL,
	base_prompt text NOT NULL,
	created_at bigint NOT NULL,
	updated_at bigint NOT NULL
);

CREATE TABLE agent_channel_sources (
	id text PRIMARY KEY NOT NULL,
	job_id text NOT NULL,
	type text DEFAULT 'url' NOT NULL,
	name text NOT NULL,
	config_json text NOT NULL,
	enabled integer DEFAULT 1 NOT NULL,
	sort_order integer DEFAULT 0 NOT NULL,
	created_at bigint NOT NULL,
	updated_at bigint NOT NULL,
	CONSTRAINT agent_channel_sources_job_id_agent_channel_configs_job_id_fk
		FOREIGN KEY (job_id) REFERENCES agent_channel_configs(job_id) ON DELETE cascade
);

CREATE INDEX agent_sources_job_idx ON agent_channel_sources (job_id, sort_order);

CREATE INDEX agent_sources_type_idx ON agent_channel_sources (type);
INSERT INTO public.newscraft_schema_migrations (version) VALUES ('0004_lowly_mikhail_rasputin');

-- Source: drizzle/0005_missions.sql; SHA256 e23851fd37c24859a4ccfb20ceb7faf9b5e2a5a5fda43cecbfd1ccda23063c4a
CREATE TABLE missions (
	id text PRIMARY KEY NOT NULL,
	name text NOT NULL,
	description text DEFAULT '' NOT NULL,
	prompt text NOT NULL,
	schedule text NOT NULL,
	enabled integer DEFAULT 1 NOT NULL,
	delivery_target text DEFAULT 'database' NOT NULL,
	output_format text DEFAULT 'markdown' NOT NULL,
	backend_job_id text NOT NULL,
	created_at bigint NOT NULL,
	updated_at bigint NOT NULL
);

CREATE TABLE mission_sources (
	id text PRIMARY KEY NOT NULL,
	mission_id text NOT NULL,
	type text DEFAULT 'url' NOT NULL,
	name text NOT NULL,
	config_json text NOT NULL,
	enabled integer DEFAULT 1 NOT NULL,
	sort_order integer DEFAULT 0 NOT NULL,
	created_at bigint NOT NULL,
	updated_at bigint NOT NULL,
	CONSTRAINT mission_sources_mission_id_missions_id_fk
		FOREIGN KEY (mission_id) REFERENCES missions(id) ON DELETE cascade
);

CREATE INDEX mission_sources_mission_idx ON mission_sources (mission_id, sort_order);

CREATE INDEX mission_sources_type_idx ON mission_sources (type);

CREATE TABLE mission_runs (
	id text PRIMARY KEY NOT NULL,
	mission_id text NOT NULL,
	status text NOT NULL,
	started_at text,
	completed_at text,
	elapsed_ms bigint,
	last_error text,
	created_at bigint NOT NULL,
	updated_at bigint NOT NULL,
	CONSTRAINT mission_runs_mission_id_missions_id_fk
		FOREIGN KEY (mission_id) REFERENCES missions(id) ON DELETE cascade
);

CREATE INDEX mission_runs_mission_started_idx ON mission_runs (mission_id, started_at);

CREATE TABLE mission_reports (
	id text PRIMARY KEY NOT NULL,
	mission_id text NOT NULL,
	mission_name text NOT NULL,
	run_time text,
	schedule text,
	filename text NOT NULL,
	file_path_display text NOT NULL,
	output_format text DEFAULT 'markdown' NOT NULL,
	response_markdown text NOT NULL,
	preview text NOT NULL,
	source_mtime_ms bigint DEFAULT 0 NOT NULL,
	legacy_channel_post_id text,
	created_at bigint NOT NULL,
	updated_at bigint NOT NULL
);

CREATE INDEX mission_reports_mission_run_idx ON mission_reports (mission_id, run_time);

CREATE INDEX mission_reports_path_idx ON mission_reports (file_path_display);

CREATE INDEX mission_reports_legacy_post_idx ON mission_reports (legacy_channel_post_id);

INSERT INTO mission_reports (
	id,
	mission_id,
	mission_name,
	run_time,
	schedule,
	filename,
	file_path_display,
	output_format,
	response_markdown,
	preview,
	source_mtime_ms,
	legacy_channel_post_id,
	created_at,
	updated_at
)
SELECT
	id,
	job_id,
	channel,
	run_time,
	schedule,
	filename,
	file_path_display,
	'markdown',
	response_markdown,
	preview,
	source_mtime_ms,
	id,
	created_at,
	updated_at
FROM agent_channel_posts
ON CONFLICT (id) DO NOTHING;

INSERT INTO missions (
	id,
	name,
	description,
	prompt,
	schedule,
	enabled,
	delivery_target,
	output_format,
	backend_job_id,
	created_at,
	updated_at
)
SELECT
	job_id,
	job_id,
	'',
	base_prompt,
	'',
	1,
	'database',
	'markdown',
	job_id,
	created_at,
	updated_at
FROM agent_channel_configs
ON CONFLICT (id) DO NOTHING;

INSERT INTO mission_sources (
	id,
	mission_id,
	type,
	name,
	config_json,
	enabled,
	sort_order,
	created_at,
	updated_at
)
SELECT
	id,
	job_id,
	type,
	name,
	config_json,
	enabled,
	sort_order,
	created_at,
	updated_at
FROM agent_channel_sources
ON CONFLICT (id) DO NOTHING;
INSERT INTO public.newscraft_schema_migrations (version) VALUES ('0005_missions');

-- Source: drizzle/0006_account_scopes.sql; SHA256 4bc75c431ae90c5864e12ee1be4748f1f7437a2cf0987ea916060f1d0ddec382
ALTER TABLE conversations ADD COLUMN account_id text REFERENCES accounts(id) ON DELETE cascade;

ALTER TABLE agent_channel_posts ADD COLUMN account_id text REFERENCES accounts(id) ON DELETE cascade;

ALTER TABLE missions ADD COLUMN account_id text REFERENCES accounts(id) ON DELETE cascade;

ALTER TABLE mission_reports ADD COLUMN account_id text REFERENCES accounts(id) ON DELETE cascade;

ALTER TABLE agent_channel_configs ADD COLUMN account_id text REFERENCES accounts(id) ON DELETE cascade;

UPDATE conversations
SET account_id = (SELECT id FROM accounts ORDER BY created_at ASC LIMIT 1)
WHERE account_id IS NULL;

UPDATE agent_channel_posts
SET account_id = (SELECT id FROM accounts ORDER BY created_at ASC LIMIT 1)
WHERE account_id IS NULL;

UPDATE missions
SET account_id = (SELECT id FROM accounts ORDER BY created_at ASC LIMIT 1)
WHERE account_id IS NULL;

UPDATE mission_reports
SET account_id = (SELECT id FROM accounts ORDER BY created_at ASC LIMIT 1)
WHERE account_id IS NULL;

UPDATE agent_channel_configs
SET account_id = (SELECT id FROM accounts ORDER BY created_at ASC LIMIT 1)
WHERE account_id IS NULL;

ALTER TABLE conversations ALTER COLUMN account_id SET NOT NULL;

ALTER TABLE agent_channel_posts ALTER COLUMN account_id SET NOT NULL;

ALTER TABLE missions ALTER COLUMN account_id SET NOT NULL;

ALTER TABLE mission_reports ALTER COLUMN account_id SET NOT NULL;

ALTER TABLE agent_channel_configs ALTER COLUMN account_id SET NOT NULL;

CREATE INDEX conversations_account_updated_idx ON conversations (account_id, updated_at);

CREATE INDEX agent_posts_account_job_idx ON agent_channel_posts (account_id, job_id);

CREATE INDEX missions_account_idx ON missions (account_id);

CREATE INDEX mission_reports_account_mission_idx ON mission_reports (account_id, mission_id);
INSERT INTO public.newscraft_schema_migrations (version) VALUES ('0006_account_scopes');

-- Source: drizzle/0007_chat_diagnostics.sql; SHA256 83378ea4f22e300cb4171eb07f029f9de0253e4bc3ea5c3c65e9f145cb343cbd
CREATE TABLE chat_diagnostics (
	id text PRIMARY KEY NOT NULL,
	conversation_id text NOT NULL,
	type text NOT NULL,
	details_json text NOT NULL,
	created_at bigint NOT NULL,
	CONSTRAINT chat_diagnostics_conversation_id_conversations_id_fk
		FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE cascade
);

CREATE INDEX chat_diagnostics_conversation_created_idx
	ON chat_diagnostics (conversation_id, created_at);

CREATE INDEX chat_diagnostics_type_created_idx
	ON chat_diagnostics (type, created_at);

CREATE TABLE chat_feedback (
	id text PRIMARY KEY NOT NULL,
	account_id text NOT NULL REFERENCES accounts(id) ON DELETE cascade,
	conversation_id text NOT NULL REFERENCES conversations(id) ON DELETE cascade,
	comment text NOT NULL,
	snapshot_json text NOT NULL,
	linear_issue_id text,
	linear_issue_identifier text,
	linear_issue_url text,
	user_agent text,
	created_at bigint NOT NULL
);

CREATE INDEX chat_feedback_account_created_idx ON chat_feedback (account_id, created_at);

CREATE INDEX chat_feedback_conversation_created_idx ON chat_feedback (conversation_id, created_at);

ALTER TABLE messages ADD COLUMN resume_claimed_at bigint;

CREATE INDEX messages_partial_claim_idx ON messages (partial, resume_claimed_at);

CREATE INDEX conversations_account_pinned_updated_idx
	ON conversations (account_id, pinned, updated_at);

CREATE INDEX mission_reports_account_updated_idx
	ON mission_reports (account_id, updated_at);
INSERT INTO public.newscraft_schema_migrations (version) VALUES ('0007_chat_diagnostics');

-- Source: drizzle/0008_message_provenance.sql; SHA256 78ed3a4254ccc31c4ec0feb9df83161c35c27377390bee350c5908630cb14e99
CREATE TABLE IF NOT EXISTS "message_provenance" (
	"message_id" text PRIMARY KEY NOT NULL,
	"conversation_id" text NOT NULL,
	"provenance_json" text NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "message_provenance_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE cascade,
	CONSTRAINT "message_provenance_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE cascade
);

CREATE INDEX IF NOT EXISTS "message_provenance_conversation_updated_idx" ON "message_provenance" ("conversation_id","updated_at");
INSERT INTO public.newscraft_schema_migrations (version) VALUES ('0008_message_provenance');

-- Source: drizzle/0009_sessions.sql; SHA256 f09245742f076d402425d046ee4f4d9ae57bb9b7468e3013cf81f1c0f7e8b338
CREATE TABLE IF NOT EXISTS sessions (
	id text PRIMARY KEY,
	account_id text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
	created_at bigint NOT NULL,
	expires_at bigint NOT NULL,
	revoked_at bigint,
	last_seen_at bigint
);

CREATE INDEX IF NOT EXISTS sessions_account_idx ON sessions (account_id);

CREATE INDEX IF NOT EXISTS sessions_expires_idx ON sessions (expires_at);
INSERT INTO public.newscraft_schema_migrations (version) VALUES ('0009_sessions');

-- Source: drizzle/0010_org_foundation.sql; SHA256 c6a6a8cd5eabe914a1beb42e721f46db4be8c8a9a45298231cf81d471ad1da42
CREATE TABLE IF NOT EXISTS organizations (
	id text PRIMARY KEY,
	name text NOT NULL DEFAULT 'Newsroom',
	created_at bigint NOT NULL,
	updated_at bigint NOT NULL
);

CREATE TABLE IF NOT EXISTS organization_members (
	id text PRIMARY KEY,
	org_id text NOT NULL REFERENCES organizations(id) ON DELETE cascade,
	account_id text NOT NULL REFERENCES accounts(id) ON DELETE cascade,
	role text NOT NULL DEFAULT 'member',
	created_at bigint NOT NULL,
	updated_at bigint NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS organization_members_account_org_unique ON organization_members (account_id, org_id);

CREATE INDEX IF NOT EXISTS organization_members_org_idx ON organization_members (org_id);

CREATE INDEX IF NOT EXISTS organization_members_account_idx ON organization_members (account_id);

INSERT INTO organizations (id, name, created_at, updated_at)
VALUES ('org_default', 'Newsroom', 1783122060000, 1783122060000)
ON CONFLICT (id) DO NOTHING;

INSERT INTO organization_members (id, org_id, account_id, role, created_at, updated_at)
SELECT 'org_default:' || accounts.id, 'org_default', accounts.id,
	CASE WHEN accounts.role = 'admin' THEN 'owner' ELSE 'member' END,
	1783122060000, 1783122060000
FROM accounts
ON CONFLICT (account_id, org_id) DO NOTHING;

ALTER TABLE conversations ADD COLUMN IF NOT EXISTS org_id text REFERENCES organizations(id) ON DELETE set null;

ALTER TABLE missions ADD COLUMN IF NOT EXISTS org_id text REFERENCES organizations(id) ON DELETE set null;

ALTER TABLE mission_reports ADD COLUMN IF NOT EXISTS org_id text REFERENCES organizations(id) ON DELETE set null;

ALTER TABLE chat_feedback ADD COLUMN IF NOT EXISTS org_id text REFERENCES organizations(id) ON DELETE set null;

UPDATE conversations
SET org_id = 'org_default'
WHERE org_id IS NULL
	AND account_id IN (SELECT account_id FROM organization_members WHERE org_id = 'org_default');

UPDATE missions
SET org_id = 'org_default'
WHERE org_id IS NULL
	AND account_id IN (SELECT account_id FROM organization_members WHERE org_id = 'org_default');

UPDATE mission_reports
SET org_id = 'org_default'
WHERE org_id IS NULL
	AND account_id IN (SELECT account_id FROM organization_members WHERE org_id = 'org_default');

UPDATE chat_feedback
SET org_id = 'org_default'
WHERE org_id IS NULL
	AND account_id IN (SELECT account_id FROM organization_members WHERE org_id = 'org_default');

CREATE INDEX IF NOT EXISTS conversations_org_updated_idx ON conversations (org_id, updated_at);

CREATE INDEX IF NOT EXISTS missions_org_idx ON missions (org_id);

CREATE INDEX IF NOT EXISTS mission_reports_org_updated_idx ON mission_reports (org_id, updated_at);

CREATE INDEX IF NOT EXISTS chat_feedback_org_created_idx ON chat_feedback (org_id, created_at);
INSERT INTO public.newscraft_schema_migrations (version) VALUES ('0010_org_foundation');

-- Source: drizzle/0011_agent_jobs.sql; SHA256 3fc0d693cab2b562656d27d8b1d1245d1dc582b819db447980d7a0ca5c258f56
CREATE TABLE IF NOT EXISTS agent_jobs (
	id text PRIMARY KEY,
	account_id text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
	org_id text REFERENCES organizations(id) ON DELETE SET NULL,
	state text NOT NULL DEFAULT 'queued',
	last_run_id text,
	last_run_at bigint,
	last_error text,
	created_at bigint NOT NULL,
	updated_at bigint NOT NULL
);

CREATE INDEX IF NOT EXISTS agent_jobs_account_job_idx ON agent_jobs (account_id, id);

CREATE INDEX IF NOT EXISTS agent_jobs_state_idx ON agent_jobs (state);

CREATE INDEX IF NOT EXISTS agent_jobs_org_idx ON agent_jobs (org_id);
INSERT INTO public.newscraft_schema_migrations (version) VALUES ('0011_agent_jobs');

-- Source: drizzle/0012_newsroom_profiles.sql; SHA256 f4a156a6adf28b3c5c85384783f27b47634bb039f41fdf44e33db3261b877dce
CREATE TABLE IF NOT EXISTS newsroom_profiles (
	org_id text PRIMARY KEY REFERENCES organizations(id) ON DELETE cascade,
	timezone text NOT NULL DEFAULT 'UTC',
	home_market text NOT NULL DEFAULT '',
	preferred_domains jsonb NOT NULL DEFAULT '[]'::jsonb,
	created_at bigint NOT NULL,
	updated_at bigint NOT NULL,
	CONSTRAINT newsroom_profiles_timezone_not_blank CHECK (length(trim(timezone)) > 0),
	CONSTRAINT newsroom_profiles_preferred_domains_array CHECK (jsonb_typeof(preferred_domains) = 'array')
);
INSERT INTO public.newscraft_schema_migrations (version) VALUES ('0012_newsroom_profiles');

-- Source: drizzle/0013_conversation_documents.sql; SHA256 77084ed5467492123fffc7c97a6bb64a11c8e7baddb84f40e9163fec3454e55a
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

CREATE INDEX IF NOT EXISTS conversation_documents_owner_idx
	ON conversation_documents (account_id, conversation_id, created_at);

CREATE INDEX IF NOT EXISTS conversation_documents_org_idx
	ON conversation_documents (org_id, updated_at);

CREATE INDEX IF NOT EXISTS conversation_documents_state_idx
	ON conversation_documents (processing_state, updated_at);

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

CREATE INDEX IF NOT EXISTS conversation_document_pages_owner_idx
	ON conversation_document_pages (account_id, conversation_id, document_id, page_number);

CREATE INDEX IF NOT EXISTS conversation_document_pages_org_idx
	ON conversation_document_pages (org_id, document_id, page_number);

CREATE INDEX IF NOT EXISTS conversation_document_pages_search_idx
	ON conversation_document_pages USING gin (search_vector);
INSERT INTO public.newscraft_schema_migrations (version) VALUES ('0013_conversation_documents');

-- Source: drizzle/0014_runtime_reconciliation.sql; SHA256 db111f6d4332f25f03570960eadbfdecbbc315a800d582f43e6b4dba48d0ce74
UPDATE accounts SET role = 'member' WHERE role NOT IN ('admin', 'member');

UPDATE accounts
SET role = 'admin'
WHERE id = (SELECT id FROM accounts ORDER BY created_at ASC LIMIT 1)
	AND NOT EXISTS (SELECT 1 FROM accounts WHERE role = 'admin');

INSERT INTO organizations (id, name, created_at, updated_at)
VALUES ('org_default', 'Newsroom', (extract(epoch FROM clock_timestamp()) * 1000)::bigint, (extract(epoch FROM clock_timestamp()) * 1000)::bigint)
ON CONFLICT (id) DO NOTHING;

INSERT INTO organization_members (id, org_id, account_id, role, created_at, updated_at)
SELECT 'org_default:' || accounts.id, 'org_default', accounts.id,
	CASE WHEN accounts.role = 'admin' THEN 'owner' ELSE 'member' END,
	(extract(epoch FROM clock_timestamp()) * 1000)::bigint,
	(extract(epoch FROM clock_timestamp()) * 1000)::bigint
FROM accounts
ON CONFLICT (account_id, org_id) DO NOTHING;

UPDATE conversations
SET org_id = 'org_default'
WHERE org_id IS NULL
	AND account_id IN (SELECT account_id FROM organization_members WHERE org_id = 'org_default');

UPDATE missions
SET org_id = 'org_default'
WHERE org_id IS NULL
	AND account_id IN (SELECT account_id FROM organization_members WHERE org_id = 'org_default');

UPDATE mission_reports
SET org_id = 'org_default'
WHERE org_id IS NULL
	AND account_id IN (SELECT account_id FROM organization_members WHERE org_id = 'org_default');

UPDATE agent_jobs
SET org_id = 'org_default'
WHERE org_id IS NULL
	AND account_id IN (SELECT account_id FROM organization_members WHERE org_id = 'org_default');

UPDATE chat_feedback
SET org_id = 'org_default'
WHERE org_id IS NULL
	AND account_id IN (SELECT account_id FROM organization_members WHERE org_id = 'org_default');
INSERT INTO public.newscraft_schema_migrations (version) VALUES ('0014_runtime_reconciliation');

-- Source: drizzle/0015_durable_hermes_runs.sql; SHA256 2d8b2c0c1142e0b87f4bf646daa0e40045ccde2552385efd95cf3d9ee60382db
CREATE TABLE IF NOT EXISTS hermes_runs (
	id text PRIMARY KEY,
	account_id text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
	org_id text REFERENCES organizations(id) ON DELETE SET NULL,
	conversation_id text NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
	user_message_id text REFERENCES messages(id) ON DELETE SET NULL,
	assistant_message_id text NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
	idempotency_key text NOT NULL,
	tenant_key text NOT NULL,
	session_id text NOT NULL,
	input_json text NOT NULL,
	seeded_citations_json text NOT NULL DEFAULT '[]',
	state text NOT NULL DEFAULT 'queued',
	answer_text text NOT NULL DEFAULT '',
	sources_json text NOT NULL DEFAULT '[]',
	citations_json text NOT NULL DEFAULT '[]',
	tools_json text NOT NULL DEFAULT '[]',
	cursor integer NOT NULL DEFAULT 0,
	worker_cursor integer NOT NULL DEFAULT 0,
	error_message text,
	cancel_requested_at bigint,
	lease_owner text,
	lease_token text,
	lease_expires_at bigint,
	created_at bigint NOT NULL,
	started_at bigint,
	updated_at bigint NOT NULL,
	completed_at bigint
);

CREATE UNIQUE INDEX IF NOT EXISTS hermes_runs_account_idempotency_unique
	ON hermes_runs (account_id, idempotency_key);

CREATE INDEX IF NOT EXISTS hermes_runs_conversation_state_idx
	ON hermes_runs (account_id, conversation_id, state, updated_at);

CREATE INDEX IF NOT EXISTS hermes_runs_lease_idx
	ON hermes_runs (state, lease_expires_at);

CREATE INDEX IF NOT EXISTS hermes_runs_account_updated_idx
	ON hermes_runs (account_id, updated_at);

CREATE TABLE IF NOT EXISTS hermes_run_events (
	run_id text NOT NULL REFERENCES hermes_runs(id) ON DELETE CASCADE,
	account_id text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
	cursor integer NOT NULL,
	event_type text NOT NULL,
	data_json text NOT NULL,
	created_at bigint NOT NULL,
	PRIMARY KEY (run_id, cursor)
);

CREATE INDEX IF NOT EXISTS hermes_run_events_account_cursor_idx
	ON hermes_run_events (account_id, run_id, cursor);
INSERT INTO public.newscraft_schema_migrations (version) VALUES ('0015_durable_hermes_runs');

-- Source: drizzle/0016_conversation_artifacts.sql; SHA256 d63d131b8a1a03f849deab5c586d40e858b21d77462931e3ad23dc7f72edc30a
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

CREATE INDEX IF NOT EXISTS artifact_families_owner_message_idx
	ON artifact_families (account_id, conversation_id, source_message_id, updated_at);

CREATE INDEX IF NOT EXISTS artifact_families_conversation_idx
	ON artifact_families (account_id, conversation_id, updated_at);

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

CREATE UNIQUE INDEX IF NOT EXISTS artifact_revisions_family_revision_unique
	ON artifact_revisions (family_id, revision);

CREATE INDEX IF NOT EXISTS artifact_revisions_family_status_idx
	ON artifact_revisions (family_id, status, updated_at);

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

CREATE UNIQUE INDEX IF NOT EXISTS artifact_assets_revision_role_unique
	ON artifact_assets (revision_id, role);

CREATE UNIQUE INDEX IF NOT EXISTS artifact_assets_object_version_unique
	ON artifact_assets (object_key, object_version);

CREATE INDEX IF NOT EXISTS artifact_assets_revision_idx
	ON artifact_assets (revision_id, created_at);

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

CREATE UNIQUE INDEX IF NOT EXISTS artifact_upload_grants_producer_unique
	ON artifact_upload_grants (revision_id, role, producer_key);

CREATE UNIQUE INDEX IF NOT EXISTS artifact_upload_grants_staging_key_unique
	ON artifact_upload_grants (staging_key);

CREATE INDEX IF NOT EXISTS artifact_upload_grants_run_idx
	ON artifact_upload_grants (run_id, state, expires_at);

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

CREATE INDEX IF NOT EXISTS artifact_verifications_object_version_idx
	ON artifact_verifications (object_key, object_version, created_at);

CREATE INDEX IF NOT EXISTS artifact_verifications_grant_idx
	ON artifact_verifications (grant_id, created_at);

CREATE TABLE IF NOT EXISTS hermes_run_artifact_refs (
	 run_id text NOT NULL REFERENCES hermes_runs(id) ON DELETE CASCADE,
	 revision_id text NOT NULL REFERENCES artifact_revisions(id) ON DELETE CASCADE,
	 cursor integer NOT NULL,
	 created_at bigint NOT NULL,
	 PRIMARY KEY (run_id, revision_id)
);

CREATE INDEX IF NOT EXISTS hermes_run_artifact_refs_cursor_idx
	ON hermes_run_artifact_refs (run_id, cursor);

-- Artifact state is server-owned. Keep RLS enabled as defense in depth while
-- leaving policies empty so client roles cannot read or mutate these tables.
ALTER TABLE artifact_families ENABLE ROW LEVEL SECURITY;

ALTER TABLE artifact_revisions ENABLE ROW LEVEL SECURITY;

ALTER TABLE artifact_assets ENABLE ROW LEVEL SECURITY;

ALTER TABLE artifact_upload_grants ENABLE ROW LEVEL SECURITY;

ALTER TABLE artifact_verifications ENABLE ROW LEVEL SECURITY;

ALTER TABLE hermes_run_artifact_refs ENABLE ROW LEVEL SECURITY;

REVOKE ALL PRIVILEGES ON TABLE artifact_families FROM anon, authenticated;

REVOKE ALL PRIVILEGES ON TABLE artifact_revisions FROM anon, authenticated;

REVOKE ALL PRIVILEGES ON TABLE artifact_assets FROM anon, authenticated;

REVOKE ALL PRIVILEGES ON TABLE artifact_upload_grants FROM anon, authenticated;

REVOKE ALL PRIVILEGES ON TABLE artifact_verifications FROM anon, authenticated;

REVOKE ALL PRIVILEGES ON TABLE hermes_run_artifact_refs FROM anon, authenticated;
INSERT INTO public.newscraft_schema_migrations (version) VALUES ('0016_conversation_artifacts');

-- Source: drizzle/0017_managed_agent_sessions.sql; SHA256 07b03835416aa723095e91b95fc92ac8b05f0fe61cb328ef50212dbd1b26118d
-- Provider identifiers and submission checkpoints are private application state.
CREATE TABLE managed_agent_sessions (
  conversation_id text PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  account_id text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  active_run_id text NOT NULL REFERENCES hermes_runs(id) ON DELETE CASCADE,
  session_id text UNIQUE,
  state_json text NOT NULL DEFAULT '{}',
  version integer NOT NULL DEFAULT 0,
  updated_at bigint NOT NULL
);
CREATE INDEX managed_agent_sessions_owner_idx ON managed_agent_sessions(account_id);
ALTER TABLE managed_agent_sessions ENABLE ROW LEVEL SECURITY;
INSERT INTO public.newscraft_schema_migrations (version) VALUES ('0017_managed_agent_sessions');

-- Source: drizzle/0018_portable_agent_core.sql; SHA256 6af3b7324bcfea4fb48607435e3de1826c014955d2fa3c55f8b4ea58100b91c7
CREATE TABLE agent_runtime_checkpoints (
    run_id text PRIMARY KEY REFERENCES hermes_runs(id) ON DELETE CASCADE,
    account_id text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    state_json text NOT NULL DEFAULT '{}',
    version integer NOT NULL DEFAULT 0,
    updated_at bigint NOT NULL
);
ALTER TABLE agent_runtime_checkpoints ENABLE ROW LEVEL SECURITY;
CREATE TABLE auth_identities (
    provider text NOT NULL,
    issuer text NOT NULL,
    subject text NOT NULL,
    account_id text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
    PRIMARY KEY (provider, issuer, subject)
);
CREATE INDEX auth_identities_account ON auth_identities(account_id);
ALTER TABLE auth_identities ENABLE ROW LEVEL SECURITY;
INSERT INTO public.newscraft_schema_migrations (version) VALUES ('0018_portable_agent_core');

-- Database-only protection, kept in this same initialization transaction.
-- Source: deploy/supabase-database-private.sql; SHA256 239d26efceaa714fe43bf2a7447cf1ed65b374de78e5a30ab067cc0c8b313340
DO $requirements$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon')
     OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    RAISE EXCEPTION 'Expected Supabase browser roles are absent';
  END IF;
  IF to_regclass('public.newscraft_schema_migrations') IS NULL THEN
    RAISE EXCEPTION 'Apply the reviewed NewsCraft schema first';
  END IF;
END
$requirements$;

-- These defaults apply to future objects created by this migration role.
-- Future migrations must still explicitly enable RLS on their own tables.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE ALL ON TABLES FROM PUBLIC, anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  REVOKE ALL ON SEQUENCES FROM PUBLIC, anon, authenticated;

DO $security$
DECLARE table_name text;
BEGIN
  FOR table_name IN SELECT tablename FROM pg_tables WHERE schemaname = 'public'
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon, authenticated', table_name);
  END LOOP;
  REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC, anon, authenticated;

  -- The app server owns authentication and checks tenant/account ownership.
  -- Direct browser table access has no role in either supported auth adapter.
  IF EXISTS (
    SELECT 1 FROM pg_tables
    WHERE schemaname = 'public' AND (
      NOT rowsecurity OR
      has_table_privilege('anon', format('%I.%I', schemaname, tablename),
        'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR
      has_table_privilege('authenticated', format('%I.%I', schemaname, tablename),
        'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
    )
  ) THEN
    RAISE EXCEPTION 'Direct browser table access is not fully disabled';
  END IF;
END
$security$;

COMMIT;
