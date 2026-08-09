import { env } from '$env/dynamic/private';
import { sql } from '$lib/server/db';
import { EXPECTED_MIGRATION_COUNT, MIGRATION_TABLE, MIGRATION_VERSIONS } from './migration-contract';

interface CheckResult {
	ok: boolean;
	result?: string;
	messages?: string[];
	error?: string;
}

interface MigrationStatus {
	ok: boolean;
	table: string;
	tableExists: boolean;
	appliedCount?: number;
	latest?: string;
	expectedCount: number;
	error?: string;
}

export interface MaintenanceStatus {
	ok: boolean;
	generatedAt: string;
	db: {
		path: string;
		configuredPath: string;
		memory: boolean;
		checks: {
			quickCheck: CheckResult;
			integrityCheck: CheckResult;
		};
		migrations: MigrationStatus;
	};
	build: Record<string, string>;
}

function configuredDbPath(): string {
	return env.DATABASE_URL ? 'Postgres DATABASE_URL' : 'missing DATABASE_URL';
}

export async function getMaintenanceStatus(): Promise<MaintenanceStatus> {
	const check = await postgresCheck();
	const migrations = check.ok ? await migrationStatus() : missingMigrationStatus('Postgres check failed');
	return {
		ok: check.ok && migrations.ok,
		generatedAt: new Date().toISOString(),
		db: {
			path: configuredDbPath(),
			configuredPath: configuredDbPath(),
			memory: false,
			checks: {
				quickCheck: check,
				integrityCheck: check
			},
			migrations
		},
		build: buildMetadata()
	};
}

async function migrationStatus(): Promise<MigrationStatus> {
	try {
		const [table] = await sql.unsafe<Array<{ name: string | null }>>(
			`SELECT to_regclass('public.${MIGRATION_TABLE}')::text AS name`
		);
		if (!table?.name) return missingMigrationStatus('Migration table is not initialized');
		const [row] = await sql.unsafe<Array<{ applied_count: number; latest: string | null }>>(
			`SELECT count(*)::int AS applied_count, max(version) AS latest FROM "${MIGRATION_TABLE}"`
		);
		const appliedCount = Number(row?.applied_count ?? 0);
		return {
			ok: appliedCount >= EXPECTED_MIGRATION_COUNT,
			table: MIGRATION_TABLE,
			tableExists: true,
			appliedCount,
			latest: row?.latest ?? undefined,
			expectedCount: EXPECTED_MIGRATION_COUNT,
			...(appliedCount >= EXPECTED_MIGRATION_COUNT ? {} : { error: 'Schema migrations are incomplete' })
		};
	} catch {
		return missingMigrationStatus('Migration status query failed');
	}
}

function missingMigrationStatus(error: string): MigrationStatus {
	return {
		ok: false,
		table: MIGRATION_TABLE,
		tableExists: false,
		appliedCount: 0,
		latest: MIGRATION_VERSIONS[0],
		expectedCount: EXPECTED_MIGRATION_COUNT,
		error
	};
}

async function postgresCheck(): Promise<CheckResult> {
	try {
		await sql`SELECT 1`;
		return { ok: true, result: 'ok', messages: ['Postgres reachable'] };
	} catch {
		return { ok: false, error: 'Postgres check failed' };
	}
}

function buildMetadata(): Record<string, string> {
	const source = {
		version: process.env.npm_package_version,
		name: process.env.npm_package_name,
		buildId: process.env.BUILD_ID,
		buildTime: process.env.BUILD_TIME,
		commit:
			process.env.VERCEL_GIT_COMMIT_SHA ??
			process.env.NETLIFY_COMMIT_REF ??
			process.env.CF_PAGES_COMMIT_SHA ??
			process.env.SOURCE_VERSION ??
			process.env.GIT_COMMIT ??
			process.env.COMMIT_SHA
	};
	return Object.fromEntries(Object.entries(source).filter((entry): entry is [string, string] => Boolean(entry[1])));
}
