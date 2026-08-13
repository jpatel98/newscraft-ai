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
}

export interface StreamCallbacks {
	onDelta: (piece: string) => void;
	onReplace?: (content: string) => void;
	onMeta?: (meta: { conversation_id: string; trace_id?: string }) => void;
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

const CLIENT_STREAM_IDLE_MS = 2 * 60_000;

function createClientWatchdog(inputSignal?: AbortSignal): {
	signal: AbortSignal | undefined;
	touch: () => void;
	timedOut: () => boolean;
	cleanup: () => void;
} {
	const timeoutController = new AbortController();
	let timedOut = false;
	let idleTimer: ReturnType<typeof setTimeout> | undefined;
	const signal = inputSignal
		? typeof AbortSignal.any === 'function'
			? AbortSignal.any([inputSignal, timeoutController.signal])
			: (() => {
					const combined = new AbortController();
					const forward = (source: AbortSignal) => () => combined.abort(source.reason);
					if (inputSignal.aborted) combined.abort(inputSignal.reason);
					else inputSignal.addEventListener('abort', forward(inputSignal), { once: true });
					timeoutController.signal.addEventListener('abort', forward(timeoutController.signal), { once: true });
					return combined.signal;
				})()
			: timeoutController.signal;
	const touch = () => {
		if (idleTimer) clearTimeout(idleTimer);
		idleTimer = setTimeout(() => {
			timedOut = true;
			timeoutController.abort(new Error('interactive chat stream became idle'));
		}, CLIENT_STREAM_IDLE_MS);
	};
	touch();
	return {
		signal,
		touch,
		timedOut: () => timedOut,
		cleanup: () => {
			if (idleTimer) clearTimeout(idleTimer);
		}
	};
}

function clientWatchdogError(): ChatStreamError {
	return new ChatStreamError('interactive chat stream exceeded its client safety bound', {
		publicMessage: 'The research run took too long to finish. Any saved partial answer is still available; retry to continue.'
	});
}

export async function streamChat(args: StreamArgs, cb: StreamCallbacks): Promise<void> {
	const watchdog = createClientWatchdog(cb.signal);
	let r: Response;
	try {
		try {
			r = await fetch('/api/chat/stream', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(args),
				signal: watchdog.signal
			});
		} catch (error) {
			if (watchdog.timedOut()) throw clientWatchdogError();
			if (isAbortError(error)) throw error;
			throw new ChatStreamError(`stream fetch failed: ${toDiagnostic(error)}`, { cause: error });
		}
		if (!r.ok) {
			const body = await r.text().catch(() => '');
			throw new ChatStreamError(`stream ${r.status}: ${body || r.statusText}`);
		}
		if (!r.body) throw new ChatStreamError('stream response body missing');

		const streamState = new StreamEventState();
		let completed = false;
		for await (const ev of readSSE(r.body)) {
			watchdog.touch();
			if (ev.event === 'agent.meta') {
				try {
					cb.onMeta?.(JSON.parse(ev.data) as { conversation_id: string });
				} catch {
					/* ignore */
				}
				continue;
			}
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
		if (!completed && !cb.signal?.aborted) {
			if (watchdog.timedOut()) throw clientWatchdogError();
			throw new ChatStreamError('stream ended before a completed response was received');
		}
	} catch (error) {
		if (watchdog.timedOut()) throw clientWatchdogError();
		if (isAbortError(error) || error instanceof ChatStreamError) throw error;
		throw new ChatStreamError(`stream read failed: ${toDiagnostic(error)}`, { cause: error });
	} finally {
		watchdog.cleanup();
	}
}
