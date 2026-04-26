import { error, json, type RequestHandler } from '@sveltejs/kit';
import { listHermesJobs } from '$lib/server/hermes/board';

export const GET: RequestHandler = async ({ locals }) => {
	if (!locals.user) throw error(401, 'unauthorized');
	return json({ jobs: await listHermesJobs() });
};
