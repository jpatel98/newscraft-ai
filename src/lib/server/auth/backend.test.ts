import { beforeEach, describe, expect, it, vi } from 'vitest';
const environment = vi.hoisted(() => ({ APP_SESSION_SECRET: Buffer.alloc(32, 'fixture').toString('base64'), NODE_ENV: 'production', NEWSCRAFT_AUTH_PROVIDER: '' }));
const accounts = vi.hoisted(() => ({ createLocalAccount: vi.fn(), findAccountByEmailAndPassword: vi.fn(), updateAccountPassword: vi.fn() }));
const sessions = vi.hoisted(() => ({ createSession: vi.fn(), getActiveSessionAccount: vi.fn(), revokeSession: vi.fn() }));
const cloud = vi.hoisted(() => ({ createClient: vi.fn(() => { throw new Error('Supabase must remain unused'); }) }));
vi.mock('$env/dynamic/private', () => ({ env: environment }));
vi.mock('$lib/server/db/accounts', () => accounts);
vi.mock('$lib/server/db/sessions', () => sessions);
vi.mock('@supabase/supabase-js', () => cloud);
import { authBackend } from './backend';
import { SESSION_COOKIE_NAME } from './cookie';
function jar() {
    const values = new Map<string, string>();
    return { get: (k: string) => values.get(k), set: vi.fn((k: string, v: string) => { values.set(k, v); }), delete: vi.fn((k: string) => { values.delete(k); }) } as any;
}
describe('concrete Postgres auth without Supabase configuration', () => {
    const account = { id: 'internal-id', email: 'person@example.test', name: 'Person', role: 'member' };
    beforeEach(() => {
        vi.clearAllMocks(); environment.NEWSCRAFT_AUTH_PROVIDER = '';
        accounts.findAccountByEmailAndPassword.mockResolvedValue(account);
        accounts.createLocalAccount.mockResolvedValue(account);
        sessions.createSession.mockResolvedValue({ id: 'session-one' });
        sessions.getActiveSessionAccount.mockResolvedValue({ account });
    });
    it('signs in, verifies the signed cookie and DB session, then revokes it', async () => {
        const auth = await authBackend(), cookies = jar();
        await auth.signIn(account.email, 'fixture-password', cookies);
        expect(cookies.set).toHaveBeenCalledWith(SESSION_COOKIE_NAME, expect.any(String), expect.objectContaining({ httpOnly: true, secure: true }));
        expect(await auth.authenticate(cookies)).toEqual(account);
        expect(sessions.getActiveSessionAccount).toHaveBeenCalledWith('session-one', 'internal-id');
        await auth.signOut(cookies);
        expect(sessions.revokeSession).toHaveBeenCalledWith('session-one', 'internal-id');
        expect(cookies.get(SESSION_COOKIE_NAME)).toBeUndefined();
        expect(cloud.createClient).not.toHaveBeenCalled();
    });
    it('creates an owned account and session for local signup', async () => {
        const auth = await authBackend(), cookies = jar();
        expect(await auth.signUp({ name: 'Person', email: account.email, password: 'fixture-password' }, cookies, 'https://app.example')).toBe(true);
        expect(accounts.createLocalAccount).toHaveBeenCalledOnce();
        expect(sessions.createSession).toHaveBeenCalledWith('internal-id');
        expect(cloud.createClient).not.toHaveBeenCalled();
    });
    it('rejects forged cookies before a database session read', async () => {
        const auth = await authBackend(), cookies = jar();
        cookies.set(SESSION_COOKIE_NAME, 'forged.signature');
        expect(await auth.authenticate(cookies)).toBeNull();
        expect(sessions.getActiveSessionAccount).not.toHaveBeenCalled();
    });
    it('requires the same internal account during password reauthentication', async () => {
        const auth = await authBackend();
        accounts.findAccountByEmailAndPassword.mockResolvedValue({ ...account, id: 'other-person' });
        await expect(auth.changePassword(account as any, 'old', 'new', jar())).rejects.toMatchObject({ status: 401 });
        expect(accounts.updateAccountPassword).not.toHaveBeenCalled();
    });
    it('fails unavailable adapters without falling back to a different identity system', async () => {
        environment.NEWSCRAFT_AUTH_PROVIDER = 'unknown';
        await expect(authBackend()).rejects.toMatchObject({ status: 503 });
    });
});
