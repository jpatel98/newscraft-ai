import { error, type RequestHandler } from '@sveltejs/kit';
import { dev } from '$app/environment';
import { env } from '$env/dynamic/private';
import { getConversation } from '$lib/server/db/conversations';
import { DocumentError } from '$lib/server/documents/errors';
import { throwDocumentHttpError } from '$lib/server/documents/http';
import { getConversationDocumentService } from '$lib/server/documents/runtime';
import { isAllowedSignedStorageUrl } from '$lib/server/documents/signed-url';

export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) throw error(401, 'unauthorized');
	if (!params.id) throw error(400, 'conversation id required');
	if (!params.documentId) throw error(400, 'document id required');
	const conversation = await getConversation(locals.user.id, params.id);
	if (!conversation) throw error(404, 'conversation not found');

	try {
		const signedUrl = await getConversationDocumentService().createDownloadUrl(
			locals.user.id,
			conversation.id,
			params.documentId
		);
		// Validate the signed URL against the backend that actually issued it.
		// Keep the Supabase origin authoritative during rollback even if an old
		// VPS base URL is still present in the environment.
		const storageMode = env.NEWSCRAFT_STORAGE_MODE?.trim().toLowerCase();
		const storageBaseUrl = storageMode === 'vps'
			? env.NEWSCRAFT_STORAGE_BASE_URL?.trim() || ''
			: env.SUPABASE_URL?.trim() || '';
		if (!isAllowedSignedStorageUrl(signedUrl, storageBaseUrl, dev, storageMode === 'vps')) {
			throw new DocumentError(503, 'document_storage_unavailable', 'PDF storage is unavailable right now.');
		}
		const destination = new URL(signedUrl);
		return new Response(null, {
			status: 303,
			headers: { Location: destination.toString(), 'Cache-Control': 'no-store' }
		});
	} catch (cause) {
		throwDocumentHttpError(cause);
	}
};
