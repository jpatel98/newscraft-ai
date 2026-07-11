import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { mintSessionCookie } from '$lib/server/auth/cookie';
import { isValidEmail, normalizeDisplayName, normalizeEmail } from '$lib/server/auth/account-input';
import { accountCount, createAccount, getAccountByEmail, touchAccountLogin } from '$lib/server/db/accounts';
import { createSession } from '$lib/server/db/sessions';
import { checkRateLimit } from '$lib/server/rate-limit';

export const load: PageServerLoad = async ({ locals }) => {
	if (locals.user) throw redirect(303, '/');
	if ((await accountCount()) === 0) throw redirect(303, '/setup');
	return {};
};

export const actions: Actions = {
	default: async ({ request, cookies, getClientAddress }) => {
		if ((await accountCount()) === 0) throw redirect(303, '/setup');

		const data = await request.formData();
		const name = normalizeDisplayName(String(data.get('name') ?? ''));
		const email = normalizeEmail(String(data.get('email') ?? ''));
		const password = String(data.get('password') ?? '');
		const confirm = String(data.get('confirm') ?? '');
		const form = { name, email };

		const rate = checkRateLimit(`signup:${getClientAddress()}`, {
			limit: 5,
			windowMs: 60 * 60 * 1000
		});
		if (!rate.allowed) return fail(429, { ...form, error: 'Too many sign-up attempts. Try again later.' });
		if (name.length < 1 || name.length > 80) {
			return fail(400, { ...form, error: 'Enter a name between 1 and 80 characters.' });
		}
		if (!isValidEmail(email)) return fail(400, { ...form, error: 'Enter a valid email address.' });
		if (password.length < 8) {
			return fail(400, { ...form, error: 'Password must be at least 8 characters.' });
		}
		if (password !== confirm) return fail(400, { ...form, error: 'Passwords do not match.' });
		if (await getAccountByEmail(email)) {
			return fail(409, { ...form, error: 'An account with that email already exists. Sign in instead.' });
		}

		let account;
		try {
			account = await createAccount({ email, name, password });
		} catch (error) {
			if (isUniqueViolation(error)) {
				return fail(409, { ...form, error: 'An account with that email already exists. Sign in instead.' });
			}
			return fail(500, { ...form, error: 'Could not create your account. Try again.' });
		}

		await touchAccountLogin(account.id);
		const session = await createSession(account.id);
		const c = mintSessionCookie(account.id, session.id);
		cookies.set(c.name, c.value, c.opts);
		throw redirect(303, '/');
	}
};

function isUniqueViolation(value: unknown): boolean {
	return typeof value === 'object' && value !== null && 'code' in value && value.code === '23505';
}
