import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { listAccounts } from '$lib/server/db/accounts';
import { ensureDefaultOrganizationForAccount } from '$lib/server/db';
import { getNewsroomProfile } from '$lib/server/documents/profiles';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) throw error(401, 'unauthorized');
	const [accounts, newsroomProfile] = await Promise.all([
		listAccounts(),
		ensureDefaultOrganizationForAccount(locals.user.id)
			.then((orgId) => getNewsroomProfile(orgId))
			.catch(() => undefined)
	]);
	return {
		accounts: accounts.map((account) => ({
			...account,
			isCurrent: account.id === locals.user?.id
		})),
		newsroomProfile: newsroomProfile ?? {
			timezone: 'America/Toronto',
			homeMarket: '',
			preferredDomains: []
		}
	};
};
