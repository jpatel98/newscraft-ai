import { error, json, type RequestHandler } from '@sveltejs/kit';
import { listAgentSkills } from '$lib/server/agent/bridge';

export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user) throw error(401, 'unauthorized');
	return json({ skills: await listAgentSkills() });
};
