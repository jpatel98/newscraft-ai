import { sql } from '$lib/server/db';
import { createUnpdfExtractor } from '$lib/server/documents/pdf';
import { createPostgresEvidenceRepository } from './repository';
import { ProjectEvidenceService } from './service';
import { createEvidenceStorage } from './storage';

let service: ProjectEvidenceService | undefined;

export function getProjectEvidenceService(): ProjectEvidenceService {
	service ??= new ProjectEvidenceService(createPostgresEvidenceRepository(), createEvidenceStorage(), createUnpdfExtractor());
	return service;
}

/**
 * True when migration 0027 is installed. The UI hides evidence controls and the
 * chat skips evidence context until then, so the app can deploy ahead of the
 * database change without failing requests.
 */
export async function evidenceTablesReady(): Promise<boolean> {
	try {
		const [tables] = await sql<Array<{ ready: boolean }>>`SELECT
			to_regclass('public.project_documents') IS NOT NULL AND
			to_regclass('public.project_document_pages') IS NOT NULL AND
			to_regclass('public.project_datasets') IS NOT NULL AND
			to_regclass('public.project_dataset_rows') IS NOT NULL AND
			to_regclass('public.project_analysis_runs') IS NOT NULL AND
			to_regclass('public.project_findings') IS NOT NULL AS ready`;
		return tables?.ready === true;
	} catch {
		return false;
	}
}

const EVIDENCE_TABLES = new Set(['project_documents', 'project_document_pages', 'project_datasets', 'project_dataset_rows', 'project_analysis_runs', 'project_findings']);

export function isMissingEvidenceTablesError(error: unknown): boolean {
	let current: unknown = error;
	const seen = new Set<unknown>();
	while (current && typeof current === 'object' && !seen.has(current)) {
		seen.add(current);
		const record = current as Record<string, unknown>;
		const code = typeof record.code === 'string' ? record.code : '';
		const table = typeof record.table_name === 'string' ? record.table_name : typeof record.table === 'string' ? record.table : '';
		const message = current instanceof Error ? current.message : typeof record.message === 'string' ? record.message : '';
		if (code === '42P01' && (EVIDENCE_TABLES.has(table) || /\bproject_(?:documents|document_pages|datasets|dataset_rows|analysis_runs|findings)\b/.test(message))) {
			return true;
		}
		current = record.cause;
	}
	return false;
}

