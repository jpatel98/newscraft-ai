import { fail, redirect } from '@sveltejs/kit';
import type { Actions } from './$types';
import { mintSessionCookie } from '$lib/server/auth/cookie';
import { lockedOut, recordFailure, recordSuccess } from '$lib/server/auth/password';
import { findAccountByPassword, touchAccountLogin } from '$lib/server/db/accounts';
import { createSession } from '$lib/server/db/sessions';
import { checkRateLimit } from '$lib/server/rate-limit';

export const actions: Actions = {
	default: async ({ request, cookies, getClientAddress, url }) => {
		const data = await request.formData();
		const password = String(data.get('password') ?? '');
		const next = String(data.get('next') ?? url.searchParams.get('next') ?? '/');

		const key = getClientAddress();
		const rate = checkRateLimit(`login:${key}`, { limit: 20, windowMs: 10 * 60 * 1000 });
		if (!rate.allowed) {
			return fail(429, { error: `too many attempts; try again in ${Math.ceil(rate.retryAfterMs / 1000)}s` });
		}
		const lock = lockedOut(key);
		if (lock > 0) {
			return fail(429, { error: `too many attempts; try again in ${Math.ceil(lock / 1000)}s` });
		}

		const account = await findAccountByPassword(password);
		if (!account) {
			recordFailure(key);
			return fail(401, { error: 'invalid password' });
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
