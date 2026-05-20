import { env } from '$env/dynamic/private';
import { sql } from '$lib/server/db';
import { resolve } from 'node:path';

const DEFAULT_BACKUP_DIR = './data/backups';

export interface FileStatus {
	path: string;
	exists: boolean;
	sizeBytes?: number;
	modifiedAt?: string;
	error?: string;
}

export interface BackupInfo {
	name: string;
	path: string;
	sizeBytes: number;
	createdAt: string;
	modifiedAt: string;
}

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
		file: FileStatus;
		wal: FileStatus;
		shm: FileStatus;
		checks: {
			quickCheck: CheckResult;
			integrityCheck: CheckResult;
		};
		migrations: MigrationStatus;
	};
	backups: {
		directory: FileStatus;
		count: number;
		latest: BackupInfo | null;
		error?: string;
	};
	build: Record<string, string>;
}

export interface BackupListResult {
	ok: boolean;
	directory: FileStatus;
	count: number;
	latest: BackupInfo | null;
	backups: BackupInfo[];
	error?: string;
}

export interface CreateBackupResult extends BackupListResult {
	backup?: BackupInfo;
	rotation?: {
		keep: number;
		deleted: string[];
		errors: Array<{ name: string; error: string }>;
	};
	metadata?: Record<string, never>;
}

export function configuredDbPath(): string {
	return env.DATABASE_URL ? 'Postgres DATABASE_URL' : 'missing DATABASE_URL';
}

export function configuredBackupDir(): string {
	return resolve(env.APP_BACKUP_DIR ?? DEFAULT_BACKUP_DIR);
}

export async function getMaintenanceStatus(): Promise<MaintenanceStatus> {
	const check = await postgresCheck();
	const directory = { path: configuredBackupDir(), exists: false, error: 'file backups are disabled on Vercel' };
	return {
		ok: check.ok,
		generatedAt: new Date().toISOString(),
		db: {
			path: configuredDbPath(),
			configuredPath: configuredDbPath(),
			memory: false,
			file: { path: configuredDbPath(), exists: true },
			wal: { path: '', exists: false },
			shm: { path: '', exists: false },
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
		backups: {
			directory,
			count: 0,
			latest: null,
			error: 'Use hosted Postgres backups/exports for production.'
		},
		build: buildMetadata()
	};
}

export async function listBackups(): Promise<BackupListResult> {
	return failedBackupList('file backups are disabled for hosted Postgres');
}

export async function createBackup(keep = 7): Promise<CreateBackupResult> {
	return {
		...failedBackupList('file backups are disabled for hosted Postgres'),
		rotation: { keep, deleted: [], errors: [] },
		metadata: {}
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

function failedBackupList(error: string): BackupListResult {
	return {
		ok: false,
		directory: {
			path: configuredBackupDir(),
			exists: false
		},
		count: 0,
		latest: null,
		backups: [],
		error
	};
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
