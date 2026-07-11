import { beforeEach, describe, expect, it, vi } from 'vitest';

const accountMocks = vi.hoisted(() => ({
	findAccountByEmailAndPassword: vi.fn(),
	findAccountByPassword: vi.fn(),
	touchAccountLogin: vi.fn()
}));
const sessionMocks = vi.hoisted(() => ({ createSession: vi.fn() }));
const cookieMocks = vi.hoisted(() => ({ mintSessionCookie: vi.fn() }));
const rateLimitMocks = vi.hoisted(() => ({
	checkRateLimit: vi.fn(() => ({ allowed: true, retryAfterMs: 0, remaining: 19 }))
}));
const passwordMocks = vi.hoisted(() => ({
	lockedOut: vi.fn(() => 0),
	recordFailure: vi.fn(),
	recordSuccess: vi.fn()
}));

vi.mock('$lib/server/db/accounts', () => accountMocks);
vi.mock('$lib/server/db/sessions', () => sessionMocks);
vi.mock('$lib/server/auth/cookie', () => cookieMocks);
vi.mock('$lib/server/rate-limit', () => rateLimitMocks);
vi.mock('$lib/server/auth/password', () => passwordMocks);

import { actions } from './+page.server';

const account = { id: 'acct_1' };

function request(fields: Record<string, string>) {
	return new Request('http://localhost/login', {
		method: 'POST',
		body: new URLSearchParams(fields)
	});
}

describe('login credentials', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		sessionMocks.createSession.mockResolvedValue({ id: 'session_1' });
		cookieMocks.mintSessionCookie.mockReturnValue({
			name: 'agent_sess',
			value: 'signed-cookie',
			opts: { httpOnly: true }
		});
	});

	it('authenticates new accounts by email and password', async () => {
		accountMocks.findAccountByEmailAndPassword.mockResolvedValue(account);
		const cookies = { set: vi.fn() };

		await expect(
			actions.default({
				request: request({ email: 'Reporter@Example.com', password: 'password' }),
				cookies,
				getClientAddress: () => '127.0.0.1',
				url: new URL('http://localhost/login')
			} as any)
		).rejects.toMatchObject({ status: 303, location: '/' });

		expect(accountMocks.findAccountByEmailAndPassword).toHaveBeenCalledWith(
			'reporter@example.com',
			'password'
		);
		expect(accountMocks.findAccountByPassword).not.toHaveBeenCalled();
		expect(cookies.set).toHaveBeenCalled();
	});

	it('keeps password-only sign-in working for legacy accounts', async () => {
		accountMocks.findAccountByPassword.mockResolvedValue(account);

		await expect(
			actions.default({
				request: request({ password: 'password' }),
				cookies: { set: vi.fn() },
				getClientAddress: () => '127.0.0.1',
				url: new URL('http://localhost/login')
			} as any)
		).rejects.toMatchObject({ status: 303, location: '/' });

		expect(accountMocks.findAccountByPassword).toHaveBeenCalledWith('password');
	});
});
