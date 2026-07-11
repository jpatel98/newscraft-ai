ALTER TABLE conversations ADD COLUMN account_id text REFERENCES accounts(id) ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE agent_channel_posts ADD COLUMN account_id text REFERENCES accounts(id) ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE missions ADD COLUMN account_id text REFERENCES accounts(id) ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE mission_reports ADD COLUMN account_id text REFERENCES accounts(id) ON DELETE cascade;
--> statement-breakpoint
ALTER TABLE agent_channel_configs ADD COLUMN account_id text REFERENCES accounts(id) ON DELETE cascade;
--> statement-breakpoint
UPDATE conversations
SET account_id = (SELECT id FROM accounts ORDER BY created_at ASC LIMIT 1)
WHERE account_id IS NULL;
--> statement-breakpoint
UPDATE agent_channel_posts
SET account_id = (SELECT id FROM accounts ORDER BY created_at ASC LIMIT 1)
WHERE account_id IS NULL;
--> statement-breakpoint
UPDATE missions
SET account_id = (SELECT id FROM accounts ORDER BY created_at ASC LIMIT 1)
WHERE account_id IS NULL;
--> statement-breakpoint
UPDATE mission_reports
SET account_id = (SELECT id FROM accounts ORDER BY created_at ASC LIMIT 1)
WHERE account_id IS NULL;
--> statement-breakpoint
UPDATE agent_channel_configs
SET account_id = (SELECT id FROM accounts ORDER BY created_at ASC LIMIT 1)
WHERE account_id IS NULL;
--> statement-breakpoint
ALTER TABLE conversations ALTER COLUMN account_id SET NOT NULL;
--> statement-breakpoint
ALTER TABLE agent_channel_posts ALTER COLUMN account_id SET NOT NULL;
--> statement-breakpoint
ALTER TABLE missions ALTER COLUMN account_id SET NOT NULL;
--> statement-breakpoint
ALTER TABLE mission_reports ALTER COLUMN account_id SET NOT NULL;
--> statement-breakpoint
ALTER TABLE agent_channel_configs ALTER COLUMN account_id SET NOT NULL;
--> statement-breakpoint
CREATE INDEX conversations_account_updated_idx ON conversations (account_id, updated_at);
--> statement-breakpoint
CREATE INDEX agent_posts_account_job_idx ON agent_channel_posts (account_id, job_id);
--> statement-breakpoint
CREATE INDEX missions_account_idx ON missions (account_id);
--> statement-breakpoint
CREATE INDEX mission_reports_account_mission_idx ON mission_reports (account_id, mission_id);
