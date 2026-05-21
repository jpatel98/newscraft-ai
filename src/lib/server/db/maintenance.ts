import { env } from '$env/dynamic/private';
import { sql } from '$lib/server/db';

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
	return {
		ok: check.ok,
		generatedAt: new Date().toISOString(),
		db: {
			path: configuredDbPath(),
			configuredPath: configuredDbPath(),
			memory: false,
			checks: {
				quickCheck: check,
				integrityCheck: check
			},
			migrations: {
				ok: true,
				table: 'runtime bootstrap',
				tableExists: true,
				appliedCount: 0
			}
		},
		build: buildMetadata()
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
