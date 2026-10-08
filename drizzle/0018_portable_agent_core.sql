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
