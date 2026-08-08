import { error, json, type RequestHandler } from '@sveltejs/kit';
import {
	getConversation,
	getMessageById,
	discardPartialAssistantMessage
} from '$lib/server/db/conversations';
import { getMessageProvenance } from '$lib/server/db/message-provenance';
import { contentText } from '$lib/types';

interface Body {
	conversation_id: string;
	claim_token: number;
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
	const convo = body.conversation_id ? await getConversation(locals.user.id, body.conversation_id) : undefined;
	if (!convo) throw error(404, 'conversation not found');
	if (!Number.isSafeInteger(body.claim_token) || body.claim_token <= 0) {
		throw error(400, 'active claim token required');
	}

	const msg = await getMessageById(messageId);
	if (!msg || msg.conversationId !== convo.id) throw error(404, 'message not found');

	const provenance = await getMessageProvenance(messageId);
	const committed = await discardPartialAssistantMessage({
		id: messageId,
		conversationId: convo.id,
		claimToken: body.claim_token,
		toolCalls: msg.toolCalls,
		provenanceJson:
			provenance?.provenanceJson ||
			JSON.stringify({
				stream: {
					answerText: contentText(msg.content),
					assistantChars: contentText(msg.content).length,
					done: true,
					finishStatus: 'cancelled'
				}
			}),
		now: Date.now()
	});
	if (!committed) throw error(409, 'partial claim lost');
	return json({ ok: true });
};
