import { createHash } from 'node:crypto';
import type {
	NewsroomCrawlPlanVersionDto,
	NewsroomGateDto,
	NewsroomJobDto
} from '@newscraft/shared';
import { executeCrawlPlan } from '../crawl-plans/executor.js';
import { DEFAULT_WORKSPACE_ID, type HarnessRepository } from '../db/repository.js';
import { politeFetch, type PoliteFetchOptions } from '../tools/polite-fetch.js';
import { selectSourceAdapter, type SourceAdapterKind, type SourceItem } from '../tools/source-adapters/index.js';
import { nowIso } from '../util/ids.js';
import { assessSourceQuality } from '../util/source-quality.js';

const WATCHLIST_HEADING = '## Configured Watchlist';
const CRAWL_PLAN_HEADING = '## Approved Crawl Plans';
const DEFAULT_MAX_PITCHES = 3;
const DEFAULT_MAX_ITEMS_PER_SOURCE = 6;
const DEFAULT_MAX_CRAWL_PLAN_LINKS = 4;

interface StandingBriefSource {
	name: string;
	url: string;
}

interface StandingBriefPromptConfig {
	sources: StandingBriefSource[];
	approvedPlanSeedUrls: Set<string>;
	hasApprovedCrawlPlanBlock: boolean;
}

interface BeatMonitorRunInput {
	runId: string;
	workspaceId?: string;
}

interface BeatMonitorRunOptions {
	fetchImpl?: typeof fetch;
	signal?: AbortSignal;
	maxPitches?: number;
	maxItemsPerSource?: number;
}

interface BeatMonitorLead {
	title: string;
	url: string;
	summary: string;
	contentText: string;
	sourceName: string;
	sourceUrl: string;
	adapter: SourceAdapterKind | string;
	publishedAt: string | null;
	updatedAt: string | null;
	contentHash: string | null;
	statusCode: number | null;
	archiveSnapshotUrl: string | null;
	metadata?: SourceItem['metadata'];
	provenance?: SourceItem['provenance'];
	eventId?: string | null;
	via: 'watchlist' | 'crawl_plan';
}

interface BeatMonitorPitch {
	id: string;
	title: string;
	confidence: number;
	whyNow: string;
	suggestedAngle: string;
	sources: Array<{
		title: string;
		url: string;
		summary: string;
		adapter: string;
		source_name: string;
		published_at: string | null;
		updated_at: string | null;
		content_hash: string | null;
		archive_snapshot_url?: string | null;
		metadata?: SourceItem['metadata'];
		provenance?: Record<string, unknown>;
		event_id?: string | null;
	}>;
}

export interface BeatMonitorRunResult {
	beatId: string;
	sourceCount: number;
	pitchCount: number;
	gates: NewsroomGateDto[];
}

export function hasBeatMonitorInputs(repository: HarnessRepository, job: NewsroomJobDto): boolean {
	const promptConfig = parseStandingBriefPrompt(job.prompt || '');
	if (promptConfig.sources.length > 0) return true;
	return approvedCrawlPlansForBeat(repository, job.id, promptConfig).length > 0;
}

export async function runBeatMonitor(
	repository: HarnessRepository,
	job: NewsroomJobDto,
	input: BeatMonitorRunInput,
	options: BeatMonitorRunOptions = {}
): Promise<BeatMonitorRunResult> {
	const workspaceId = input.workspaceId || job.workspace_id || DEFAULT_WORKSPACE_ID;
	const promptConfig = parseStandingBriefPrompt(job.prompt || '');
	const startedAt = nowIso();
	const knownKeys = knownLeadKeys(repository, job.id);
	const leads: BeatMonitorLead[] = [];

	repository.appendEvent({
		workspaceId,
		jobId: job.id,
		runId: input.runId,
		agent: 'beat_monitor',
		kind: 'beat_monitor.pass.started',
		payload: {
			beat_id: job.id,
			beat_name: job.name,
			standing_brief: {
				job_id: job.id,
				schedule: job.schedule
			},
			configured_source_count: promptConfig.sources.length,
			approved_crawl_plan_count: approvedCrawlPlansForBeat(repository, job.id, promptConfig).length
		},
		createdAt: startedAt
	});

	for (const source of promptConfig.sources) {
		try {
			leads.push(...(await readConfiguredSource(repository, job, input.runId, source, options)));
		} catch (err) {
			appendMonitorFailureEvent(repository, workspaceId, job, input.runId, 'beat_monitor.source.failed', {
				source,
				error: publicError(err)
			});
		}
	}

	for (const plan of approvedCrawlPlansForBeat(repository, job.id, promptConfig)) {
		try {
			leads.push(...(await executeApprovedCrawlPlan(repository, job, input.runId, workspaceId, plan, options)));
		} catch (err) {
			appendMonitorFailureEvent(repository, workspaceId, job, input.runId, 'beat_monitor.crawl_plan.failed', {
				plan_id: plan.id,
				plan_version: plan.version,
				seed_urls: plan.seed_urls,
				error: publicError(err)
			});
		}
	}

	const candidateLeads = dedupeLeads(leads).filter((lead) => !knownKeys.has(leadKey(lead.url)));
	const pitches = candidateLeads
		.slice(0, clampPositiveInteger(options.maxPitches, DEFAULT_MAX_PITCHES))
		.map((lead) => pitchFromLead(job, lead));
	const gates = pitches.map((pitch) => queuePitchGate(repository, job, input.runId, workspaceId, pitch));
	const pitchedLeads = candidateLeads.slice(0, pitches.length);
	const completedAt = nowIso();

	repository.appendBeatMemory(job.id, {
		key: 'prior_coverage',
		kind: 'beat_monitor.working_memory.updated',
		actor: 'beat_monitor',
		createdAt: completedAt,
		value: {
			beat_id: job.id,
			beat_name: job.name,
			run_id: input.runId,
			observed_at: completedAt,
			configured_sources: promptConfig.sources.map((source) => ({ name: source.name, url: source.url })),
			source_count: leads.length,
			pitch_count: pitches.length,
			pitch_gate_ids: gates.map((gate) => gate.id),
			source_urls: pitchedLeads.map((lead) => lead.url),
			pitches: pitches.map((pitch) => ({
				pitch_id: pitch.id,
				title: pitch.title,
				confidence: pitch.confidence,
				why_now: pitch.whyNow,
				suggested_angle: pitch.suggestedAngle,
				source_set: pitch.sources
			}))
		}
	});

	repository.appendEvent({
		workspaceId,
		jobId: job.id,
		runId: input.runId,
		agent: 'beat_monitor',
		kind: 'beat_monitor.pass.completed',
		payload: {
			beat_id: job.id,
			beat_name: job.name,
			source_count: leads.length,
			new_lead_count: candidateLeads.length,
			pitch_gate_ids: gates.map((gate) => gate.id)
		},
		sources: candidateLeads.slice(0, 12).map((lead) => ({
			url: lead.url,
			title: lead.title,
			adapter: lead.adapter,
			source_name: lead.sourceName,
			metadata: lead.metadata ?? null,
			provenance: lead.provenance ? sourceProvenancePayload(lead) : null,
			...(lead.archiveSnapshotUrl ? { archive_snapshot_url: lead.archiveSnapshotUrl } : {})
		})),
		createdAt: completedAt
	});

	return {
		beatId: job.id,
		sourceCount: leads.length,
		pitchCount: gates.length,
		gates
	};
}

export function parseStandingBriefPrompt(prompt: string): StandingBriefPromptConfig {
	const sources = parseConfiguredWatchlist(prompt);
	const approvedPlanSeedUrls = parseApprovedCrawlPlanSeedUrls(prompt);
	return {
		sources,
		approvedPlanSeedUrls,
		hasApprovedCrawlPlanBlock: prompt.includes(CRAWL_PLAN_HEADING)
	};
}

function parseConfiguredWatchlist(prompt: string): StandingBriefSource[] {
	const block = sectionBlock(prompt, WATCHLIST_HEADING);
	if (!block) return [];
	const seen = new Set<string>();
	const sources: StandingBriefSource[] = [];
	for (const line of block.split(/\r?\n/)) {
		const match = line.match(/^\s*-\s*(.+?):\s*(https?:\/\/\S+)/i);
		if (!match) continue;
		const url = normalizeHttpUrl(match[2]);
		if (!url || seen.has(url)) continue;
		seen.add(url);
		sources.push({
			name: compactText(match[1], 96) || sourceNameFromUrl(url),
			url
		});
	}
	return sources;
}

function parseApprovedCrawlPlanSeedUrls(prompt: string): Set<string> {
	const block = sectionBlock(prompt, CRAWL_PLAN_HEADING);
	const urls = new Set<string>();
	if (!block) return urls;
	for (const line of block.split(/\r?\n/)) {
		const match = line.match(/^\s*-\s*Seed URL:\s*(https?:\/\/\S+)/i);
		const url = match ? normalizeHttpUrl(match[1]) : null;
		if (url) urls.add(url);
	}
	return urls;
}

function sectionBlock(prompt: string, heading: string): string {
	const start = prompt.indexOf(heading);
	if (start < 0) return '';
	const afterHeading = prompt.slice(start + heading.length);
	const nextHeading = afterHeading.search(/\n##\s+/);
	return (nextHeading >= 0 ? afterHeading.slice(0, nextHeading) : afterHeading).trim();
}

function approvedCrawlPlansForBeat(
	repository: HarnessRepository,
	beatId: string,
	promptConfig: StandingBriefPromptConfig
): NewsroomCrawlPlanVersionDto[] {
	const latest = new Map<string, NewsroomCrawlPlanVersionDto>();
	for (const plan of repository.listCrawlPlanVersions(beatId)) {
		const current = latest.get(plan.id);
		if (!current || plan.version > current.version) latest.set(plan.id, plan);
	}
	return Array.from(latest.values()).filter((plan) => {
		if (plan.status === 'approved') return true;
		if (plan.status === 'pending' || plan.status === 'rejected') return false;
		return promptConfig.hasApprovedCrawlPlanBlock && plan.seed_urls.some((url) => promptConfig.approvedPlanSeedUrls.has(url));
	});
}

async function readConfiguredSource(
	repository: HarnessRepository,
	job: NewsroomJobDto,
	runId: string,
	source: StandingBriefSource,
	options: BeatMonitorRunOptions
): Promise<BeatMonitorLead[]> {
	const fetched = await politeFetch(source.url, monitorFetchOptions(options));
	const adapter = selectSourceAdapter({ url: source.url, contentType: fetched.contentType, body: fetched.body });
	const adapterInput = {
		url: source.url,
		body: fetched.body,
		contentType: fetched.contentType,
		fetchedAt: fetched.fetchedAt,
		statusCode: fetched.statusCode,
		contentHash: fetched.cache.contentHash,
		archiveSnapshotUrl: fetched.archiveSnapshot.ok ? fetched.archiveSnapshot.snapshotUrl : null,
		cache: fetched.cache
	};
	const discovered = await adapter.discover(adapterInput);
	const extracted = discovered.length ? discovered : await adapter.extract(adapterInput);
	const maxItems = clampPositiveInteger(options.maxItemsPerSource, DEFAULT_MAX_ITEMS_PER_SOURCE);
	const leads: BeatMonitorLead[] = [];

	if (!extracted.length || !fetched.ok) {
		repository.storeSource({
			runId,
			jobId: job.id,
			url: source.url,
			title: source.name,
			fetchedAt: fetched.fetchedAt,
			snippet: '',
			summary: fetched.ok ? 'No source items discovered.' : `Source returned HTTP ${fetched.statusCode}.`,
			used: false,
			contentText: '',
			contentHash: fetched.cache.contentHash,
			contentType: fetched.contentType,
			statusCode: fetched.statusCode,
			healthGate: fetched.sourceHealthGate ?? null
		});
		return [];
	}

	for (const item of extracted.slice(0, maxItems)) {
		const lead = leadFromSourceItem(item, source.name, source.url, adapter.kind);
		const quality = assessSourceQuality({
			title: lead.title,
			text: lead.contentText,
			summary: lead.summary,
			statusCode: lead.statusCode
		});
		const stored = repository.storeSource({
			runId,
			jobId: job.id,
			url: lead.url,
			title: lead.title,
			fetchedAt: item.provenance.fetchedAt || fetched.fetchedAt,
			snippet: quality.usable ? compactText(lead.contentText || lead.summary, 600) : '',
			summary: quality.usable ? compactText(lead.summary || lead.contentText, 420) : '',
			used: quality.usable,
			contentText: quality.usable ? compactText(lead.contentText || lead.summary || lead.title, 8000) : '',
			contentHash: lead.contentHash || hashText(`${lead.url}\n${lead.title}\n${lead.contentText}`),
			contentType: item.provenance.contentType || fetched.contentType,
			statusCode: item.provenance.statusCode ?? fetched.statusCode,
			archiveSnapshotUrl: lead.archiveSnapshotUrl,
			metadata: lead.metadata ?? null,
			provenance: lead.provenance ?? null,
			healthGate: fetched.sourceHealthGate ?? null
		});
		if (quality.usable) leads.push({ ...lead, eventId: stored.id });
	}

	return leads;
}

async function executeApprovedCrawlPlan(
	repository: HarnessRepository,
	job: NewsroomJobDto,
	runId: string,
	workspaceId: string,
	plan: NewsroomCrawlPlanVersionDto,
	options: BeatMonitorRunOptions
): Promise<BeatMonitorLead[]> {
	const result = await executeCrawlPlan(
		repository,
		job.id,
		plan.id,
		{
			workspace_id: workspaceId,
			job_id: job.id,
			run_id: runId,
			version: plan.version,
			max_links: DEFAULT_MAX_CRAWL_PLAN_LINKS,
			actor: 'beat_monitor'
		},
		{ fetchImpl: options.fetchImpl }
	);
	return result.sources.map((source) => ({
		title: source.title,
		url: source.url,
		summary: source.summary,
		contentText: source.summary,
		sourceName: sourceNameFromUrl(source.url),
		sourceUrl: plan.seed_urls[0] || source.url,
		adapter: source.adapter,
		publishedAt: null,
		updatedAt: null,
		contentHash: source.content_hash,
		statusCode: source.status_code,
		archiveSnapshotUrl: source.archive_snapshot_url ?? null,
		metadata: source.metadata ?? null,
		provenance: source.provenance ? (source.provenance as unknown as SourceItem['provenance']) : undefined,
		eventId: source.event_id,
		via: 'crawl_plan'
	}));
}

function monitorFetchOptions(options: BeatMonitorRunOptions): PoliteFetchOptions {
	return {
		signal: options.signal,
		fetchImpl: options.fetchImpl,
		robots: {
			fetchImpl: options.fetchImpl
		},
		archive: {
			webArchive: process.env.NEWSROOM_ARCHIVE_SNAPSHOT !== '0' && process.env.VITEST !== 'true',
			fetchImpl: options.fetchImpl
		},
		sourceHealth: {
			failureBudget: 3
		}
	};
}

function appendMonitorFailureEvent(
	repository: HarnessRepository,
	workspaceId: string,
	job: NewsroomJobDto,
	runId: string,
	kind: string,
	payload: unknown
): void {
	repository.appendEvent({
		workspaceId,
		jobId: job.id,
		runId,
		agent: 'beat_monitor',
		kind,
		payload
	});
}

function leadFromSourceItem(
	item: SourceItem,
	sourceName: string,
	sourceUrl: string,
	adapter: SourceAdapterKind
): BeatMonitorLead {
	const contentText = compactText(item.contentText || item.summary || item.title, 8000);
	const summary = compactText(item.summary || contentText, 420);
	return {
		title: compactText(item.title, 160),
		url: item.url,
		summary,
		contentText,
		sourceName,
		sourceUrl,
		adapter,
		publishedAt: item.publishedAt,
		updatedAt: item.updatedAt,
		contentHash: item.provenance.contentHash || hashText(`${item.url}\n${item.title}\n${contentText}`),
		statusCode: item.provenance.statusCode ?? null,
		archiveSnapshotUrl: item.provenance.archiveSnapshotUrl ?? null,
		metadata: item.metadata ?? null,
		provenance: item.provenance,
		via: 'watchlist'
	};
}

function pitchFromLead(job: NewsroomJobDto, lead: BeatMonitorLead): BeatMonitorPitch {
	const confidence = confidenceForLead(lead);
	const sourceName = lead.sourceName || sourceNameFromUrl(lead.url);
	return {
		id: `pitch-${hashText(`${job.id}\n${lead.url}\n${lead.title}`).slice(0, 16)}`,
		title: compactText(lead.title, 120),
		confidence,
		whyNow: whyNowForLead(job, lead),
		suggestedAngle: suggestedAngleForLead(lead, sourceName),
		sources: [
			{
				title: lead.title,
				url: lead.url,
				summary: lead.summary,
				adapter: String(lead.adapter),
				source_name: sourceName,
				published_at: lead.publishedAt,
				updated_at: lead.updatedAt,
				content_hash: lead.contentHash,
				metadata: lead.metadata ?? null,
				provenance: lead.provenance ? sourceProvenancePayload(lead) : undefined,
				...(lead.archiveSnapshotUrl ? { archive_snapshot_url: lead.archiveSnapshotUrl } : {}),
				event_id: lead.eventId ?? null
			}
		]
	};
}

function sourceProvenancePayload(lead: Pick<BeatMonitorLead, 'provenance' | 'metadata' | 'adapter'>): Record<string, unknown> {
	return {
		adapter: lead.provenance?.adapter ?? lead.adapter,
		source_url: lead.provenance?.sourceUrl ?? null,
		fetched_at: lead.provenance?.fetchedAt ?? null,
		content_type: lead.provenance?.contentType ?? null,
		status_code: lead.provenance?.statusCode ?? null,
		content_hash: lead.provenance?.contentHash ?? null,
		archive_snapshot_url: lead.provenance?.archiveSnapshotUrl ?? null,
		etag: lead.provenance?.etag ?? null,
		last_modified: lead.provenance?.lastModified ?? null,
		extraction_method: lead.provenance?.extractionMethod ?? null,
		metadata_sources: lead.provenance?.metadataSources ?? lead.metadata?.metadataSources ?? null,
		structured_type: lead.provenance?.structuredType ?? lead.metadata?.structuredType ?? null,
		canonical_url: lead.provenance?.canonicalUrl ?? lead.metadata?.canonicalUrl ?? null
	};
}

function queuePitchGate(
	repository: HarnessRepository,
	job: NewsroomJobDto,
	runId: string,
	workspaceId: string,
	pitch: BeatMonitorPitch
): NewsroomGateDto {
	return repository.queueGate({
		workspace_id: workspaceId,
		job_id: job.id,
		run_id: runId,
		type: 'pitch',
		title: `Pitch: ${pitch.title}`,
		summary: compactText(`${pitch.whyNow} Suggested angle: ${pitch.suggestedAngle}`, 420),
		priority: priorityForConfidence(pitch.confidence),
		created_by: 'beat_monitor',
		actions: ['accept', 'hold', 'spike'],
		payload: {
			pitch_id: pitch.id,
			beat_id: job.id,
			beat_name: job.name,
			title: pitch.title,
			confidence: pitch.confidence,
			why_now: pitch.whyNow,
			source_set: pitch.sources,
			suggested_angle: pitch.suggestedAngle,
			standing_brief: {
				job_id: job.id,
				schedule: job.schedule,
				next_run_at: job.next_run_at
			}
		}
	});
}

function confidenceForLead(lead: BeatMonitorLead): number {
	let score = 68;
	if (lead.via === 'crawl_plan') score += 6;
	if (lead.adapter === 'rss' || lead.adapter === 'atom') score += 5;
	if (lead.contentText.length > 180 || lead.summary.length > 80) score += 5;
	if (isRecent(lead.publishedAt, 48) || isRecent(lead.updatedAt, 48)) score += 10;
	if (lead.statusCode && lead.statusCode >= 200 && lead.statusCode < 300) score += 3;
	return Math.max(50, Math.min(92, score));
}

function whyNowForLead(job: NewsroomJobDto, lead: BeatMonitorLead): string {
	const timestamp = lead.publishedAt || lead.updatedAt;
	if (timestamp) {
		return `${lead.sourceName} published or updated this item at ${timestamp}; the ${job.name} Standing Brief surfaced it on this monitor pass.`;
	}
	if (lead.via === 'crawl_plan') {
		return `An approved Crawl Plan assigned to ${job.name} surfaced this source during the monitor pass.`;
	}
	return `${job.name} surfaced this configured-source lead during the latest monitor pass.`;
}

function suggestedAngleForLead(lead: BeatMonitorLead, sourceName: string): string {
	const summary = lead.summary || lead.contentText;
	if (summary && summary.toLowerCase() !== lead.title.toLowerCase()) {
		return compactText(`${lead.title}: ${summary}`, 260);
	}
	return compactText(`Use ${sourceName} as the first source and verify what changed, who is affected, and what happens next.`, 260);
}

function priorityForConfidence(confidence: number): number {
	if (confidence >= 82) return 2;
	if (confidence >= 70) return 3;
	return 4;
}

function knownLeadKeys(repository: HarnessRepository, beatId: string): Set<string> {
	const keys = new Set<string>();
	const memory = repository.inspectBeatMemory(beatId);
	collectKnownKeys(memory.current.prior_coverage, keys);
	for (const gate of repository.listGates({ jobId: beatId, status: 'open', limit: 200 })) {
		collectKnownKeys(gate.payload, keys);
	}
	return keys;
}

function collectKnownKeys(value: unknown, keys: Set<string>): void {
	if (Array.isArray(value)) {
		for (const item of value) collectKnownKeys(item, keys);
		return;
	}
	if (!value || typeof value !== 'object') return;
	const raw = value as Record<string, unknown>;
	for (const field of ['url', 'source_url', 'sourceUrl']) {
		if (typeof raw[field] === 'string') keys.add(leadKey(raw[field]));
	}
	for (const field of ['source_urls', 'sourceUrls']) {
		if (Array.isArray(raw[field])) {
			for (const url of raw[field]) {
				if (typeof url === 'string') keys.add(leadKey(url));
			}
		}
	}
	for (const nested of Object.values(raw)) collectKnownKeys(nested, keys);
}

function dedupeLeads(leads: BeatMonitorLead[]): BeatMonitorLead[] {
	const seen = new Set<string>();
	const deduped: BeatMonitorLead[] = [];
	for (const lead of leads) {
		const key = leadKey(lead.url);
		if (!key || seen.has(key)) continue;
		seen.add(key);
		deduped.push(lead);
	}
	return deduped;
}

function leadKey(url: string): string {
	const normalized = normalizeHttpUrl(url);
	return normalized ? normalized.toLowerCase() : url.trim().toLowerCase();
}

function isRecent(value: string | null, hours: number): boolean {
	if (!value) return false;
	const timestamp = Date.parse(value);
	if (!Number.isFinite(timestamp)) return false;
	return Date.now() - timestamp <= hours * 60 * 60 * 1000;
}

function normalizeHttpUrl(value: string): string | null {
	const raw = value.trim().replace(/[),.;]+$/, '');
	try {
		const parsed = new URL(raw);
		if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
		parsed.hash = '';
		return parsed.toString();
	} catch {
		return null;
	}
}

function sourceNameFromUrl(value: string): string {
	try {
		return new URL(value).hostname.replace(/^www\./, '');
	} catch {
		return value;
	}
}

function compactText(value: string, maxLength: number): string {
	const cleaned = value.replace(/\s+/g, ' ').trim();
	if (cleaned.length <= maxLength) return cleaned;
	return `${cleaned.slice(0, Math.max(0, maxLength - 3)).trim()}...`;
}

function hashText(value: string): string {
	return createHash('sha256').update(value).digest('hex');
}

function clampPositiveInteger(value: number | undefined, fallback: number): number {
	if (!Number.isFinite(value)) return fallback;
	return Math.max(1, Math.trunc(value as number));
}

function publicError(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
