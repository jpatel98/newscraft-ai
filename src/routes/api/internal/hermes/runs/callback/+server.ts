import { json, type RequestHandler } from '@sveltejs/kit';
import {
	appendHermesRunEvent,
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
	};
	try {
		body = (await request.json()) as typeof body;
	} catch {
		return json({ detail: 'invalid json' }, { status: 400 });
	}
	const accountId = body.account_id?.trim();
	const runId = body.run_id?.trim();
	const tenantKey = body.tenant_key?.trim();
	const leaseOwner = body.lease_owner?.trim();
	const leaseToken = body.lease_token?.trim();
	const eventType = body.event_type?.trim();
	if (!accountId || !runId || !tenantKey || !leaseOwner || !leaseToken || !eventType || !Number.isSafeInteger(body.worker_cursor)) {
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
	let dataJson: string;
	try {
		dataJson = JSON.stringify(body.data ?? {});
	} catch {
		return json({ detail: 'callback data is not serializable' }, { status: 400 });
	}
	try {
		const result = await appendHermesRunEvent(accountId, runId, leaseOwner, leaseToken, {
			eventType,
			dataJson,
			workerCursor: body.worker_cursor as number
		});
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
			const status = cause.code === 'not_found' ? 404 : cause.code === 'terminal' ? 409 : 409;
			return json({ detail: cause.message, code: cause.code }, { status });
		}
		throw cause;
	}
};
