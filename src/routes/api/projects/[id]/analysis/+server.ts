import { json, type RequestHandler } from '@sveltejs/kit';
import { noStoreHeaders, requireOwnedProject, throwEvidenceHttpError } from '$lib/server/evidence/http';
import { getProjectEvidenceService } from '$lib/server/evidence/runtime';

/** Run the deterministic analyzers over this project's ready evidence. No model call. */
export const POST: RequestHandler = async ({ params, locals }) => {
	const project = await requireOwnedProject(locals, params.id);
	try {
		const result = await getProjectEvidenceService().runAnalysis(project.accountId, project.id, 'manual');
		return json(result, { status: 201, headers: noStoreHeaders });
	} catch (cause) {
		throwEvidenceHttpError(cause);
	}
};

export const GET: RequestHandler = async ({ params, locals }) => {
	const project = await requireOwnedProject(locals, params.id);
	try {
		const run = (await getProjectEvidenceService().latestRun(project.accountId, project.id)) ?? null;
		return json({ run }, { headers: noStoreHeaders });
	} catch (cause) {
		throwEvidenceHttpError(cause);
	}
};

