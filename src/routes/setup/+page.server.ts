import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { mintSessionCookie } from '$lib/server/auth/cookie';
import {
	legacyPasswordConfigured,
	lockedOut,
	recordFailure,
	recordSuccess,
	verifyLegacyPassword
} from '$lib/server/auth/password';
import {
	accountCount,
	createAccountWithPassword,
	normalizeEmail,
	touchAccountLogin,
	validEmail
} from '$lib/server/db/accounts';

export const load: PageServerLoad = async () => {
	if (accountCount() > 0) throw redirect(303, '/login');
	return {
		requiresBootstrapPassword: legacyPasswordConfigured()
	};
};

export const actions: Actions = {
	default: async ({ request, cookies, getClientAddress }) => {
		if (accountCount() > 0) throw redirect(303, '/login');

		const data = await request.formData();
		const email = normalizeEmail(String(data.get('email') ?? ''));
		const name = String(data.get('name') ?? '').trim();
		const password = String(data.get('password') ?? '');
		const confirm = String(data.get('confirm') ?? '');
		const bootstrapPassword = String(data.get('bootstrapPassword') ?? '');

		const fields = { email, name };

		if (!validEmail(email)) return fail(400, { error: 'enter a valid email address', ...fields });
		if (password.length < 8) {
			return fail(400, { error: 'password must be at least 8 characters', ...fields });
		}
		if (password !== confirm) return fail(400, { error: 'passwords do not match', ...fields });

		if (legacyPasswordConfigured()) {
			const key = `setup:${getClientAddress()}`;
			const lock = lockedOut(key);
			if (lock > 0) {
				return fail(429, {
					error: `too many attempts; try again in ${Math.ceil(lock / 1000)}s`,
					...fields
				});
			}
			const ok = await verifyLegacyPassword(bootstrapPassword);
			if (!ok) {
				recordFailure(key);
				return fail(401, { error: 'current access password is incorrect', ...fields });
			}
			recordSuccess(key);
		}

		try {
			const account = await createAccountWithPassword({ email, name, password });
			touchAccountLogin(account.id);
			const c = mintSessionCookie(account.id);
			cookies.set(c.name, c.value, c.opts);
		} catch {
			return fail(409, { error: 'account could not be created', ...fields });
		}

		throw redirect(303, '/');
	}
};
