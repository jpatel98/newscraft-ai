import { beforeEach, describe, expect, it, vi } from 'vitest';
import { error } from '@sveltejs/kit';
const auth = vi.hoisted(() => ({ signIn: vi.fn() }));
vi.mock('$lib/server/auth/backend', () => ({ authBackend: async () => auth }));
vi.mock('$lib/server/rate-limit', () => ({ checkRateLimit: () => ({ allowed: true }) }));
import { actions } from './+page.server';
function event(fields: Record<string, string>) { return { request: new Request('http://localhost/login', { method: 'POST', body: new URLSearchParams(fields) }), cookies: {}, getClientAddress: () => '127.0.0.1', url: new URL('http://localhost/login') } as any; }
describe('provider-independent sign-in', () => {
    beforeEach(() => { vi.clearAllMocks(); auth.signIn.mockResolvedValue(undefined); });
    it('passes normalized credentials through the configured auth contract', async () => {
        await expect(actions.default(event({ email: 'Reporter@Example.com', password: 'password' }))).rejects.toMatchObject({ status: 303, location: '/' });
        expect(auth.signIn).toHaveBeenCalledWith('reporter@example.com', 'password', {});
    });
    it('requires email and rejects the retired password-only bypass', async () => {
        expect(await actions.default(event({ password: 'password' }))).toMatchObject({ status: 400 });
        expect(auth.signIn).not.toHaveBeenCalled();
    });
    it.each(['//evil.example', '/\\evil.example', '/\t/evil.example', 'https://evil.example', '/\n/evil.example'])('rejects an unsafe redirect %j', async next => {
        await expect(actions.default(event({ email: 'reporter@example.com', password: 'password', next }))).rejects.toMatchObject({ location: '/' });
    });
    it('does not redirect when the identity provider rejects sign-in', async () => {
        auth.signIn.mockImplementation(async () => { throw error(401, 'unverified'); });
        expect(await actions.default(event({ email: 'reporter@example.com', password: 'password' }))).toMatchObject({ status: 401 });
    });
});
