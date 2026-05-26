import { error, json, type RequestHandler } from '@sveltejs/kit';
import { draftCrawlPlan } from '$lib/server/agent/crawl-plans';
import {
	createCrawlPlanProposal,
	listCrawlPlans
} from '$lib/server/db/crawl-plans';
import { getMissionConfig } from '$lib/server/db/missions';
import { syncCrawlPlanVersionToAgent } from '$lib/server/agent/crawl-plan-sync';

export const GET: RequestHandler = async ({ locals, params }) => {
	if (!locals.user) throw error(401, 'unauthorized');
	const id = params.id?.trim();
	if (!id) throw error(400, 'job id is required');
	if (!(await getMissionConfig(locals.user.id, id))) throw error(404, 'mission not found');

	return json({ crawlPlans: await listCrawlPlans(locals.user.id, id) });
};

export const POST: RequestHandler = async ({ locals, params, request }) => {
	if (!locals.user) throw error(401, 'unauthorized');
	const id = params.id?.trim();
	if (!id) throw error(400, 'job id is required');
	if (!(await getMissionConfig(locals.user.id, id))) throw error(404, 'mission not found');

	const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
	const seedUrl = typeof body?.seedUrl === 'string' ? body.seedUrl : '';
	const missionSchedule = typeof body?.missionSchedule === 'string' ? body.missionSchedule : null;
	try {
		const draft = await draftCrawlPlan({ seedUrl, missionSchedule });
		const proposal = await createCrawlPlanProposal(locals.user.id, id, draft);
		let syncWarning: string | null = null;
		try {
			await syncCrawlPlanVersionToAgent(locals.user.id, id, proposal, 'beat_monitor');
		} catch (err) {
			syncWarning = err instanceof Error ? err.message : String(err);
		}
		return json({ ok: true, crawlPlan: proposal, syncWarning });
	} catch (err) {
		throw error(400, err instanceof Error ? err.message : String(err));
	}
};
