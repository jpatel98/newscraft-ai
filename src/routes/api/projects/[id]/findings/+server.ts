import { json, type RequestHandler } from '@sveltejs/kit';
import { noStoreHeaders, requireOwnedProject, throwEvidenceHttpError } from '$lib/server/evidence/http';
import { getProjectEvidenceService } from '$lib/server/evidence/runtime';

export const GET: RequestHandler = async ({ params, locals }) => {
	const project = await requireOwnedProject(locals, params.id);
	try {
		const findings = await getProjectEvidenceService().listFindings(project.accountId, project.id);
		return json({ findings }, { headers: noStoreHeaders });
	} catch (cause) {
		throwEvidenceHttpError(cause);
	}
};

