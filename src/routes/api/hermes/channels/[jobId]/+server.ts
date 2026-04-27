import { error, json, type RequestHandler } from '@sveltejs/kit';
import { deleteChannelPostsByJobId } from '$lib/server/db/channel-posts';
import { hideChannelJobId } from '$lib/server/db/hidden-channels';
import { deleteHermesJob } from '$lib/server/hermes/board';

const JOB_ID_RE = /^[A-Za-z0-9_-]{1,80}$/;

export const DELETE: RequestHandler = async ({ locals, params }) => {
	if (!locals.user) throw error(401, 'unauthorized');
	const jobId = (params.jobId ?? '').trim();
	if (!JOB_ID_RE.test(jobId)) throw error(400, 'invalid job id');
	hideChannelJobId(jobId);

	let cronDeleted = false;
	let cronDeleteError: string | null = null;
	try {
		await deleteHermesJob(jobId);
		cronDeleted = true;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		// If the upstream job already vanished, still clear local channel posts.
		if (/\b404\b/.test(message) || /not found/i.test(message)) {
			cronDeleteError = message;
		} else {
			throw error(502, message);
		}
	}

	deleteChannelPostsByJobId(jobId);
	return json({ ok: true, deleted: jobId, cronDeleted, cronDeleteError });
};
