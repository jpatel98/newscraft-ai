import { eq } from 'drizzle-orm';
import { env } from '$env/dynamic/private';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from './schema';
import { settings } from './schema';

const databaseUrl = env.DATABASE_URL || 'postgres://invalid:invalid@127.0.0.1:1/invalid';
const poolMax = Number.parseInt(env.DATABASE_POOL_MAX || '', 10);
export const DEFAULT_ORGANIZATION_ID = 'org_default';
const DEFAULT_ORGANIZATION_NAME = 'Newsroom';

export const sql = postgres(databaseUrl, {
	max: Number.isFinite(poolMax) && poolMax > 0 ? poolMax : 5,
	prepare: false,
	onnotice: () => {}
});
export const db = drizzle(sql, { schema }) as any;

export async function getSetting(key: string): Promise<string | undefined> {
	const [row] = await db.select().from(settings).where(eq(settings.key, key)).limit(1);
	return row?.value;
}

export async function setSetting(key: string, value: string): Promise<void> {
	await db.insert(settings)
		.values({ key, value })
		.onConflictDoUpdate({ target: settings.key, set: { value } });
}

export async function ensureDefaultOrganization(): Promise<string> {
	const now = Date.now();
	await sql`
		INSERT INTO organizations (id, name, created_at, updated_at)
		VALUES (${DEFAULT_ORGANIZATION_ID}, ${DEFAULT_ORGANIZATION_NAME}, ${now}, ${now})
		ON CONFLICT (id) DO NOTHING
	`;
	return DEFAULT_ORGANIZATION_ID;
}

export async function ensureDefaultOrganizationForAccount(
	accountId: string,
	role: 'owner' | 'admin' | 'member' = 'member'
): Promise<string> {
	if (!accountId) return ensureDefaultOrganization();
	const orgId = await ensureDefaultOrganization();
	const now = Date.now();
	await sql`
		INSERT INTO organization_members (id, org_id, account_id, role, created_at, updated_at)
		VALUES (${`${orgId}:${accountId}`}, ${orgId}, ${accountId}, ${role}, ${now}, ${now})
		ON CONFLICT (account_id, org_id) DO UPDATE
		SET
			role = CASE
				WHEN organization_members.role = 'owner' THEN organization_members.role
				ELSE EXCLUDED.role
			END,
			updated_at = EXCLUDED.updated_at
	`;
	await backfillAccountOrganizationData(accountId, orgId);
	return orgId;
}

let migrated: Promise<void> | null = null;
export async function ensureMigrated(): Promise<void> {
	if (!env.DATABASE_URL) {
		throw new Error('DATABASE_URL is required. Configure a hosted Postgres database before starting NewsCraft.');
	}
	if (migrated) return migrated;
	migrated = (async () => {
		await ensureSchema();
		await ensurePerformanceIndexes();
		await ensureDefaultOrganizationData();
		// One-time migration: copy APP_PASSWORD_HASH from env into settings so a
		// running process can rotate the password without a redeploy.
		if (!(await getSetting('auth.password_hash')) && env.APP_PASSWORD_HASH) {
			await setSetting('auth.password_hash', env.APP_PASSWORD_HASH);
		}
	})();
	await migrated;
}

async function ensureSchema(): Promise<void> {
	await sql`
		CREATE TABLE IF NOT EXISTS organizations (
			id text PRIMARY KEY,
			name text NOT NULL DEFAULT 'Newsroom',
			created_at bigint NOT NULL,
			updated_at bigint NOT NULL
		)
	`;

	await sql`
		CREATE TABLE IF NOT EXISTS accounts (
			id text PRIMARY KEY,
			email text NOT NULL,
			name text NOT NULL DEFAULT '',
			role text NOT NULL DEFAULT 'member',
			password_hash text,
			setup_token_hash text,
			setup_token_expires_at bigint,
			created_at bigint NOT NULL,
			updated_at bigint NOT NULL,
			last_login_at bigint
		)
	`;
	await sql`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'member'`;
	await sql`UPDATE accounts SET role = 'member' WHERE role NOT IN ('admin', 'member')`;
	await sql`
		UPDATE accounts
		SET role = 'admin'
		WHERE id = (SELECT id FROM accounts ORDER BY created_at ASC LIMIT 1)
			AND NOT EXISTS (SELECT 1 FROM accounts WHERE role = 'admin')
	`;
	await sql`CREATE UNIQUE INDEX IF NOT EXISTS accounts_email_unique ON accounts (email)`;
	await sql`CREATE INDEX IF NOT EXISTS accounts_setup_token_idx ON accounts (setup_token_hash)`;

	await sql`
		CREATE TABLE IF NOT EXISTS organization_members (
			id text PRIMARY KEY,
			org_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
			account_id text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
			role text NOT NULL DEFAULT 'member',
			created_at bigint NOT NULL,
			updated_at bigint NOT NULL
		)
	`;
	await sql`
		CREATE UNIQUE INDEX IF NOT EXISTS organization_members_account_org_unique
			ON organization_members (account_id, org_id)
	`;
	await sql`CREATE INDEX IF NOT EXISTS organization_members_org_idx ON organization_members (org_id)`;
	await sql`CREATE INDEX IF NOT EXISTS organization_members_account_idx ON organization_members (account_id)`;

	await sql`
		CREATE TABLE IF NOT EXISTS sessions (
			id text PRIMARY KEY,
			account_id text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
			created_at bigint NOT NULL,
			expires_at bigint NOT NULL,
			revoked_at bigint,
			last_seen_at bigint
		)
	`;
	await sql`CREATE INDEX IF NOT EXISTS sessions_account_idx ON sessions (account_id)`;
	await sql`CREATE INDEX IF NOT EXISTS sessions_expires_idx ON sessions (expires_at)`;

	await sql`
		CREATE TABLE IF NOT EXISTS conversations (
			id text PRIMARY KEY,
			account_id text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
			org_id text REFERENCES organizations(id) ON DELETE SET NULL,
			title text NOT NULL DEFAULT '',
			system_prompt text,
			created_at bigint NOT NULL,
			updated_at bigint NOT NULL,
			pinned integer NOT NULL DEFAULT 0
		)
	`;
	await sql`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS org_id text REFERENCES organizations(id) ON DELETE SET NULL`;
	await sql`CREATE INDEX IF NOT EXISTS conversations_account_updated_idx ON conversations (account_id, updated_at)`;
	await sql`CREATE INDEX IF NOT EXISTS conversations_org_updated_idx ON conversations (org_id, updated_at)`;

	await sql`
		CREATE TABLE IF NOT EXISTS messages (
			id text PRIMARY KEY,
			conversation_id text NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
			role text NOT NULL,
			content text NOT NULL,
			tool_calls text,
			partial integer NOT NULL DEFAULT 0,
			resume_claimed_at bigint,
			created_at bigint NOT NULL
		)
	`;
	await sql`ALTER TABLE messages ADD COLUMN IF NOT EXISTS resume_claimed_at bigint`;
	await sql`CREATE INDEX IF NOT EXISTS messages_convo_created_idx ON messages (conversation_id, created_at)`;
	await sql`CREATE INDEX IF NOT EXISTS messages_partial_claim_idx ON messages (partial, resume_claimed_at)`;

	await sql`
		CREATE TABLE IF NOT EXISTS message_provenance (
			message_id text PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
			conversation_id text NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
			provenance_json text NOT NULL,
			created_at bigint NOT NULL,
			updated_at bigint NOT NULL
		)
	`;
	await sql`CREATE INDEX IF NOT EXISTS message_provenance_conversation_updated_idx ON message_provenance (conversation_id, updated_at)`;

	await sql`
		CREATE TABLE IF NOT EXISTS chat_feedback (
			id text PRIMARY KEY,
			account_id text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
			org_id text REFERENCES organizations(id) ON DELETE SET NULL,
			conversation_id text NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
			comment text NOT NULL,
			snapshot_json text NOT NULL,
			linear_issue_id text,
			linear_issue_identifier text,
			linear_issue_url text,
			user_agent text,
			created_at bigint NOT NULL
		)
	`;
	await sql`ALTER TABLE chat_feedback ADD COLUMN IF NOT EXISTS org_id text REFERENCES organizations(id) ON DELETE SET NULL`;
	await sql`ALTER TABLE chat_feedback ADD COLUMN IF NOT EXISTS linear_issue_id text`;
	await sql`ALTER TABLE chat_feedback ADD COLUMN IF NOT EXISTS linear_issue_identifier text`;
	await sql`ALTER TABLE chat_feedback ADD COLUMN IF NOT EXISTS linear_issue_url text`;
	await sql`CREATE INDEX IF NOT EXISTS chat_feedback_account_created_idx ON chat_feedback (account_id, created_at)`;
	await sql`CREATE INDEX IF NOT EXISTS chat_feedback_org_created_idx ON chat_feedback (org_id, created_at)`;
	await sql`CREATE INDEX IF NOT EXISTS chat_feedback_conversation_created_idx ON chat_feedback (conversation_id, created_at)`;

	await sql`
		CREATE TABLE IF NOT EXISTS chat_diagnostics (
			id text PRIMARY KEY,
			conversation_id text NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
			type text NOT NULL,
			details_json text NOT NULL,
			created_at bigint NOT NULL
		)
	`;
	await sql`CREATE INDEX IF NOT EXISTS chat_diagnostics_conversation_created_idx ON chat_diagnostics (conversation_id, created_at)`;
	await sql`CREATE INDEX IF NOT EXISTS chat_diagnostics_type_created_idx ON chat_diagnostics (type, created_at)`;

	await sql`
		CREATE TABLE IF NOT EXISTS settings (
			key text PRIMARY KEY,
			value text NOT NULL
		)
	`;

	await sql`
		CREATE TABLE IF NOT EXISTS agent_channel_posts (
			id text PRIMARY KEY,
			account_id text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
			job_id text NOT NULL,
			channel text NOT NULL,
			run_time text,
			schedule text,
			filename text NOT NULL,
			file_path_display text NOT NULL,
			response_markdown text NOT NULL,
			preview text NOT NULL,
			source_mtime_ms bigint NOT NULL DEFAULT 0,
			created_at bigint NOT NULL,
			updated_at bigint NOT NULL
		)
	`;
	await sql`CREATE INDEX IF NOT EXISTS agent_posts_account_job_idx ON agent_channel_posts (account_id, job_id)`;
	await sql`CREATE INDEX IF NOT EXISTS agent_posts_job_run_idx ON agent_channel_posts (job_id, run_time)`;
	await sql`CREATE INDEX IF NOT EXISTS agent_posts_path_idx ON agent_channel_posts (file_path_display)`;

	await sql`
		CREATE TABLE IF NOT EXISTS agent_channel_configs (
			job_id text PRIMARY KEY,
			account_id text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
			base_prompt text NOT NULL,
			created_at bigint NOT NULL,
			updated_at bigint NOT NULL
		)
	`;

	await sql`
		CREATE TABLE IF NOT EXISTS agent_channel_sources (
			id text PRIMARY KEY,
			job_id text NOT NULL REFERENCES agent_channel_configs(job_id) ON DELETE CASCADE,
			type text NOT NULL DEFAULT 'url',
			name text NOT NULL,
			config_json text NOT NULL,
			enabled integer NOT NULL DEFAULT 1,
			sort_order integer NOT NULL DEFAULT 0,
			created_at bigint NOT NULL,
			updated_at bigint NOT NULL
		)
	`;
	await sql`CREATE INDEX IF NOT EXISTS agent_sources_job_idx ON agent_channel_sources (job_id, sort_order)`;
	await sql`CREATE INDEX IF NOT EXISTS agent_sources_type_idx ON agent_channel_sources (type)`;

	await sql`
		CREATE TABLE IF NOT EXISTS missions (
			id text PRIMARY KEY,
			account_id text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
			org_id text REFERENCES organizations(id) ON DELETE SET NULL,
			name text NOT NULL,
			description text NOT NULL DEFAULT '',
			prompt text NOT NULL,
			schedule text NOT NULL,
			enabled integer NOT NULL DEFAULT 1,
			delivery_target text NOT NULL DEFAULT 'database',
			output_format text NOT NULL DEFAULT 'markdown',
			backend_job_id text NOT NULL,
			created_at bigint NOT NULL,
			updated_at bigint NOT NULL
		)
	`;
	await sql`ALTER TABLE missions ADD COLUMN IF NOT EXISTS org_id text REFERENCES organizations(id) ON DELETE SET NULL`;
	await sql`CREATE INDEX IF NOT EXISTS missions_account_idx ON missions (account_id)`;
	await sql`CREATE INDEX IF NOT EXISTS missions_org_idx ON missions (org_id)`;

	await sql`
		CREATE TABLE IF NOT EXISTS mission_sources (
			id text PRIMARY KEY,
			mission_id text NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
			type text NOT NULL DEFAULT 'url',
			name text NOT NULL,
			config_json text NOT NULL,
			enabled integer NOT NULL DEFAULT 1,
			sort_order integer NOT NULL DEFAULT 0,
			created_at bigint NOT NULL,
			updated_at bigint NOT NULL
		)
	`;
	await sql`CREATE INDEX IF NOT EXISTS mission_sources_mission_idx ON mission_sources (mission_id, sort_order)`;
	await sql`CREATE INDEX IF NOT EXISTS mission_sources_type_idx ON mission_sources (type)`;

	await sql`
		CREATE TABLE IF NOT EXISTS mission_runs (
			id text PRIMARY KEY,
			mission_id text NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
			status text NOT NULL,
			started_at text,
			completed_at text,
			elapsed_ms bigint,
			last_error text,
			created_at bigint NOT NULL,
			updated_at bigint NOT NULL
		)
	`;
	await sql`CREATE INDEX IF NOT EXISTS mission_runs_mission_started_idx ON mission_runs (mission_id, started_at)`;

	await sql`
		CREATE TABLE IF NOT EXISTS mission_reports (
			id text PRIMARY KEY,
			account_id text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
			org_id text REFERENCES organizations(id) ON DELETE SET NULL,
			mission_id text NOT NULL,
			mission_name text NOT NULL,
			run_time text,
			schedule text,
			filename text NOT NULL,
			file_path_display text NOT NULL,
			output_format text NOT NULL DEFAULT 'markdown',
			response_markdown text NOT NULL,
			preview text NOT NULL,
			source_mtime_ms bigint NOT NULL DEFAULT 0,
			legacy_channel_post_id text,
			created_at bigint NOT NULL,
			updated_at bigint NOT NULL
		)
	`;
	await sql`ALTER TABLE mission_reports ADD COLUMN IF NOT EXISTS org_id text REFERENCES organizations(id) ON DELETE SET NULL`;
	await sql`CREATE INDEX IF NOT EXISTS mission_reports_account_mission_idx ON mission_reports (account_id, mission_id)`;
	await sql`CREATE INDEX IF NOT EXISTS mission_reports_org_updated_idx ON mission_reports (org_id, updated_at)`;
	await sql`CREATE INDEX IF NOT EXISTS mission_reports_mission_run_idx ON mission_reports (mission_id, run_time)`;
	await sql`CREATE INDEX IF NOT EXISTS mission_reports_path_idx ON mission_reports (file_path_display)`;
	await sql`CREATE INDEX IF NOT EXISTS mission_reports_legacy_post_idx ON mission_reports (legacy_channel_post_id)`;

	await sql`
		CREATE TABLE IF NOT EXISTS agent_jobs (
			id text PRIMARY KEY,
			account_id text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
			org_id text REFERENCES organizations(id) ON DELETE SET NULL,
			state text NOT NULL DEFAULT 'queued',
			last_run_id text,
			last_run_at bigint,
			last_error text,
			created_at bigint NOT NULL,
			updated_at bigint NOT NULL
		)
	`;
	await sql`CREATE INDEX IF NOT EXISTS agent_jobs_account_job_idx ON agent_jobs (account_id, id)`;
	await sql`CREATE INDEX IF NOT EXISTS agent_jobs_state_idx ON agent_jobs (state)`;
	await sql`CREATE INDEX IF NOT EXISTS agent_jobs_org_idx ON agent_jobs (org_id)`;
}

async function ensurePerformanceIndexes(): Promise<void> {
	await sql`
		CREATE INDEX IF NOT EXISTS conversations_account_pinned_updated_idx
			ON conversations (account_id, pinned, updated_at)
	`;
	await sql`
		CREATE INDEX IF NOT EXISTS mission_reports_account_updated_idx
			ON mission_reports (account_id, updated_at)
	`;
}

async function ensureDefaultOrganizationData(): Promise<void> {
	const orgId = await ensureDefaultOrganization();
	const now = Date.now();
	await sql`
		INSERT INTO organization_members (id, org_id, account_id, role, created_at, updated_at)
		SELECT ${`${orgId}:`} || accounts.id, ${orgId}, accounts.id,
			CASE WHEN accounts.role = 'admin' THEN 'owner' ELSE 'member' END,
			${now}, ${now}
		FROM accounts
		ON CONFLICT (account_id, org_id) DO NOTHING
	`;
	await backfillOrganizationData(orgId);
}

async function backfillOrganizationData(orgId: string): Promise<void> {
	await sql`
		UPDATE conversations
		SET org_id = ${orgId}
		WHERE org_id IS NULL AND account_id IN (
			SELECT account_id FROM organization_members WHERE org_id = ${orgId}
		)
	`;
	await sql`
		UPDATE missions
		SET org_id = ${orgId}
		WHERE org_id IS NULL AND account_id IN (
			SELECT account_id FROM organization_members WHERE org_id = ${orgId}
		)
	`;
	await sql`
		UPDATE mission_reports
		SET org_id = ${orgId}
		WHERE org_id IS NULL AND account_id IN (
			SELECT account_id FROM organization_members WHERE org_id = ${orgId}
		)
	`;
	await sql`
		UPDATE agent_jobs
		SET org_id = ${orgId}
		WHERE org_id IS NULL AND account_id IN (
			SELECT account_id FROM organization_members WHERE org_id = ${orgId}
		)
	`;
	await sql`
		UPDATE chat_feedback
		SET org_id = ${orgId}
		WHERE org_id IS NULL AND account_id IN (
			SELECT account_id FROM organization_members WHERE org_id = ${orgId}
		)
	`;
}

async function backfillAccountOrganizationData(accountId: string, orgId: string): Promise<void> {
	await sql`UPDATE conversations SET org_id = ${orgId} WHERE org_id IS NULL AND account_id = ${accountId}`;
	await sql`UPDATE missions SET org_id = ${orgId} WHERE org_id IS NULL AND account_id = ${accountId}`;
	await sql`UPDATE mission_reports SET org_id = ${orgId} WHERE org_id IS NULL AND account_id = ${accountId}`;
	await sql`UPDATE agent_jobs SET org_id = ${orgId} WHERE org_id IS NULL AND account_id = ${accountId}`;
	await sql`UPDATE chat_feedback SET org_id = ${orgId} WHERE org_id IS NULL AND account_id = ${accountId}`;
}
