import { error, json, type RequestHandler } from '@sveltejs/kit';
import { noStoreHeaders, requireOwnedProject, throwEvidenceHttpError } from '$lib/server/evidence/http';
import { getProjectEvidenceService } from '$lib/server/evidence/runtime';

function integerParam(value: string | null, fallback: number, min: number, max: number): number {
	if (value === null || value === '') return fallback;
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw error(400, 'invalid query parameter');
	return parsed;
}

/**
 * Document detail. `?page=N` returns one extracted PDF page; `?rows=1` returns
 * a window of CSV rows (`offset`, `limit`) or exact rows (`ordinals=1,5,9`).
 */
export const GET: RequestHandler = async ({ params, locals, url }) => {
	const project = await requireOwnedProject(locals, params.id);
	if (!params.documentId) throw error(400, 'document id required');
	const service = getProjectEvidenceService();
	try {
		const page = url.searchParams.get('page');
		if (page !== null) {
			const result = await service.getPage(project.accountId, project.id, params.documentId, integerParam(page, 1, 1, 100_000));
			return json({ page: result }, { headers: noStoreHeaders });
		}
		if (url.searchParams.get('rows') !== null) {
			const ordinalsParam = url.searchParams.get('ordinals');
			const ordinals = ordinalsParam
				? ordinalsParam.split(',').slice(0, 200).map((value) => integerParam(value, 0, 1, 10_000_000))
				: undefined;
			const result = await service.getRows(project.accountId, project.id, params.documentId, {
				offset: integerParam(url.searchParams.get('offset'), 0, 0, 10_000_000),
				limit: integerParam(url.searchParams.get('limit'), 50, 1, 200),
				ordinals
			});
			return json({ rows: result }, { headers: noStoreHeaders });
		}
		const document = await service.getDocument(project.accountId, project.id, params.documentId);
		return json({ document }, { headers: noStoreHeaders });
	} catch (cause) {
		throwEvidenceHttpError(cause);
	}
};

export const DELETE: RequestHandler = async ({ params, locals }) => {
	const project = await requireOwnedProject(locals, params.id);
	if (!params.documentId) throw error(400, 'document id required');
	try {
		await getProjectEvidenceService().deleteDocument(project.accountId, project.id, params.documentId);
		return json({ ok: true }, { headers: noStoreHeaders });
	} catch (cause) {
		throwEvidenceHttpError(cause);
	}
};

