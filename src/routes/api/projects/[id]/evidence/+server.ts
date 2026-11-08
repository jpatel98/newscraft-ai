import { json, type RequestHandler } from '@sveltejs/kit';
import { noStoreHeaders, readJsonObject, requireOwnedProject, throwEvidenceHttpError } from '$lib/server/evidence/http';
import { getProjectEvidenceService } from '$lib/server/evidence/runtime';
import { validateEvidenceUploads } from '$lib/server/evidence/validation';

export const GET: RequestHandler = async ({ params, locals }) => {
	const project = await requireOwnedProject(locals, params.id);
	try {
		const documents = await getProjectEvidenceService().listDocuments(project.accountId, project.id);
		return json({ documents }, { headers: noStoreHeaders });
	} catch (cause) {
		throwEvidenceHttpError(cause);
	}
};

/** Upload intents: one opaque storage key per file, bound to this project. */
export const POST: RequestHandler = async ({ params, locals, request }) => {
	const project = await requireOwnedProject(locals, params.id);
	const body = await readJsonObject(request);
	try {
		const uploads = validateEvidenceUploads(body.documents);
		const documents = await getProjectEvidenceService().createUploadIntents(project, uploads);
		return json({ documents }, { status: 201, headers: noStoreHeaders });
	} catch (cause) {
		throwEvidenceHttpError(cause);
	}
};
