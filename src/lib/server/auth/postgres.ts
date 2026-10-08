import { error, type Cookies } from '@sveltejs/kit';
import { createLocalAccount, findAccountByEmailAndPassword, updateAccountPassword } from '$lib/server/db/accounts';
import { createSession, getActiveSessionAccount, revokeSession } from '$lib/server/db/sessions';
import { mintSessionCookie, verifySessionCookie, SESSION_COOKIE_NAME } from './cookie';
import type { AuthBackend } from './backend';
async function issue(accountId: string, cookies: Cookies) {
    const session = await createSession(accountId);
    const cookie = mintSessionCookie(accountId, session.id);
    cookies.set(cookie.name, cookie.value, cookie.opts);
}
export const postgresAuth: AuthBackend = {
    async authenticate(cookies) {
        const identity = verifySessionCookie(cookies.get(SESSION_COOKIE_NAME));
        if (!identity) return null;
        const found = await getActiveSessionAccount(identity.sessionId, identity.accountId);
        if (!found) { cookies.delete(SESSION_COOKIE_NAME, { path: '/' }); return null; }
        const { id, email, name, role } = found.account;
        return { id, email, name, role };
    },
    async signIn(email, password, cookies) {
        const account = await findAccountByEmailAndPassword(email, password);
        if (!account) throw error(401, 'Sign-in failed. Check your email and password.');
        await issue(account.id, cookies);
    },
    async signUp(input, cookies) {
        const account = await createLocalAccount(input);
        await issue(account.id, cookies);
        return true;
    },
    async confirm() { return false; },
    async signOut(cookies) {
        const identity = verifySessionCookie(cookies.get(SESSION_COOKIE_NAME));
        try { if (identity) await revokeSession(identity.sessionId, identity.accountId); }
        finally { cookies.delete(SESSION_COOKIE_NAME, { path: '/' }); }
    },
    async changePassword(user, current, next, cookies) {
        const account = await findAccountByEmailAndPassword(user.email, current);
        if (!account || account.id !== user.id) throw error(401, 'Current password is incorrect.');
        await updateAccountPassword(account.id, next);
        await this.signOut(cookies);
        await issue(account.id, cookies);
    }
};
