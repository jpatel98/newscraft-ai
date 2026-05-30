import type {
	CrawlPlanSourceEventDto,
	ExecuteCrawlPlanInput,
	ExecuteCrawlPlanResult,
	NewsroomCrawlPlanCandidateLinkDto,
	NewsroomCrawlPlanVersionDto,
	NewsroomEventDto
} from '@newscraft/shared';
import { DEFAULT_WORKSPACE_ID, type HarnessRepository } from '../db/repository.js';
import { politeFetch, type PoliteFetchOptions } from '../tools/polite-fetch.js';
import { selectSourceAdapter, type SourceItem } from '../tools/source-adapters/index.js';

interface ExecuteOptions {
	fetchImpl?: typeof fetch;
}

const DEFAULT_MAX_LINKS = 6;
const MAX_LINKS = 20;

export async function executeCrawlPlan(
	repository: HarnessRepository,
	beatId: string,
	planId: string,
	input: ExecuteCrawlPlanInput = {},
	options: ExecuteOptions = {}
): Promise<ExecuteCrawlPlanResult> {
	const plan = repository.requireCrawlPlanVersion(beatId, planId, input.version);
	const workspaceId = input.workspace_id || DEFAULT_WORKSPACE_ID;
	const actor = input.actor || 'crawl_plan_executor';
	const maxLinks = clampMaxLinks(input.max_links);
	const events: NewsroomEventDto[] = [];
	const sources: CrawlPlanSourceEventDto[] = [];

	for (const seedUrl of plan.seed_urls) {
		if (sources.length >= maxLinks) break;
		const seedDecision = repository.sourceHealthDecisionForUrl(seedUrl, workspaceId);
		if (seedDecision?.blocks_fetch) {
			events.push(appendSourceHealthSkippedEvent(repository, seedUrl, seedDecision, { actor, workspaceId, jobId: input.job_id, runId: input.run_id }));
			continue;
		}
		const fetched = await politeFetch(seedUrl, politeFetchOptions(plan, options.fetchImpl));
		const adapter = selectSourceAdapter({
			url: seedUrl,
			contentType: fetched.contentType,
			body: fetched.body
		});
		const discovered = await adapter.discover({
			url: seedUrl,
			body: fetched.body,
			contentType: fetched.contentType,
			fetchedAt: fetched.fetchedAt,
			statusCode: fetched.statusCode,
			contentHash: fetched.cache.contentHash,
			archiveSnapshotUrl: fetched.archiveSnapshot.ok ? fetched.archiveSnapshot.snapshotUrl : null,
			cache: fetched.cache
		});
		const sourceItems =
			adapter.kind === 'html_article'
				? await fetchCandidateArticles(repository, plan, seedUrl, maxLinks - sources.length, {
						actor,
						workspaceId,
						jobId: input.job_id,
						runId: input.run_id,
						fetchImpl: options.fetchImpl,
						events
					})
				: filterDiscoveredItems(discovered, plan, seedUrl).slice(0, maxLinks - sources.length);

		for (const item of sourceItems) {
			const event = appendSourceEvent(repository, plan, item, {
				actor,
				workspaceId,
				jobId: input.job_id,
				runId: input.run_id
			});
			events.push(event);
			sources.push(sourceEventDto(plan, item, event.id));
		}
	}

	events.push(
		repository.appendEvent({
			workspaceId,
			jobId: input.job_id,
			runId: input.run_id,
			agent: actor,
			kind: 'crawl_plan.executed',
			payload: {
				plan_id: plan.id,
				plan_version: plan.version,
				beat_id: plan.beat_id,
				seed_urls: plan.seed_urls,
				source_count: sources.length,
				source_event_ids: sources.map((source) => source.event_id),
				plan_memory_entry_id: plan.source_memory_entry_id
			},
			sources: sources.map((source) => ({
				url: source.url,
				title: source.title,
				event_id: source.event_id,
				plan_id: plan.id,
				plan_version: plan.version
			}))
		})
	);

	return { plan, events, sources };
}

async function fetchCandidateArticles(
	repository: HarnessRepository,
	plan: NewsroomCrawlPlanVersionDto,
	seedUrl: string,
	maxLinks: number,
	options: {
		actor: string;
		workspaceId: string;
		jobId?: string | null;
		runId?: string | null;
		fetchImpl: typeof fetch | undefined;
		events: NewsroomEventDto[];
	}
): Promise<SourceItem[]> {
	const candidates = plan.candidate_links
		.filter((candidate) => candidateMatchesRule(candidate, plan, seedUrl))
		.slice(0, maxLinks);
	const items: SourceItem[] = [];
	for (const candidate of candidates) {
		const decision = repository.sourceHealthDecisionForUrl(candidate.url, options.workspaceId);
		if (decision?.blocks_fetch) {
			options.events.push(
				appendSourceHealthSkippedEvent(repository, candidate.url, decision, {
					actor: options.actor,
					workspaceId: options.workspaceId,
					jobId: options.jobId,
					runId: options.runId
				})
			);
			continue;
		}
		const fetched = await politeFetch(candidate.url, politeFetchOptions(plan, options.fetchImpl));
		if (!fetched.ok) continue;
		const adapter = selectSourceAdapter({
			url: candidate.url,
			contentType: fetched.contentType,
			body: fetched.body
		});
		const extracted = await adapter.extract({
			url: candidate.url,
			body: fetched.body,
			contentType: fetched.contentType,
			fetchedAt: fetched.fetchedAt,
			statusCode: fetched.statusCode,
			contentHash: fetched.cache.contentHash,
			archiveSnapshotUrl: fetched.archiveSnapshot.ok ? fetched.archiveSnapshot.snapshotUrl : null,
			cache: fetched.cache
		});
		const item = extracted[0];
		if (item) items.push(item);
	}
	return items;
}

function appendSourceHealthSkippedEvent(
	repository: HarnessRepository,
	url: string,
	decision: ReturnType<HarnessRepository['sourceHealthDecisionForUrl']>,
	input: {
		actor: string;
		workspaceId: string;
		jobId?: string | null;
		runId?: string | null;
	}
): NewsroomEventDto {
	return repository.appendEvent({
		workspaceId: input.workspaceId,
		jobId: input.jobId,
		runId: input.runId,
		agent: input.actor,
		kind: 'source.health.skipped',
		payload: {
			url,
			host: decision?.host ?? null,
			action: decision?.action ?? null,
			status: decision?.status ?? null,
			gate_id: decision?.gate_id ?? null,
			reason: 'Source Health policy blocks fetch.'
		}
	});
}

function filterDiscoveredItems(items: SourceItem[], plan: NewsroomCrawlPlanVersionDto, seedUrl: string): SourceItem[] {
	return items.filter((item) => candidateMatchesRule(item, plan, seedUrl));
}

function candidateMatchesRule(
	item: Pick<NewsroomCrawlPlanCandidateLinkDto, 'url' | 'title'>,
	plan: NewsroomCrawlPlanVersionDto,
	seedUrl: string
): boolean {
	const rule = plan.link_follow_rule.toLowerCase();
	if (rule.includes('same-site') || rule.includes('same site')) {
		if (!sameSite(item.url, seedUrl)) return false;
	}
	const underPath = rule.match(/\bunder\s+([/\w.-]+)/)?.[1];
	if (underPath && underPath.startsWith('/')) {
		try {
			if (!new URL(item.url).pathname.startsWith(underPath.replace(/\/$/, ''))) return false;
		} catch {
			return false;
		}
	}
	const regexRule = plan.link_follow_rule.match(/^regex:\s*(.+)$/i)?.[1];
	if (regexRule) {
		try {
			return new RegExp(regexRule, 'i').test(`${item.title}\n${item.url}`);
		} catch {
			return false;
		}
	}
	return true;
}

function sameSite(url: string, seedUrl: string): boolean {
	try {
		const host = new URL(url).hostname.toLowerCase();
		const seedHost = new URL(seedUrl).hostname.toLowerCase();
		return host === seedHost || host.endsWith(`.${seedHost}`) || seedHost.endsWith(`.${host}`);
	} catch {
		return false;
	}
}

function appendSourceEvent(
	repository: HarnessRepository,
	plan: NewsroomCrawlPlanVersionDto,
	item: SourceItem,
	input: {
		actor: string;
		workspaceId: string;
		jobId?: string | null;
		runId?: string | null;
	}
): NewsroomEventDto {
	return repository.appendEvent({
		workspaceId: input.workspaceId,
		jobId: input.jobId,
		runId: input.runId,
		agent: input.actor,
		kind: 'source.discovered',
		payload: {
			via: 'crawl_plan',
			plan_id: plan.id,
			plan_version: plan.version,
			beat_id: plan.beat_id,
			plan_memory_entry_id: plan.source_memory_entry_id,
			url: item.url,
			title: item.title,
			summary: item.summary,
			adapter: item.provenance.adapter,
			content_hash: item.provenance.contentHash,
			archive_snapshot_url: item.provenance.archiveSnapshotUrl,
			status_code: item.provenance.statusCode,
			metadata: item.metadata ?? null,
			provenance: sourceProvenancePayload(item)
		},
		sources: [
			{
				url: item.url,
				title: item.title,
				summary: item.summary,
				adapter: item.provenance.adapter,
				content_hash: item.provenance.contentHash,
				archive_snapshot_url: item.provenance.archiveSnapshotUrl,
				status_code: item.provenance.statusCode,
				metadata: item.metadata ?? null,
				provenance: sourceProvenancePayload(item),
				plan_id: plan.id,
				plan_version: plan.version
			}
		]
	});
}

function sourceEventDto(
	plan: NewsroomCrawlPlanVersionDto,
	item: SourceItem,
	eventId: string
): CrawlPlanSourceEventDto {
	return {
		url: item.url,
		title: item.title,
		summary: item.summary,
		event_id: eventId,
		content_hash: item.provenance.contentHash ?? null,
		status_code: item.provenance.statusCode ?? null,
		archive_snapshot_url: item.provenance.archiveSnapshotUrl ?? null,
		adapter: item.provenance.adapter,
		plan_version: plan.version,
		metadata: sourceMetadataPayload(item),
		provenance: sourceProvenancePayload(item)
	};
}

function sourceMetadataPayload(item: SourceItem): Record<string, unknown> | null {
	return item.metadata ? { ...item.metadata } : null;
}

function sourceProvenancePayload(item: SourceItem): Record<string, unknown> {
	return {
		adapter: item.provenance.adapter,
		source_url: item.provenance.sourceUrl,
		discovered_at: item.provenance.discoveredAt,
		fetched_at: item.provenance.fetchedAt ?? null,
		content_type: item.provenance.contentType ?? null,
		status_code: item.provenance.statusCode ?? null,
		content_hash: item.provenance.contentHash ?? null,
		archive_snapshot_url: item.provenance.archiveSnapshotUrl ?? null,
		etag: item.provenance.etag ?? null,
		last_modified: item.provenance.lastModified ?? null,
		extraction_method: item.provenance.extractionMethod ?? null,
		metadata_sources: item.provenance.metadataSources ?? item.metadata?.metadataSources ?? null,
		structured_type: item.provenance.structuredType ?? item.metadata?.structuredType ?? null,
		canonical_url: item.provenance.canonicalUrl ?? item.metadata?.canonicalUrl ?? null
	};
}

function politeFetchOptions(plan: NewsroomCrawlPlanVersionDto, fetchImpl: typeof fetch | undefined): PoliteFetchOptions {
	return {
		fetchImpl,
		rateLimit: {
			hostDelayMs: plan.polite_fetch.host_delay_ms
		},
		robots: {
			respect: plan.polite_fetch.respect_robots,
			override: plan.polite_fetch.robots_override,
			fetchImpl
		},
		archive: {
			webArchive: plan.polite_fetch.archive_web,
			fetchImpl
		},
		sourceHealth: {
			failureBudget: plan.polite_fetch.failure_budget
		}
	};
}

function clampMaxLinks(value: number | undefined): number {
	if (!Number.isFinite(value)) return DEFAULT_MAX_LINKS;
	return Math.max(1, Math.min(MAX_LINKS, Math.trunc(value as number)));
}
