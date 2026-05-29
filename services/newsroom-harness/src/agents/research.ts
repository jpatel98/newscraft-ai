import { createHash } from 'node:crypto';
import { DEFAULT_WORKSPACE_ID, type HarnessRepository } from '../db/repository.js';
import { fetchSourceUrl, type FetchedSource } from '../tools/sources.js';
import { nowIso } from '../util/ids.js';

type ResearchStatus = 'completed' | 'blocked';

export interface ResearchInput {
	command: string;
	workspaceId?: string;
	storyId?: string | null;
	jobId?: string | null;
	runId?: string | null;
	parentEventId?: string | null;
	facts?: unknown[];
}

export interface ResearchClaim {
	id: string;
	claim: string;
	status: 'proposed';
	command_excerpt: string;
	research_intent: string;
	target_claim: ResearchTargetClaim | null;
	sources: ResearchSourceEvidence[];
}

export interface ResearchTargetClaim {
	id: string | null;
	index: number | null;
	claim: string;
	status: string | null;
	source_urls: string[];
}

export interface ResearchSourceEvidence {
	title: string;
	name: string;
	url: string;
	summary: string;
	fetched_at: string;
	content_hash: string;
	content_type: string | null;
	status_code: number | null;
	adapter: string | null;
	archive_snapshot_url: string | null;
	metadata?: unknown;
	provenance?: unknown;
}

export interface ResearchRunResult {
	ok: boolean;
	status: ResearchStatus;
	events: Array<{ id: string; kind: string }>;
	claim?: ResearchClaim;
	source?: ResearchSourceEvidence;
	target_claim?: ResearchTargetClaim | null;
	error?: string;
}

export async function runResearchAgent(
	repository: HarnessRepository,
	input: ResearchInput,
	options: { signal?: AbortSignal } = {}
): Promise<ResearchRunResult> {
	const command = requiredCommand(input.command);
	const workspaceId = input.workspaceId || DEFAULT_WORKSPACE_ID;
	const storyId = textOrNull(input.storyId);
	const targetClaim = targetClaimFromCommand(command, input.facts);

	if (!storyId) {
		const event = repository.appendEvent({
			workspaceId,
			jobId: input.jobId,
			runId: input.runId,
			agent: 'research',
			kind: 'research.command.blocked',
			payload: {
				command_excerpt: excerpt(command),
				reason: 'Research needs an active story workspace.'
			},
			parentEventId: input.parentEventId
		});
		return {
			ok: false,
			status: 'blocked',
			events: [{ id: event.id, kind: event.kind }],
			error: 'Research needs an active story workspace.'
		};
	}

	const sourceUrl = firstHttpUrl(command);
	if (!sourceUrl) {
		const event = repository.appendEvent({
			workspaceId,
			storyId,
			jobId: input.jobId,
			runId: input.runId,
			agent: 'research',
			kind: targetClaim ? 'research.counter_source.requested' : 'research.command.noted',
			payload: {
				command_excerpt: excerpt(command),
				research_intent: researchIntent(command),
				target_claim: targetClaim,
				next_step: targetClaim
					? 'Find a source that corroborates, contradicts, or materially qualifies the target claim.'
					: 'Find source-backed facts to add to the fact ledger.'
			},
			parentEventId: input.parentEventId
		});
		return {
			ok: true,
			status: 'completed',
			events: [{ id: event.id, kind: event.kind }],
			target_claim: targetClaim
		};
	}

	const source = await fetchSourceUrl(sourceUrl, options.signal);
	const evidence = sourceEvidence(source);
	if (!source.used || !source.contentText.trim()) {
		const event = repository.appendEvent({
			workspaceId,
			storyId,
			jobId: input.jobId,
			runId: input.runId,
			agent: 'research',
			kind: 'research.source.unusable',
			payload: {
				command_excerpt: excerpt(command),
				research_intent: researchIntent(command),
				target_claim: targetClaim,
				source: evidence,
				reason: 'The source was fetched but did not produce usable article text.'
			},
			sources: [evidence],
			parentEventId: input.parentEventId
		});
		return {
			ok: false,
			status: 'blocked',
			events: [{ id: event.id, kind: event.kind }],
			source: evidence,
			target_claim: targetClaim,
			error: 'The source was fetched but did not produce usable article text.'
		};
	}

	const claim = claimFromSource(command, source, evidence, targetClaim);
	const createdAt = nowIso();
	const event = repository.appendEvent({
		workspaceId,
		storyId,
		jobId: input.jobId,
		runId: input.runId,
		agent: 'research',
		kind: 'claim.proposed',
		payload: {
			...claim,
			source_count: claim.sources.length
		},
		sources: claim.sources,
		parentEventId: input.parentEventId,
		createdAt
	});
	const memoryValue = {
		...claim,
		event_id: event.id,
		proposed_at: createdAt
	};
	repository.appendStoryMemory(storyId, {
		workspaceId,
		key: 'fact_ledger',
		kind: 'claim.proposed',
		actor: 'research',
		createdAt,
		value: memoryValue
	});

	return {
		ok: true,
		status: 'completed',
		events: [{ id: event.id, kind: event.kind }],
		claim,
		source: evidence,
		target_claim: targetClaim
	};
}

function claimFromSource(
	command: string,
	source: FetchedSource,
	evidence: ResearchSourceEvidence,
	targetClaim: ResearchTargetClaim | null
): ResearchClaim {
	const claim = compactText(source.summary || firstSentence(source.contentText) || source.title, 420);
	const id = `claim-${hashText(`${source.url}\n${claim}`).slice(0, 16)}`;
	return {
		id,
		claim,
		status: 'proposed',
		command_excerpt: excerpt(command),
		research_intent: researchIntent(command),
		target_claim: targetClaim,
		sources: [evidence]
	};
}

function sourceEvidence(source: FetchedSource): ResearchSourceEvidence {
	const archiveSnapshotUrl = source.archiveSnapshot?.ok ? source.archiveSnapshot.snapshotUrl : null;
	return {
		title: source.title,
		name: source.title || sourceHost(source.url),
		url: source.url,
		summary: source.summary,
		fetched_at: source.fetchedAt,
		content_hash: source.contentHash,
		content_type: source.contentType,
		status_code: source.statusCode,
		adapter: source.adapter ?? null,
		archive_snapshot_url: archiveSnapshotUrl,
		metadata: source.metadata ?? null,
		provenance: sourceProvenancePayload(source)
	};
}

function sourceProvenancePayload(source: FetchedSource): Record<string, unknown> {
	return {
		adapter: source.provenance?.adapter ?? source.adapter ?? null,
		source_url: source.provenance?.sourceUrl ?? source.url,
		fetched_at: source.provenance?.fetchedAt ?? source.fetchedAt,
		content_hash: source.provenance?.contentHash ?? source.contentHash,
		content_type: source.provenance?.contentType ?? source.contentType,
		status_code: source.provenance?.statusCode ?? source.statusCode,
		archive_snapshot_url:
			source.provenance?.archiveSnapshotUrl ?? (source.archiveSnapshot?.ok ? source.archiveSnapshot.snapshotUrl : null),
		etag: source.provenance?.etag ?? null,
		last_modified: source.provenance?.lastModified ?? null,
		extraction_method: source.provenance?.extractionMethod ?? null,
		metadata_sources: source.provenance?.metadataSources ?? source.metadata?.metadataSources ?? null,
		structured_type: source.provenance?.structuredType ?? source.metadata?.structuredType ?? null,
		canonical_url: source.provenance?.canonicalUrl ?? source.metadata?.canonicalUrl ?? null
	};
}

function targetClaimFromCommand(command: string, facts: unknown[] | undefined): ResearchTargetClaim | null {
	const rawFacts = Array.isArray(facts) ? facts : [];
	if (rawFacts.length === 0) return null;
	const index = referencedClaimIndex(command);
	if (index === null) return null;
	const raw = objectValue(rawFacts[index - 1]);
	if (!raw) return null;
	const claim =
		stringValue(raw.claim) ||
		stringValue(raw.text) ||
		stringValue(raw.detail) ||
		stringValue(raw.summary);
	if (!claim) return null;
	return {
		id: stringValue(raw.id) || stringValue(raw.claim_id) || stringValue(raw.fact_id),
		index,
		claim,
		status: stringValue(raw.status) || stringValue(raw.verification_status),
		source_urls: sourceUrls(raw)
	};
}

function referencedClaimIndex(command: string): number | null {
	const match = command.match(/\b(?:claim|fact|source)\s*#?\s*(\d{1,3})\b/i);
	if (!match) return null;
	const index = Number.parseInt(match[1], 10);
	return Number.isFinite(index) && index > 0 ? index : null;
}

function sourceUrls(raw: Record<string, unknown>): string[] {
	const urls = new Set<string>();
	for (const value of [...arrayValue(raw.sources), ...arrayValue(raw.source_set), ...arrayValue(raw.sourceSet)]) {
		const source = objectValue(value);
		const url = safeHttpUrl(stringValue(source?.url) || stringValue(source?.source_url) || stringValue(source?.sourceUrl));
		if (url) urls.add(url);
	}
	const direct = safeHttpUrl(stringValue(raw.source_url) || stringValue(raw.sourceUrl) || stringValue(raw.url));
	if (direct) urls.add(direct);
	return [...urls];
}

function researchIntent(command: string): string {
	if (/\bcounter[- ]?source|contradict|opposing|counter\b/i.test(command)) return 'counter_source';
	if (/\bcorroborat|confirm|support\b/i.test(command)) return 'corroboration';
	if (/\bbackground|context|timeline\b/i.test(command)) return 'background';
	return 'fact_ledger_growth';
}

function firstHttpUrl(value: string): string | null {
	const match = value.match(/https?:\/\/[^\s<>"')\]]+/i);
	if (!match) return null;
	return safeHttpUrl(match[0]);
}

function safeHttpUrl(value: string): string | null {
	try {
		const url = new URL(value.trim().replace(/[),.;]+$/, ''));
		if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
		url.hash = '';
		return url.toString();
	} catch {
		return null;
	}
}

function firstSentence(value: string): string {
	return value.split(/(?<=[.!?])\s+/).find((sentence) => sentence.trim().length > 20)?.trim() || '';
}

function compactText(value: string, maxLength: number): string {
	const cleaned = value.replace(/\s+/g, ' ').trim();
	if (cleaned.length <= maxLength) return cleaned;
	return `${cleaned.slice(0, Math.max(0, maxLength - 3)).trim()}...`;
}

function hashText(value: string): string {
	return createHash('sha256').update(value).digest('hex');
}

function requiredCommand(value: string): string {
	const command = value.replace(/\s+/g, ' ').trim();
	if (!command) throw new Error('command is required');
	return command;
}

function textOrNull(value: string | null | undefined): string | null {
	const text = value?.trim();
	return text || null;
}

function stringValue(value: unknown): string {
	if (typeof value === 'string') return value.trim();
	if (typeof value === 'number' || typeof value === 'boolean') return String(value);
	return '';
}

function objectValue(value: unknown): Record<string, unknown> | null {
	return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function arrayValue(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

function sourceHost(value: string): string {
	try {
		return new URL(value).hostname.replace(/^www\./, '');
	} catch {
		return value;
	}
}

function excerpt(value: string): string {
	const normalized = value.replace(/\s+/g, ' ').trim();
	if (normalized.length <= 180) return normalized;
	return `${normalized.slice(0, 177).trim()}...`;
}
