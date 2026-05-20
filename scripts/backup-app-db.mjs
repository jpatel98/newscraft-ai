#!/usr/bin/env node
import Database from 'better-sqlite3';
import { config as loadEnv } from 'dotenv';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

loadEnv({ path: '.env.local', override: false, quiet: true });
loadEnv({ path: '.env', override: false, quiet: true });

const dbPath = process.env.APP_DB_PATH || './data/app.db';
const backupDir = process.env.APP_BACKUP_DIR || './data/backups';
const keep = positiveInt(process.env.APP_BACKUP_KEEP, 7);
const prefix = 'hermes-ui-';
const extension = '.sqlite';

if (dbPath === ':memory:') {
	console.log('Skipping backup for in-memory APP_DB_PATH.');
	process.exit(0);
}

const resolvedDbPath = path.resolve(dbPath);
if (!existsSync(resolvedDbPath)) {
	console.log(`Skipping backup; database does not exist yet at ${resolvedDbPath}.`);
	process.exit(0);
}

await mkdir(backupDir, { recursive: true, mode: 0o700 });
const destination = await nextBackupPath(backupDir);
const db = new Database(resolvedDbPath, { readonly: true, fileMustExist: true });
try {
	db.pragma('busy_timeout = 5000');
	await db.backup(destination);
} finally {
	db.close();
}

const rotation = await rotateBackups(backupDir, keep);
console.log(`OK: backed up ${resolvedDbPath} to ${destination}`);
if (rotation.deleted.length > 0) {
	console.log(`Rotated ${rotation.deleted.length} old backup(s): ${rotation.deleted.join(', ')}`);
}
if (rotation.errors.length > 0) {
	console.error(`WARNING: ${rotation.errors.length} old backup(s) could not be removed.`);
	process.exitCode = 1;
}

function positiveInt(value, fallback) {
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : fallback;
}

async function nextBackupPath(dir) {
	const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
	for (let i = 0; i < 100; i += 1) {
		const suffix = i === 0 ? '' : `-${i}`;
		const candidate = path.resolve(dir, `${prefix}${stamp}${suffix}${extension}`);
		if (!existsSync(candidate)) return candidate;
	}
	throw new Error('backup filename collision');
}

async function rotateBackups(dir, keepCount) {
	const backups = await listBackups(dir);
	const stale = backups.slice(keepCount);
	const deleted = [];
	const errors = [];
	for (const backup of stale) {
		try {
			await rm(backup.path);
			deleted.push(backup.name);
		} catch (err) {
			errors.push({ name: backup.name, error: err instanceof Error ? err.message : String(err) });
		}
	}
	return { deleted, errors };
}

async function listBackups(dir) {
	const entries = await readdir(dir, { withFileTypes: true });
	const backups = await Promise.all(
		entries
			.filter((entry) => entry.isFile() && entry.name.startsWith(prefix) && entry.name.endsWith(extension))
			.map(async (entry) => {
				const backupPath = path.resolve(dir, entry.name);
				const info = await stat(backupPath);
				return { name: entry.name, path: backupPath, modifiedAt: info.mtimeMs };
			})
	);
	return backups.sort((a, b) => b.modifiedAt - a.modifiedAt);
}
