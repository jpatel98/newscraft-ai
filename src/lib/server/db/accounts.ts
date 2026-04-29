import { createHash, randomBytes } from 'node:crypto';
import { count, desc, eq } from 'drizzle-orm';
import { hashPassword, verifyHash } from '$lib/server/auth/password';
import { newId } from '$lib/utils/id';
import { db } from './index';
import { accounts } from './schema';

const SETUP_TOKEN_TTL_MS = 1000 * 60 * 60 * 24 * 7;

export interface AccountRow {
	id: string;
	email: string;
	name: string;
	passwordHash: string | null;
	setupTokenHash: string | null;
	setupTokenExpiresAt: number | null;
	createdAt: number;
	updatedAt: number;
	lastLoginAt: number | null;
}

export interface AccountSummary {
	id: string;
	email: string;
	name: string;
	createdAt: number;
	updatedAt: number;
	lastLoginAt: number | null;
	status: 'active' | 'pending';
}

export function normalizeEmail(email: string): string {
	return email.trim().toLowerCase();
}

export function validEmail(email: string): boolean {
	return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export function accountDisplayName(email: string, name: string): string {
	const trimmed = name.trim();
	if (trimmed) return trimmed.slice(0, 80);
	return generatedAccountLabel(email);
}

export function accountCount(): number {
	const row = db.select({ value: count() }).from(accounts).get();
	return Number(row?.value ?? 0);
}

export function listAccounts(): AccountSummary[] {
	return db
		.select()
		.from(accounts)
		.orderBy(desc(accounts.createdAt))
		.all()
		.map((row) => toSummary(row as AccountRow));
}

export function getAccount(id: string): AccountRow | undefined {
	return db.select().from(accounts).where(eq(accounts.id, id)).get() as AccountRow | undefined;
}

export function findAccountByEmail(email: string): AccountRow | undefined {
	const normalized = normalizeEmail(email);
	return db
		.select()
		.from(accounts)
		.where(eq(accounts.email, normalized))
		.get() as AccountRow | undefined;
}

export async function createAccountWithPassword(input: {
	email: string;
	name?: string;
	password: string;
}): Promise<AccountRow> {
	const email = normalizeEmail(input.email);
	const now = Date.now();
	const row: AccountRow = {
		id: newId(),
		email,
		name: accountDisplayName(email, input.name ?? ''),
		passwordHash: await hashPassword(input.password),
		setupTokenHash: null,
		setupTokenExpiresAt: null,
		createdAt: now,
		updatedAt: now,
		lastLoginAt: null
	};
	db.insert(accounts).values(row).run();
	return row;
}

export async function createPasswordOnlyAccount(password: string): Promise<AccountRow> {
	const id = newId();
	const email = generatedAccountEmail(id);
	const now = Date.now();
	const row: AccountRow = {
		id,
		email,
		name: generatedAccountLabel(email),
		passwordHash: await hashPassword(password),
		setupTokenHash: null,
		setupTokenExpiresAt: null,
		createdAt: now,
		updatedAt: now,
		lastLoginAt: null
	};
	db.insert(accounts).values(row).run();
	return row;
}

export function createAccountInvite(input: { email: string; name?: string }): {
	account: AccountRow;
	token: string;
	expiresAt: number;
} {
	const email = normalizeEmail(input.email);
	const now = Date.now();
	const token = randomToken();
	const expiresAt = now + SETUP_TOKEN_TTL_MS;
	const row: AccountRow = {
		id: newId(),
		email,
		name: accountDisplayName(email, input.name ?? ''),
		passwordHash: null,
		setupTokenHash: tokenHash(token),
		setupTokenExpiresAt: expiresAt,
		createdAt: now,
		updatedAt: now,
		lastLoginAt: null
	};
	db.insert(accounts).values(row).run();
	return { account: row, token, expiresAt };
}

export function createPasswordOnlyInvite(): {
	account: AccountRow;
	token: string;
	expiresAt: number;
} {
	const id = newId();
	const email = generatedAccountEmail(id);
	const now = Date.now();
	const token = randomToken();
	const expiresAt = now + SETUP_TOKEN_TTL_MS;
	const row: AccountRow = {
		id,
		email,
		name: generatedAccountLabel(email),
		passwordHash: null,
		setupTokenHash: tokenHash(token),
		setupTokenExpiresAt: expiresAt,
		createdAt: now,
		updatedAt: now,
		lastLoginAt: null
	};
	db.insert(accounts).values(row).run();
	return { account: row, token, expiresAt };
}

export function createPasswordSetupToken(accountId: string): { token: string; expiresAt: number } | null {
	const account = getAccount(accountId);
	if (!account) return null;
	const token = randomToken();
	const expiresAt = Date.now() + SETUP_TOKEN_TTL_MS;
	db.update(accounts)
		.set({
			setupTokenHash: tokenHash(token),
			setupTokenExpiresAt: expiresAt,
			updatedAt: Date.now()
		})
		.where(eq(accounts.id, accountId))
		.run();
	return { token, expiresAt };
}

export function getAccountBySetupToken(token: string): AccountRow | undefined {
	if (!token) return undefined;
	const row = db
		.select()
		.from(accounts)
		.where(eq(accounts.setupTokenHash, tokenHash(token)))
		.get() as AccountRow | undefined;
	if (!row?.setupTokenExpiresAt || row.setupTokenExpiresAt <= Date.now()) return undefined;
	return row;
}

export async function claimSetupToken(token: string, password: string): Promise<AccountRow | undefined> {
	const account = getAccountBySetupToken(token);
	if (!account) return undefined;
	const now = Date.now();
	db.update(accounts)
		.set({
			passwordHash: await hashPassword(password),
			setupTokenHash: null,
			setupTokenExpiresAt: null,
			updatedAt: now
		})
		.where(eq(accounts.id, account.id))
		.run();
	return getAccount(account.id);
}

export async function verifyAccountCredentials(
	email: string,
	password: string
): Promise<AccountRow | undefined> {
	const account = findAccountByEmail(email);
	if (!account?.passwordHash) return undefined;
	const ok = await verifyHash(account.passwordHash, password);
	return ok ? account : undefined;
}

export async function findAccountByPassword(password: string): Promise<AccountRow | undefined> {
	if (!password) return undefined;
	const rows = db.select().from(accounts).all() as AccountRow[];
	for (const account of rows) {
		if (!account.passwordHash) continue;
		if (await verifyHash(account.passwordHash, password)) return account;
	}
	return undefined;
}

export async function updateAccountPassword(accountId: string, password: string): Promise<void> {
	db.update(accounts)
		.set({
			passwordHash: await hashPassword(password),
			setupTokenHash: null,
			setupTokenExpiresAt: null,
			updatedAt: Date.now()
		})
		.where(eq(accounts.id, accountId))
		.run();
}

export function touchAccountLogin(accountId: string): void {
	db.update(accounts).set({ lastLoginAt: Date.now() }).where(eq(accounts.id, accountId)).run();
}

export function deleteAccount(accountId: string): number {
	const result = db.delete(accounts).where(eq(accounts.id, accountId)).run();
	return result.changes ?? 0;
}

function toSummary(row: AccountRow): AccountSummary {
	return {
		id: row.id,
		email: row.email,
		name: row.name,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
		lastLoginAt: row.lastLoginAt,
		status: row.passwordHash ? 'active' : 'pending'
	};
}

function randomToken(): string {
	return randomBytes(32).toString('base64url');
}

function tokenHash(token: string): string {
	return createHash('sha256').update(token).digest('base64url');
}

function generatedAccountEmail(id: string): string {
	return `${id}@accounts.local`;
}

function generatedAccountLabel(email: string): string {
	const stem = email.split('@')[0] || 'account';
	return `Account ${stem.slice(-6).toUpperCase()}`;
}
