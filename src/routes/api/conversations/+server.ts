import { error, json, type RequestHandler } from '@sveltejs/kit';
import { createConversation } from '$lib/server/db/conversations';
import { projectBody, projectId } from '$lib/server/project-input';
export const POST: RequestHandler = async ({ request, locals }) => {
 if (!locals.user) throw error(401, 'unauthorized');
 const body = await projectBody(request, true);
 const membership = body.projectId === undefined ? null : projectId(body.projectId);
 if (body.system_prompt !== undefined && typeof body.system_prompt !== 'string') throw error(400, 'Invalid system prompt');
 try {
  const convo = await createConversation(locals.user.id, (body.system_prompt as string | undefined)?.trim() || undefined, membership);
  return json({ id: convo.id });
 } catch (e) {
  if (e instanceof Error && e.message === 'PROJECT_NOT_FOUND') throw error(404, 'Project not found');
  throw e;
 }
};
