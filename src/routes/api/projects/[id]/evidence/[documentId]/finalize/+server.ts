import { error, json, type RequestHandler } from '@sveltejs/kit';
import { noStoreHeaders, requireOwnedProject, throwEvidenceHttpError } from '$lib/server/evidence/http';
import { getProjectEvidenceService } from '$lib/server/evidence/runtime';

/** Seal the uploaded bytes (size + SHA-256 must match) and extract pages or rows. */
export const POST: RequestHandler = async ({ params, locals }) => {
	const project = await requireOwnedProject(locals, params.id);
	if (!params.documentId) throw error(400, 'document id required');
	try {
		const document = await getProjectEvidenceService().finalizeDocument(project.accountId, project.id, params.documentId);
		return json({ document }, { headers: noStoreHeaders });
	} catch (cause) {
		throwEvidenceHttpError(cause);
	}
};
