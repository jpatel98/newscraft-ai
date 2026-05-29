import { error, json, type RequestHandler } from '@sveltejs/kit';
import { agentFetch, describeGatewayError } from '$lib/server/agent/transport';

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) throw error(401, 'unauthorized');
	const input = (await request.json().catch(() => ({}))) as {
		command?: string;
		workspaceId?: string | null;
		storyId?: string | null;
		jobId?: string | null;
		runId?: string | null;
		targetAgent?: 'monitor' | 'research' | 'drafting' | null;
		facts?: unknown[];
	};
	const command = input.command?.trim();
	if (!command) throw error(400, 'command is required');

	try {
		const response = await agentFetch('/api/editor-commands', {
			method: 'POST',
			body: JSON.stringify({
				command,
				workspace_id: input.workspaceId || undefined,
				story_id: input.storyId || undefined,
				job_id: input.jobId || undefined,
				run_id: input.runId || undefined,
				target_agent: input.targetAgent || undefined,
				facts: Array.isArray(input.facts) ? input.facts : undefined
			})
		});
		const body = await response.json().catch(() => null);
		if (!response.ok) {
			const message = typeof body?.error === 'string' ? body.error : `Agent gateway returned ${response.status}`;
			throw error(response.status, message);
		}
		return json(body);
	} catch (err) {
		if (err && typeof err === 'object' && 'status' in err) throw err;
		throw error(502, describeGatewayError(err));
	}
};
