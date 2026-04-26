import { error, json, type RequestHandler } from '@sveltejs/kit';
import { listHermesSkills } from '$lib/server/hermes/bridge';

export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user) throw error(401, 'unauthorized');
	return json({ skills: await listHermesSkills() });
};
