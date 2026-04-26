import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { eq } from 'drizzle-orm';
import { env } from '$env/dynamic/private';
import * as schema from './schema';
import { settings } from './schema';

const dbPath = env.APP_DB_PATH ?? './data/app.db';
const dir = dirname(dbPath);
if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });

const sqlite = new Database(dbPath);
sqlite.pragma('journal_mode = WAL');
sqlite.pragma('synchronous = NORMAL');
sqlite.pragma('foreign_keys = ON');

export const db = drizzle(sqlite, { schema });

export function getSetting(key: string): string | undefined {
	const row = db.select().from(settings).where(eq(settings.key, key)).get();
	return row?.value;
}

export function setSetting(key: string, value: string) {
	db.insert(settings)
		.values({ key, value })
		.onConflictDoUpdate({ target: settings.key, set: { value } })
		.run();
}

let migrated = false;
export function ensureMigrated() {
	if (migrated) return;
	migrate(db, { migrationsFolder: './drizzle' });
	// One-time migration: copy APP_PASSWORD_HASH from env into settings so a
	// running process can rotate the password without an SSH/restart cycle.
	if (!getSetting('auth.password_hash') && env.APP_PASSWORD_HASH) {
		setSetting('auth.password_hash', env.APP_PASSWORD_HASH);
	}
	migrated = true;
}
