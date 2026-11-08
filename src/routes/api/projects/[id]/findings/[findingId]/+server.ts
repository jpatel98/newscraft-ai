import { error, json, type RequestHandler } from '@sveltejs/kit';
import { noStoreHeaders, readJsonObject, requireOwnedProject, throwEvidenceHttpError } from '$lib/server/evidence/http';
import { getProjectEvidenceService } from '$lib/server/evidence/runtime';
import { validateFindingPatch } from '$lib/server/evidence/validation';

/** Save, mark reviewed, dismiss (with a reason) or reopen one lead. Attributed to the signed-in account. */
export const PATCH: RequestHandler = async ({ params, locals, request }) => {
	const project = await requireOwnedProject(locals, params.id);
	if (!params.findingId) throw error(400, 'finding id required');
	const body = await readJsonObject(request);
	try {
		const patch = validateFindingPatch(body);
		const finding = await getProjectEvidenceService().reviewFinding(project.accountId, project.id, params.findingId, patch);
		return json({ finding }, { headers: noStoreHeaders });
	} catch (cause) {
		throwEvidenceHttpError(cause);
	}
};

