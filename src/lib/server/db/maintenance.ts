import { env } from '$env/dynamic/private';
import { appDbPath, sqliteClient } from '$lib/server/db';
import { mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

const DEFAULT_BACKUP_DIR = './data/backups';
const BACKUP_PREFIX = 'hermes-ui-';
const BACKUP_EXTENSION = '.sqlite';
const MIGRATIONS_TABLE = '__drizzle_migrations';
const JOURNAL_PATH = './drizzle/meta/_journal.json';

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
	latest?: {
		id?: number;
		hashPrefix?: string;
		createdAt?: number;
		createdAtIso?: string;
	};
	expected?: {
		count: number;
		latestTag?: string;
		latestWhen?: number;
		latestWhenIso?: string;
	};
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
	metadata?: {
		totalPages?: number;
		remainingPages?: number;
	};
}

interface MigrationRow {
	id?: number | bigint;
	hash?: string;
	created_at?: number | bigint | string;
	createdAt?: number | bigint | string;
}

interface CountRow {
	count?: number | bigint;
}

interface DrizzleJournal {
	entries?: Array<{ tag?: string; when?: number }>;
}

export function configuredDbPath(): string {
	return appDbPath;
}

export function configuredBackupDir(): string {
	return resolve(env.APP_BACKUP_DIR ?? DEFAULT_BACKUP_DIR);
}

export async function getMaintenanceStatus(): Promise<MaintenanceStatus> {
	const dbPath = resolvedDbPath();
	const [file, wal, shm, directory, backupSnapshot, migrations, expected] = await Promise.all([
		fileStatus(dbPath),
		fileStatus(`${dbPath}-wal`),
		fileStatus(`${dbPath}-shm`),
		fileStatus(configuredBackupDir()),
		readBackupSnapshot(),
		readMigrationStatus(),
		readExpectedMigrations()
	]);
	const quickCheck = runPragmaCheck('quick_check');
	const integrityCheck = runPragmaCheck('integrity_check');
	const migrationStatus = { ...migrations, expected };

	return {
		ok: quickCheck.ok && integrityCheck.ok && migrationStatus.ok && !backupSnapshot.error,
		generatedAt: new Date().toISOString(),
		db: {
			path: dbPath,
			configuredPath: configuredDbPath(),
			memory: sqliteClient.memory,
			file,
			wal,
			shm,
			checks: {
				quickCheck,
				integrityCheck
			},
			migrations: migrationStatus
		},
		backups: {
			directory,
			count: backupSnapshot.backups.length,
			latest: backupSnapshot.backups[0] ?? null,
			error: backupSnapshot.error
		},
		build: buildMetadata()
	};
}

export async function listBackups(): Promise<BackupListResult> {
	try {
		const directory = await fileStatus(configuredBackupDir());
		const backups = await readBackups();
		return {
			ok: true,
			directory,
			count: backups.length,
			latest: backups[0] ?? null,
			backups
		};
	} catch {
		return failedBackupList('unable to list backups');
	}
}

export async function createBackup(keep = 7): Promise<CreateBackupResult> {
	try {
		const backupDir = configuredBackupDir();
		await mkdir(backupDir, { recursive: true, mode: 0o700 });
		const destination = await nextBackupPath(backupDir);
		const metadata = await sqliteClient.backup(destination);
		const rotation = await rotateBackups(keep);
		const directory = await fileStatus(backupDir);
		const backups = await readBackups();
		const backup = backups.find((entry) => entry.path === destination) ?? (await backupInfo(destination));

		return {
			ok: rotation.errors.length === 0,
			directory,
			count: backups.length,
			latest: backups[0] ?? null,
			backups,
			backup,
			rotation,
			metadata,
			error: rotation.errors.length > 0 ? 'backup created, but rotation was incomplete' : undefined
		};
	} catch {
		return failedBackupList('unable to create backup');
	}
}

async function fileStatus(path: string): Promise<FileStatus> {
	try {
		const s = await stat(path);
		return {
			path,
			exists: true,
			sizeBytes: s.size,
			modifiedAt: s.mtime.toISOString()
		};
	} catch (e) {
		if (hasCode(e, 'ENOENT')) return { path, exists: false };
		return { path, exists: false, error: publicError(e, 'unable to inspect file') };
	}
}

async function readBackups(): Promise<BackupInfo[]> {
	try {
		const entries = await readdir(configuredBackupDir(), { withFileTypes: true });
		const backups = await Promise.all(
			entries
				.filter((entry) => entry.isFile() && isManagedBackup(entry.name))
				.map((entry) => backupInfo(resolve(configuredBackupDir(), entry.name)))
		);
		return backups.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
	} catch (e) {
		if (hasCode(e, 'ENOENT')) return [];
		throw e;
	}
}

async function readBackupSnapshot(): Promise<{ backups: BackupInfo[]; error?: string }> {
	try {
		return { backups: await readBackups() };
	} catch (e) {
		return { backups: [], error: publicError(e, 'unable to list backups') };
	}
}

async function backupInfo(path: string): Promise<BackupInfo> {
	const s = await stat(path);
	return {
		name: path.split('/').at(-1) ?? path,
		path,
		sizeBytes: s.size,
		createdAt: s.birthtime.toISOString(),
		modifiedAt: s.mtime.toISOString()
	};
}

async function nextBackupPath(backupDir: string): Promise<string> {
	const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
	for (let i = 0; i < 100; i += 1) {
		const suffix = i === 0 ? '' : `-${i}`;
		const path = resolve(backupDir, `${BACKUP_PREFIX}${stamp}${suffix}${BACKUP_EXTENSION}`);
		const status = await fileStatus(path);
		if (!status.exists) return path;
	}
	throw new Error('backup filename collision');
}

async function rotateBackups(keep: number) {
	const backups = await readBackups();
	const stale = backups.slice(Math.max(keep, 0));
	const deleted: string[] = [];
	const errors: Array<{ name: string; error: string }> = [];

	for (const backup of stale) {
		try {
			await rm(backup.path);
			deleted.push(backup.name);
		} catch (e) {
			errors.push({ name: backup.name, error: publicError(e, 'unable to remove old backup') });
		}
	}

	return { keep, deleted, errors };
}

function runPragmaCheck(pragma: 'quick_check' | 'integrity_check'): CheckResult {
	try {
		const messages = sqliteClient.prepare(`PRAGMA ${pragma}`).pluck().all() as string[];
		const ok = messages.length === 1 && messages[0] === 'ok';
		return {
			ok,
			result: ok ? 'ok' : 'issues',
			messages
		};
	} catch (e) {
		return { ok: false, error: publicError(e, `${pragma} failed`) };
	}
}

async function readMigrationStatus(): Promise<Omit<MigrationStatus, 'expected'>> {
	try {
		const tableExists = Boolean(
			sqliteClient
				.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
				.get(MIGRATIONS_TABLE)
		);

		if (!tableExists) {
			return {
				ok: true,
				table: MIGRATIONS_TABLE,
				tableExists: false,
				appliedCount: 0
			};
		}

		const countRow = sqliteClient
			.prepare(`SELECT count(*) AS count FROM "${MIGRATIONS_TABLE}"`)
			.get() as CountRow | undefined;
		const latest = sqliteClient
			.prepare(`SELECT id, hash, created_at FROM "${MIGRATIONS_TABLE}" ORDER BY created_at DESC, id DESC LIMIT 1`)
			.get() as MigrationRow | undefined;

		return {
			ok: true,
			table: MIGRATIONS_TABLE,
			tableExists: true,
			appliedCount: toNumber(countRow?.count) ?? 0,
			latest: normalizeMigrationRow(latest)
		};
	} catch (e) {
		return {
			ok: false,
			table: MIGRATIONS_TABLE,
			tableExists: false,
			error: publicError(e, 'unable to read migration status')
		};
	}
}

async function readExpectedMigrations(): Promise<MigrationStatus['expected']> {
	try {
		const raw = await readFile(resolve(JOURNAL_PATH), 'utf8');
		const journal = JSON.parse(raw) as DrizzleJournal;
		const entries = Array.isArray(journal.entries) ? journal.entries : [];
		const latest = entries.at(-1);
		return {
			count: entries.length,
			latestTag: latest?.tag,
			latestWhen: latest?.when,
			latestWhenIso: latest?.when ? new Date(latest.when).toISOString() : undefined
		};
	} catch {
		return undefined;
	}
}

function normalizeMigrationRow(row: MigrationRow | undefined): MigrationStatus['latest'] {
	if (!row) return undefined;
	const createdAt = toNumber(row.created_at ?? row.createdAt);
	return {
		id: toNumber(row.id),
		hashPrefix: typeof row.hash === 'string' ? row.hash.slice(0, 12) : undefined,
		createdAt,
		createdAtIso: createdAt ? new Date(createdAt).toISOString() : undefined
	};
}

function resolvedDbPath(): string {
	const name = sqliteClient.name || configuredDbPath();
	if (sqliteClient.memory || name === ':memory:') return name;
	return resolve(name);
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

function isManagedBackup(name: string): boolean {
	return name.startsWith(BACKUP_PREFIX) && name.endsWith(BACKUP_EXTENSION);
}

function toNumber(value: number | bigint | string | undefined): number | undefined {
	if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
	if (typeof value === 'bigint') return Number(value);
	if (typeof value === 'string') {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : undefined;
	}
	return undefined;
}

function hasCode(error: unknown, code: string): boolean {
	return (
		typeof error === 'object' &&
		error !== null &&
		'code' in error &&
		(error as { code?: unknown }).code === code
	);
}

function publicError(error: unknown, fallback: string): string {
	if (typeof error === 'object' && error !== null && 'code' in error) {
		const code = (error as { code?: unknown }).code;
		if (typeof code === 'string') return `${fallback} (${code})`;
	}
	return fallback;
}
