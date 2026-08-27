import { json, type RequestHandler } from '@sveltejs/kit';
import { getHermesRun, renewHermesRunLease, HermesRunRepositoryError } from '$lib/server/db/hermes-runs';
import { verifyHermesRunCallback } from '$lib/server/hermes-durable';
import { validateDurableTraceBinding } from '$lib/server/durable-run-telemetry';

export const POST: RequestHandler = async ({ request }) => {
	if (!verifyHermesRunCallback(request)) return json({ detail: 'unauthorized' }, { status: 401 });
	let body: { run_id?: string; account_id?: string; tenant_key?: string; lease_owner?: string; lease_token?: string; trace_id?: unknown };
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
	if (!accountId || !runId || !tenantKey || !leaseOwner || !leaseToken) return json({ detail: 'lease fields are required' }, { status: 400 });
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
		const run = await renewHermesRunLease(accountId, runId, leaseOwner, leaseToken);
		return json({ state: run.state, lease_expires_at: run.leaseExpiresAt });
	} catch (cause) {
		if (cause instanceof HermesRunRepositoryError && cause.code === 'stale_lease') {
			return json({ detail: 'run lease is stale' }, { status: 409 });
		}
		throw cause;
	}
};
