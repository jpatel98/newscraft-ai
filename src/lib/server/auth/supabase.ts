import { createClient, type Session, type User } from '@supabase/supabase-js';
import type { Cookies } from '@sveltejs/kit';
import { error } from '@sveltejs/kit';
import { dev } from '$app/environment';
import { env } from '$env/dynamic/private';
import { ensureSupabaseAccount } from '$lib/server/db/accounts';
import type { AuthBackend } from './backend';

export const ACCESS_COOKIE = 'nc-access';
export const REFRESH_COOKIE = 'nc-refresh';
const COOKIE_OPTIONS = { path: '/', httpOnly: true, secure: !dev, sameSite: 'lax' as const };

/** A new client for each request. Never share auth state between users. */
export function createAuthClient(cookies?: Cookies) {
	if (!env.SUPABASE_URL || !env.SUPABASE_PUBLISHABLE_KEY) {
		throw error(503, 'Sign-in is not configured.');
	}
	return createClient(env.SUPABASE_URL, env.SUPABASE_PUBLISHABLE_KEY, {
		auth: { persistSession: Boolean(cookies), autoRefreshToken: false, detectSessionInUrl: false,
            flowType: 'pkce', storageKey: 'newscraft-auth',
            ...(cookies ? { storage: {
                getItem: (key: string) => key.endsWith('-code-verifier') ? cookies.get('nc-pkce') ?? null : null,
                setItem: (key: string, value: string) => {
                    if (key.endsWith('-code-verifier')) cookies.set('nc-pkce', value, { ...COOKIE_OPTIONS, maxAge: 3600 });
                },
                removeItem: (key: string) => {
                    if (key.endsWith('-code-verifier')) cookies.delete('nc-pkce', { path: '/' });
                }
            } } : {}) }
	});
}

export function clearAuthCookies(cookies: Cookies) {
	for (const name of [ACCESS_COOKIE, REFRESH_COOKIE, 'nc-session', 'nc-pkce']) cookies.delete(name, { path: '/' });
}

export function writeAuthCookies(cookies: Cookies, session: Session) {
	// Keep the access token as long as the refresh token: an expired token is
	// still useful to identify the session that should be refreshed.
	const opts = { ...COOKIE_OPTIONS, maxAge: 60 * 60 * 24 * 30 };
	cookies.set(ACCESS_COOKIE, session.access_token, opts);
	cookies.set(REFRESH_COOKIE, session.refresh_token, opts);
}

export async function accountForVerifiedUser(user: User) {
	if (!user.email || !user.email_confirmed_at) throw error(401, 'Confirm your email before signing in.');
	// Metadata is display data only. Permissions always come from the database.
	const issuer = new URL(env.SUPABASE_URL!).href.replace(/\/$/, '') + '/auth/v1';
	return ensureSupabaseAccount({ issuer, id: user.id, email: user.email,
		name: typeof user.user_metadata?.name === 'string' ? user.user_metadata.name.slice(0, 80) : '' });
}

export async function authenticateRequest(cookies: Cookies): Promise<App.Locals['user']> {
	const access = cookies.get(ACCESS_COOKIE);
	const refresh = cookies.get(REFRESH_COOKIE);
	if (!access && !refresh) return null;
	const client = createAuthClient();
	let verified = access ? await client.auth.getUser(access) : null;
	if (verified?.error && (!verified.error.status || verified.error.status >= 500)) {
		throw error(503, 'Sign-in verification is temporarily unavailable.');
	}
	if (!verified?.data.user && refresh) {
		const renewed = await client.auth.refreshSession({ refresh_token: refresh });
		if (renewed.error && (!renewed.error.status || renewed.error.status >= 500)) {
			throw error(503, 'Sign-in verification is temporarily unavailable.');
		}
		if (renewed.data.session) {
			verified = await client.auth.getUser(renewed.data.session.access_token);
			if (verified.error && (!verified.error.status || verified.error.status >= 500)) {
				writeAuthCookies(cookies, renewed.data.session);
				throw error(503, 'Sign-in verification is temporarily unavailable.');
			}
			if (!verified.error && verified.data.user) writeAuthCookies(cookies, renewed.data.session);
		}
	}
	if (!verified?.data.user || verified.error) {
		clearAuthCookies(cookies);
		return null;
	}
	const account = await accountForVerifiedUser(verified.data.user);
	return { id: account.id, email: account.email, name: account.name, role: account.role };
}

export const supabaseAuth: AuthBackend = {
    authenticate: authenticateRequest,
    async signIn(email, password, cookies) {
        const client = createAuthClient();
        const result = await client.auth.signInWithPassword({ email, password });
        if (result.error || !result.data.session) throw error(401, 'Sign-in failed.');
        const verified = await client.auth.getUser(result.data.session.access_token);
        if (verified.error || !verified.data.user) throw error(401, 'Your sign-in could not be verified.');
        await accountForVerifiedUser(verified.data.user);
        writeAuthCookies(cookies, result.data.session);
    },
    async signUp(input, cookies, origin) {
        const client = createAuthClient(cookies);
        const result = await client.auth.signUp({ email: input.email, password: input.password,
            options: { data: { name: input.name }, emailRedirectTo: `${origin}/auth/callback` } });
        if (result.error) throw error(400, 'Could not create your account.');
        if (!result.data.session) return false;
        const verified = await client.auth.getUser(result.data.session.access_token);
        if (verified.error || !verified.data.user) throw error(401, 'Your sign-in could not be verified.');
        await accountForVerifiedUser(verified.data.user);
        writeAuthCookies(cookies, result.data.session);
        return true;
    },
    async confirm(code, cookies) {
        const client = createAuthClient(cookies);
        const result = await client.auth.exchangeCodeForSession(code);
        if (result.error || !result.data.session) return false;
        const verified = await client.auth.getUser(result.data.session.access_token);
        if (verified.error || !verified.data.user) return false;
        await accountForVerifiedUser(verified.data.user);
        writeAuthCookies(cookies, result.data.session);
        return true;
    },
    async signOut(cookies) {
        const access_token = cookies.get(ACCESS_COOKIE), refresh_token = cookies.get(REFRESH_COOKIE);
        try {
            if (access_token && refresh_token) {
                const client = createAuthClient();
                const result = await client.auth.setSession({ access_token, refresh_token });
                if (!result.error) await client.auth.signOut({ scope: 'local' });
            }
        } finally { clearAuthCookies(cookies); }
    },
    async changePassword(user, current, next, cookies) {
        const client = createAuthClient();
        const result = await client.auth.signInWithPassword({ email: user.email, password: current });
        if (result.error || !result.data.session) throw error(401, 'Current password is incorrect.');
        const verified = await client.auth.getUser(result.data.session.access_token);
        if (verified.error || !verified.data.user) throw error(401, 'Current password is incorrect.');
        const account = await accountForVerifiedUser(verified.data.user);
        if (account.id !== user.id) throw error(401, 'Current password is incorrect.');
        const updated = await client.auth.updateUser({ password: next });
        if (updated.error || updated.data.user?.id !== verified.data.user.id) throw error(400, 'The password could not be updated.');
        writeAuthCookies(cookies, result.data.session);
    }
};
