import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { listConversations } from '$lib/server/db/conversations';

export const load: PageServerLoad = ({ locals }) => {
	if (!locals.user) return {};
	const recent = listConversations(1)[0];
	if (recent) throw redirect(302, `/c/${recent.id}`);
	return {};
};
