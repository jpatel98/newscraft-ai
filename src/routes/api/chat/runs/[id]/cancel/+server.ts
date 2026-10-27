import { json, type RequestHandler } from '@sveltejs/kit';
import {
	finalizeAgentRunCancellation,
	getAgentRun,
	requestAgentRunCancellation,
	snapshotFromRun,
	listAgentRunEvents
} from '$lib/server/db/agent-runs';
import { agentBackend } from '$lib/server/agent/backend';
import { recordChatDiagnostic } from '$lib/server/chat-diagnostics';
import {
	collectDurableRunEvents,
	summarizeDurableRunTelemetry,
	traceIdFromAgentInput
} from '$lib/server/durable-run-telemetry';

export const POST: RequestHandler = async ({ locals, params }) => {
	if (!locals.user) return json({ detail: 'unauthorized' }, { status: 401 });
	const runId = params.id?.trim();
	if (!runId) return json({ detail: 'run id required' }, { status: 400 });
	const existing = await getAgentRun(locals.user.id, runId);
	if (!existing) return json({ detail: 'run not found' }, { status: 404 });
	const wasTerminal = ['cancelled', 'failed', 'complete'].includes(existing.state);
	const traceId = traceIdFromAgentInput(existing.inputJson);
	let run = await requestAgentRunCancellation(locals.user.id, runId);
	if (!wasTerminal && run.state === 'cancel_requested') {
		recordChatDiagnostic(existing.conversationId, 'chat.durable.cancel_requested', {
			...(traceId ? { trace_id: traceId } : {})
		});
	}
	if (run.state === 'cancel_requested') {
		try {
			const result = await agentBackend().cancelRun(locals.user.id, runId, traceId || undefined);
			if (result.state === 'not_running') {
				run = await finalizeAgentRunCancellation(locals.user.id, runId);
			}
		} catch {
			// The durable state remains cancel_requested. A recovering worker can
			// claim it for cleanup, but dispatch checkpoints reject new work.
		}
	}
	if (!wasTerminal && run.state === 'cancelled') {
		try {
			const collection = await collectDurableRunEvents(locals.user.id, runId, listAgentRunEvents);
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
