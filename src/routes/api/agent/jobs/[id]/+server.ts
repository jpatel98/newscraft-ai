import { error, json, type RequestHandler } from '@sveltejs/kit';
import { hideChannelJobId } from '$lib/server/db/hidden-channels';
import type { ChannelSource } from '$lib/types';
import {
	deleteMissionConfig,
	getMissionConfig,
	saveMissionConfig
} from '$lib/server/db/missions';
import { listApprovedCrawlPlans } from '$lib/server/db/crawl-plans';
import { deleteAgentJob, listAgentJobs, updateAgentJob } from '$lib/server/agent/board';
import { compileChannelPrompt, normalizeChannelSources } from '$lib/utils/channel-sources';

export const PATCH: RequestHandler = async ({ locals, params, request }) => {
	if (!locals.user) throw error(401, 'unauthorized');
	const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
	const id = params.id?.trim();
	if (!id) throw error(400, 'job id is required');
	const name = typeof body?.name === 'string' ? body.name.trim() : undefined;
	const description = typeof body?.description === 'string' ? body.description.trim() : undefined;
	const schedule = typeof body?.schedule === 'string' ? body.schedule.trim() : undefined;
	const prompt = typeof body?.prompt === 'string' ? body.prompt.trim() : undefined;
	const deliver = typeof body?.deliver === 'string' ? body.deliver.trim() : undefined;
	const outputFormat = typeof body?.outputFormat === 'string' ? body.outputFormat.trim() : undefined;
	const enabled = typeof body?.enabled === 'boolean' ? body.enabled : undefined;
	const hasSources = Boolean(body && Object.prototype.hasOwnProperty.call(body, 'sources'));
	let sources: ChannelSource[] | undefined;
	let configToSave: { basePrompt: string; sources: ChannelSource[] } | null = null;
	let existingConfig = await getMissionConfig(locals.user.id, id);

	if (name !== undefined && !name) throw error(400, 'Mission name is required');
	if (schedule !== undefined && !schedule) throw error(400, 'Schedule is required');
	if (prompt !== undefined && !prompt) throw error(400, 'Prompt is required');
	if (hasSources) {
		try {
			sources = normalizeChannelSources(body?.sources);
		} catch (err) {
			throw error(400, err instanceof Error ? err.message : String(err));
		}
	}

	try {
		let promptForAgent = prompt;
		if (
			prompt !== undefined ||
			sources !== undefined ||
			description !== undefined ||
			outputFormat !== undefined ||
			name !== undefined ||
			schedule !== undefined ||
			deliver !== undefined ||
			enabled !== undefined
		) {
			const existingJob = prompt === undefined ? (await listAgentJobs(locals.user.id)).find((job) => job.id === id) : null;
			const basePrompt = prompt ?? existingConfig?.basePrompt ?? existingJob?.prompt ?? '';
			const nextSources = sources ?? existingConfig?.sources ?? [];
			if (prompt !== undefined || sources !== undefined) {
				const crawlPlans = await listApprovedCrawlPlans(locals.user.id, id);
				promptForAgent = compileChannelPrompt(basePrompt, nextSources, crawlPlans);
			}
			configToSave = { basePrompt, sources: nextSources };
		}

		const job = await updateAgentJob(locals.user.id, id, {
			name,
			schedule,
			prompt: promptForAgent,
			deliver,
			enabled
		});
		if (job && configToSave) {
			await saveMissionConfig(locals.user.id, job.id, configToSave.basePrompt, configToSave.sources, {
				name: name ?? job.name,
				description: description ?? existingConfig?.description ?? job.description ?? '',
				schedule: schedule ?? job.scheduleDisplay,
				enabled: enabled ?? job.enabled,
				deliveryTarget: deliver ?? job.deliver ?? 'database',
				outputFormat: outputFormat ?? existingConfig?.outputFormat ?? job.outputFormat ?? 'markdown'
			});
			return json({
				ok: true,
				job: {
					...job,
					description: description ?? existingConfig?.description ?? job.description ?? '',
					prompt: configToSave.basePrompt,
					sources: configToSave.sources,
					outputFormat: outputFormat ?? existingConfig?.outputFormat ?? job.outputFormat ?? 'markdown'
				}
			});
		}
		return json({ ok: true, job });
	} catch (err) {
		throw error(502, err instanceof Error ? err.message : String(err));
	}
};

export const DELETE: RequestHandler = async ({ locals, params }) => {
	if (!locals.user) throw error(401, 'unauthorized');
	const id = params.id?.trim();
	if (!id) throw error(400, 'job id is required');
	await hideChannelJobId(locals.user.id, id);
	try {
		await deleteAgentJob(locals.user.id, id);
		await deleteMissionConfig(locals.user.id, id);
		return json({ ok: true });
	} catch (err) {
		throw error(502, err instanceof Error ? err.message : String(err));
	}
};
