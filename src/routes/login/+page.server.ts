import { fail, redirect, type Actions } from '@sveltejs/kit';
import { mintSessionCookie } from '$lib/server/auth/cookie';
import { verifyPassword, lockedOut, recordFailure, recordSuccess } from '$lib/server/auth/password';

export const actions: Actions = {
	default: async ({ request, cookies, getClientAddress, url }) => {
		const data = await request.formData();
		const password = String(data.get('password') ?? '');
		const next = String(data.get('next') ?? url.searchParams.get('next') ?? '/');

		const key = getClientAddress();
		const lock = lockedOut(key);
		if (lock > 0) {
			return fail(429, { error: `too many attempts; try again in ${Math.ceil(lock / 1000)}s` });
		}

		const ok = await verifyPassword(password);
		if (!ok) {
			recordFailure(key);
			return fail(401, { error: 'invalid password' });
		}

		recordSuccess(key);
		const c = mintSessionCookie();
		cookies.set(c.name, c.value, c.opts);

		const safeNext = next.startsWith('/') && !next.startsWith('//') ? next : '/';
		throw redirect(303, safeNext);
	}
};
