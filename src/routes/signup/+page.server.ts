import { redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { accountCount } from '$lib/server/db/accounts';

export const load: PageServerLoad = async ({ locals }) => {
	if (locals.user) throw redirect(303, '/');
	throw redirect(303, (await accountCount()) === 0 ? '/setup' : '/login');
};

export const actions: Actions = {
	default: async () => {
		throw redirect(303, (await accountCount()) === 0 ? '/setup' : '/login');
	}
};
