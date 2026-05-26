import { refreshCrawlPlanCandidates } from '$lib/server/agent/crawl-plans';
import { updateAgentJob } from '$lib/server/agent/board';
import { listApprovedCrawlPlans, updateCrawlPlan } from '$lib/server/db/crawl-plans';
import { getMissionConfig } from '$lib/server/db/missions';
import type { CrawlPlanProposal } from '$lib/types';
import { compileChannelPrompt } from '$lib/utils/channel-sources';
import { agentFetch } from './transport';

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

export async function syncCrawlPlanVersionToAgent(
	_accountId: string,
	missionId: string,
	plan: CrawlPlanProposal,
	actor = 'editor'
): Promise<void> {
	const response = await agentFetch('/api/crawl-plans', {
		method: 'POST',
		body: JSON.stringify({
			beat_id: missionId,
			id: plan.id,
			seed_url: plan.seedUrl,
			link_follow_rule: plan.linkFollowRule,
			article_body_strategy: plan.articleBodyStrategy,
			polling_cadence: plan.pollingCadence,
			jitter_ms: plan.jitterMs,
			change_detection: plan.changeDetection,
			polite_fetch: {
				respect_robots: plan.politeFetch.respectRobots,
				robots_override: plan.politeFetch.robotsOverride,
				host_delay_ms: plan.politeFetch.hostDelayMs,
				failure_budget: plan.politeFetch.failureBudget,
				archive_web: plan.politeFetch.archiveWeb
			},
			candidate_links: plan.candidateLinks,
			created_by: actor
		})
	});
	if (!response.ok) throw new Error(`Agent ${response.status}: ${await response.text()}`);
}
