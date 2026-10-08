import { fail, redirect, isHttpError } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { authBackend } from '$lib/server/auth/backend';
import { isValidEmail, normalizeDisplayName, normalizeEmail } from '$lib/server/auth/account-input';
import { checkRateLimit } from '$lib/server/rate-limit';

export const load: PageServerLoad = async ({ locals }) => {
    if (locals.user) throw redirect(303, '/');
    return {};
};

export const actions: Actions = {
    default: async ({ request, cookies, getClientAddress, url }) => {
        const data = await request.formData();
        const name = normalizeDisplayName(String(data.get('name') ?? ''));
        const email = normalizeEmail(String(data.get('email') ?? ''));
        const password = String(data.get('password') ?? '');
        const confirm = String(data.get('confirm') ?? '');
        const form = { name, email };
        const rate = checkRateLimit(`signup:${getClientAddress()}`, { limit: 5, windowMs: 60 * 60 * 1000 });
        if (!rate.allowed) return fail(429, { ...form, error: 'Too many sign-up attempts. Try again later.' });
        if (name.length < 1 || name.length > 80) return fail(400, { ...form, error: 'Enter a name between 1 and 80 characters.' });
        if (!isValidEmail(email)) return fail(400, { ...form, error: 'Enter a valid email address.' });
        if (password.length < 8) return fail(400, { ...form, error: 'Password must be at least 8 characters.' });
        if (password !== confirm) return fail(400, { ...form, error: 'Passwords do not match.' });
        let signedIn;
        try { signedIn = await (await authBackend()).signUp({ email, password, name }, cookies, url.origin); }
        catch (cause) { return fail(isHttpError(cause) ? cause.status : 400, { ...form, error: 'Could not create your account. Try again or sign in.' }); }
        if (!signedIn) return { ...form, message: 'Check your email to confirm your account. Open the link in this browser, then sign in.' };
        throw redirect(303, '/');
    }
};
