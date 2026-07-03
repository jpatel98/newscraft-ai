import { and, eq } from 'drizzle-orm';
import { SESSION_COOKIE_MAX_AGE } from '$lib/server/auth/cookie';
import { newId } from '$lib/utils/id';
import { db } from './index';
import { sessions } from './schema';

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

export type SessionState = 'active' | 'missing' | 'revoked' | 'expired' | 'account_mismatch';

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
	const [row] = (await db
		.select()
		.from(sessions)
		.where(eq(sessions.id, sessionId))
		.limit(1)) as SessionRow[];
	if (sessionRowState(row, accountId, now) !== 'active') return null;
	if (!row.lastSeenAt || now - row.lastSeenAt >= LAST_SEEN_WRITE_INTERVAL_MS) {
		await db.update(sessions).set({ lastSeenAt: now }).where(eq(sessions.id, sessionId));
		row.lastSeenAt = now;
	}
	return row;
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
