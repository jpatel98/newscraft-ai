import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/server/auth/password', () => ({
	hashPassword: async (password: string) => `hashed:${password}`,
	verifyHash: async (hash: string, password: string) => hash === `hashed:${password}`
}));

const originalDbPath = process.env.APP_DB_PATH;
let tempDir: string | null = null;
let closeDb: (() => void) | null = null;

async function loadIsolatedAccounts() {
	vi.resetModules();
	tempDir = await mkdtemp(path.join(tmpdir(), 'hermes-ui-accounts-'));
	process.env.APP_DB_PATH = path.join(tempDir, 'app.db');
	vi.doMock('$env/dynamic/private', () => ({ env: process.env }));
	const dbModule = await import('./index');
	closeDb = () => dbModule.sqliteClient.close();
	dbModule.sqliteClient.exec(`
		CREATE TABLE accounts (
			id text PRIMARY KEY NOT NULL,
			email text NOT NULL,
			name text DEFAULT '' NOT NULL,
			password_hash text,
			setup_token_hash text,
			setup_token_expires_at integer,
			created_at integer NOT NULL,
			updated_at integer NOT NULL,
			last_login_at integer
		);
		CREATE UNIQUE INDEX accounts_email_unique ON accounts (email);
		CREATE INDEX accounts_setup_token_idx ON accounts (setup_token_hash);
		CREATE TABLE conversations (
			id text PRIMARY KEY NOT NULL,
			account_id text,
			title text DEFAULT '' NOT NULL,
			system_prompt text,
			created_at integer NOT NULL,
			updated_at integer NOT NULL,
			pinned integer DEFAULT 0 NOT NULL
		);
		CREATE TABLE missions (id text PRIMARY KEY NOT NULL, account_id text);
		CREATE TABLE mission_reports (id text PRIMARY KEY NOT NULL, account_id text);
		CREATE TABLE hermes_channel_configs (job_id text PRIMARY KEY NOT NULL, account_id text);
		CREATE TABLE hermes_channel_posts (id text PRIMARY KEY NOT NULL, account_id text);
	`);
	return import('./accounts');
}

describe('account queries', () => {
	beforeEach(() => {
		closeDb = null;
		tempDir = null;
	});

	afterEach(async () => {
		closeDb?.();
		closeDb = null;
		if (tempDir) await rm(tempDir, { recursive: true, force: true });
		tempDir = null;
		if (originalDbPath === undefined) delete process.env.APP_DB_PATH;
		else process.env.APP_DB_PATH = originalDbPath;
		vi.resetModules();
	});

	it('keeps the cached account count correct across create and delete', async () => {
		const accounts = await loadIsolatedAccounts();

		expect(accounts.accountCount()).toBe(0);
		const first = await accounts.createAccountWithPassword({
			email: 'first@example.com',
			password: 'first-password'
		});
		expect(accounts.accountCount()).toBe(1);

		const second = accounts.createAccountInvite({ email: 'second@example.com' }).account;
		expect(accounts.accountCount()).toBe(2);

		expect(accounts.deleteAccount(first.id)).toBe(1);
		expect(accounts.accountCount()).toBe(1);
		expect(accounts.deleteAccount(first.id)).toBe(0);
		expect(accounts.accountCount()).toBe(1);
		expect(accounts.deleteAccount(second.id)).toBe(1);
		expect(accounts.accountCount()).toBe(0);
	});
});
