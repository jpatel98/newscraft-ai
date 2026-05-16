import { error, json, type RequestHandler } from '@sveltejs/kit';
import { getMissionReport } from '$lib/server/db/mission-reports';

export const GET: RequestHandler = async ({ locals, params, setHeaders }) => {
	if (!locals.user) throw error(401, 'unauthorized');
	const id = params.id?.trim();
	if (!id) throw error(400, 'missing report id');
	const report = getMissionReport(locals.user.id, id);
	if (!report) throw error(404, 'report not found');
	setHeaders({ 'cache-control': 'private, max-age=30' });
	return json({
		id: report.id,
		responseMarkdown: report.responseMarkdown
	});
};
