import { error, redirect } from '@sveltejs/kit';
import { getProject, listProjectConversations } from '$lib/server/db/projects';
import type { PageServerLoad } from './$types';
export const load: PageServerLoad = async ({ locals, params, depends }) => {
 if (!locals.user) throw redirect(303, '/login');
 depends('app:projects');
 const project = await getProject(locals.user.id, params.id);
 if (!project) throw error(404, 'Project not found');
 return { project, projectConversations: await listProjectConversations(locals.user.id, params.id) };
};
