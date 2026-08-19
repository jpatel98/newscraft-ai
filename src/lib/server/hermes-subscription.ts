import { json } from '@sveltejs/kit';
import {
	getHermesRun,
	listHermesRunEvents,
	snapshotFromRun,
	HERMES_TERMINAL_STATES
} from '$lib/server/db/hermes-runs';

export const HERMES_SUBSCRIPTION_POLL_MS = 100;

export interface HermesSubscriptionRequest {
	request: Request;
	accountId: string;
	runId: string;
	afterCursor: number;
}

function sse(event: string, data: unknown, cursor?: number): string {
	return `${cursor === undefined ? '' : `id: ${cursor}\n`}event: ${event}\ndata: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`;
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
	if (afterCursor > initial.cursor) return json({ detail: 'cursor is ahead of the saved run' }, { status: 409 });

	const encoder = new TextEncoder();
	const stream = new ReadableStream<Uint8Array>({
		async start(controller) {
			const enqueue = (value: string) => {
				try {
					controller.enqueue(encoder.encode(value));
				} catch {
					/* The browser closed the subscription. */
				}
			};
			const waitForNextPoll = () =>
				new Promise<void>((resolve) => {
					const timer = setTimeout(resolve, HERMES_SUBSCRIPTION_POLL_MS);
					request.signal.addEventListener(
						'abort',
						() => {
							clearTimeout(timer);
							resolve();
						},
						{ once: true }
					);
				});

			try {
				enqueue(
					sse('agent.meta', {
						conversation_id: initial.conversationId,
						run_id: initial.id,
						cursor: initial.cursor
					})
				);
				enqueue(
					sse('run.snapshot', {
						run_id: initial.id,
						conversation_id: initial.conversationId,
						assistant_message_id: initial.assistantMessageId,
						cursor: initial.cursor,
						status: initial.state,
						...snapshotFromRun(initial)
					})
				);

				let cursor = afterCursor;
				while (!request.signal.aborted) {
					const run = await getHermesRun(accountId, runId);
					if (!run) break;
					const events = await listHermesRunEvents(accountId, runId, cursor, 500);
					for (const event of events) {
						enqueue(sse(event.eventType, event.dataJson, event.cursor));
						cursor = event.cursor;
					}
					if (
						HERMES_TERMINAL_STATES.includes(
							run.state as (typeof HERMES_TERMINAL_STATES)[number]
						) &&
						cursor >= run.cursor
					) {
						break;
					}
					await waitForNextPoll();
				}
			} catch (cause) {
				if (!request.signal.aborted) controller.error(cause);
				return;
			}
			try {
				controller.close();
			} catch {
				/* already closed */
			}
		}
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
