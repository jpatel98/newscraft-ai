import { beforeEach, describe, expect, it, vi } from 'vitest';

const accountMocks = vi.hoisted(() => ({
	accountCount: vi.fn(),
	createAccount: vi.fn(),
	getAccountByEmail: vi.fn(),
	touchAccountLogin: vi.fn()
}));
const sessionMocks = vi.hoisted(() => ({ createSession: vi.fn() }));
const cookieMocks = vi.hoisted(() => ({ mintSessionCookie: vi.fn() }));
const rateLimitMocks = vi.hoisted(() => ({
	checkRateLimit: vi.fn(() => ({ allowed: true, retryAfterMs: 0, remaining: 4 }))
}));

vi.mock('$lib/server/db/accounts', () => accountMocks);
vi.mock('$lib/server/db/sessions', () => sessionMocks);
vi.mock('$lib/server/auth/cookie', () => cookieMocks);
vi.mock('$lib/server/rate-limit', () => rateLimitMocks);

import { actions, load } from './+page.server';

const account = {
	id: 'acct_1',
	email: 'jigar@example.com',
	name: 'Jigar Patel',
	role: 'member' as const
};

function request(fields: Record<string, string>) {
	return new Request('http://localhost/signup', {
		method: 'POST',
		body: new URLSearchParams(fields)
	});
}

describe('public account signup', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		accountMocks.accountCount.mockResolvedValue(1);
		accountMocks.getAccountByEmail.mockResolvedValue(undefined);
		accountMocks.createAccount.mockResolvedValue(account);
		sessionMocks.createSession.mockResolvedValue({ id: 'session_1' });
		cookieMocks.mintSessionCookie.mockReturnValue({
			name: 'agent_sess',
			value: 'signed-cookie',
			opts: { httpOnly: true }
		});
	});

	it('renders for an unauthenticated user once the first account exists', async () => {
		await expect(load({ locals: { user: null } } as any)).resolves.toEqual({});
	});

	it('keeps first-account bootstrap protected', async () => {
		accountMocks.accountCount.mockResolvedValue(0);

		await expect(load({ locals: { user: null } } as any)).rejects.toMatchObject({
			status: 303,
			location: '/setup'
		});
		await expect(
			actions.default({ request: request({}), cookies: {} } as any)
		).rejects.toMatchObject({ status: 303, location: '/setup' });
	});

	it('creates an account, starts a session, and redirects home', async () => {
		const cookies = { set: vi.fn() };

		await expect(
			actions.default({
				request: request({
					name: '  Jigar   Patel ',
					email: 'JIGAR@EXAMPLE.COM',
					password: 'correct horse battery staple',
					confirm: 'correct horse battery staple'
				}),
				cookies,
				getClientAddress: () => '127.0.0.1'
			} as any)
		).rejects.toMatchObject({ status: 303, location: '/' });

		expect(accountMocks.getAccountByEmail).toHaveBeenCalledWith('jigar@example.com');
		expect(accountMocks.createAccount).toHaveBeenCalledWith({
			email: 'jigar@example.com',
			name: 'Jigar Patel',
			password: 'correct horse battery staple'
		});
		expect(accountMocks.touchAccountLogin).toHaveBeenCalledWith(account.id);
		expect(sessionMocks.createSession).toHaveBeenCalledWith(account.id);
		expect(cookies.set).toHaveBeenCalledWith('agent_sess', 'signed-cookie', { httpOnly: true });
	});

	it('preserves the typed identity when validation fails', async () => {
		const result = await actions.default({
			request: request({ name: 'Jigar Patel', email: 'not-an-email', password: 'password', confirm: 'password' }),
			cookies: {},
			getClientAddress: () => '127.0.0.1'
		} as any);

		expect(result).toMatchObject({
			status: 400,
			data: { name: 'Jigar Patel', email: 'not-an-email', error: 'Enter a valid email address.' }
		});
		expect(accountMocks.createAccount).not.toHaveBeenCalled();
	});

	it('rejects an email that is already registered', async () => {
		accountMocks.getAccountByEmail.mockResolvedValue(account);

		const result = await actions.default({
			request: request({
				name: 'Another Reporter',
				email: 'jigar@example.com',
				password: 'correct horse battery staple',
				confirm: 'correct horse battery staple'
			}),
			cookies: {},
			getClientAddress: () => '127.0.0.1'
		} as any);

		expect(result).toMatchObject({
			status: 409,
			data: { error: 'An account with that email already exists. Sign in instead.' }
		});
		expect(accountMocks.createAccount).not.toHaveBeenCalled();
	});

	it('does not render for authenticated users', async () => {
		await expect(load({ locals: { user: { id: account.id } } } as any)).rejects.toMatchObject({
			status: 303,
			location: '/'
		});
		expect(accountMocks.accountCount).not.toHaveBeenCalled();
	});
});
