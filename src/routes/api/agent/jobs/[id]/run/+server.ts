import { error, json, type RequestHandler } from '@sveltejs/kit';
import { runJobAction } from '$lib/server/agent/board';
import { syncApprovedCrawlPlansToAgent } from '$lib/server/agent/crawl-plan-sync';

export const POST: RequestHandler = async ({ locals, params }) => {
	if (!locals.user) throw error(401, 'unauthorized');
	const id = params.id?.trim();
	if (!id) throw error(400, 'job id is required');
	try {
		await syncApprovedCrawlPlansToAgent(locals.user.id, id, { refreshCandidates: true });
		const job = await runJobAction(locals.user.id, id, 'run');
		return json({ ok: true, job });
	} catch (err) {
		throw error(502, err instanceof Error ? err.message : String(err));
	}
};
