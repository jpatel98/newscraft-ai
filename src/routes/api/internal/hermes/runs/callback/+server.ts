import { json, type RequestHandler } from '@sveltejs/kit';
import {
	appendHermesRunEvents,
	getHermesRun,
	listHermesRunEvents,
	HermesRunRepositoryError
} from '$lib/server/db/hermes-runs';
import { verifyHermesRunCallback } from '$lib/server/hermes-durable';
import { generateConversationTitle } from '$lib/server/conversation-title';
import { CHAT_TITLE_TIMEOUT_MS, withChatTimeout } from '$lib/server/chat-timeouts';
import { recordChatDiagnostic } from '$lib/server/chat-diagnostics';
import {
	collectDurableRunEvents,
	summarizeDurableRunTelemetry,
	validateDurableTraceBinding
} from '$lib/server/durable-run-telemetry';

export const POST: RequestHandler = async ({ request }) => {
	if (!verifyHermesRunCallback(request)) return json({ detail: 'unauthorized' }, { status: 401 });
	let body: {
		run_id?: string;
		account_id?: string;
		tenant_key?: string;
		lease_owner?: string;
		lease_token?: string;
		worker_cursor?: number;
		event_type?: string;
		trace_id?: unknown;
		data?: unknown;
		events?: Array<{ worker_cursor?: number; event_type?: string; data?: unknown }>;
	};
	try {
		body = (await request.json()) as typeof body;
	} catch {
		return json({ detail: 'invalid json' }, { status: 400 });
	}
	if (!body || typeof body !== 'object') return json({ detail: 'invalid callback body' }, { status: 400 });
	const accountId = typeof body.account_id === 'string' ? body.account_id.trim() : '';
	const runId = typeof body.run_id === 'string' ? body.run_id.trim() : '';
	const tenantKey = typeof body.tenant_key === 'string' ? body.tenant_key.trim() : '';
	const leaseOwner = typeof body.lease_owner === 'string' ? body.lease_owner.trim() : '';
	const leaseToken = typeof body.lease_token === 'string' ? body.lease_token.trim() : '';
	const events = body.events ?? [body];
	if (!Array.isArray(events) || events.length < 1 || events.length > 32 ||
		(body.events !== undefined && (body.event_type !== undefined || body.worker_cursor !== undefined)) ||
		events.some((event) => !event || typeof event.event_type !== 'string' || !event.event_type.trim() || !Number.isSafeInteger(event.worker_cursor))) {
		return json({ detail: 'invalid callback events' }, { status: 400 });
	}
	if (!accountId || !runId || !tenantKey || !leaseOwner || !leaseToken) {
		return json({ detail: 'callback fields are required' }, { status: 400 });
	}
	const existing = await getHermesRun(accountId, runId);
	if (!existing || existing.tenantKey !== tenantKey) return json({ detail: 'run not found' }, { status: 404 });
	const traceBinding = validateDurableTraceBinding(existing.inputJson, body.trace_id);
	if (!traceBinding.ok) {
		return json(
			{
				code: 'trace_binding',
				detail:
					traceBinding.reason === 'invalid' || traceBinding.reason === 'persisted_invalid'
						? 'trace_id is invalid'
						: 'trace binding does not match'
			},
			{ status: 409 }
		);
	}
	try {
		const inputs = events.map((event) => ({
			eventType: event.event_type!.trim(),
			dataJson: JSON.stringify(event.data ?? {}),
			workerCursor: event.worker_cursor as number,
			artifactRevisionId: event.event_type!.trim() === 'artifact.ready' && event.data && typeof event.data === 'object' && !Array.isArray(event.data)
				? typeof (event.data as Record<string, unknown>).artifact_revision_id === 'string'
					? (event.data as Record<string, unknown>).artifact_revision_id as string
					: null
				: null
		}));
		const result = await appendHermesRunEvents(accountId, runId, leaseOwner, leaseToken, inputs);
		if (result.run.state === 'complete') {
			try {
				await withChatTimeout(
					generateConversationTitle(accountId, result.run.conversationId, {
						idempotencyKey: `title-${result.run.conversationId}-${result.run.assistantMessageId}`
					}),
					CHAT_TITLE_TIMEOUT_MS,
					'conversation title'
				);
			} catch {
				/* A saved answer must not fail because its title could not be generated. */
			}
		}
		if (result.run.state === 'complete' || result.run.state === 'failed' || result.run.state === 'cancelled') {
			try {
				const collection = await collectDurableRunEvents(accountId, runId, listHermesRunEvents);
				recordChatDiagnostic(
					result.run.conversationId,
					'chat.durable.terminal',
					summarizeDurableRunTelemetry(result.run, collection.events, {
						eventsTruncated: collection.truncated
					}),
					{ id: `durable-terminal:${result.run.id}` }
				);
			} catch {
				/* Telemetry must not change the durable callback result. */
			}
		}
		return json({ cursor: result.event.cursor, state: result.run.state });
	} catch (cause) {
		if (cause instanceof HermesRunRepositoryError) {
			const status = cause.code === 'not_found' ? 404 : cause.code === 'invalid_input' ? 400 : 409;
			return json({ detail: cause.message, code: cause.code }, { status });
		}
		throw cause;
	}
};
