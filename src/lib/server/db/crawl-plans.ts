import { and, asc, eq } from 'drizzle-orm';
import type { CrawlPlanCandidateLink, CrawlPlanProposal, CrawlPlanStatus } from '$lib/types';
import type { CrawlPlanDraft } from '$lib/server/agent/crawl-plans';
import { newId } from '$lib/utils/id';
import { db } from './index';
import { missionCrawlPlans } from './schema';

type CrawlPlanRow = typeof missionCrawlPlans.$inferSelect;

function parseCandidateLinks(value: string): CrawlPlanCandidateLink[] {
	try {
		const parsed = JSON.parse(value);
		if (!Array.isArray(parsed)) return [];
		return parsed
			.map((item) => {
				if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
				const link = item as Record<string, unknown>;
				return {
					title: typeof link.title === 'string' ? link.title : '',
					url: typeof link.url === 'string' ? link.url : '',
					reason: typeof link.reason === 'string' ? link.reason : '',
					score: typeof link.score === 'number' && Number.isFinite(link.score) ? link.score : 0
				};
			})
			.filter((link): link is CrawlPlanCandidateLink => Boolean(link?.title && link.url));
	} catch {
		return [];
	}
}

function rowToProposal(row: CrawlPlanRow): CrawlPlanProposal {
	return {
		id: row.id,
		missionId: row.missionId,
		seedUrl: row.seedUrl,
		siteName: row.siteName,
		status: row.status,
		linkFollowRule: row.linkFollowRule,
		articleBodyStrategy: row.articleBodyStrategy,
		pollingCadence: row.pollingCadence,
		changeDetection: row.changeDetection,
		candidateLinks: parseCandidateLinks(row.candidateLinksJson),
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
		approvedAt: row.approvedAt,
		rejectedAt: row.rejectedAt
	};
}

export async function listCrawlPlans(accountId: string, missionId: string): Promise<CrawlPlanProposal[]> {
	const rows = (await db
		.select()
		.from(missionCrawlPlans)
		.where(and(eq(missionCrawlPlans.accountId, accountId), eq(missionCrawlPlans.missionId, missionId)))
		.orderBy(asc(missionCrawlPlans.createdAt))) as CrawlPlanRow[];
	return rows.map(rowToProposal);
}

export async function listApprovedCrawlPlans(accountId: string, missionId: string): Promise<CrawlPlanProposal[]> {
	return (await listCrawlPlans(accountId, missionId)).filter((plan) => plan.status === 'approved');
}

export async function createCrawlPlanProposal(
	accountId: string,
	missionId: string,
	draft: CrawlPlanDraft
): Promise<CrawlPlanProposal> {
	const now = Date.now();
	const id = newId();
	await db.insert(missionCrawlPlans).values({
		id,
		accountId,
		missionId,
		seedUrl: draft.seedUrl,
		siteName: draft.siteName,
		status: 'pending',
		linkFollowRule: draft.linkFollowRule,
		articleBodyStrategy: draft.articleBodyStrategy,
		pollingCadence: draft.pollingCadence,
		changeDetection: draft.changeDetection,
		candidateLinksJson: JSON.stringify(draft.candidateLinks),
		planJson: JSON.stringify(draft.plan),
		createdAt: now,
		updatedAt: now,
		approvedAt: null,
		rejectedAt: null
	});
	const [row] = (await db
		.select()
		.from(missionCrawlPlans)
		.where(and(eq(missionCrawlPlans.accountId, accountId), eq(missionCrawlPlans.id, id)))
		.limit(1)) as CrawlPlanRow[];
	return rowToProposal(row);
}

export async function getCrawlPlan(
	accountId: string,
	missionId: string,
	planId: string
): Promise<CrawlPlanProposal | null> {
	const [row] = (await db
		.select()
		.from(missionCrawlPlans)
		.where(
			and(
				eq(missionCrawlPlans.accountId, accountId),
				eq(missionCrawlPlans.missionId, missionId),
				eq(missionCrawlPlans.id, planId)
			)
		)
		.limit(1)) as CrawlPlanRow[];
	return row ? rowToProposal(row) : null;
}

export async function updateCrawlPlan(
	accountId: string,
	missionId: string,
	planId: string,
	input: {
		status?: CrawlPlanStatus;
		linkFollowRule?: string;
		pollingCadence?: string;
		changeDetection?: CrawlPlanProposal['changeDetection'];
		candidateLinks?: CrawlPlanCandidateLink[];
	}
): Promise<CrawlPlanProposal | null> {
	const now = Date.now();
	const status = input.status;
	const changes: Partial<{
		status: CrawlPlanStatus;
		linkFollowRule: string;
		pollingCadence: string;
		changeDetection: CrawlPlanProposal['changeDetection'];
		candidateLinksJson: string;
		updatedAt: number;
		approvedAt: number | null;
		rejectedAt: number | null;
	}> = { updatedAt: now };

	if (status !== undefined) {
		changes.status = status;
		changes.approvedAt = status === 'approved' ? now : null;
		changes.rejectedAt = status === 'rejected' ? now : null;
	}
	if (input.linkFollowRule !== undefined) changes.linkFollowRule = input.linkFollowRule;
	if (input.pollingCadence !== undefined) changes.pollingCadence = input.pollingCadence;
	if (input.changeDetection !== undefined) changes.changeDetection = input.changeDetection;
	if (input.candidateLinks !== undefined) changes.candidateLinksJson = JSON.stringify(input.candidateLinks);

	await db
		.update(missionCrawlPlans)
		.set(changes)
		.where(
			and(
				eq(missionCrawlPlans.accountId, accountId),
				eq(missionCrawlPlans.missionId, missionId),
				eq(missionCrawlPlans.id, planId)
			)
		);
	return getCrawlPlan(accountId, missionId, planId);
}
