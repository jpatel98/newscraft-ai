import { error, fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { mintSessionCookie } from '$lib/server/auth/cookie';
import {
	claimSetupToken,
	getAccountBySetupToken,
	touchAccountLogin
} from '$lib/server/db/accounts';

export const load: PageServerLoad = async ({ params }) => {
	const account = getAccountBySetupToken(params.token);
	if (!account) throw error(404, 'invalid or expired account setup link');
	return {
		account: {
			email: account.email,
			name: account.name
		}
	};
};

export const actions: Actions = {
	default: async ({ params, request, cookies }) => {
		const data = await request.formData();
		const password = String(data.get('password') ?? '');
		const confirm = String(data.get('confirm') ?? '');

		if (password.length < 8) return fail(400, { error: 'password must be at least 8 characters' });
		if (password !== confirm) return fail(400, { error: 'passwords do not match' });

		const account = await claimSetupToken(params.token, password);
		if (!account) return fail(400, { error: 'invalid or expired account setup link' });

		touchAccountLogin(account.id);
		const c = mintSessionCookie(account.id);
		cookies.set(c.name, c.value, c.opts);
		throw redirect(303, '/');
	}
};
