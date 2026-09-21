import { error, json, type RequestHandler } from '@sveltejs/kit';
import { renameProject } from '$lib/server/db/projects';
import { projectBody, projectName } from '$lib/server/project-input';
export const PATCH: RequestHandler = async ({ locals, request, params }) => {
 if (!locals.user) throw error(401, 'unauthorized');
 const body = await projectBody(request);
 const project = await renameProject(locals.user.id, params.id!, projectName(body.name));
 if (!project) throw error(404, 'Project not found');
 return json(project);
};
