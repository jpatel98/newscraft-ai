import { json, type RequestHandler } from '@sveltejs/kit';
import { getHermesRun, claimHermesRunLease, HERMES_TERMINAL_STATES } from '$lib/server/db/hermes-runs';
import { verifyHermesRunCallback } from '$lib/server/hermes-durable';

export const POST: RequestHandler = async ({ request }) => {
	if (!verifyHermesRunCallback(request)) return json({ detail: 'unauthorized' }, { status: 401 });
	let body: { run_id?: string; account_id?: string; tenant_key?: string; lease_owner?: string };
	try {
		body = (await request.json()) as typeof body;
	} catch {
		return json({ detail: 'invalid json' }, { status: 400 });
	}
	const accountId = body.account_id?.trim();
	const runId = body.run_id?.trim();
	const tenantKey = body.tenant_key?.trim();
	const leaseOwner = body.lease_owner?.trim();
	if (!accountId || !runId || !tenantKey || !leaseOwner) return json({ detail: 'run, tenant and lease fields are required' }, { status: 400 });
	const existing = await getHermesRun(accountId, runId);
	if (!existing) return json({ detail: 'run not found' }, { status: 404 });
	if (existing.tenantKey !== tenantKey) return json({ detail: 'tenant binding does not match' }, { status: 404 });
	if (HERMES_TERMINAL_STATES.includes(existing.state as (typeof HERMES_TERMINAL_STATES)[number])) {
		return json({ terminal: true, state: existing.state, worker_cursor: existing.workerCursor });
	}
	if (existing.leaseOwner === leaseOwner && existing.leaseToken && existing.leaseExpiresAt && existing.leaseExpiresAt > Date.now()) {
		return json({
			terminal: false,
			lease_owner: existing.leaseOwner,
			lease_token: existing.leaseToken,
			worker_cursor: existing.workerCursor,
			state: existing.state
		});
	}
	const claimed = await claimHermesRunLease(accountId, runId, leaseOwner);
	if (!claimed || !claimed.leaseToken || !claimed.leaseOwner) {
		return json({ detail: 'run lease is held by another worker' }, { status: 409 });
	}
	return json({
		terminal: false,
		lease_owner: claimed.leaseOwner,
		lease_token: claimed.leaseToken,
		worker_cursor: claimed.workerCursor,
		state: claimed.state
	});
};
