import { error, json, type RequestHandler } from '@sveltejs/kit';
import { listAgentCommands } from '$lib/server/agent/bridge';

export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user) throw error(401, 'unauthorized');
	return json({ commands: await listAgentCommands() });
};
