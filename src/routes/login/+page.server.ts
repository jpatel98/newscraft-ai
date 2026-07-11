import { fail, redirect } from '@sveltejs/kit';
import type { Actions } from './$types';
import { mintSessionCookie } from '$lib/server/auth/cookie';
import { isValidEmail, normalizeEmail } from '$lib/server/auth/account-input';
import { lockedOut, recordFailure, recordSuccess } from '$lib/server/auth/password';
import { findAccountByEmailAndPassword, findAccountByPassword, touchAccountLogin } from '$lib/server/db/accounts';
import { createSession } from '$lib/server/db/sessions';
import { checkRateLimit } from '$lib/server/rate-limit';

export const actions: Actions = {
	default: async ({ request, cookies, getClientAddress, url }) => {
		const data = await request.formData();
		const email = normalizeEmail(String(data.get('email') ?? ''));
		const password = String(data.get('password') ?? '');
		const next = String(data.get('next') ?? url.searchParams.get('next') ?? '/');
		const form = { email };

		const key = getClientAddress();
		const rate = checkRateLimit(`login:${key}`, { limit: 20, windowMs: 10 * 60 * 1000 });
		if (!rate.allowed) {
			return fail(429, {
				error: `Too many sign-in attempts. Try again in ${Math.ceil(rate.retryAfterMs / 1000)}s.`
			});
		}
		const lock = lockedOut(key);
		if (lock > 0) {
			return fail(429, {
				...form,
				error: `Too many sign-in attempts. Try again in ${Math.ceil(lock / 1000)}s.`
			});
		}

		if (email && !isValidEmail(email)) return fail(400, { ...form, error: 'Enter a valid email address.' });
		const account = email
			? await findAccountByEmailAndPassword(email, password)
			: await findAccountByPassword(password);
		if (!account) {
			recordFailure(key);
			return fail(401, {
				...form,
				error: email
					? 'That email and password did not match an active account.'
					: 'That password did not match an active account.'
			});
		}

		recordSuccess(key);
		await touchAccountLogin(account.id);
		const session = await createSession(account.id);
		const c = mintSessionCookie(account.id, session.id);
		cookies.set(c.name, c.value, c.opts);

		const safeNext = next.startsWith('/') && !/^\/[/\\]/.test(next) ? next : '/';
		throw redirect(303, safeNext);
	}
};
