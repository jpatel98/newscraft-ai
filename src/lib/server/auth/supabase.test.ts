import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
const environment = vi.hoisted(() => ({ SUPABASE_URL: 'https://auth.example.test', SUPABASE_PUBLISHABLE_KEY: 'fixture-publishable' }));
const accounts = vi.hoisted(() => ({ ensureSupabaseAccount: vi.fn() }));
vi.mock('$env/dynamic/private', () => ({ env: environment }));
vi.mock('$app/environment', () => ({ dev: false }));
vi.mock('$lib/server/db/accounts', () => accounts);
import { createAuthClient, accountForVerifiedUser, authenticateRequest, clearAuthCookies, ACCESS_COOKIE, REFRESH_COOKIE } from './supabase';
const user = { id: '11111111-1111-4111-8111-111111111111', email: 'reporter@example.test', email_confirmed_at: '2026-01-01', user_metadata: { name: 'Reporter', role: 'admin' }, app_metadata: {} };
const token = `${Buffer.from('{"alg":"HS256"}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub: user.id, exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.fixture-signature`;
function cookies() {
    const values = new Map<string, string>();
    return { get: (name: string) => values.get(name), set: vi.fn((name: string, value: string) => { values.set(name, value); }), delete: vi.fn((name: string) => { values.delete(name); }), values } as any;
}
function response(data: unknown, status = 200) { return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } }); }

describe('Supabase server auth', () => {
    beforeEach(() => { vi.clearAllMocks(); accounts.ensureSupabaseAccount.mockResolvedValue({ ...user, name: 'Reporter', role: 'member' }); });
    afterEach(() => { vi.unstubAllGlobals(); });
    it('persists the real SDK PKCE verifier across separate signup and callback clients', async () => {
        let challenge = '', verifier = '';
        const fetcher = vi.fn(async (url: string, options: RequestInit) => {
            const body = JSON.parse(String(options.body || '{}'));
            if (String(url).includes('/signup')) { challenge = body.code_challenge; return response(user); }
            if (String(url).includes('grant_type=pkce')) {
                verifier = body.code_verifier;
                return response({ user, access_token: token, refresh_token: 'fixture-refresh', token_type: 'bearer', expires_in: 3600 });
            }
            return response(user);
        });
        vi.stubGlobal('fetch', fetcher);
        const jar = cookies();
        const signup = await createAuthClient(jar).auth.signUp({ email: user.email, password: 'fixture-password', options: { emailRedirectTo: 'https://newscraft.example/auth/callback' } });
        expect(signup.error).toBeNull();
        expect(signup.data.session).toBeNull();
        expect(challenge).toBeTruthy();
        expect(jar.get('nc-pkce')).toBeTruthy();
        expect(jar.get(ACCESS_COOKIE)).toBeUndefined();
        const confirmed = await createAuthClient(jar).auth.exchangeCodeForSession('fixture-code');
        expect(confirmed.error).toBeNull();
        expect(verifier).toBeTruthy();
        expect(confirmed.data.user?.id).toBe(user.id);
        expect(jar.get('nc-pkce')).toBeUndefined();
        expect(jar.set.mock.calls[0][2]).toMatchObject({ httpOnly: true, secure: true, sameSite: 'lax' });
    });
    it('uses the verified uid and never lets editable metadata assign an account role', async () => {
        const result = await accountForVerifiedUser(user as any);
        expect(result.role).toBe('member');
        expect(accounts.ensureSupabaseAccount).toHaveBeenCalledWith({ issuer: 'https://auth.example.test/auth/v1', id: user.id, email: user.email, name: 'Reporter' });
    });
    it('checks Auth before reading the account and clears forged sessions', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => response({ msg: 'invalid JWT', code: 'bad_jwt' }, 401)));
        const jar = cookies(); jar.values.set(ACCESS_COOKIE, token);
        expect(await authenticateRequest(jar)).toBeNull();
        expect(accounts.ensureSupabaseAccount).not.toHaveBeenCalled();
        expect(jar.get(ACCESS_COOKIE)).toBeUndefined();
    });
    it('refreshes an expired token and verifies the returned user before issuing cookies', async () => {
        const fetcher = vi.fn(async (url: string, options: RequestInit) => {
            if (String(url).includes('/token')) return response({ user, access_token: token, refresh_token: 'new-refresh', token_type: 'bearer', expires_in: 3600 });
            const authorization = new Headers(options.headers).get('authorization');
            return authorization === `Bearer ${token}` ? response(user) : response({ msg: 'expired JWT', code: 'bad_jwt' }, 401);
        });
        vi.stubGlobal('fetch', fetcher);
        const jar = cookies(); jar.values.set(ACCESS_COOKIE, 'expired'); jar.values.set(REFRESH_COOKIE, 'old-refresh');
        expect(await authenticateRequest(jar)).toMatchObject({ id: user.id, role: 'member' });
        expect(jar.get(REFRESH_COOKIE)).toBe('new-refresh');
        expect(fetcher).toHaveBeenCalledTimes(3);
    });
    it('does not clear the session during Auth outages and clears PKCE on logout', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => response({ msg: 'unavailable' }, 503)));
        const jar = cookies(); jar.values.set(ACCESS_COOKIE, token); jar.values.set('nc-pkce', 'verifier');
        await expect(authenticateRequest(jar)).rejects.toMatchObject({ status: 503 });
        expect(jar.get(ACCESS_COOKIE)).toBe(token);
        clearAuthCookies(jar);
        expect(jar.values.size).toBe(0);
    });
    it('preserves rotated refresh tokens during a subsequent verification outage without granting access', async () => {
        vi.stubGlobal('fetch', vi.fn(async (url: string, options: RequestInit) => {
            if (String(url).includes('/token')) return response({ user, access_token: token, refresh_token: 'new-refresh', token_type: 'bearer', expires_in: 3600 });
            return new Headers(options.headers).get('authorization') === `Bearer ${token}`
                ? response({ msg: 'unavailable' }, 503) : response({ msg: 'expired JWT', code: 'bad_jwt' }, 401);
        }));
        const jar = cookies(); jar.values.set(ACCESS_COOKIE, 'expired'); jar.values.set(REFRESH_COOKIE, 'old-refresh');
        await expect(authenticateRequest(jar)).rejects.toMatchObject({ status: 503 });
        expect(jar.get(REFRESH_COOKIE)).toBe('new-refresh');
        expect(jar.get(ACCESS_COOKIE)).toBe(token);
        expect(accounts.ensureSupabaseAccount).not.toHaveBeenCalled();
    });
});
