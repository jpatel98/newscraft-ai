import { json, type RequestHandler } from '@sveltejs/kit';
import { reclaimQueuedOrExpiredAgentRuns } from '$lib/server/db/agent-runs';
import { verifyAgentRunCallback } from '$lib/server/agent-durable';

export const GET: RequestHandler = async ({ request, url }) => {
	if (!verifyAgentRunCallback(request)) return json({ detail: 'unauthorized' }, { status: 401 });
	const leaseOwner = url.searchParams.get('lease_owner')?.trim();
	const requestedLimit = Number(url.searchParams.get('limit') || '20');
	if (!leaseOwner || !Number.isSafeInteger(requestedLimit) || requestedLimit < 1) {
		return json({ detail: 'lease_owner and a positive limit are required' }, { status: 400 });
	}
	let runs: Awaited<ReturnType<typeof reclaimQueuedOrExpiredAgentRuns>>;
	try {
		runs = await reclaimQueuedOrExpiredAgentRuns(leaseOwner, Math.min(requestedLimit, 100));
	} catch (cause) {
		// Drizzle's "Failed query" hides the Postgres reason; log its code and message (never params).
		const pg = (cause as { cause?: { code?: unknown; message?: unknown } })?.cause;
		console.error('agent run recovery query failed', {
			code: typeof pg?.code === 'string' ? pg.code : null,
			message: typeof pg?.message === 'string' ? pg.message.slice(0, 300) : null
		});
		return json({ detail: 'recovery unavailable' }, { status: 503 });
	}
	return json({
		runs: runs.map((run) => {
			const input = JSON.parse(run.inputJson) as Record<string, unknown>;
			return {
				run_id: run.id,
				account_id: run.accountId,
				tenant_key: run.tenantKey,
				input,
				trace_id: typeof input.trace_id === 'string' ? input.trace_id : undefined,
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
			};
		})
	});
};
