import { createHash, randomBytes } from 'node:crypto';
import { count, desc, eq, isNull } from 'drizzle-orm';
import { hashPassword, verifyHash } from '$lib/server/auth/password';
import { newId } from '$lib/utils/id';
import { db } from './index';
import { accounts, conversations, agentChannelConfigs, agentChannelPosts, missionReports, missions } from './schema';

const SETUP_TOKEN_TTL_MS = 1000 * 60 * 60 * 24 * 7;
let cachedAccountCount: number | null = null;

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

export async function accountCount(): Promise<number> {
	if (cachedAccountCount !== null) return cachedAccountCount;
	const [row] = await db.select({ value: count() }).from(accounts).limit(1);
	cachedAccountCount = Number(row?.value ?? 0);
	return cachedAccountCount;
}

export async function listAccounts(): Promise<AccountSummary[]> {
	return (await db
		.select()
		.from(accounts)
		.orderBy(desc(accounts.createdAt)))
		.map((row: AccountRow) => toSummary(row));
}

export async function getAccount(id: string): Promise<AccountRow | undefined> {
	const [row] = (await db.select().from(accounts).where(eq(accounts.id, id)).limit(1)) as AccountRow[];
	return row;
}

export async function createPasswordOnlyAccount(password: string): Promise<AccountRow> {
	const firstAccount = (await accountCount()) === 0;
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
	await db.insert(accounts).values(row);
	cachedAccountCount = cachedAccountCount === null ? null : cachedAccountCount + 1;
	if (firstAccount) await claimOrphanAccountData(row.id);
	return row;
}

export async function createPasswordOnlyInvite(): Promise<{
	account: AccountRow;
	token: string;
	expiresAt: number;
}> {
	const firstAccount = (await accountCount()) === 0;
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
	await db.insert(accounts).values(row);
	cachedAccountCount = cachedAccountCount === null ? null : cachedAccountCount + 1;
	if (firstAccount) await claimOrphanAccountData(row.id);
	return { account: row, token, expiresAt };
}

export async function createPasswordSetupToken(accountId: string): Promise<{ token: string; expiresAt: number } | null> {
	const account = await getAccount(accountId);
	if (!account) return null;
	const token = randomToken();
	const expiresAt = Date.now() + SETUP_TOKEN_TTL_MS;
	await db.update(accounts)
		.set({
			setupTokenHash: tokenHash(token),
			setupTokenExpiresAt: expiresAt,
			updatedAt: Date.now()
		})
		.where(eq(accounts.id, accountId));
	return { token, expiresAt };
}

export async function getAccountBySetupToken(token: string): Promise<AccountRow | undefined> {
	if (!token) return undefined;
	const [row] = (await db
		.select()
		.from(accounts)
		.where(eq(accounts.setupTokenHash, tokenHash(token)))
		.limit(1)) as AccountRow[];
	if (!row?.setupTokenExpiresAt || row.setupTokenExpiresAt <= Date.now()) return undefined;
	return row;
}

export async function claimSetupToken(token: string, password: string): Promise<AccountRow | undefined> {
	const account = await getAccountBySetupToken(token);
	if (!account) return undefined;
	const now = Date.now();
	await db.update(accounts)
		.set({
			passwordHash: await hashPassword(password),
			setupTokenHash: null,
			setupTokenExpiresAt: null,
			updatedAt: now
		})
		.where(eq(accounts.id, account.id));
	return getAccount(account.id);
}

export async function findAccountByPassword(password: string): Promise<AccountRow | undefined> {
	if (!password) return undefined;
	const rows = (await db.select().from(accounts)) as AccountRow[];
	for (const account of rows) {
		if (!account.passwordHash) continue;
		if (await verifyHash(account.passwordHash, password)) return account;
	}
	return undefined;
}

export async function updateAccountPassword(accountId: string, password: string): Promise<void> {
	await db.update(accounts)
		.set({
			passwordHash: await hashPassword(password),
			setupTokenHash: null,
			setupTokenExpiresAt: null,
			updatedAt: Date.now()
		})
		.where(eq(accounts.id, accountId));
}

export async function touchAccountLogin(accountId: string): Promise<void> {
	await db.update(accounts).set({ lastLoginAt: Date.now() }).where(eq(accounts.id, accountId));
}

export async function deleteAccount(accountId: string): Promise<number> {
	await db.delete(accounts).where(eq(accounts.id, accountId));
	cachedAccountCount = null;
	return 1;
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

async function claimOrphanAccountData(accountId: string): Promise<void> {
	await db.transaction(async (tx: any) => {
		await tx.update(conversations).set({ accountId }).where(isNull(conversations.accountId));
		await tx.update(missions).set({ accountId }).where(isNull(missions.accountId));
		await tx.update(missionReports).set({ accountId }).where(isNull(missionReports.accountId));
		await tx.update(agentChannelConfigs)
			.set({ accountId })
			.where(isNull(agentChannelConfigs.accountId));
		await tx.update(agentChannelPosts)
			.set({ accountId })
			.where(isNull(agentChannelPosts.accountId));
	});
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
