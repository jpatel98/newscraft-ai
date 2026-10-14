import type { LayoutServerLoad } from './$types';
import { listConversations } from '$lib/server/db/conversations';
import { listConversationProjectIds, listProjects } from '$lib/server/db/projects';
import { CONVERSATIONS_DEPENDENCY } from '$lib/utils/load-dependencies';
import { measureRequest } from '$lib/server/request-timing';

export const load: LayoutServerLoad = async ({ locals, depends }) => {
	if (!locals.user) return { user: null, conversations: [], folders: [], isMarketingHost: locals.isMarketingHost };
	depends(CONVERSATIONS_DEPENDENCY);
	depends('app:projects');
	const accountId = locals.user.id;
	const [conversations, folders, folderIds] = await Promise.all([
		measureRequest(locals, 'sidebar', () => listConversations(accountId, 50)),
		listProjects(accountId),
		listConversationProjectIds(accountId)
	]);
	return {
		user: locals.user,
		isMarketingHost: locals.isMarketingHost,
		folders: folders.map((f) => ({ id: f.id, name: f.name, count: f.conversationCount })),
		conversations: conversations.map((c) => ({
			id: c.id,
			title: c.title || '(untitled)',
			updatedAt: c.updatedAt,
			pinned: c.pinned,
			systemPrompt: c.systemPrompt,
			folderId: folderIds.get(c.id) ?? null
		}))
	};
};
