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
--> statement-breakpoint
CREATE UNIQUE INDEX accounts_email_unique ON accounts (email);
--> statement-breakpoint
CREATE INDEX accounts_setup_token_idx ON accounts (setup_token_hash);
