import { error, json, type RequestHandler } from '@sveltejs/kit';
import { deleteProject, renameProject } from '$lib/server/db/projects';
import { getProjectEvidenceService, isMissingEvidenceTablesError } from '$lib/server/evidence/runtime';
import { throwEvidenceHttpError } from '$lib/server/evidence/http';
import { projectBody, projectName } from '$lib/server/project-input';
export const PATCH: RequestHandler = async ({ locals, request, params }) => {
 if (!locals.user) throw error(401, 'unauthorized');
 const body = await projectBody(request);
 const project = await renameProject(locals.user.id, params.id!, projectName(body.name));
 if (!project) throw error(404, 'Project not found');
 return json(project);
};
export const DELETE: RequestHandler = async ({ locals, params }) => {
 if (!locals.user) throw error(401, 'unauthorized');
 try {
  await getProjectEvidenceService().deleteProject(locals.user.id, params.id!);
 } catch (cause) {
  if (isMissingEvidenceTablesError(cause)) {
   if (!await deleteProject(locals.user.id, params.id!)) throw error(404, 'Project not found');
  } else {
   throwEvidenceHttpError(cause);
  }
 }
 return json({ ok: true });
};
