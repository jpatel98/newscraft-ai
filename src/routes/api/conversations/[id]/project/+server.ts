import { error, json, type RequestHandler } from '@sveltejs/kit';
import { moveConversation } from '$lib/server/db/projects';
import { projectBody, projectId } from '$lib/server/project-input';
export const PATCH: RequestHandler = async ({ locals, request, params }) => {
 if (!locals.user) throw error(401, 'unauthorized');
 const body = await projectBody(request);
 if (!await moveConversation(locals.user.id, params.id!, projectId(body.projectId))) throw error(404, 'Conversation or project not found');
 return json({ ok: true });
};
