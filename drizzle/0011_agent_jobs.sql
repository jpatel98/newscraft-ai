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
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS agent_jobs_account_job_idx ON agent_jobs (account_id, id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS agent_jobs_state_idx ON agent_jobs (state);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS agent_jobs_org_idx ON agent_jobs (org_id);
