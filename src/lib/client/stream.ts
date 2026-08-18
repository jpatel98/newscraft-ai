import { readSSE } from '$lib/utils/sse-client';
import {
	StreamEventState,
	type PersistedSource,
	type StreamPlanUpdate,
	type StreamToolUpdate
} from '$lib/utils/stream-events';
import type { ChatCommand, MessageContent } from '$lib/types';
import type { CitationRecord } from '@newscraft/shared';

export const CHAT_STREAM_FAILURE_MESSAGE =
	"I couldn't start that reply. Your message is still here. Try again.";

export class ChatStreamError extends Error {
	public readonly publicMessage: string;
	public readonly diagnosticMessage: string;
	public readonly retryable = true;

	constructor(diagnosticMessage: string, options?: { cause?: unknown; publicMessage?: string }) {
		super(options?.publicMessage ?? CHAT_STREAM_FAILURE_MESSAGE, { cause: options?.cause });
		this.name = 'ChatStreamError';
		this.publicMessage = options?.publicMessage ?? CHAT_STREAM_FAILURE_MESSAGE;
		this.diagnosticMessage = diagnosticMessage;
	}
}

export function streamFailureMessage(error: unknown): string {
	return error instanceof ChatStreamError ? error.publicMessage : CHAT_STREAM_FAILURE_MESSAGE;
}

export function streamFailureDiagnostic(error: unknown): string {
	if (error instanceof ChatStreamError) return error.diagnosticMessage;
	if (error instanceof Error) return `${error.name}: ${error.message}`;
	return String(error);
}

function isAbortError(error: unknown): boolean {
	return (error as { name?: string } | null)?.name === 'AbortError';
}

function toDiagnostic(error: unknown): string {
	if (error instanceof Error) return `${error.name}: ${error.message}`;
	return String(error);
}

export interface StreamArgs {
	conversation_id?: string;
	content?: MessageContent;
	retry?: boolean;
	regenerate?: boolean;
	resume?: boolean;
	message_id?: string;
	command?: ChatCommand;
	document_ids?: string[];
	output_action?: 'producer_brief' | 'thirty_second_script' | 'interview_questions' | 'copy_with_citations';
	source_message_id?: string;
	idempotency_key?: string;
}

export interface DurableRunSnapshot {
	run_id: string;
	conversation_id: string;
	assistant_message_id: string;
	cursor: number;
	status: string;
	state: string;
	answerText: string;
	sources: PersistedSource[];
	citations: CitationRecord[];
	tools: StreamToolUpdate[];
	errorMessage: string | null;
}

export interface StreamCallbacks {
	onDelta: (piece: string) => void;
	onReplace?: (content: string) => void;
	onMeta?: (meta: { conversation_id: string; run_id?: string; trace_id?: string }) => void;
	onRunSnapshot?: (snapshot: DurableRunSnapshot) => void;
	onRunCursor?: (cursor: number) => void;
	onToolProgress?: (t: {
		id: string;
		name: string;
		emoji?: string;
		status?: string;
		detail?: string;
		url?: string;
		title?: string;
		arguments?: unknown;
		result?: unknown;
		transcript?: string;
	}) => void;
	onToolDone?: (id: string, tool?: StreamToolUpdate) => void;
	onSource?: (source: PersistedSource) => void;
	onCitations?: (citations: CitationRecord[]) => void;
	onPlan?: (plan: StreamPlanUpdate) => void;
	onTitle?: (title: string) => void;
	onPartial?: () => void;
	signal?: AbortSignal;
}

async function consumeDurableResponse(response: Response, cb: StreamCallbacks): Promise<void> {
	if (!response.ok) {
		const body = await response.text().catch(() => '');
		throw new ChatStreamError(`stream ${response.status}: ${body || response.statusText}`);
	}
	if (!response.body) throw new ChatStreamError('stream response body missing');

	const streamState = new StreamEventState();
	let completed = false;
	let failureMessage: string | null = null;
	let snapshotCursor = -1;
	for await (const ev of readSSE(response.body)) {
		if (ev.event === 'agent.meta') {
			try {
				cb.onMeta?.(JSON.parse(ev.data) as { conversation_id: string; run_id?: string });
			} catch {
				/* ignore malformed metadata */
			}
			continue;
		}
		if (ev.event === 'run.snapshot') {
			try {
				const snapshot = JSON.parse(ev.data) as DurableRunSnapshot;
				if (Number.isSafeInteger(snapshot.cursor)) snapshotCursor = Math.max(snapshotCursor, snapshot.cursor);
				const terminalState = snapshot.status || snapshot.state;
				if (['cancelled', 'failed', 'complete'].includes(terminalState)) completed = true;
				if (terminalState === 'failed') {
					failureMessage = snapshot.errorMessage || 'durable Hermes run failed';
				}
				cb.onRunSnapshot?.(snapshot);
			} catch {
				/* ignore malformed snapshots */
			}
			continue;
		}
		const eventCursor = ev.id === undefined ? undefined : Number(ev.id);
		if (typeof eventCursor === 'number' && Number.isSafeInteger(eventCursor) && eventCursor <= snapshotCursor) continue;
		if (typeof eventCursor === 'number' && Number.isSafeInteger(eventCursor)) cb.onRunCursor?.(eventCursor);
		for (const update of streamState.apply(ev.event, ev.data)) {
			if (update.done || update.partial) completed = true;
			if (update.partial) cb.onPartial?.();
			if (update.title) cb.onTitle?.(update.title);
			if (update.replace !== undefined) cb.onReplace?.(update.replace);
			if (update.delta) cb.onDelta(update.delta);
			if (update.source) cb.onSource?.(update.source);
			if (update.citations) cb.onCitations?.(update.citations);
			if (update.plan) cb.onPlan?.(update.plan);
			if (update.tool) {
				if (update.tool.done) cb.onToolDone?.(update.tool.id, update.tool);
				else cb.onToolProgress?.(update.tool);
			}
			if (update.failed) throw new ChatStreamError(`stream event failed: ${update.failed}`);
		}
	}
	if (failureMessage && !cb.signal?.aborted) {
		throw new ChatStreamError(`durable run failed: ${failureMessage}`);
	}
	if (!completed && !cb.signal?.aborted) {
		throw new ChatStreamError('stream ended before a completed response was received');
	}
}

export async function streamChat(args: StreamArgs, cb: StreamCallbacks): Promise<void> {
	let response: Response;
	try {
		try {
			response = await fetch('/api/chat/runs', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(args),
				signal: cb.signal
			});
		} catch (error) {
			if (isAbortError(error)) throw error;
			throw new ChatStreamError(`stream fetch failed: ${toDiagnostic(error)}`, { cause: error });
		}
		await consumeDurableResponse(response, cb);
	} catch (error) {
		if (isAbortError(error) || error instanceof ChatStreamError) throw error;
		throw new ChatStreamError(`stream read failed: ${toDiagnostic(error)}`, { cause: error });
	}
}

export async function subscribeDurableRun(
	runId: string,
	cursor: number,
	cb: StreamCallbacks
): Promise<void> {
	let response: Response;
	try {
		response = await fetch(`/api/chat/runs/${encodeURIComponent(runId)}?cursor=${cursor}`, {
			headers: {
				accept: 'text/event-stream',
				'last-event-id': String(cursor)
			},
			signal: cb.signal
		});
		await consumeDurableResponse(response, cb);
	} catch (error) {
		if (isAbortError(error) || error instanceof ChatStreamError) throw error;
		throw new ChatStreamError(`subscription read failed: ${toDiagnostic(error)}`, { cause: error });
	}
}
