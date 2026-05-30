import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL;
const ORIGINAL_HARNESS_DATABASE_URL = process.env.NEWSROOM_HARNESS_DATABASE_URL;

afterEach(() => {
	restoreEnv('DATABASE_URL', ORIGINAL_DATABASE_URL);
	restoreEnv('NEWSROOM_HARNESS_DATABASE_URL', ORIGINAL_HARNESS_DATABASE_URL);
});

describe('harness config', () => {
	it('does not use the UI DATABASE_URL as the harness mirror database', () => {
		process.env.DATABASE_URL = 'postgres://ui-db.example/postgres';
		delete process.env.NEWSROOM_HARNESS_DATABASE_URL;

		expect(loadConfig().databaseUrl).toBe('');
	});

	it('enables Supabase mirroring only with NEWSROOM_HARNESS_DATABASE_URL', () => {
		process.env.DATABASE_URL = 'postgres://ui-db.example/postgres';
		process.env.NEWSROOM_HARNESS_DATABASE_URL = 'postgres://harness-db.example/postgres';

		expect(loadConfig().databaseUrl).toBe('postgres://harness-db.example/postgres');
	});
});

function restoreEnv(key: string, value: string | undefined): void {
	if (value === undefined) delete process.env[key];
	else process.env[key] = value;
}
