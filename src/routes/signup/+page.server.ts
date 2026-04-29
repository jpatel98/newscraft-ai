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
	createPasswordOnlyAccount,
	findAccountByPassword,
	touchAccountLogin,
} from '$lib/server/db/accounts';

export const load: PageServerLoad = async ({ locals }) => {
	if (locals.user) throw redirect(303, '/');
	return {
		accessCodeConfigured: legacyPasswordConfigured()
	};
};

export const actions: Actions = {
	default: async ({ request, cookies, getClientAddress }) => {
		const data = await request.formData();
		const accessCode = String(data.get('accessCode') ?? '');
		const password = String(data.get('password') ?? '');
		const confirm = String(data.get('confirm') ?? '');

		if (!legacyPasswordConfigured()) {
			return fail(503, { error: 'account creation is not configured' });
		}
		if (password.length < 8) {
			return fail(400, { error: 'password must be at least 8 characters' });
		}
		if (password !== confirm) return fail(400, { error: 'passwords do not match' });

		const key = `signup:${getClientAddress()}`;
		const lock = lockedOut(key);
		if (lock > 0) {
			return fail(429, {
				error: `too many attempts; try again in ${Math.ceil(lock / 1000)}s`
			});
		}

		const accessOk = await verifyLegacyPassword(accessCode);
		if (!accessOk) {
			recordFailure(key);
			return fail(401, { error: 'access code is incorrect' });
		}
		recordSuccess(key);

		if (await findAccountByPassword(password)) {
			return fail(409, { error: 'choose a password that is not already in use' });
		}

		try {
			const account = await createPasswordOnlyAccount(password);
			touchAccountLogin(account.id);
			const c = mintSessionCookie(account.id);
			cookies.set(c.name, c.value, c.opts);
		} catch {
			return fail(409, { error: 'account could not be created' });
		}

		throw redirect(303, '/');
	}
};
