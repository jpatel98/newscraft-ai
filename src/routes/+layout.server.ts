import type { LayoutServerLoad } from './$types';
import { listConversations } from '$lib/server/db/conversations';

export const load: LayoutServerLoad = async ({ locals }) => {
	if (!locals.user) return { user: null, conversations: [], isMarketingHost: locals.isMarketingHost };
	return {
		user: locals.user,
		isMarketingHost: locals.isMarketingHost,
		conversations: (await listConversations(locals.user.id, 50)).map((c) => ({
			id: c.id,
			title: c.title || '(untitled)',
			updatedAt: c.updatedAt,
			pinned: c.pinned,
			systemPrompt: c.systemPrompt
		}))
	};
};
