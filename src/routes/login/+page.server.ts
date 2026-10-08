import { fail, redirect, isHttpError } from '@sveltejs/kit';
import type { Actions } from './$types';
import { authBackend } from '$lib/server/auth/backend';
import { isValidEmail, normalizeEmail } from '$lib/server/auth/account-input';
import { checkRateLimit } from '$lib/server/rate-limit';

export const actions: Actions = {
    default: async ({ request, cookies, getClientAddress, url }) => {
        const data = await request.formData();
        const email = normalizeEmail(String(data.get('email') ?? ''));
        const password = String(data.get('password') ?? '');
        const next = String(data.get('next') ?? url.searchParams.get('next') ?? '/');
        const rate = checkRateLimit(`login:${getClientAddress()}`, { limit: 20, windowMs: 10 * 60 * 1000 });
        if (!rate.allowed) return fail(429, { email, error: 'Too many sign-in attempts. Try again later.' });
        if (!isValidEmail(email) || !password) return fail(400, { email, error: 'Enter your email and password.' });
        try { await (await authBackend()).signIn(email, password, cookies); }
        catch (cause) { return fail(isHttpError(cause) ? cause.status : 503, { email, error: 'Sign-in failed. Check your email, password, and any email confirmation.' }); }
        const safeNext = next.startsWith('/') && !/^\/[/\\]/.test(next) && !/[\u0000-\u0020\u007f\\]/u.test(next) ? next : '/';
        throw redirect(303, safeNext);
    }
};
