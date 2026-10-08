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
