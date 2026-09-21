import { error, json, type RequestHandler } from '@sveltejs/kit';
import { createProject, listProjects } from '$lib/server/db/projects';
import { projectBody, projectName } from '$lib/server/project-input';
export const GET: RequestHandler = async ({ locals }) => {
 if (!locals.user) throw error(401, 'unauthorized');
 return json({ projects: await listProjects(locals.user.id) });
};
export const POST: RequestHandler = async ({ locals, request }) => {
 if (!locals.user) throw error(401, 'unauthorized');
 const body = await projectBody(request);
 return json(await createProject(locals.user.id, projectName(body.name)), { status: 201 });
};
