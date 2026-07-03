CREATE TABLE IF NOT EXISTS sessions (
	id text PRIMARY KEY,
	account_id text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
	created_at bigint NOT NULL,
	expires_at bigint NOT NULL,
	revoked_at bigint,
	last_seen_at bigint
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS sessions_account_idx ON sessions (account_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS sessions_expires_idx ON sessions (expires_at);
