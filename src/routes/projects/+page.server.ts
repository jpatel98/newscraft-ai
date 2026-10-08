import { redirect } from '@sveltejs/kit';
import { listProjects } from '$lib/server/db/projects';
import type { PageServerLoad } from './$types';
export const load: PageServerLoad = async ({ locals, depends }) => {
 if (!locals.user) throw redirect(303, '/login');
 depends('app:projects');
 return { projects: await listProjects(locals.user.id) };
};
