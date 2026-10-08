CREATE TABLE projects (
 id text PRIMARY KEY,
 account_id text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
 name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 100),
 created_at bigint NOT NULL,
 updated_at bigint NOT NULL,
 UNIQUE (id, account_id)
);
--> statement-breakpoint
CREATE INDEX projects_account_updated_idx ON projects(account_id, updated_at);
--> statement-breakpoint
CREATE UNIQUE INDEX conversations_id_account_unique ON conversations(id, account_id);
--> statement-breakpoint
CREATE TABLE project_conversations (
 conversation_id text PRIMARY KEY,
 account_id text NOT NULL,
 project_id text NOT NULL,
 FOREIGN KEY (conversation_id, account_id) REFERENCES conversations(id, account_id) ON DELETE CASCADE,
 FOREIGN KEY (project_id, account_id) REFERENCES projects(id, account_id) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX project_conversations_project_idx ON project_conversations(account_id, project_id);
--> statement-breakpoint
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE project_conversations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE projects FROM anon, authenticated;
--> statement-breakpoint
REVOKE ALL PRIVILEGES ON TABLE project_conversations FROM anon, authenticated;
