import { json, type RequestHandler } from '@sveltejs/kit';
import {
	failQueuedHermesRun,
	getHermesRun,
	HermesRunRepositoryError
} from '$lib/server/db/hermes-runs';
import { verifyHermesRunCallback } from '$lib/server/hermes-durable';
import { validateDurableTraceBinding } from '$lib/server/durable-run-telemetry';

const SAFE_FAILURE_MESSAGES = {
	admission: 'Research service could not start this run. Try again.',
	overload: 'Research service is temporarily at capacity. Try again shortly.'
} as const;

export const POST: RequestHandler = async ({ request }) => {
	if (!verifyHermesRunCallback(request)) return json({ detail: 'unauthorized' }, { status: 401 });
	let body: {
		run_id?: string;
		account_id?: string;
		tenant_key?: string;
		reason?: keyof typeof SAFE_FAILURE_MESSAGES;
		trace_id?: unknown;
	};
	try {
		body = (await request.json()) as typeof body;
	} catch {
		return json({ detail: 'invalid json' }, { status: 400 });
	}
	const accountId = body.account_id?.trim();
	const runId = body.run_id?.trim();
	const tenantKey = body.tenant_key?.trim();
	const reason = body.reason;
	const safeReason = reason === 'admission' || reason === 'overload' ? reason : null;
	if (!accountId || !runId || !tenantKey || !safeReason) {
		return json({ detail: 'run, tenant and failure fields are required' }, { status: 400 });
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
		const run = await failQueuedHermesRun(
			accountId,
			runId,
			SAFE_FAILURE_MESSAGES[safeReason],
			safeReason === 'overload' ? 'overload' : 'start'
		);
		return json({ state: run.state });
	} catch (cause) {
		if (cause instanceof HermesRunRepositoryError) {
			return json({ detail: cause.message, code: cause.code }, { status: 409 });
		}
		throw cause;
	}
};
