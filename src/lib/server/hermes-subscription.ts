import { json } from '@sveltejs/kit';
import {
	getHermesRun,
	getHermesRunSubscriptionState,
	listKnownHermesRunEvents,
	reconcileExpiredHermesRun,
	snapshotFromRun,
	HERMES_RECOVERY_GRACE_MS,
	HERMES_TERMINAL_STATES,
	type HermesRunSubscriptionState
} from '$lib/server/db/hermes-runs';
import { recordChatDiagnostic } from '$lib/server/chat-diagnostics';
import { traceIdFromHermesInput } from '$lib/server/durable-run-telemetry';

export const HERMES_SUBSCRIPTION_ACTIVE_POLL_MS = 250;
export const HERMES_SUBSCRIPTION_MAX_POLL_MS = 2_000;

export interface HermesSubscriptionRequest {
	request: Request;
	accountId: string;
	runId: string;
	afterCursor: number;
}

function sse(event: string, data: unknown, cursor?: number): string {
	return `${cursor === undefined ? '' : `id: ${cursor}\n`}event: ${event}\ndata: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`;
}

export function nextHermesSubscriptionPollMs(currentMs: number, receivedEvents: boolean): number {
	if (receivedEvents) return HERMES_SUBSCRIPTION_ACTIVE_POLL_MS;
	return Math.min(
		Math.max(currentMs, HERMES_SUBSCRIPTION_ACTIVE_POLL_MS) * 2,
		HERMES_SUBSCRIPTION_MAX_POLL_MS
	);
}

export function parseHermesSubscriptionCursor(request: Request, url: URL): number {
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
export async function hermesSubscriptionResponse({
	request,
	accountId,
	runId,
	afterCursor
}: HermesSubscriptionRequest): Promise<Response> {
	const initial = await getHermesRun(accountId, runId);
	if (!initial) return json({ detail: 'run not found' }, { status: 404 });
	let run = initial;
	const initialState = run.state as string;
	if (
		run.leaseExpiresAt !== null &&
		run.leaseExpiresAt !== undefined &&
		run.leaseExpiresAt <= Date.now() - HERMES_RECOVERY_GRACE_MS &&
		!HERMES_TERMINAL_STATES.includes(initialState as (typeof HERMES_TERMINAL_STATES)[number])
	) {
		// Leave expired work reclaimable while the worker recovery loop runs.
		// Beyond that grace, the repository rechecks timing and lease identity
		// under a row lock before settling the disappeared worker's run.
		run = (await reconcileExpiredHermesRun(accountId, runId)) ?? run;
	}
	if (afterCursor > run.cursor) return json({ detail: 'cursor is ahead of the saved run' }, { status: 409 });
	const traceId = traceIdFromHermesInput(run.inputJson);
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
						...snapshotFromRun(run)
					})
				);

				let cursor = afterCursor;
				let runState: HermesRunSubscriptionState | null = run;
				let pollMs = HERMES_SUBSCRIPTION_ACTIVE_POLL_MS;
				while (!signal.aborted) {
					if (!runState) break;
					const events = await listKnownHermesRunEvents(accountId, runId, cursor, 500);
					for (const event of events) {
						enqueue(sse(event.eventType, event.dataJson, event.cursor));
						cursor = event.cursor;
					}
					if (
						HERMES_TERMINAL_STATES.includes(
							runState.state as (typeof HERMES_TERMINAL_STATES)[number]
						) &&
						cursor >= runState.cursor
					) {
						break;
					}
					await waitForNextPoll(pollMs);
					if (signal.aborted) break;
					runState = await getHermesRunSubscriptionState(accountId, runId);
					pollMs = nextHermesSubscriptionPollMs(pollMs, events.length > 0);
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
