import { error, json, type RequestHandler } from '@sveltejs/kit';
import {
	clearMessagePartial,
	getConversation,
	getMessageById
} from '$lib/server/db/conversations';

interface Body {
	conversation_id: string;
}

export const POST: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.user) throw error(401, 'unauthorized');
	const messageId = params.id;
	if (!messageId) throw error(400, 'message id required');

	let body: Body;
	try {
		body = (await request.json()) as Body;
	} catch {
		throw error(400, 'invalid json');
	}
	const convo = body.conversation_id ? getConversation(body.conversation_id) : undefined;
	if (!convo) throw error(404, 'conversation not found');

	const msg = getMessageById(messageId);
	if (!msg || msg.conversationId !== convo.id) throw error(404, 'message not found');

	clearMessagePartial(messageId);
	return json({ ok: true });
};
