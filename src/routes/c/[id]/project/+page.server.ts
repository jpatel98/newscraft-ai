import { error, redirect } from '@sveltejs/kit';
import { getConversation } from '$lib/server/db/conversations';
import { getConversationProject, listProjects } from '$lib/server/db/projects';
import type { PageServerLoad } from './$types';
export const load: PageServerLoad = async ({ locals, params }) => {
 if (!locals.user) throw redirect(303, '/login');
 const conversation = await getConversation(locals.user.id, params.id);
 if (!conversation) throw error(404, 'Conversation not found');
 return { conversation, membership: await getConversationProject(locals.user.id, params.id) ?? null, projects: await listProjects(locals.user.id) };
};
