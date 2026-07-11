import { error, json, type RequestHandler } from '@sveltejs/kit';
import { getConversation } from '$lib/server/db/conversations';
import { getConversationDocumentService } from '$lib/server/documents/runtime';
import { throwDocumentHttpError } from '$lib/server/documents/http';

export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) throw error(401, 'unauthorized');
	if (!params.id) throw error(400, 'conversation id required');
	const conversation = await getConversation(locals.user.id, params.id);
	if (!conversation) throw error(404, 'conversation not found');

	try {
		const documents = await getConversationDocumentService().listDocuments(
			locals.user.id,
			conversation.id
		);
		return json({ documents }, { headers: { 'Cache-Control': 'no-store' } });
	} catch (cause) {
		throwDocumentHttpError(cause);
	}
};
