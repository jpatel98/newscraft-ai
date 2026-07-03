CREATE TABLE IF NOT EXISTS organizations (
	id text PRIMARY KEY,
	name text NOT NULL DEFAULT 'Newsroom',
	created_at bigint NOT NULL,
	updated_at bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS organization_members (
	id text PRIMARY KEY,
	org_id text NOT NULL REFERENCES organizations(id) ON DELETE cascade,
	account_id text NOT NULL REFERENCES accounts(id) ON DELETE cascade,
	role text NOT NULL DEFAULT 'member',
	created_at bigint NOT NULL,
	updated_at bigint NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS organization_members_account_org_unique ON organization_members (account_id, org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS organization_members_org_idx ON organization_members (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS organization_members_account_idx ON organization_members (account_id);
--> statement-breakpoint
INSERT INTO organizations (id, name, created_at, updated_at)
VALUES ('org_default', 'Newsroom', 1783122060000, 1783122060000)
ON CONFLICT (id) DO NOTHING;
--> statement-breakpoint
INSERT INTO organization_members (id, org_id, account_id, role, created_at, updated_at)
SELECT 'org_default:' || accounts.id, 'org_default', accounts.id,
	CASE WHEN accounts.role = 'admin' THEN 'owner' ELSE 'member' END,
	1783122060000, 1783122060000
FROM accounts
ON CONFLICT (account_id, org_id) DO NOTHING;
--> statement-breakpoint
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS org_id text REFERENCES organizations(id) ON DELETE set null;
--> statement-breakpoint
ALTER TABLE missions ADD COLUMN IF NOT EXISTS org_id text REFERENCES organizations(id) ON DELETE set null;
--> statement-breakpoint
ALTER TABLE mission_reports ADD COLUMN IF NOT EXISTS org_id text REFERENCES organizations(id) ON DELETE set null;
--> statement-breakpoint
ALTER TABLE chat_feedback ADD COLUMN IF NOT EXISTS org_id text REFERENCES organizations(id) ON DELETE set null;
--> statement-breakpoint
UPDATE conversations
SET org_id = 'org_default'
WHERE org_id IS NULL
	AND account_id IN (SELECT account_id FROM organization_members WHERE org_id = 'org_default');
--> statement-breakpoint
UPDATE missions
SET org_id = 'org_default'
WHERE org_id IS NULL
	AND account_id IN (SELECT account_id FROM organization_members WHERE org_id = 'org_default');
--> statement-breakpoint
UPDATE mission_reports
SET org_id = 'org_default'
WHERE org_id IS NULL
	AND account_id IN (SELECT account_id FROM organization_members WHERE org_id = 'org_default');
--> statement-breakpoint
UPDATE chat_feedback
SET org_id = 'org_default'
WHERE org_id IS NULL
	AND account_id IN (SELECT account_id FROM organization_members WHERE org_id = 'org_default');
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS conversations_org_updated_idx ON conversations (org_id, updated_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS missions_org_idx ON missions (org_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS mission_reports_org_updated_idx ON mission_reports (org_id, updated_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS chat_feedback_org_created_idx ON chat_feedback (org_id, created_at);
