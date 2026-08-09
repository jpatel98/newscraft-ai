import { eq } from 'drizzle-orm';
import { env } from '$env/dynamic/private';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from './schema';
import { settings } from './schema';
import { runMigrations, type MigrationClient } from './migration-runner';

const testDatabaseUrl = process.env.NEWSCRAFT_TEST_DATABASE_URL || '';
// The explicitly scoped integration-test database wins when supplied, even
// if a developer shell also has a production DATABASE_URL configured.
const configuredDatabaseUrl = testDatabaseUrl || env.DATABASE_URL;
const databaseUrl = configuredDatabaseUrl || 'postgres://invalid:invalid@127.0.0.1:1/invalid';
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

/**
 * Account creation is an ordinary user mutation. It ensures only the new
 * account's membership; organization-wide data repair belongs to 0014 and is
 * never repeated on a normal request.
 */
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
	return orgId;
}

let migrated: Promise<void> | null = null;

/**
 * Compatibility entry point for explicit test/dev/bootstrap commands only.
 * It is intentionally not called from hooks.server.ts or any request handler.
 */
export async function ensureMigrated(): Promise<void> {
	if (!configuredDatabaseUrl) {
		throw new Error('DATABASE_URL is required. Configure a hosted Postgres database before running migrations.');
	}
	if (migrated) return migrated;
	migrated = runMigrations(sql as unknown as MigrationClient, {
		appPasswordHash: env.APP_PASSWORD_HASH || undefined
	}).then(() => undefined);
	try {
		await migrated;
	} catch (error) {
		migrated = null;
		throw error;
	}
}
