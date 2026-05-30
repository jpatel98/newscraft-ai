import { DEFAULT_WORKSPACE_ID, type HarnessRepository } from '../db/repository.js';
import { fetchSourceUrl, type FetchedSource } from '../tools/sources.js';
import { nowIso } from '../util/ids.js';
import { runCopyAgent, type CopyRunResult } from './copy.js';
import { DraftingPreconditionError, runDraftingAgent, type DraftingRunResult } from './drafting.js';
import { runResearchAgent, type ResearchClaim, type ResearchSourceEvidence, type ResearchTargetClaim } from './research.js';
import { runVerificationAgent, type VerificationRunResult } from './verification.js';

type CommandAgent = 'beat_monitor' | 'research' | 'verification' | 'copy' | 'drafting';
type CommandStatus = 'completed' | 'blocked';

export interface EditorCommandInput {
	command: string;
	workspaceId?: string;
	storyId?: string | null;
	jobId?: string | null;
	runId?: string | null;
	targetAgent?: 'monitor' | 'research' | 'verification' | 'copy' | 'drafting' | null;
	targetWordCount?: number;
	facts?: unknown[];
}

export interface EditorCommandResult {
	ok: boolean;
	status: CommandStatus;
	handled_by: 'Monitor' | 'Research' | 'Verification' | 'Copy' | 'Drafting';
	agent: CommandAgent;
	route_reason: string;
	command_excerpt: string;
	events: Array<{ id: string; kind: string }>;
	source?: {
		url: string;
		title: string;
		summary: string;
		adapter: string | null;
		content_hash: string;
		archive_snapshot_url: string | null;
		metadata?: unknown;
		provenance?: unknown;
	};
	claim?: ResearchClaim;
	target_claim?: ResearchTargetClaim | null;
	verification?: VerificationRunResult;
	copy?: CopyRunResult;
	draft?: DraftingRunResult['draft'];
	gate?: DraftingRunResult['gate'];
	gates?: Array<DraftingRunResult['gate']>;
	error?: string;
}

export async function runEditorCommand(
	repository: HarnessRepository,
	input: EditorCommandInput,
	options: { signal?: AbortSignal } = {}
): Promise<EditorCommandResult> {
	const command = requiredCommand(input.command);
	const workspaceId = input.workspaceId || DEFAULT_WORKSPACE_ID;
	const storyId = textOrNull(input.storyId);
	const sourceUrl = firstHttpUrl(command);
	const route = routeCommand(command, sourceUrl, input.targetAgent, storyId);
	const routed = repository.appendEvent({
		workspaceId,
		storyId,
		jobId: input.jobId,
		runId: input.runId,
		agent: 'assignment_desk',
		kind: 'editor.command.routed',
		payload: {
			command_excerpt: excerpt(command),
			handled_by: route.handledBy,
			agent: route.agent,
			route_reason: route.reason,
			source_url: sourceUrl
		},
		createdAt: nowIso()
	});

	if (route.agent === 'beat_monitor') {
		if (!sourceUrl) {
			const event = repository.appendEvent({
				workspaceId,
				storyId,
				jobId: input.jobId,
				runId: input.runId,
				agent: 'beat_monitor',
				kind: 'monitor.command.noted',
				payload: {
					command_excerpt: excerpt(command),
					route_reason: route.reason
				},
				parentEventId: routed.id
			});
			return {
				ok: true,
				status: 'completed',
				handled_by: route.handledBy,
				agent: route.agent,
				route_reason: route.reason,
				command_excerpt: excerpt(command),
				events: [
					{ id: routed.id, kind: routed.kind },
					{ id: event.id, kind: event.kind }
				]
			};
		}
		const source = await fetchSourceUrl(sourceUrl, options.signal);
		const event = appendAdHocSourceEvent(repository, {
			workspaceId,
			storyId,
			jobId: input.jobId,
			runId: input.runId,
			parentEventId: routed.id,
			command,
			source
		});
		return {
			ok: true,
			status: 'completed',
			handled_by: route.handledBy,
			agent: route.agent,
			route_reason: route.reason,
			command_excerpt: excerpt(command),
			events: [
				{ id: routed.id, kind: routed.kind },
				{ id: event.id, kind: event.kind }
			],
			source: sourceResult(source)
		};
	}

	if (route.agent === 'research') {
		const research = await runResearchAgent(
			repository,
			{
				command,
				workspaceId,
				storyId,
				jobId: input.jobId,
				runId: input.runId,
				parentEventId: routed.id,
				facts: input.facts
			},
			options
		);
		const verification =
			research.claim && storyId
				? runVerificationAgent(repository, {
						workspaceId,
						storyId,
						jobId: input.jobId,
						runId: input.runId,
						claimEventId: research.events.find((event) => event.kind === 'claim.proposed')?.id
					})
				: null;
		return {
			ok: research.ok,
			status: research.status,
			handled_by: route.handledBy,
			agent: route.agent,
			route_reason: route.reason,
			command_excerpt: excerpt(command),
			events: [{ id: routed.id, kind: routed.kind }, ...research.events, ...(verification?.events ?? [])],
			source: research.source ? sourceResultFromResearch(research.source) : undefined,
			claim: research.claim,
			target_claim: research.target_claim,
			verification: verification ?? undefined,
			gates: verification?.gates,
			gate: verification?.gates[0],
			error: research.error
		};
	}

	if (route.agent === 'verification') {
		const verification = runVerificationAgent(repository, {
			workspaceId,
			storyId,
			jobId: input.jobId,
			runId: input.runId
		});
		return {
			ok: verification.ok,
			status: verification.status,
			handled_by: route.handledBy,
			agent: route.agent,
			route_reason: route.reason,
			command_excerpt: excerpt(command),
			events: [{ id: routed.id, kind: routed.kind }, ...verification.events],
			verification,
			gates: verification.gates,
			gate: verification.gates[0],
			error: verification.error
		};
	}

	if (route.agent === 'copy') {
		const copy = runCopyAgent(repository, {
			workspaceId,
			storyId,
			jobId: input.jobId,
			runId: input.runId
		});
		return {
			ok: copy.ok,
			status: copy.status,
			handled_by: route.handledBy,
			agent: route.agent,
			route_reason: route.reason,
			command_excerpt: excerpt(command),
			events: [{ id: routed.id, kind: routed.kind }, ...copy.events],
			copy,
			gate: copy.gate,
			gates: copy.gate ? [copy.gate] : [],
			error: copy.error
		};
	}

	if (!storyId) {
		const event = repository.appendEvent({
			workspaceId,
			jobId: input.jobId,
			runId: input.runId,
			agent: 'drafting',
			kind: 'draft.command.blocked',
			payload: {
				command_excerpt: excerpt(command),
				reason: 'Drafting needs an active story workspace.'
			},
			parentEventId: routed.id
		});
		return blocked(route, command, routed, event, 'Drafting needs an active story workspace.');
	}

	try {
		appendClientFacts(repository, storyId, workspaceId, input.facts);
		const draft = runDraftingAgent(repository, {
			storyId,
			workspaceId,
			jobId: input.jobId,
			runId: input.runId,
			targetWordCount: input.targetWordCount
		});
		return {
			ok: true,
			status: 'completed',
			handled_by: route.handledBy,
			agent: route.agent,
			route_reason: route.reason,
			command_excerpt: excerpt(command),
			events: [{ id: routed.id, kind: routed.kind }],
			draft: draft.draft,
			gate: draft.gate
		};
	} catch (err) {
		if (!(err instanceof DraftingPreconditionError)) throw err;
		const event = repository.appendEvent({
			workspaceId,
			storyId,
			jobId: input.jobId,
			runId: input.runId,
			agent: 'drafting',
			kind: 'draft.command.blocked',
			payload: {
				command_excerpt: excerpt(command),
				reason: err.message
			},
			parentEventId: routed.id
		});
		return blocked(route, command, routed, event, err.message);
	}
}

function appendAdHocSourceEvent(
	repository: HarnessRepository,
	input: {
		workspaceId: string;
		storyId: string | null;
		jobId?: string | null;
		runId?: string | null;
		parentEventId: string;
		command: string;
		source: FetchedSource;
	}
) {
	const archiveSnapshotUrl = input.source.archiveSnapshot?.ok ? input.source.archiveSnapshot.snapshotUrl : null;
	const provenance = sourceProvenancePayload(input.source);
	return repository.appendEvent({
		workspaceId: input.workspaceId,
		storyId: input.storyId,
		jobId: input.jobId,
		runId: input.runId,
		agent: 'beat_monitor',
		kind: 'source.ad_hoc_scraped',
		payload: {
			command_excerpt: excerpt(input.command),
			url: input.source.url,
			title: input.source.title,
			summary: input.source.summary,
			adapter: input.source.adapter ?? null,
			fetched_at: input.source.fetchedAt,
			content_hash: input.source.contentHash,
			content_type: input.source.contentType,
			status_code: input.source.statusCode,
			used: input.source.used,
			cache_status: input.source.cacheStatus ?? null,
			archive_snapshot_url: archiveSnapshotUrl,
			robots: input.source.robots ?? null,
			health_gate: input.source.healthGate ?? null,
			metadata: input.source.metadata ?? null,
			provenance
		},
		sources: [
			{
				url: input.source.url,
				title: input.source.title,
				summary: input.source.summary,
				adapter: input.source.adapter ?? null,
				fetched_at: input.source.fetchedAt,
				content_hash: input.source.contentHash,
				status_code: input.source.statusCode,
				archive_snapshot_url: archiveSnapshotUrl,
				metadata: input.source.metadata ?? null,
				provenance
			}
		],
		parentEventId: input.parentEventId
	});
}

function routeCommand(
	command: string,
	sourceUrl: string | null,
	targetAgent: EditorCommandInput['targetAgent'],
	storyId: string | null
): { agent: CommandAgent; handledBy: 'Monitor' | 'Research' | 'Verification' | 'Copy' | 'Drafting'; reason: string } {
	if (targetAgent === 'drafting') {
		return { agent: 'drafting', handledBy: 'Drafting', reason: 'Explicit drafting target.' };
	}
	if (targetAgent === 'copy') {
		return { agent: 'copy', handledBy: 'Copy', reason: 'Explicit copy target.' };
	}
	if (targetAgent === 'verification') {
		return { agent: 'verification', handledBy: 'Verification', reason: 'Explicit verification target.' };
	}
	if (targetAgent === 'research') {
		return { agent: 'research', handledBy: 'Research', reason: 'Explicit research target.' };
	}
	if (targetAgent === 'monitor') {
		return { agent: 'beat_monitor', handledBy: 'Monitor', reason: 'Explicit monitor target.' };
	}
	if (storyId && sourceUrl) {
		return { agent: 'research', handledBy: 'Research', reason: 'Story-context source commands route to Research.' };
	}
	if (storyId && /\b(copy|style|legal|libel|risk|copy edit|line edit|review draft)\b/i.test(command)) {
		return { agent: 'copy', handledBy: 'Copy', reason: 'Story-context copy/legal-style command.' };
	}
	if (storyId && /\b(verify|verification|fact[- ]?check|cross[- ]?check|two[- ]?source|source rule)\b/i.test(command)) {
		return { agent: 'verification', handledBy: 'Verification', reason: 'Story-context verification command.' };
	}
	if (storyId && /\b(counter[- ]?source|counter source|research|claim|fact|corroborat|contradict)\b/i.test(command)) {
		return { agent: 'research', handledBy: 'Research', reason: 'Story-context fact-ledger command.' };
	}
	if (sourceUrl) {
		return { agent: 'beat_monitor', handledBy: 'Monitor', reason: 'URL commands route to Monitor for one-shot extraction.' };
	}
	if (/\b(draft|write|lede|headline)\b/i.test(command)) {
		return { agent: 'drafting', handledBy: 'Drafting', reason: 'Story-context drafting command.' };
	}
	return { agent: 'beat_monitor', handledBy: 'Monitor', reason: 'Beat/source commands route to Monitor.' };
}

function appendClientFacts(
	repository: HarnessRepository,
	storyId: string,
	workspaceId: string,
	facts: unknown[] | undefined
): void {
	if (!Array.isArray(facts)) return;
	for (const fact of facts) {
		const raw = objectValue(fact);
		if (!raw) continue;
		repository.appendStoryMemory(storyId, {
			workspaceId,
			key: 'fact_ledger',
			kind: 'claim.verified',
			actor: 'assignment_desk',
			value: raw
		});
	}
}

function sourceResult(source: FetchedSource): EditorCommandResult['source'] {
	return {
		url: source.url,
		title: source.title,
		summary: source.summary,
		adapter: source.adapter ?? null,
		content_hash: source.contentHash,
		archive_snapshot_url: source.archiveSnapshot?.ok ? source.archiveSnapshot.snapshotUrl : null,
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

function blocked(
	route: { agent: CommandAgent; handledBy: 'Monitor' | 'Research' | 'Verification' | 'Copy' | 'Drafting'; reason: string },
	command: string,
	routed: { id: string; kind: string },
	event: { id: string; kind: string },
	error: string
): EditorCommandResult {
	return {
		ok: false,
		status: 'blocked',
		handled_by: route.handledBy,
		agent: route.agent,
		route_reason: route.reason,
		command_excerpt: excerpt(command),
		events: [
			{ id: routed.id, kind: routed.kind },
			{ id: event.id, kind: event.kind }
		],
		error
	};
}

function sourceResultFromResearch(source: ResearchSourceEvidence): EditorCommandResult['source'] {
	return {
		url: source.url,
		title: source.title,
		summary: source.summary,
		adapter: source.adapter,
		content_hash: source.content_hash,
		archive_snapshot_url: source.archive_snapshot_url,
		metadata: source.metadata,
		provenance: source.provenance
	};
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

function firstHttpUrl(value: string): string | null {
	const match = value.match(/https?:\/\/[^\s<>"')\]]+/i);
	if (!match) return null;
	try {
		const url = new URL(match[0]);
		return url.toString();
	} catch {
		return null;
	}
}

function excerpt(value: string): string {
	return value.length <= 180 ? value : `${value.slice(0, 177).trim()}...`;
}

function objectValue(value: unknown): Record<string, unknown> | null {
	return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}
