CREATE TABLE conversations (
	id text PRIMARY KEY NOT NULL,
	title text DEFAULT '' NOT NULL,
	system_prompt text,
	created_at bigint NOT NULL,
	updated_at bigint NOT NULL,
	pinned integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
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
--> statement-breakpoint
CREATE INDEX messages_convo_created_idx ON messages (conversation_id, created_at);
--> statement-breakpoint
CREATE TABLE settings (
	key text PRIMARY KEY NOT NULL,
	value text NOT NULL
);
