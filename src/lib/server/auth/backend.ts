import type { Cookies } from '@sveltejs/kit';
import { error } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
export interface AuthBackend {
    authenticate(cookies: Cookies): Promise<App.Locals['user']>;
    signIn(email: string, password: string, cookies: Cookies): Promise<void>;
    signUp(input: { email: string; password: string; name: string }, cookies: Cookies, origin: string): Promise<boolean>;
    confirm(code: string, cookies: Cookies): Promise<boolean>;
    signOut(cookies: Cookies): Promise<void>;
    changePassword(user: NonNullable<App.Locals['user']>, current: string, next: string, cookies: Cookies): Promise<void>;
}
/** Concrete local auth is the default; vendor SDKs never enter route code. */
export async function authBackend(): Promise<AuthBackend> {
    const provider = env.NEWSCRAFT_AUTH_PROVIDER || 'postgres';
    if (provider === 'postgres') return (await import('./postgres')).postgresAuth;
    if (provider === 'supabase') return (await import('./supabase')).supabaseAuth;
    throw error(503, 'The configured sign-in provider is unavailable.');
}
export async function authenticateRequest(cookies: Cookies) {
    return (await authBackend()).authenticate(cookies);
}
