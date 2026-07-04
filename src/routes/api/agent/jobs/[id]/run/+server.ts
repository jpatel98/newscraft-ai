import { error, json, type RequestHandler } from '@sveltejs/kit';
import { stateForAgentJobAction, upsertAgentJobState } from '$lib/server/db/agent-jobs';
import { runJobAction } from '$lib/server/agent/board';

export const POST: RequestHandler = async ({ locals, params }) => {
	if (!locals.user) throw error(401, 'unauthorized');
	const id = params.id?.trim();
	if (!id) throw error(400, 'job id is required');
	const accountId = locals.user.id;
	const state = stateForAgentJobAction('run', null);
	const startedAt = Date.now();
	await upsertAgentJobState(accountId, id, { state, lastRunAt: startedAt, lastError: null });
	try {
		const job = await runJobAction(accountId, id, 'run');
		await upsertAgentJobState(accountId, id, {
			state: stateForAgentJobAction('run', job),
			lastRunId: job?.id,
			lastRunAt: Date.now(),
			lastError: job?.lastError ?? null
		});
		return json({ ok: true, job });
	} catch (err) {
		await upsertAgentJobState(accountId, id, {
			state: 'failed',
			lastRunAt: Date.now(),
			lastError: err instanceof Error ? err.message : String(err)
		});
		throw error(502, err instanceof Error ? err.message : String(err));
	}
};
