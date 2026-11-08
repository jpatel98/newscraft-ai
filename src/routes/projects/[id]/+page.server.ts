import { error, redirect } from '@sveltejs/kit';
import { getProject, listProjectConversations } from '$lib/server/db/projects';
import { evidenceTablesReady, getProjectEvidenceService, isMissingEvidenceTablesError } from '$lib/server/evidence/runtime';
import type { AnalysisRunRow, ProjectFindingRow, PublicEvidenceDocument } from '$lib/server/evidence/types';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, params, depends }) => {
 if (!locals.user) throw redirect(303, '/login');
 depends('app:projects');
 depends('app:evidence');
 const project = await getProject(locals.user.id, params.id);
 if (!project) throw error(404, 'Project not found');
 const accountId = locals.user.id;
 let evidenceEnabled = await evidenceTablesReady();
 let evidence: PublicEvidenceDocument[] = [];
 let findings: ProjectFindingRow[] = [];
 let latestRun: AnalysisRunRow | null = null;
 if (evidenceEnabled) {
  try {
   const service = getProjectEvidenceService();
   [evidence, findings, latestRun] = await Promise.all([
    service.listDocuments(accountId, project.id),
    service.listFindings(accountId, project.id),
    service.latestRun(accountId, project.id).then((run) => run ?? null)
   ]);
  } catch (cause) {
   if (!isMissingEvidenceTablesError(cause)) throw cause;
   evidenceEnabled = false;
  }
 }
 return {
  project,
  projectConversations: await listProjectConversations(accountId, params.id),
  evidenceEnabled,
  evidence,
  findings,
  latestRun
 };
};
