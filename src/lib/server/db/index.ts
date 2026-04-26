import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { env } from '$env/dynamic/private';
import * as schema from './schema';

const dbPath = env.APP_DB_PATH ?? './data/app.db';
const dir = dirname(dbPath);
if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });

const sqlite = new Database(dbPath);
sqlite.pragma('journal_mode = WAL');
sqlite.pragma('synchronous = NORMAL');
sqlite.pragma('foreign_keys = ON');

export const sqliteClient = sqlite;
export const db = drizzle(sqlite, { schema });

let migrated = false;
export function ensureMigrated() {
	if (migrated) return;
	migrate(db, { migrationsFolder: './drizzle' });
	migrated = true;
}
