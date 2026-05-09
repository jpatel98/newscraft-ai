import type { LayoutServerLoad } from './$types';
import { listConversations } from '$lib/server/db/conversations';
import { boardData } from '$lib/server/hermes/board';
import type { BoardChannel } from '$lib/types';

export const load: LayoutServerLoad = async ({ locals }) => {
	if (!locals.user) {
		return { user: null, conversations: [], channels: [] };
	}
	let channels: BoardChannel[] = [];
	try {
		channels = (await boardData(locals.user.id)).channels;
	} catch {
		channels = [];
	}
	return {
		user: locals.user,
		conversations: listConversations(locals.user.id, 50).map((c) => ({
			id: c.id,
			title: c.title || '(untitled)',
			updatedAt: c.updatedAt,
			pinned: c.pinned,
			systemPrompt: c.systemPrompt
		})),
		channels
	};
};
