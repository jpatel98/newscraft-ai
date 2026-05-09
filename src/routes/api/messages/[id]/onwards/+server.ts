import { error, json, type RequestHandler } from '@sveltejs/kit';
import { deleteMessagesFrom, getConversation } from '$lib/server/db/conversations';

interface Body {
	conversation_id: string;
}

export const DELETE: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.user) throw error(401, 'unauthorized');
	const messageId = params.id;
	if (!messageId) throw error(400, 'message id required');

	let body: Body;
	try {
		body = (await request.json()) as Body;
	} catch {
		throw error(400, 'invalid json');
	}
	const convo = body.conversation_id ? getConversation(locals.user.id, body.conversation_id) : undefined;
	if (!convo) throw error(404, 'conversation not found');

	const removed = deleteMessagesFrom(convo.id, messageId);
	return json({ ok: true, removed });
};
