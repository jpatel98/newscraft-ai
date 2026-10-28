import { json } from '@sveltejs/kit';
import {
	getAgentRun,
	getAgentRunSubscriptionState,
	listKnownAgentRunEvents,
	reconcileExpiredAgentRun,
	snapshotFromRun,
	AGENT_RECOVERY_GRACE_MS,
	AGENT_TERMINAL_STATES,
	type AgentRunSubscriptionState
} from '$lib/server/db/agent-runs';
import { recordChatDiagnostic } from '$lib/server/chat-diagnostics';
import { traceIdFromAgentInput } from '$lib/server/durable-run-telemetry';
import { stripLedgerForDisplay } from '$lib/utils/story-ledger';

export const AGENT_SUBSCRIPTION_ACTIVE_POLL_MS = 250;
export const AGENT_SUBSCRIPTION_MAX_POLL_MS = 500;
export const AGENT_SUBSCRIPTION_HEARTBEAT_MS = 10_000;
export const AGENT_SUBSCRIPTION_HEARTBEAT_FRAME = ': ping\n\n';

export interface AgentSubscriptionRequest {
	request: Request;
	accountId: string;
	runId: string;
	afterCursor: number;
}

function sse(event: string, data: unknown, cursor?: number): string {
	return `${cursor === undefined ? '' : `id: ${cursor}\n`}event: ${event}\ndata: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`;
}

export function nextAgentSubscriptionPollMs(currentMs: number, receivedEvents: boolean): number {
	if (receivedEvents) return AGENT_SUBSCRIPTION_ACTIVE_POLL_MS;
	return Math.min(
		Math.max(currentMs, AGENT_SUBSCRIPTION_ACTIVE_POLL_MS) * 2,
		AGENT_SUBSCRIPTION_MAX_POLL_MS
	);
}

export function parseAgentSubscriptionCursor(request: Request, url: URL): number {
	const raw = request.headers.get('last-event-id') || url.searchParams.get('cursor') || '0';
	const cursor = Number(raw);
	if (!Number.isSafeInteger(cursor) || cursor < 0) {
		throw new Error('cursor must be a non-negative integer');
	}
	return cursor;
}

/**
 * Stream only persisted NewsCraft events. A closed browser subscription does
 * not touch the durable worker or its lease.
 */
export async function agentSubscriptionResponse({
	request,
	accountId,
	runId,
	afterCursor
}: AgentSubscriptionRequest): Promise<Response> {
	const initial = await getAgentRun(accountId, runId);
	if (!initial) return json({ detail: 'run not found' }, { status: 404 });
	let run = initial;
	const initialState = run.state as string;
	if (
		run.leaseExpiresAt !== null &&
		run.leaseExpiresAt !== undefined &&
		run.leaseExpiresAt <= Date.now() - AGENT_RECOVERY_GRACE_MS &&
		!AGENT_TERMINAL_STATES.includes(initialState as (typeof AGENT_TERMINAL_STATES)[number])
	) {
		// Leave expired work reclaimable while the worker recovery loop runs.
		// Beyond that grace, the repository rechecks timing and lease identity
		// under a row lock before settling the disappeared worker's run.
		run = (await reconcileExpiredAgentRun(accountId, runId)) ?? run;
	}
	if (afterCursor > run.cursor) return json({ detail: 'cursor is ahead of the saved run' }, { status: 409 });
	const traceId = traceIdFromAgentInput(run.inputJson);
	recordChatDiagnostic(run.conversationId, 'chat.durable.subscription', {
		...(traceId ? { trace_id: traceId } : {}),
		replay: afterCursor > 0,
		reconnect_count: afterCursor > 0 ? 1 : 0,
		after_cursor: afterCursor,
		current_cursor: run.cursor
	});

	const encoder = new TextEncoder();
	// The Node adapter cancels the response reader on disconnect even after the
	// incoming request has ended, when request.signal no longer reports it.
	// This controller stops only this subscriber's polling, never the run.
	const subscriptionAbort = new AbortController();
	const signal = AbortSignal.any([request.signal, subscriptionAbort.signal]);
	const stream = new ReadableStream<Uint8Array>({
		async start(controller) {
			const enqueue = (value: string) => {
				if (signal.aborted) return;
				try {
					controller.enqueue(encoder.encode(value));
				} catch {
					/* The browser closed the subscription. */
				}
			};
			const waitForNextPoll = (delayMs: number) =>
				new Promise<void>((resolve) => {
					if (signal.aborted) { resolve(); return; }
					const onAbort = () => {
						clearTimeout(timer);
						resolve();
					};
					const timer = setTimeout(() => {
						signal.removeEventListener('abort', onAbort);
						resolve();
					}, delayMs);
					signal.addEventListener('abort', onAbort, { once: true });
				});

			try {
				enqueue(
					sse('agent.meta', {
						conversation_id: run.conversationId,
						run_id: run.id,
						cursor: run.cursor,
						...(traceId ? { trace_id: traceId } : {})
					})
				);
				enqueue(
					sse('run.snapshot', {
						run_id: run.id,
						conversation_id: run.conversationId,
						assistant_message_id: run.assistantMessageId,
						cursor: run.cursor,
						status: run.state,
						...(traceId ? { trace_id: traceId } : {}),
						...(() => {
							const snapshot = snapshotFromRun(run);
							// A streamed ledger fence is machine-only; never replay it to the browser.
							return { ...snapshot, answerText: stripLedgerForDisplay(snapshot.answerText) };
						})()
					})
				);

				// Comment frames carry no event; they push buffered bytes through
				// intermediaries and are ignored by the browser parser.
				enqueue(AGENT_SUBSCRIPTION_HEARTBEAT_FRAME);
				let lastWriteAt = Date.now();

				let cursor = afterCursor;
				let runState: AgentRunSubscriptionState | null = run;
				let pollMs = AGENT_SUBSCRIPTION_ACTIVE_POLL_MS;
				while (!signal.aborted) {
					if (!runState) break;
					const events = await listKnownAgentRunEvents(accountId, runId, cursor, 500);
					for (const event of events) {
						enqueue(sse(event.eventType, event.dataJson, event.cursor));
						cursor = event.cursor;
						lastWriteAt = Date.now();
					}
					if (
						AGENT_TERMINAL_STATES.includes(
							runState.state as (typeof AGENT_TERMINAL_STATES)[number]
						) &&
						cursor >= runState.cursor
					) {
						break;
					}
					await waitForNextPoll(pollMs);
					if (signal.aborted) break;
					if (Date.now() - lastWriteAt >= AGENT_SUBSCRIPTION_HEARTBEAT_MS) {
						enqueue(AGENT_SUBSCRIPTION_HEARTBEAT_FRAME);
						lastWriteAt = Date.now();
					}
					runState = await getAgentRunSubscriptionState(accountId, runId);
					pollMs = nextAgentSubscriptionPollMs(pollMs, events.length > 0);
				}
			} catch (cause) {
				if (!signal.aborted) controller.error(cause);
				return;
			} finally {
				subscriptionAbort.abort();
			}
			try {
				controller.close();
			} catch {
				/* already closed */
			}
		},
		cancel() { subscriptionAbort.abort(); }
	});

	return new Response(stream, {
		status: 200,
		headers: {
			'content-type': 'text/event-stream; charset=utf-8',
			'cache-control': 'no-cache, no-transform',
			connection: 'keep-alive',
			'x-accel-buffering': 'no'
		}
	});
}
