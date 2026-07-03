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
	createPasswordOnlyAccount,
	touchAccountLogin,
} from '$lib/server/db/accounts';
import { createSession } from '$lib/server/db/sessions';

export const load: PageServerLoad = async () => {
	if ((await accountCount()) > 0) throw redirect(303, '/login');
	return {
		requiresBootstrapPassword: await legacyPasswordConfigured()
	};
};

export const actions: Actions = {
	default: async ({ request, cookies, getClientAddress }) => {
		if ((await accountCount()) > 0) throw redirect(303, '/login');

		const data = await request.formData();
		const password = String(data.get('password') ?? '');
		const confirm = String(data.get('confirm') ?? '');
		const bootstrapPassword = String(data.get('bootstrapPassword') ?? '');

		if (password.length < 8) {
			return fail(400, { error: 'password must be at least 8 characters' });
		}
		if (password !== confirm) return fail(400, { error: 'passwords do not match' });

		if (await legacyPasswordConfigured()) {
			const key = `setup:${getClientAddress()}`;
			const lock = lockedOut(key);
			if (lock > 0) {
				return fail(429, {
					error: `too many attempts; try again in ${Math.ceil(lock / 1000)}s`
				});
			}
			const ok = await verifyLegacyPassword(bootstrapPassword);
			if (!ok) {
				recordFailure(key);
				return fail(401, { error: 'current access password is incorrect' });
			}
			recordSuccess(key);
		}

		try {
			const account = await createPasswordOnlyAccount(password);
			await touchAccountLogin(account.id);
			const session = await createSession(account.id);
			const c = mintSessionCookie(account.id, session.id);
			cookies.set(c.name, c.value, c.opts);
		} catch {
			return fail(409, { error: 'account could not be created' });
		}

		throw redirect(303, '/');
	}
};
