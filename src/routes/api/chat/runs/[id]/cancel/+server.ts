import { json, type RequestHandler } from '@sveltejs/kit';
import {
	finalizeHermesRunCancellation,
	getHermesRun,
	requestHermesRunCancellation,
	snapshotFromRun,
	listHermesRunEvents
} from '$lib/server/db/hermes-runs';
import { cancelDurableHermesRun } from '$lib/server/hermes-durable';
import { recordChatDiagnostic } from '$lib/server/chat-diagnostics';
import {
	collectDurableRunEvents,
	summarizeDurableRunTelemetry,
	traceIdFromHermesInput
} from '$lib/server/durable-run-telemetry';

export const POST: RequestHandler = async ({ locals, params }) => {
	if (!locals.user) return json({ detail: 'unauthorized' }, { status: 401 });
	const runId = params.id?.trim();
	if (!runId) return json({ detail: 'run id required' }, { status: 400 });
	const existing = await getHermesRun(locals.user.id, runId);
	if (!existing) return json({ detail: 'run not found' }, { status: 404 });
	const wasTerminal = ['cancelled', 'failed', 'complete'].includes(existing.state);
	const traceId = traceIdFromHermesInput(existing.inputJson);
	let run = await requestHermesRunCancellation(locals.user.id, runId);
	if (!wasTerminal && run.state === 'cancel_requested') {
		recordChatDiagnostic(existing.conversationId, 'chat.durable.cancel_requested', {
			...(traceId ? { trace_id: traceId } : {})
		});
	}
	if (run.state === 'cancel_requested') {
		try {
			const result = await cancelDurableHermesRun(locals.user.id, runId, traceId || undefined);
			if (result.state === 'not_running') {
				run = await finalizeHermesRunCancellation(locals.user.id, runId);
			}
		} catch {
			// The durable state remains cancel_requested. No new worker can claim
			// it; the caller can retry cancellation when Hermes is reachable.
		}
	}
	if (!wasTerminal && run.state === 'cancelled') {
		try {
			const collection = await collectDurableRunEvents(locals.user.id, runId, listHermesRunEvents);
			recordChatDiagnostic(
				run.conversationId,
				'chat.durable.terminal',
				summarizeDurableRunTelemetry(run, collection.events, { eventsTruncated: collection.truncated }),
				{ id: `durable-terminal:${run.id}` }
			);
		} catch {
			/* Telemetry must not change the cancellation result. */
		}
	}
	return json({ run_id: run.id, cursor: run.cursor, ...snapshotFromRun(run) }, { status: 202 });
};
