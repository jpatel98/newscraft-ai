import { eq } from 'drizzle-orm';
import { env } from '$env/dynamic/private';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from './schema';
import { settings } from './schema';

const databaseUrl = env.DATABASE_URL || 'postgres://invalid:invalid@127.0.0.1:1/invalid';

export const sql = postgres(databaseUrl, {
	max: 1,
	prepare: false
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

let migrated: Promise<void> | null = null;
export async function ensureMigrated(): Promise<void> {
	if (!env.DATABASE_URL) {
		throw new Error('DATABASE_URL is required. Configure a hosted Postgres database before starting NewsCraft.');
	}
	if (migrated) return migrated;
	migrated = (async () => {
		await ensureSchema();
		await ensurePerformanceIndexes();
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
		CREATE TABLE IF NOT EXISTS accounts (
			id text PRIMARY KEY,
			email text NOT NULL,
			name text NOT NULL DEFAULT '',
			password_hash text,
			setup_token_hash text,
			setup_token_expires_at bigint,
			created_at bigint NOT NULL,
			updated_at bigint NOT NULL,
			last_login_at bigint
		)
	`;
	await sql`CREATE UNIQUE INDEX IF NOT EXISTS accounts_email_unique ON accounts (email)`;
	await sql`CREATE INDEX IF NOT EXISTS accounts_setup_token_idx ON accounts (setup_token_hash)`;

	await sql`
		CREATE TABLE IF NOT EXISTS conversations (
			id text PRIMARY KEY,
			account_id text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
			title text NOT NULL DEFAULT '',
			system_prompt text,
			created_at bigint NOT NULL,
			updated_at bigint NOT NULL,
			pinned integer NOT NULL DEFAULT 0
		)
	`;
	await sql`CREATE INDEX IF NOT EXISTS conversations_account_updated_idx ON conversations (account_id, updated_at)`;

	await sql`
		CREATE TABLE IF NOT EXISTS messages (
			id text PRIMARY KEY,
			conversation_id text NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
			role text NOT NULL,
			content text NOT NULL,
			tool_calls text,
			partial integer NOT NULL DEFAULT 0,
			created_at bigint NOT NULL
		)
	`;
	await sql`CREATE INDEX IF NOT EXISTS messages_convo_created_idx ON messages (conversation_id, created_at)`;

	await sql`
		CREATE TABLE IF NOT EXISTS settings (
			key text PRIMARY KEY,
			value text NOT NULL
		)
	`;

	await sql`
		CREATE TABLE IF NOT EXISTS hermes_channel_posts (
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
	await sql`CREATE INDEX IF NOT EXISTS hermes_posts_account_job_idx ON hermes_channel_posts (account_id, job_id)`;
	await sql`CREATE INDEX IF NOT EXISTS hermes_posts_job_run_idx ON hermes_channel_posts (job_id, run_time)`;
	await sql`CREATE INDEX IF NOT EXISTS hermes_posts_path_idx ON hermes_channel_posts (file_path_display)`;

	await sql`
		CREATE TABLE IF NOT EXISTS hermes_channel_configs (
			job_id text PRIMARY KEY,
			account_id text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
			base_prompt text NOT NULL,
			created_at bigint NOT NULL,
			updated_at bigint NOT NULL
		)
	`;

	await sql`
		CREATE TABLE IF NOT EXISTS hermes_channel_sources (
			id text PRIMARY KEY,
			job_id text NOT NULL REFERENCES hermes_channel_configs(job_id) ON DELETE CASCADE,
			type text NOT NULL DEFAULT 'url',
			name text NOT NULL,
			config_json text NOT NULL,
			enabled integer NOT NULL DEFAULT 1,
			sort_order integer NOT NULL DEFAULT 0,
			created_at bigint NOT NULL,
			updated_at bigint NOT NULL
		)
	`;
	await sql`CREATE INDEX IF NOT EXISTS hermes_sources_job_idx ON hermes_channel_sources (job_id, sort_order)`;
	await sql`CREATE INDEX IF NOT EXISTS hermes_sources_type_idx ON hermes_channel_sources (type)`;

	await sql`
		CREATE TABLE IF NOT EXISTS missions (
			id text PRIMARY KEY,
			account_id text NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
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
	await sql`CREATE INDEX IF NOT EXISTS missions_account_idx ON missions (account_id)`;

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
	await sql`CREATE INDEX IF NOT EXISTS mission_reports_account_mission_idx ON mission_reports (account_id, mission_id)`;
	await sql`CREATE INDEX IF NOT EXISTS mission_reports_mission_run_idx ON mission_reports (mission_id, run_time)`;
	await sql`CREATE INDEX IF NOT EXISTS mission_reports_path_idx ON mission_reports (file_path_display)`;
	await sql`CREATE INDEX IF NOT EXISTS mission_reports_legacy_post_idx ON mission_reports (legacy_channel_post_id)`;
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
