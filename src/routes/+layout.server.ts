import type { LayoutServerLoad } from './$types';
import { listConversations } from '$lib/server/db/conversations';
import { CONVERSATIONS_DEPENDENCY } from '$lib/utils/load-dependencies';
import { measureRequest } from '$lib/server/request-timing';

export const load: LayoutServerLoad = async ({ locals, depends }) => {
	if (!locals.user) return { user: null, conversations: [], isMarketingHost: locals.isMarketingHost };
	depends(CONVERSATIONS_DEPENDENCY);
	return {
		user: locals.user,
		isMarketingHost: locals.isMarketingHost,
		conversations: (await measureRequest(locals, 'sidebar', () => listConversations(locals.user!.id, 50))).map((c) => ({
			id: c.id,
			title: c.title || '(untitled)',
			updatedAt: c.updatedAt,
			pinned: c.pinned,
			systemPrompt: c.systemPrompt
		}))
	};
};
