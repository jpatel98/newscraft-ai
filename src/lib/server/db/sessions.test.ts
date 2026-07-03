import { describe, expect, it } from 'vitest';
import { sessionRowState, type SessionRow } from './sessions';

const activeRow: SessionRow = {
	id: 'session-1',
	accountId: 'account-1',
	createdAt: 1_000,
	expiresAt: 11_000,
	revokedAt: null,
	lastSeenAt: 1_000
};

describe('session row state', () => {
	it('accepts an unrevoked session before expiry', () => {
		expect(sessionRowState(activeRow, 'account-1', 5_000)).toBe('active');
	});

	it('rejects a missing session', () => {
		expect(sessionRowState(null, 'account-1', 5_000)).toBe('missing');
	});

	it('rejects revoked sessions', () => {
		expect(sessionRowState({ ...activeRow, revokedAt: 4_000 }, 'account-1', 5_000)).toBe(
			'revoked'
		);
	});

	it('rejects expired sessions', () => {
		expect(sessionRowState({ ...activeRow, expiresAt: 5_000 }, 'account-1', 5_000)).toBe(
			'expired'
		);
	});

	it('rejects sessions for another account', () => {
		expect(sessionRowState(activeRow, 'account-2', 5_000)).toBe('account_mismatch');
	});
});
