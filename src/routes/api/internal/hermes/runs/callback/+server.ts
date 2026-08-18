import { json, type RequestHandler } from '@sveltejs/kit';
import {
	appendHermesRunEvent,
	getHermesRun,
	HermesRunRepositoryError
} from '$lib/server/db/hermes-runs';
import { verifyHermesRunCallback } from '$lib/server/hermes-durable';

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
		return json({ cursor: result.event.cursor, state: result.run.state });
	} catch (cause) {
		if (cause instanceof HermesRunRepositoryError) {
			const status = cause.code === 'not_found' ? 404 : cause.code === 'terminal' ? 409 : 409;
			return json({ detail: cause.message, code: cause.code }, { status });
		}
		throw cause;
	}
};
