import { error, json, type RequestHandler } from '@sveltejs/kit';
import { createHermesJob, listHermesJobs } from '$lib/server/hermes/board';

export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user) throw error(401, 'unauthorized');
	return json({ jobs: await listHermesJobs() });
};

export const POST: RequestHandler = async ({ locals, request }) => {
	if (!locals.user) throw error(401, 'unauthorized');
	const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
	const name = typeof body?.name === 'string' ? body.name.trim() : '';
	const schedule = typeof body?.schedule === 'string' ? body.schedule.trim() : '';
	const prompt = typeof body?.prompt === 'string' ? body.prompt.trim() : '';
	const deliver = typeof body?.deliver === 'string' ? body.deliver.trim() : '';

	if (!name) throw error(400, 'Channel name is required');
	if (!schedule) throw error(400, 'Schedule is required');
	if (!prompt) throw error(400, 'Prompt is required');

	try {
		const job = await createHermesJob({
			name,
			schedule,
			prompt,
			deliver: deliver || null,
			enabled: body?.enabled !== false
		});
		return json({ ok: true, job });
	} catch (err) {
		throw error(502, err instanceof Error ? err.message : String(err));
	}
};
