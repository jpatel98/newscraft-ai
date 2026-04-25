import type { LayoutServerLoad } from './$types';
import { listConversations } from '$lib/server/db/conversations';

export const load: LayoutServerLoad = ({ locals }) => {
	if (!locals.user) {
		return { user: null, conversations: [] };
	}
	return {
		user: locals.user,
		conversations: listConversations(50).map((c) => ({
			id: c.id,
			title: c.title || '(untitled)',
			updatedAt: c.updatedAt
		}))
	};
};
