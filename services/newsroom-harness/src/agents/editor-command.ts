import { DEFAULT_WORKSPACE_ID, type HarnessRepository } from '../db/repository.js';
import { fetchSourceUrl, type FetchedSource } from '../tools/sources.js';
import { nowIso } from '../util/ids.js';
import { DraftingPreconditionError, runDraftingAgent, type DraftingRunResult } from './drafting.js';

type CommandAgent = 'beat_monitor' | 'drafting';
type CommandStatus = 'completed' | 'blocked';

export interface EditorCommandInput {
	command: string;
	workspaceId?: string;
	storyId?: string | null;
	jobId?: string | null;
	runId?: string | null;
	targetAgent?: 'monitor' | 'drafting' | null;
	targetWordCount?: number;
}

export interface EditorCommandResult {
	ok: boolean;
	status: CommandStatus;
	handled_by: 'Monitor' | 'Drafting';
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
	};
	draft?: DraftingRunResult['draft'];
	gate?: DraftingRunResult['gate'];
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
			health_gate: input.source.healthGate ?? null
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
				archive_snapshot_url: archiveSnapshotUrl
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
): { agent: CommandAgent; handledBy: 'Monitor' | 'Drafting'; reason: string } {
	if (targetAgent === 'drafting') {
		return { agent: 'drafting', handledBy: 'Drafting', reason: 'Explicit drafting target.' };
	}
	if (targetAgent === 'monitor') {
		return { agent: 'beat_monitor', handledBy: 'Monitor', reason: 'Explicit monitor target.' };
	}
	if (sourceUrl) {
		return { agent: 'beat_monitor', handledBy: 'Monitor', reason: 'URL commands route to Monitor for one-shot extraction.' };
	}
	if (storyId || /\b(draft|write|lede|headline|story)\b/i.test(command)) {
		return { agent: 'drafting', handledBy: 'Drafting', reason: 'Story-context drafting command.' };
	}
	return { agent: 'beat_monitor', handledBy: 'Monitor', reason: 'Beat/source commands route to Monitor.' };
}

function sourceResult(source: FetchedSource): EditorCommandResult['source'] {
	return {
		url: source.url,
		title: source.title,
		summary: source.summary,
		adapter: source.adapter ?? null,
		content_hash: source.contentHash,
		archive_snapshot_url: source.archiveSnapshot?.ok ? source.archiveSnapshot.snapshotUrl : null
	};
}

function blocked(
	route: { agent: CommandAgent; handledBy: 'Monitor' | 'Drafting'; reason: string },
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
