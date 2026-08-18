import { json, type RequestHandler } from '@sveltejs/kit';
import { getHermesRun, requestHermesRunCancellation, snapshotFromRun } from '$lib/server/db/hermes-runs';
import { cancelDurableHermesRun } from '$lib/server/hermes-durable';

export const POST: RequestHandler = async ({ locals, params }) => {
	if (!locals.user) return json({ detail: 'unauthorized' }, { status: 401 });
	const runId = params.id?.trim();
	if (!runId) return json({ detail: 'run id required' }, { status: 400 });
	const existing = await getHermesRun(locals.user.id, runId);
	if (!existing) return json({ detail: 'run not found' }, { status: 404 });
	const run = await requestHermesRunCancellation(locals.user.id, runId);
	if (run.state === 'cancel_requested') {
		try {
			await cancelDurableHermesRun(locals.user.id, runId);
		} catch {
			// The durable state remains cancel_requested. No new worker can claim
			// it; the caller can retry cancellation when Hermes is reachable.
		}
	}
	return json({ run_id: run.id, cursor: run.cursor, ...snapshotFromRun(run) }, { status: 202 });
};
