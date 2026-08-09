UPDATE accounts SET role = 'member' WHERE role NOT IN ('admin', 'member');
--> statement-breakpoint
UPDATE accounts
SET role = 'admin'
WHERE id = (SELECT id FROM accounts ORDER BY created_at ASC LIMIT 1)
	AND NOT EXISTS (SELECT 1 FROM accounts WHERE role = 'admin');
--> statement-breakpoint
INSERT INTO organizations (id, name, created_at, updated_at)
VALUES ('org_default', 'Newsroom', (extract(epoch FROM clock_timestamp()) * 1000)::bigint, (extract(epoch FROM clock_timestamp()) * 1000)::bigint)
ON CONFLICT (id) DO NOTHING;
--> statement-breakpoint
INSERT INTO organization_members (id, org_id, account_id, role, created_at, updated_at)
SELECT 'org_default:' || accounts.id, 'org_default', accounts.id,
	CASE WHEN accounts.role = 'admin' THEN 'owner' ELSE 'member' END,
	(extract(epoch FROM clock_timestamp()) * 1000)::bigint,
	(extract(epoch FROM clock_timestamp()) * 1000)::bigint
FROM accounts
ON CONFLICT (account_id, org_id) DO NOTHING;
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
UPDATE agent_jobs
SET org_id = 'org_default'
WHERE org_id IS NULL
	AND account_id IN (SELECT account_id FROM organization_members WHERE org_id = 'org_default');
--> statement-breakpoint
UPDATE chat_feedback
SET org_id = 'org_default'
WHERE org_id IS NULL
	AND account_id IN (SELECT account_id FROM organization_members WHERE org_id = 'org_default');
