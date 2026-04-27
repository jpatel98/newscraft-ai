import { error, json, type RequestHandler } from '@sveltejs/kit';
import { hideChannelJobId } from '$lib/server/db/hidden-channels';
import { deleteHermesJob, updateHermesJob } from '$lib/server/hermes/board';

export const PATCH: RequestHandler = async ({ locals, params, request }) => {
	if (!locals.user) throw error(401, 'unauthorized');
	const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
	const name = typeof body?.name === 'string' ? body.name.trim() : undefined;
	const schedule = typeof body?.schedule === 'string' ? body.schedule.trim() : undefined;
	const deliver = typeof body?.deliver === 'string' ? body.deliver.trim() : undefined;
	const enabled = typeof body?.enabled === 'boolean' ? body.enabled : undefined;

	if (name !== undefined && !name) throw error(400, 'Channel name is required');
	if (schedule !== undefined && !schedule) throw error(400, 'Schedule is required');

	try {
		const job = await updateHermesJob(params.id ?? '', {
			name,
			schedule,
			deliver,
			enabled
		});
		return json({ ok: true, job });
	} catch (err) {
		throw error(502, err instanceof Error ? err.message : String(err));
	}
};

export const DELETE: RequestHandler = async ({ locals, params }) => {
	if (!locals.user) throw error(401, 'unauthorized');
	const id = (params.id ?? '').trim();
	hideChannelJobId(id);
	try {
		await deleteHermesJob(id);
		return json({ ok: true });
	} catch (err) {
		throw error(502, err instanceof Error ? err.message : String(err));
	}
};
