import { beforeEach, describe, expect, it, vi } from 'vitest';

const authMocks = vi.hoisted(() => ({
	SESSION_COOKIE_NAME: 'session',
	verifySessionCookie: vi.fn()
}));
const accountMocks = vi.hoisted(() => ({ accountCount: vi.fn() }));
const sessionMocks = vi.hoisted(() => ({ getActiveSessionAccount: vi.fn() }));

vi.mock('$lib/server/auth/cookie', () => authMocks);
vi.mock('$lib/server/db/accounts', () => accountMocks);
vi.mock('$lib/server/db/sessions', () => sessionMocks);

function event(path = '/login') {
	return {
		cookies: { get: vi.fn(), delete: vi.fn() },
		url: new URL(`http://localhost${path}`),
		locals: {}
	} as any;
}

async function loadHandle() {
	vi.resetModules();
	return (await import('./hooks.server')).handle;
}

describe('request bootstrap account checks', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		authMocks.verifySessionCookie.mockReturnValue(null);
		sessionMocks.getActiveSessionAccount.mockResolvedValue(null);
		accountMocks.accountCount.mockResolvedValue(1);
	});

	it('does not count accounts after a valid session proves one exists', async () => {
		const handle = await loadHandle();
		authMocks.verifySessionCookie.mockReturnValue({ sessionId: 'session-1', accountId: 'account-1' });
		sessionMocks.getActiveSessionAccount.mockResolvedValue({
			account: { id: 'account-1', email: 'editor@example.test', name: 'Editor', role: 'member' }
		});
		const resolve = vi.fn().mockResolvedValue(new Response('ok'));

		await handle({ event: event('/'), resolve } as any);

		expect(accountMocks.accountCount).not.toHaveBeenCalled();
		expect(resolve).toHaveBeenCalledOnce();
	});

	it('shares one account count across concurrent unauthenticated requests', async () => {
		const handle = await loadHandle();
		let release: ((count: number) => void) | undefined;
		accountMocks.accountCount.mockImplementation(
			() => new Promise<number>((resolve) => (release = resolve))
		);
		const resolve = vi.fn().mockResolvedValue(new Response('ok'));

		const first = handle({ event: event('/login'), resolve } as any);
		const second = handle({ event: event('/login'), resolve } as any);
		await Promise.resolve();
		expect(accountMocks.accountCount).toHaveBeenCalledOnce();
		release?.(1);
		await Promise.all([first, second]);
		expect(resolve).toHaveBeenCalledTimes(2);
	});

	it('clears a failed shared count so the next request can retry', async () => {
		const handle = await loadHandle();
		accountMocks.accountCount
			.mockRejectedValueOnce(new Error('temporary database failure'))
			.mockResolvedValueOnce(1);
		await expect(handle({ event: event('/login'), resolve: vi.fn() } as any)).rejects.toThrow(
			'temporary database failure'
		);
		await expect(handle({ event: event('/login'), resolve: vi.fn().mockResolvedValue(new Response('ok')) } as any)).resolves.toBeDefined();
		expect(accountMocks.accountCount).toHaveBeenCalledTimes(2);
	});
});
