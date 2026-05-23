import { error, json, type RequestHandler } from '@sveltejs/kit';
import { deleteMissionReportsByMissionId } from '$lib/server/db/mission-reports';
import { deleteMissionConfig } from '$lib/server/db/missions';
import { hideChannelJobId } from '$lib/server/db/hidden-channels';
import { deleteAgentJob } from '$lib/server/agent/board';

const JOB_ID_RE = /^[A-Za-z0-9_-]{1,80}$/;

export const DELETE: RequestHandler = async ({ locals, params }) => {
	if (!locals.user) throw error(401, 'unauthorized');
	const jobId = (params.jobId ?? '').trim();
	if (!JOB_ID_RE.test(jobId)) throw error(400, 'invalid job id');
	await hideChannelJobId(locals.user.id, jobId);

	let cronDeleted = false;
	let cronDeleteError: string | null = null;
	try {
		await deleteAgentJob(locals.user.id, jobId);
		cronDeleted = true;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		// If the upstream task already vanished, still clear local mission reports.
		if (/\b404\b/.test(message) || /not found/i.test(message)) {
			cronDeleteError = message;
		} else {
			throw error(502, message);
		}
	}

	await deleteMissionConfig(locals.user.id, jobId);
	await deleteMissionReportsByMissionId(locals.user.id, jobId);
	return json({ ok: true, deleted: jobId, cronDeleted, cronDeleteError });
};
