import { and, eq, gt, isNull } from 'drizzle-orm';
import type { AccountRow } from './accounts';
import { SESSION_COOKIE_MAX_AGE } from '$lib/server/auth/cookie';
import { newId } from '$lib/utils/id';
import { configuredDatabaseHostname, db } from './index';
import { accounts, sessions } from './schema';

export const SESSION_TTL_MS = SESSION_COOKIE_MAX_AGE * 1000;
const LAST_SEEN_WRITE_INTERVAL_MS = 5 * 60 * 1000;

export interface SessionRow {
	id: string;
	accountId: string;
	createdAt: number;
	expiresAt: number;
	revokedAt: number | null;
	lastSeenAt: number | null;
}

export interface ActiveSessionAccount {
	session: SessionRow;
	account: AccountRow;
}

export type SessionState = 'active' | 'missing' | 'revoked' | 'expired' | 'account_mismatch';

const MAX_DATABASE_ERROR_CAUSES = 4;
const DNS_HOSTNAME_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

function safeDnsHostname(value: unknown): string | null {
	if (typeof value !== 'string') return null;
	const hostname = value.trim().replace(/\.$/u, '').toLowerCase();
	return DNS_HOSTNAME_RE.test(hostname) ? hostname : null;
}

function safeDatabaseErrorChain(error: unknown): Array<{ name: string; code: string | null; hostname: string | null }> {
	const chain: Array<{ name: string; code: string | null; hostname: string | null }> = [];
	const seen = new Set<object>();
	let current: unknown = error;
	while (chain.length < MAX_DATABASE_ERROR_CAUSES && current && typeof current === 'object') {
		if (seen.has(current)) break;
		seen.add(current);
		const value = current as { name?: unknown; code?: unknown; hostname?: unknown; cause?: unknown };
		chain.push({
			name: typeof value.name === 'string' ? value.name.slice(0, 64) : 'unknown',
			code: typeof value.code === 'string' ? value.code.slice(0, 32) : null,
			hostname: safeDnsHostname(value.hostname)
		});
		current = value.cause;
	}
	return chain;
}

export async function createSession(accountId: string, now = Date.now()): Promise<SessionRow> {
	const row: SessionRow = {
		id: newId(),
		accountId,
		createdAt: now,
		expiresAt: now + SESSION_TTL_MS,
		revokedAt: null,
		lastSeenAt: now
	};
	await db.insert(sessions).values(row);
	return row;
}

export async function getActiveSession(
	sessionId: string,
	accountId: string,
	now = Date.now()
): Promise<SessionRow | null> {
	let row: SessionRow | undefined;
	try {
		[row] = (await db
			.select()
			.from(sessions)
			.where(eq(sessions.id, sessionId))
			.limit(1)) as SessionRow[];
	} catch (error) {
		// Keep diagnostics useful for remote connection failures without logging
		// SQL, parameters, session identifiers, DSNs, or error messages.
		console.warn('[newscraft] active session lookup failed', {
			errorChain: safeDatabaseErrorChain(error),
			configuredHostname: safeDnsHostname(configuredDatabaseHostname())
		});
		throw error;
	}
	if (sessionRowState(row, accountId, now) !== 'active') return null;
	if (!row.lastSeenAt || now - row.lastSeenAt >= LAST_SEEN_WRITE_INTERVAL_MS) {
		await db.update(sessions).set({ lastSeenAt: now }).where(eq(sessions.id, sessionId));
		row.lastSeenAt = now;
	}
	return row;
}

/**
 * Authenticate a request with one tenant-scoped read. The session predicates
 * stay in SQL so an expired or revoked cookie never hydrates an account, while
 * the returned shape keeps the existing last-seen behavior for the request
 * hook.
 */
export async function getActiveSessionAccount(
	sessionId: string,
	accountId: string,
	now = Date.now()
): Promise<ActiveSessionAccount | null> {
	let row: { session: SessionRow; account: AccountRow } | undefined;
	try {
		[row] = (await db
			.select({ session: sessions, account: accounts })
			.from(sessions)
			.innerJoin(accounts, eq(sessions.accountId, accounts.id))
			.where(
				and(
					eq(sessions.id, sessionId),
					eq(sessions.accountId, accountId),
					isNull(sessions.revokedAt),
					gt(sessions.expiresAt, now)
				)
			)
			.limit(1)) as Array<{ session: SessionRow; account: AccountRow }>;
	} catch (error) {
		// Keep diagnostics useful for remote connection failures without logging
		// SQL, parameters, session identifiers, DSNs, or error messages.
		console.warn('[newscraft] active session lookup failed', {
			errorChain: safeDatabaseErrorChain(error),
			configuredHostname: safeDnsHostname(configuredDatabaseHostname())
		});
		throw error;
	}
	if (!row) return null;
	const { session, account } = row;
	if (!session.lastSeenAt || now - session.lastSeenAt >= LAST_SEEN_WRITE_INTERVAL_MS) {
		await db
			.update(sessions)
			.set({ lastSeenAt: now })
			.where(and(eq(sessions.id, sessionId), eq(sessions.accountId, accountId)));
		session.lastSeenAt = now;
	}
	return { session, account };
}

export async function revokeSession(sessionId: string, accountId: string, now = Date.now()): Promise<void> {
	await db
		.update(sessions)
		.set({ revokedAt: now })
		.where(and(eq(sessions.id, sessionId), eq(sessions.accountId, accountId)));
}

export function sessionRowState(
	row: SessionRow | null | undefined,
	accountId: string,
	now = Date.now()
): SessionState {
	if (!row) return 'missing';
	if (row.accountId !== accountId) return 'account_mismatch';
	if (row.revokedAt !== null) return 'revoked';
	if (row.expiresAt <= now) return 'expired';
	return 'active';
}
