import { beforeEach, describe, expect, it, vi } from 'vitest';
const auth = vi.hoisted(() => ({ signUp: vi.fn() }));
vi.mock('$lib/server/auth/backend', () => ({ authBackend: async () => auth }));
vi.mock('$lib/server/rate-limit', () => ({ checkRateLimit: () => ({ allowed: true }) }));
import { actions, load } from './+page.server';
function event(fields: Record<string, string> = {}) { return { request: new Request('https://app.example/signup', { method: 'POST', body: new URLSearchParams({ name: 'Reporter', email: 'reporter@example.com', password: 'password', confirm: 'password', ...fields }) }), cookies: {}, url: new URL('https://app.example/signup'), getClientAddress: () => '127.0.0.1' } as any; }
describe('provider-independent signup', () => {
    beforeEach(() => { vi.clearAllMocks(); auth.signUp.mockResolvedValue(false); });
    it('allows signup without password-only bootstrap', async () => { expect(await load({ locals: { user: null } } as any)).toEqual({}); });
    it('waits when the configured provider requires email confirmation', async () => {
        expect(await actions.default(event())).toMatchObject({ message: expect.stringContaining('confirm') });
        expect(auth.signUp).toHaveBeenCalledWith({ name: 'Reporter', email: 'reporter@example.com', password: 'password' }, {}, 'https://app.example');
    });
    it('validates identity before calling Auth', async () => {
        expect(await actions.default(event({ email: 'invalid' }))).toMatchObject({ status: 400, data: { email: 'invalid' } });
        expect(auth.signUp).not.toHaveBeenCalled();
    });
    it('redirects only when the provider has established the session', async () => {
        auth.signUp.mockResolvedValue(true);
        await expect(actions.default(event())).rejects.toMatchObject({ status: 303, location: '/' });
    });
    it('redirects an authenticated account home', async () => { await expect(load({ locals: { user: { id: 'account' } } } as any)).rejects.toMatchObject({ status: 303, location: '/' }); });
});
