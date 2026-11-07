import { error, json, type RequestHandler } from '@sveltejs/kit';
import { deleteProject, renameProject } from '$lib/server/db/projects';
import { getProjectEvidenceService, isMissingEvidenceTablesError } from '$lib/server/evidence/runtime';
import { projectBody, projectName } from '$lib/server/project-input';
export const PATCH: RequestHandler = async ({ locals, request, params }) => {
 if (!locals.user) throw error(401, 'unauthorized');
 const body = await projectBody(request);
 const project = await renameProject(locals.user.id, params.id!, projectName(body.name));
 if (!project) throw error(404, 'Project not found');
 return json(project);
};
// Removing a folder keeps its chats. It must not silently drop sealed evidence
// and the stored bytes behind it, so a folder that still holds evidence is
// refused until each file is removed through the evidence API.
export const DELETE: RequestHandler = async ({ locals, params }) => {
 if (!locals.user) throw error(401, 'unauthorized');
 try {
  const documents = await getProjectEvidenceService().listDocuments(locals.user.id, params.id!);
  if (documents.length > 0) throw error(409, 'Remove this folder’s evidence before deleting it');
 } catch (cause) {
  if (!isMissingEvidenceTablesError(cause)) throw cause;
 }
 if (!await deleteProject(locals.user.id, params.id!)) throw error(404, 'Project not found');
 return json({ ok: true });
};
