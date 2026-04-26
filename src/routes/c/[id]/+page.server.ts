import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getConversation, getMessages, parseContent } from '$lib/server/db/conversations';

export const load: PageServerLoad = ({ params, locals }) => {
	if (!locals.user) throw error(401, 'unauthorized');
	const convo = getConversation(params.id);
	if (!convo) throw error(404, 'not found');
	return {
		conversation: { id: convo.id, title: convo.title, updatedAt: convo.updatedAt },
		messages: getMessages(convo.id).map((m) => ({
			id: m.id,
			role: m.role,
			content: parseContent(m.content),
			partial: m.partial === 1,
			createdAt: m.createdAt
		}))
	};
};
