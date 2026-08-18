import { json, type RequestHandler } from '@sveltejs/kit';
import { reclaimQueuedOrExpiredHermesRuns } from '$lib/server/db/hermes-runs';
import { verifyHermesRunCallback } from '$lib/server/hermes-durable';

export const GET: RequestHandler = async ({ request, url }) => {
	if (!verifyHermesRunCallback(request)) return json({ detail: 'unauthorized' }, { status: 401 });
	const leaseOwner = url.searchParams.get('lease_owner')?.trim();
	const requestedLimit = Number(url.searchParams.get('limit') || '20');
	if (!leaseOwner || !Number.isSafeInteger(requestedLimit) || requestedLimit < 1) {
		return json({ detail: 'lease_owner and a positive limit are required' }, { status: 400 });
	}
	const runs = await reclaimQueuedOrExpiredHermesRuns(leaseOwner, Math.min(requestedLimit, 100));
	return json({
		runs: runs.map((run) => ({
			run_id: run.id,
			account_id: run.accountId,
			tenant_key: run.tenantKey,
			input: JSON.parse(run.inputJson),
		seeded_citations: JSON.parse(run.seededCitationsJson),
		resume_snapshot: {
			answer_text: run.answerText.slice(0, 64 * 1024),
			sources: JSON.parse(run.sourcesJson),
			citations: JSON.parse(run.citationsJson)
		},
		lease_owner: run.leaseOwner,
			lease_token: run.leaseToken,
			worker_cursor: run.workerCursor,
			state: run.state
		}))
	});
};
