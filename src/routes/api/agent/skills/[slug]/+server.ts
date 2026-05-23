import { error, json, type RequestHandler } from '@sveltejs/kit';
import { getAgentSkillDetail } from '$lib/server/agent/bridge';

export const GET: RequestHandler = async ({ locals, params }) => {
	if (!locals.user) throw error(401, 'unauthorized');
	if (!params.slug) throw error(404, 'skill not found');
	try {
		return json({ skill: await getAgentSkillDetail(params.slug) });
	} catch {
		throw error(404, 'skill not found');
	}
};
