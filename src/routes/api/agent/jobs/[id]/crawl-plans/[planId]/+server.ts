import { error, json, type RequestHandler } from '@sveltejs/kit';
import type { CrawlPlanProposal, CrawlPlanStatus } from '$lib/types';
import { getCrawlPlan, updateCrawlPlan } from '$lib/server/db/crawl-plans';
import { getMissionConfig } from '$lib/server/db/missions';
import { syncApprovedCrawlPlansToAgent } from '$lib/server/agent/crawl-plan-sync';

const STATUSES = new Set<CrawlPlanStatus>(['pending', 'approved', 'rejected']);
const CHANGE_DETECTION = new Set<CrawlPlanProposal['changeDetection']>([
	'hash',
	'structured_diff',
	'semantic_similarity'
]);

export const PATCH: RequestHandler = async ({ locals, params, request }) => {
	if (!locals.user) throw error(401, 'unauthorized');
	const missionId = params.id?.trim();
	const planId = params.planId?.trim();
	if (!missionId) throw error(400, 'job id is required');
	if (!planId) throw error(400, 'crawl plan id is required');
	const config = await getMissionConfig(locals.user.id, missionId);
	if (!config) throw error(404, 'mission not found');
	const existing = await getCrawlPlan(locals.user.id, missionId, planId);
	if (!existing) throw error(404, 'crawl plan not found');

	const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
	const status = parseStatus(body?.status);
	const linkFollowRule = typeof body?.linkFollowRule === 'string' ? body.linkFollowRule.trim() : undefined;
	const pollingCadence = typeof body?.pollingCadence === 'string' ? body.pollingCadence.trim() : undefined;
	const changeDetection = parseChangeDetection(body?.changeDetection);
	if (linkFollowRule !== undefined && !linkFollowRule) throw error(400, 'Link-follow rule is required');
	if (pollingCadence !== undefined && !pollingCadence) throw error(400, 'Polling cadence is required');

	const crawlPlan = await updateCrawlPlan(locals.user.id, missionId, planId, {
		status,
		linkFollowRule,
		pollingCadence,
		changeDetection
	});
	let syncWarning: string | null = null;
	try {
		await syncApprovedCrawlPlansToAgent(locals.user.id, missionId);
	} catch (err) {
		syncWarning = err instanceof Error ? err.message : String(err);
	}
	return json({ ok: true, crawlPlan, syncWarning });
};

function parseStatus(value: unknown): CrawlPlanStatus | undefined {
	if (typeof value !== 'string') return undefined;
	if (!STATUSES.has(value as CrawlPlanStatus)) throw error(400, 'Invalid crawl plan status');
	return value as CrawlPlanStatus;
}

function parseChangeDetection(value: unknown): CrawlPlanProposal['changeDetection'] | undefined {
	if (typeof value !== 'string') return undefined;
	if (!CHANGE_DETECTION.has(value as CrawlPlanProposal['changeDetection'])) {
		throw error(400, 'Invalid change detection mode');
	}
	return value as CrawlPlanProposal['changeDetection'];
}
