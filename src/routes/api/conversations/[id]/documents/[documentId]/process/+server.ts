import { error, json, type RequestHandler } from '@sveltejs/kit';
import { getConversation } from '$lib/server/db/conversations';
import { throwDocumentHttpError } from '$lib/server/documents/http';
import { getConversationDocumentService } from '$lib/server/documents/runtime';
import { recordChatDiagnostic } from '$lib/server/chat-diagnostics';

export const POST: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) throw error(401, 'unauthorized');
	if (!params.id) throw error(400, 'conversation id required');
	if (!params.documentId) throw error(400, 'document id required');
	const conversation = await getConversation(locals.user.id, params.id);
	if (!conversation) throw error(404, 'conversation not found');

	const startedAt = Date.now();
	try {
		const document = await getConversationDocumentService().processDocument(
			locals.user.id,
			conversation.id,
			params.documentId
		);
		recordChatDiagnostic(conversation.id, 'document.processing', {
			documentCount: 1,
			state: 'ready',
			pageCount: document.pageCount,
			durationMs: Date.now() - startedAt
		});
		return json({ document }, { headers: { 'Cache-Control': 'no-store' } });
	} catch (cause) {
		recordChatDiagnostic(conversation.id, 'document.processing', {
			documentCount: 1,
			state: 'failed',
			durationMs: Date.now() - startedAt
		});
		throwDocumentHttpError(cause);
	}
};
