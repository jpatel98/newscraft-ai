import { error, json, type RequestHandler } from '@sveltejs/kit';
import { addMessage, getConversation } from '$lib/server/db/conversations';

interface Body {
	content?: string;
}

export const POST: RequestHandler = async ({ locals, params, request }) => {
	if (!locals.user) throw error(401, 'unauthorized');
	const conversationId = params.id;
	if (!conversationId) throw error(400, 'conversation id required');
	const conversation = getConversation(locals.user.id, conversationId);
	if (!conversation) throw error(404, 'not found');

	let body: Body;
	try {
		body = (await request.json()) as Body;
	} catch {
		throw error(400, 'invalid json');
	}

	const content = (body.content ?? '').trim();
	if (!content) throw error(400, 'content required');

	const message = addMessage({
		conversationId: conversation.id,
		role: 'assistant',
		content,
		partial: false
	});

	return json({ message });
};
