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
