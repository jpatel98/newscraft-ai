import { createHash } from 'node:crypto';
import type { NewsroomEventDto, NewsroomGateDto, NewsroomEventJson } from '@newscraft/shared';
import { DEFAULT_WORKSPACE_ID, type HarnessRepository } from '../db/repository.js';
import { nowIso } from '../util/ids.js';

type VerificationStatus = 'completed' | 'blocked';
type ClaimVerificationStatus = 'verified' | 'disputed' | 'needs_more';

export interface VerificationInput {
	workspaceId?: string;
	storyId?: string | null;
	jobId?: string | null;
	runId?: string | null;
	claimEventId?: string | null;
}

export interface VerificationClaimResult {
	claim_id: string;
	claim: string;
	status: ClaimVerificationStatus;
	event: { id: string; kind: string };
	gate?: NewsroomGateDto;
}

export interface VerificationRunResult {
	ok: boolean;
	status: VerificationStatus;
	events: Array<{ id: string; kind: string }>;
	gates: NewsroomGateDto[];
	processed_claims: VerificationClaimResult[];
	error?: string;
}

interface ProposedClaim {
	id: string;
	claim: string;
	eventId: string | null;
	eventIds: string[];
	idAliases: string[];
	sources: ClaimSource[];
	targetClaim: Record<string, unknown> | null;
	researchIntent: string | null;
}

interface ClaimSource {
	title: string;
	name: string;
	url: string;
	summary: string;
	content_hash: string | null;
	archive_snapshot_url: string | null;
}

interface ConflictDetection {
	status: 'none' | 'conflict_detected';
	reason: string | null;
	contradicts_claim_id: string | null;
}

interface ProcessedClaimState {
	status: ClaimVerificationStatus;
	eventId: string;
	claimKeys: string[];
	sources: ClaimSource[];
	createdAt: string;
}

export function runVerificationAgent(
	repository: HarnessRepository,
	input: VerificationInput
): VerificationRunResult {
	const workspaceId = input.workspaceId || DEFAULT_WORKSPACE_ID;
	const storyId = textOrNull(input.storyId);
	if (!storyId) {
		const event = repository.appendEvent({
			workspaceId,
			jobId: input.jobId,
			runId: input.runId,
			agent: 'verification',
			kind: 'verification.command.blocked',
			payload: {
				reason: 'Verification needs an active story workspace.'
			}
		});
		return {
			ok: false,
			status: 'blocked',
			events: [{ id: event.id, kind: event.kind }],
			gates: [],
			processed_claims: [],
			error: 'Verification needs an active story workspace.'
		};
	}

	const proposedClaims = proposedClaimsFor(repository, storyId, workspaceId, input.claimEventId);
	if (proposedClaims.length === 0) {
		const event = repository.appendEvent({
			workspaceId,
			storyId,
			jobId: input.jobId,
			runId: input.runId,
			agent: 'verification',
			kind: 'verification.no_claims',
			payload: {
				reason: 'No unverified proposed claims were found for this story.'
			}
		});
		return {
			ok: true,
			status: 'completed',
			events: [{ id: event.id, kind: event.kind }],
			gates: [],
			processed_claims: []
		};
	}

	const processed: VerificationClaimResult[] = [];
	const events: Array<{ id: string; kind: string }> = [];
	const gates: NewsroomGateDto[] = [];
	for (const claim of proposedClaims) {
		const result = verifyClaim(repository, {
			claim,
			workspaceId,
			storyId,
			jobId: input.jobId,
			runId: input.runId
		});
		processed.push(result);
		events.push(result.event);
		if (result.gate) gates.push(result.gate);
	}

	return {
		ok: true,
		status: 'completed',
		events,
		gates,
		processed_claims: processed
	};
}

function verifyClaim(
	repository: HarnessRepository,
	input: {
		claim: ProposedClaim;
		workspaceId: string;
		storyId: string;
		jobId?: string | null;
		runId?: string | null;
	}
): VerificationClaimResult {
	const uniqueSources = uniqueSourcesFor(input.claim.sources);
	const conflict = detectConflict(input.claim);
	const status: ClaimVerificationStatus =
		conflict.status === 'conflict_detected' ? 'disputed' : uniqueSources.length >= 2 ? 'verified' : 'needs_more';
	const twoSourceRule = {
		required: 2,
		actual: uniqueSources.length,
		passed: uniqueSources.length >= 2
	};
	const createdAt = nowIso();
	const payload = {
		id: input.claim.id,
		claim_id: input.claim.id,
		claim: input.claim.claim,
		status,
		source_count: uniqueSources.length,
		sources: uniqueSources,
		target_claim: input.claim.targetClaim,
		two_source_rule: twoSourceRule,
		conflict_detection: conflict,
		proposed_event_id: input.claim.eventId,
		proposed_event_ids: input.claim.eventIds,
		verified_at: createdAt
	};
	const event = repository.appendEvent({
		workspaceId: input.workspaceId,
		storyId: input.storyId,
		jobId: input.jobId,
		runId: input.runId,
		agent: 'verification',
		kind: `claim.${status}`,
		payload,
		sources: uniqueSources,
		parentEventId: input.claim.eventId,
		createdAt
	});
	repository.appendStoryMemory(input.storyId, {
		workspaceId: input.workspaceId,
		key: 'fact_ledger',
		kind: `claim.${status}`,
		actor: 'verification',
		createdAt,
		value: {
			...payload,
			event_id: event.id
		}
	});

	const gate =
		status === 'verified'
			? undefined
			: repository.queueGate({
					workspace_id: input.workspaceId,
					story_id: input.storyId,
					job_id: input.jobId,
					run_id: input.runId,
					type: 'verification',
					title:
						status === 'disputed'
							? `Resolve disputed claim: ${excerpt(input.claim.claim, 72)}`
							: `Verify single-source claim: ${excerpt(input.claim.claim, 72)}`,
					summary:
						status === 'disputed'
							? 'Verification detected a contradiction or counter-source relationship that needs editor resolution.'
							: 'Verification needs another independent source before this claim can support a draft.',
					priority: status === 'disputed' ? 1 : 2,
					created_by: 'verification',
					payload: {
						...payload,
						verification_event_id: event.id
					}
				});

	return {
		claim_id: input.claim.id,
		claim: input.claim.claim,
		status,
		event: { id: event.id, kind: event.kind },
		gate
	};
}

function proposedClaimsFor(
	repository: HarnessRepository,
	storyId: string,
	workspaceId: string,
	claimEventId?: string | null
): ProposedClaim[] {
	if (claimEventId) {
		const event = repository.getEvent(claimEventId);
		if (!event || event.workspace_id !== workspaceId || event.story_id !== storyId || event.kind !== 'claim.proposed') {
			return [];
		}
		const claim = proposedClaimFromEvent(event);
		return claim ? [claim] : [];
	}

	const memory = repository.inspectStoryMemory(storyId, workspaceId);
	const processed = processedClaimStates(memory.agent_event_log || []);
	const claims = new Map<string, ProposedClaim>();
	const eventBackedClaims = new Set<string>();
	for (const event of memory.agent_event_log || []) {
		if (event.kind !== 'claim.proposed') continue;
		const claim = proposedClaimFromEvent(event);
		if (!claim) continue;
		if (claim.eventId) eventBackedClaims.add(claim.eventId);
		addProposedClaim(claims, claim);
	}
	for (const entry of memory.entries) {
		if (entry.kind !== 'claim.proposed') continue;
		const claim = proposedClaimFromValue(entry.value, null);
		if (!claim || (claim.eventId && eventBackedClaims.has(claim.eventId))) continue;
		addProposedClaim(claims, claim);
	}
	return [...claims.values()].filter((claim) => !isClaimAlreadyProcessed(claim, processed));
}

function proposedClaimFromEvent(event: NewsroomEventDto): ProposedClaim | null {
	return proposedClaimFromValue(event.payload, event.id, event.sources);
}

function proposedClaimFromValue(
	value: NewsroomEventJson,
	eventId: string | null,
	eventSources: NewsroomEventJson[] = []
): ProposedClaim | null {
	const raw = objectValue(value);
	if (!raw) return null;
	const claim = compactText(
		stringValue(raw.claim) ||
			stringValue(raw.text) ||
			stringValue(raw.detail) ||
			stringValue(raw.summary),
		600
	);
	if (!claim) return null;
	const sourceEventId = eventId || stringValue(raw.event_id) || stringValue(raw.eventId);
	const sources = [...arrayValue(raw.sources), ...arrayValue(raw.source_set), ...eventSources]
		.map(sourceFromValue)
		.filter((source): source is ClaimSource => Boolean(source));
	const id =
		stringValue(raw.id) ||
		stringValue(raw.claim_id) ||
		`claim-${hashText(`${sourceEventId || ''}\n${claim}`).slice(0, 16)}`;
	return {
		id,
		claim,
		eventId: sourceEventId,
		eventIds: sourceEventId ? [sourceEventId] : [],
		idAliases: [id],
		sources,
		targetClaim: objectValue(raw.target_claim),
		researchIntent: stringValue(raw.research_intent)
	};
}

function sourceFromValue(value: unknown): ClaimSource | null {
	const raw = objectValue(value);
	if (!raw) return null;
	const url = safeHttpUrl(stringValue(raw.url) || stringValue(raw.source_url) || stringValue(raw.sourceUrl));
	if (!url) return null;
	const title = stringValue(raw.title) || stringValue(raw.source_title) || stringValue(raw.sourceTitle) || url;
	const name = stringValue(raw.name) || stringValue(raw.source_name) || stringValue(raw.sourceName) || title;
	return {
		title,
		name,
		url,
		summary: stringValue(raw.summary) || '',
		content_hash: stringValue(raw.content_hash) || stringValue(raw.contentHash),
		archive_snapshot_url:
			safeHttpUrl(
				stringValue(raw.archive_snapshot_url) ||
					stringValue(raw.archiveSnapshotUrl) ||
					stringValue(raw.archive_url) ||
					stringValue(raw.archiveUrl)
			) || null
	};
}

function uniqueSourcesFor(sources: ClaimSource[]): ClaimSource[] {
	const seen = new Set<string>();
	const unique: ClaimSource[] = [];
	for (const source of sources) {
		const key = sourceIndependenceKey(source);
		if (seen.has(key)) continue;
		seen.add(key);
		unique.push(source);
	}
	return unique;
}

function detectConflict(claim: ProposedClaim): ConflictDetection {
	const target = objectValue(claim.targetClaim);
	const targetClaim = stringValue(target?.claim);
	const targetId = stringValue(target?.id) || stringValue(target?.claim_id);
	if (claim.researchIntent === 'counter_source' && targetClaim) {
		return {
			status: 'conflict_detected',
			reason: 'Research was explicitly requested as a counter-source for an existing claim.',
			contradicts_claim_id: targetId
		};
	}
	const combined = `${claim.claim} ${claim.sources.map((source) => source.summary).join(' ')}`.toLowerCase();
	if (/\b(denied|denies|false|not true|contradict|disputed|no evidence|refuted)\b/.test(combined)) {
		return {
			status: 'conflict_detected',
			reason: 'The proposed claim or source summary contains contradiction language.',
			contradicts_claim_id: targetId
		};
	}
	return { status: 'none', reason: null, contradicts_claim_id: null };
}

function claimIdFromPayload(value: unknown): string | null {
	const raw = objectValue(value);
	return raw ? stringValue(raw.id) || stringValue(raw.claim_id) : null;
}

function addProposedClaim(groups: Map<string, ProposedClaim>, claim: ProposedClaim): void {
	const key = claimGroupKey(claim.claim);
	const existing = groups.get(key);
	if (!existing) {
		groups.set(key, { ...claim, sources: [...claim.sources], eventIds: [...claim.eventIds], idAliases: [...claim.idAliases] });
		return;
	}
	existing.sources.push(...claim.sources);
	existing.eventIds = uniqueStrings([...existing.eventIds, ...claim.eventIds]);
	existing.idAliases = uniqueStrings([...existing.idAliases, ...claim.idAliases]);
	if (!existing.targetClaim && claim.targetClaim) existing.targetClaim = claim.targetClaim;
	if (!existing.researchIntent && claim.researchIntent) existing.researchIntent = claim.researchIntent;
}

function processedClaimStates(events: NewsroomEventDto[]): ProcessedClaimState[] {
	const supersededEventIds = new Set(
		events
			.filter((event) => event.kind.startsWith('claim.'))
			.flatMap((event) => {
				const payload = objectValue(event.payload);
				return [
					stringValue(payload?.supersedes_event_id),
					stringValue(payload?.supersedes_verification_event_id)
				];
			})
			.filter((value): value is string => Boolean(value))
	);
	const states: ProcessedClaimState[] = [];
	for (const event of events) {
		const status = statusFromClaimKind(event.kind);
		if (!status || supersededEventIds.has(event.id)) continue;
		const payload = objectValue(event.payload) ?? {};
		const claim = stringValue(payload.claim);
		const sources = arrayValue(payload.sources).map(sourceFromValue).filter((source): source is ClaimSource => Boolean(source));
		states.push({
			status,
			eventId: event.id,
			claimKeys: uniqueStrings([
				event.id,
				stringValue(payload.proposed_event_id),
				...arrayValue(payload.proposed_event_ids).flatMap((value) => {
					const text = stringValue(value);
					return text ? [text] : [];
				}),
				claimIdFromPayload(payload),
				claim ? claimGroupKey(claim) : null
			].filter((value): value is string => Boolean(value))),
			sources,
			createdAt: event.created_at
		});
	}
	return states;
}

function isClaimAlreadyProcessed(claim: ProposedClaim, processed: ProcessedClaimState[]): boolean {
	const keys = new Set(claimProcessingKeys(claim));
	const matching = processed.filter((state) => state.claimKeys.some((key) => keys.has(key)));
	const latest = matching.at(-1);
	if (!latest) return false;
	if (latest.status === 'verified' || latest.status === 'disputed') return true;
	return !hasAdditionalEvidence(claim.sources, latest.sources);
}

function claimProcessingKeys(claim: ProposedClaim): string[] {
	return uniqueStrings([...claim.eventIds, ...claim.idAliases, claimGroupKey(claim.claim)]);
}

function statusFromClaimKind(kind: string): ClaimVerificationStatus | null {
	if (kind === 'claim.verified') return 'verified';
	if (kind === 'claim.disputed') return 'disputed';
	if (kind === 'claim.needs_more') return 'needs_more';
	return null;
}

function hasAdditionalEvidence(currentSources: ClaimSource[], previousSources: ClaimSource[]): boolean {
	const current = new Set(currentSources.map(sourceEvidenceKey));
	const previous = new Set(previousSources.map(sourceEvidenceKey));
	return [...current].some((key) => !previous.has(key));
}

function sourceEvidenceKey(source: ClaimSource): string {
	return `${source.url}\n${source.content_hash || ''}`;
}

function sourceIndependenceKey(source: ClaimSource): string {
	const host = hostFromUrl(source.url);
	const publisher = normalizeSourceName(source.name);
	const title = normalizeSourceName(source.title);
	if (host) return `host:${host}`;
	if (publisher && publisher !== title) return `publisher:${publisher}`;
	return `url:${source.url}`;
}

function hostFromUrl(value: string): string | null {
	try {
		return new URL(value).host.toLowerCase();
	} catch {
		return null;
	}
}

function claimGroupKey(claim: string): string {
	return `claim:${hashText(normalizeClaimText(claim)).slice(0, 24)}`;
}

function normalizeClaimText(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function normalizeSourceName(value: string): string {
	return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

function uniqueStrings(values: string[]): string[] {
	const seen = new Set<string>();
	const unique: string[] = [];
	for (const value of values) {
		if (seen.has(value)) continue;
		seen.add(value);
		unique.push(value);
	}
	return unique;
}

function compactText(value: string | null, maxLength: number): string {
	const text = value?.replace(/\s+/g, ' ').trim() || '';
	if (text.length <= maxLength) return text;
	return `${text.slice(0, maxLength - 3).trim()}...`;
}

function excerpt(value: string, maxLength: number): string {
	return value.length <= maxLength ? value : `${value.slice(0, maxLength - 3).trim()}...`;
}

function hashText(value: string): string {
	return createHash('sha256').update(value).digest('hex');
}

function textOrNull(value: string | null | undefined): string | null {
	const text = value?.trim();
	return text || null;
}

function objectValue(value: unknown): Record<string, unknown> | null {
	return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function arrayValue(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string | null {
	if (typeof value === 'string' && value.trim()) return value.trim();
	if (typeof value === 'number' || typeof value === 'boolean') return String(value);
	return null;
}

function safeHttpUrl(value?: string | null): string | null {
	if (!value) return null;
	try {
		const url = new URL(value);
		if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
		return url.toString();
	} catch {
		return null;
	}
}
