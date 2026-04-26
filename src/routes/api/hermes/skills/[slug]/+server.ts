import { error, json, type RequestHandler } from '@sveltejs/kit';
import { getHermesSkillDetail } from '$lib/server/hermes/bridge';

export const GET: RequestHandler = async ({ locals, params }) => {
	if (!locals.user) throw error(401, 'unauthorized');
	if (!params.slug) throw error(404, 'skill not found');
	try {
		return json({ skill: await getHermesSkillDetail(params.slug) });
	} catch {
		throw error(404, 'skill not found');
	}
};
