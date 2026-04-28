import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { listAccounts } from '$lib/server/db/accounts';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) throw error(401, 'unauthorized');
	return {
		accounts: listAccounts().map((account) => ({
			...account,
			isCurrent: account.id === locals.user?.id
		}))
	};
};
