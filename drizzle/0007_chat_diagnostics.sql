CREATE TABLE chat_diagnostics (
	id text PRIMARY KEY NOT NULL,
	conversation_id text NOT NULL,
	type text NOT NULL,
	details_json text NOT NULL,
	created_at bigint NOT NULL,
	CONSTRAINT chat_diagnostics_conversation_id_conversations_id_fk
		FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX chat_diagnostics_conversation_created_idx
	ON chat_diagnostics (conversation_id, created_at);
--> statement-breakpoint
CREATE INDEX chat_diagnostics_type_created_idx
	ON chat_diagnostics (type, created_at);
--> statement-breakpoint
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
--> statement-breakpoint
CREATE INDEX chat_feedback_account_created_idx ON chat_feedback (account_id, created_at);
--> statement-breakpoint
CREATE INDEX chat_feedback_conversation_created_idx ON chat_feedback (conversation_id, created_at);
--> statement-breakpoint
ALTER TABLE messages ADD COLUMN resume_claimed_at bigint;
--> statement-breakpoint
CREATE INDEX messages_partial_claim_idx ON messages (partial, resume_claimed_at);
--> statement-breakpoint
CREATE INDEX conversations_account_pinned_updated_idx
	ON conversations (account_id, pinned, updated_at);
--> statement-breakpoint
CREATE INDEX mission_reports_account_updated_idx
	ON mission_reports (account_id, updated_at);
