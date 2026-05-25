import { refreshCrawlPlanCandidates } from '$lib/server/agent/crawl-plans';
import { updateAgentJob } from '$lib/server/agent/board';
import { listApprovedCrawlPlans, updateCrawlPlan } from '$lib/server/db/crawl-plans';
import { getMissionConfig } from '$lib/server/db/missions';
import { compileChannelPrompt } from '$lib/utils/channel-sources';

interface SyncApprovedCrawlPlansOptions {
	refreshCandidates?: boolean;
}

export async function syncApprovedCrawlPlansToAgent(
	accountId: string,
	missionId: string,
	options: SyncApprovedCrawlPlansOptions = {}
): Promise<void> {
	const config = await getMissionConfig(accountId, missionId);
	if (!config) return;
	const approved = await listApprovedCrawlPlans(accountId, missionId);
	if (approved.length === 0) {
		await updateAgentJob(accountId, missionId, {
			prompt: compileChannelPrompt(config.basePrompt, config.sources)
		});
		return;
	}

	if (options.refreshCandidates) {
		await Promise.all(
			approved.map(async (plan) => {
				try {
					const candidateLinks = await refreshCrawlPlanCandidates(plan);
					await updateCrawlPlan(accountId, missionId, plan.id, { candidateLinks });
				} catch {
					// Keep the last approved preview if the seed page is temporarily unavailable.
				}
			})
		);
	}

	const refreshed = await listApprovedCrawlPlans(accountId, missionId);
	await updateAgentJob(accountId, missionId, {
		prompt: compileChannelPrompt(config.basePrompt, config.sources, refreshed)
	});
}
