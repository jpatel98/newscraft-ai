import { beforeEach, describe, expect, it, vi } from 'vitest';

const authMocks = vi.hoisted(() => ({
	SESSION_COOKIE_NAME: 'session',
	verifySessionCookie: vi.fn()
}));
vi.mock('$env/dynamic/private', () => ({ env: { NEWSCRAFT_AUTH_PROVIDER: 'postgres' } }));
const accountMocks = vi.hoisted(() => ({ accountCount: vi.fn() }));
const sessionMocks = vi.hoisted(() => ({ getActiveSessionAccount: vi.fn() }));

vi.mock('$lib/server/auth/cookie', () => authMocks);
vi.mock('$lib/server/db/accounts', () => accountMocks);
vi.mock('$lib/server/db/sessions', () => sessionMocks);

function event(path = '/login') {
	return {
		cookies: { get: vi.fn(), delete: vi.fn() },
		url: new URL(`http://localhost${path}`),
		route: { id: path.startsWith('/c/') ? '/c/[id]' : path },
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

	it('exposes only fixed timing labels for authenticated chat requests', async () => {
		const handle = await loadHandle();
		authMocks.verifySessionCookie.mockReturnValue({ sessionId: 'private-session', accountId: 'private-account' });
		sessionMocks.getActiveSessionAccount.mockResolvedValue({
			account: { id: 'private-account', email: 'private@example.test', name: 'Editor', role: 'member' }
		});
		const response = await handle({
			event: event('/c/private-conversation'),
			resolve: () => new Response('ok', { headers: { 'server-timing': 'existing;dur=1' } })
		} as any);
		const header = response.headers.get('server-timing');
		expect(header).toMatch(/^existing;dur=1, auth;dur=[\d.]+, resolve;dur=[\d.]+, total;dur=[\d.]+$/);
		expect(header).not.toContain('private');
	});

	it('does not emit chat timings on public requests', async () => {
		const handle = await loadHandle();
		const response = await handle({ event: event('/login'), resolve: () => new Response('ok') } as any);
		expect(response.headers.has('server-timing')).toBe(false);
	});

    it('does not use account count or first-account bootstrap for unauthenticated requests', async () => {
        const handle = await loadHandle();
        const resolve = vi.fn().mockResolvedValue(new Response('ok'));
        await Promise.all([handle({ event: event('/login'), resolve } as any), handle({ event: event('/signup'), resolve } as any)]);
        expect(accountMocks.accountCount).not.toHaveBeenCalled();
        expect(resolve).toHaveBeenCalledTimes(2);
    });
    it('propagates a transient session lookup failure instead of granting access', async () => {
        const handle = await loadHandle();
        authMocks.verifySessionCookie.mockReturnValue({ sessionId: 'session-1', accountId: 'account-1' });
        sessionMocks.getActiveSessionAccount.mockRejectedValue(new Error('temporary database failure'));
        const resolve = vi.fn();
        await expect(handle({ event: event('/'), resolve } as any)).rejects.toThrow('temporary database failure');
        expect(resolve).not.toHaveBeenCalled();
    });
});
