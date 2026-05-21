import { error, json, type RequestHandler } from '@sveltejs/kit';
import type { ChannelSource } from '$lib/types';
import { createHermesJob, deleteAllHermesJobs, listHermesJobs } from '$lib/server/hermes/board';
import { saveMissionConfig } from '$lib/server/db/missions';
import { compileChannelPrompt, normalizeChannelSources } from '$lib/utils/channel-sources';

export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user) throw error(401, 'unauthorized');
	return json({ jobs: await listHermesJobs(locals.user.id) });
};

export const POST: RequestHandler = async ({ locals, request }) => {
	if (!locals.user) throw error(401, 'unauthorized');
	const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
	const name = typeof body?.name === 'string' ? body.name.trim() : '';
	const description = typeof body?.description === 'string' ? body.description.trim() : '';
	const schedule = typeof body?.schedule === 'string' ? body.schedule.trim() : '';
	const prompt = typeof body?.prompt === 'string' ? body.prompt.trim() : '';
	const deliver = typeof body?.deliver === 'string' ? body.deliver.trim() : '';
	const outputFormat = typeof body?.outputFormat === 'string' ? body.outputFormat.trim() : 'markdown';
	let sources: ChannelSource[];

	if (!name) throw error(400, 'Mission name is required');
	if (!schedule) throw error(400, 'Schedule is required');
	if (!prompt) throw error(400, 'Prompt is required');
	try {
		sources = normalizeChannelSources(body?.sources);
	} catch (err) {
		throw error(400, err instanceof Error ? err.message : String(err));
	}

	try {
		const job = await createHermesJob(locals.user.id, {
			name,
			schedule,
			prompt: compileChannelPrompt(prompt, sources),
			deliver: deliver || null,
			enabled: body?.enabled !== false
		});
		if (job) {
			await saveMissionConfig(locals.user.id, job.id, prompt, sources, {
				name,
				description,
				schedule,
				enabled: body?.enabled !== false,
				deliveryTarget: deliver || 'database',
				outputFormat: outputFormat || 'markdown'
			});
			return json({ ok: true, job: { ...job, description, prompt, sources, outputFormat: outputFormat || 'markdown' } });
		}
		return json({ ok: true, job });
	} catch (err) {
		throw error(502, err instanceof Error ? err.message : String(err));
	}
};

export const DELETE: RequestHandler = async ({ locals }) => {
	if (!locals.user) throw error(401, 'unauthorized');
	try {
		const result = await deleteAllHermesJobs(locals.user.id);
		return json({ ok: true, ...result });
	} catch (err) {
		throw error(502, err instanceof Error ? err.message : String(err));
	}
};
