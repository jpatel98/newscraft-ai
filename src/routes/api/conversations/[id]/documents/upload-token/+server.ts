import { error, json, type RequestHandler } from '@sveltejs/kit';
import { getConversation } from '$lib/server/db/conversations';
import { throwDocumentHttpError } from '$lib/server/documents/http';
import { getConversationDocumentService } from '$lib/server/documents/runtime';
import { validatePdfUploads } from '$lib/server/documents/validation';

export const POST: RequestHandler = async ({ params, locals, request }) => {
	if (!locals.user) throw error(401, 'unauthorized');
	if (!params.id) throw error(400, 'conversation id required');
	const conversation = await getConversation(locals.user.id, params.id);
	if (!conversation) throw error(404, 'conversation not found');

	let body: { documents?: unknown };
	try {
		body = (await request.json()) as { documents?: unknown };
	} catch {
		throw error(400, 'invalid json');
	}

	try {
		const uploads = validatePdfUploads(body.documents);
		const documents = await getConversationDocumentService().createUploadTokens(conversation, uploads);
		return json({ documents }, { status: 201, headers: { 'Cache-Control': 'no-store' } });
	} catch (cause) {
		throwDocumentHttpError(cause);
	}
};
