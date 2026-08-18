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
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS hermes_runs_account_idempotency_unique
	ON hermes_runs (account_id, idempotency_key);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS hermes_runs_conversation_state_idx
	ON hermes_runs (account_id, conversation_id, state, updated_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS hermes_runs_lease_idx
	ON hermes_runs (state, lease_expires_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS hermes_runs_account_updated_idx
	ON hermes_runs (account_id, updated_at);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS hermes_run_events (
	run_id text NOT NULL REFERENCES hermes_runs(id) ON DELETE CASCADE,
	account_id text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
	cursor integer NOT NULL,
	event_type text NOT NULL,
	data_json text NOT NULL,
	created_at bigint NOT NULL,
	PRIMARY KEY (run_id, cursor)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS hermes_run_events_account_cursor_idx
	ON hermes_run_events (account_id, run_id, cursor);
