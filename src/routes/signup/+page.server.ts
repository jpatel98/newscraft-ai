import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { mintSessionCookie } from '$lib/server/auth/cookie';
import {
	accountCount,
	createPasswordOnlyAccount,
	findAccountByPassword,
	touchAccountLogin,
} from '$lib/server/db/accounts';
import { createSession } from '$lib/server/db/sessions';

export const load: PageServerLoad = async ({ locals }) => {
	if (locals.user) throw redirect(303, '/');
	if ((await accountCount()) > 0) throw redirect(303, '/login');
	return {};
};

export const actions: Actions = {
	default: async ({ request, cookies }) => {
		if ((await accountCount()) > 0) throw redirect(303, '/login');

		const data = await request.formData();
		const password = String(data.get('password') ?? '');
		const confirm = String(data.get('confirm') ?? '');

		if (password.length < 8) {
			return fail(400, { error: 'password must be at least 8 characters' });
		}
		if (password !== confirm) return fail(400, { error: 'passwords do not match' });

		if (await findAccountByPassword(password)) {
			return fail(409, { error: 'choose a password that is not already in use' });
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
