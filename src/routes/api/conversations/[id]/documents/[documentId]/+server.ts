import { error, json, type RequestHandler } from '@sveltejs/kit';
import { getConversation } from '$lib/server/db/conversations';
import { throwDocumentHttpError } from '$lib/server/documents/http';
import { getConversationDocumentService } from '$lib/server/documents/runtime';

export const DELETE: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) throw error(401, 'unauthorized');
	if (!params.id) throw error(400, 'conversation id required');
	if (!params.documentId) throw error(400, 'document id required');
	const conversation = await getConversation(locals.user.id, params.id);
	if (!conversation) throw error(404, 'conversation not found');

	try {
		await getConversationDocumentService().deleteDocument(
			locals.user.id,
			conversation.id,
			params.documentId
		);
		return json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } });
	} catch (cause) {
		throwDocumentHttpError(cause);
	}
};
