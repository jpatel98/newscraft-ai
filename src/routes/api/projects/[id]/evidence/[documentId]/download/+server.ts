import { error, type RequestHandler } from '@sveltejs/kit';
import { dev } from '$app/environment';
import { env } from '$env/dynamic/private';
import { DocumentError } from '$lib/server/documents/errors';
import { isAllowedSignedStorageUrl } from '$lib/server/documents/signed-url';
import { documentStorageProvider } from '$lib/server/documents/storage';
import { requireOwnedProject, throwEvidenceHttpError } from '$lib/server/evidence/http';
import { getProjectEvidenceService } from '$lib/server/evidence/runtime';

/**
 * Access is rechecked before a short-lived signed link is minted, and the link
 * is validated against the backend that issued it. The response is never
 * cached and sends no referrer to the storage origin.
 */
export const GET: RequestHandler = async ({ params, locals }) => {
	const project = await requireOwnedProject(locals, params.id);
	if (!params.documentId) throw error(400, 'document id required');
	try {
		const signedUrl = await getProjectEvidenceService().createDownloadUrl(project.accountId, project.id, params.documentId);
		const provider = documentStorageProvider();
		if (provider !== 'vps' && provider !== 'supabase') {
			throw new DocumentError(503, 'evidence_storage_unavailable', 'Evidence storage is unavailable right now.');
		}
		const storageBaseUrl = provider === 'vps' ? env.NEWSCRAFT_STORAGE_BASE_URL?.trim() || '' : env.SUPABASE_URL?.trim() || '';
		if (!isAllowedSignedStorageUrl(signedUrl, storageBaseUrl, dev, provider === 'vps')) {
			throw new DocumentError(503, 'evidence_storage_unavailable', 'Evidence storage is unavailable right now.');
		}
		return new Response(null, {
			status: 303,
			headers: { Location: new URL(signedUrl).toString(), 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }
		});
	} catch (cause) {
		throwEvidenceHttpError(cause);
	}
};

