/** Client-side shapes for findings and runs, mirroring the server rows the page loader returns. */
export interface FindingEvidenceView {
	documentId: string;
	documentName: string;
	sha256: string;
	kind: 'rows' | 'page';
	columnIds?: string[];
	columnNames?: string[];
	rows?: Array<{ ordinal: number; cells: Record<string, string> }>;
	pageNumber?: number;
	excerpt?: string;
	withdrawn?: boolean;
}

export interface ProjectFindingView {
	id: string;
	kind: string;
	rank: number;
	title: string;
	claim: string;
	evidence: FindingEvidenceView[];
	calculation: { method: string; parameters: Record<string, string | number | boolean | string[]>; counts: Record<string, number> };
	limitations: string;
	nextQuestion: string;
	status: 'proposed' | 'saved' | 'reviewed' | 'dismissed' | 'stale';
	reviewNote: string;
	dismissalReason: string;
	reviewedAt: number | null;
	createdAt: number;
	updatedAt: number;
}

export interface AnalysisRunView {
	id: string;
	status: 'running' | 'succeeded' | 'failed' | 'cancelled';
	trigger: 'manual' | 'auto';
	findingCount: number;
	errorMessage: string | null;
	startedAt: number;
	finishedAt: number | null;
}

export const FINDING_KIND_LABELS: Record<string, string> = {
	dataset_summary: 'Dataset summary',
	duplicate_identifiers: 'Repeated identifiers',
	candidate_join: 'Possible join between files',
	amount_outliers: 'Unusual amounts',
	identifier_mentions: 'Identifiers found in a document'
};

export const DISMISSAL_REASONS = [
	'Expected in this data',
	'Already known',
	'Wrong column or key',
	'Not relevant to this story',
	'Other'
] as const;

export function isLead(finding: ProjectFindingView): boolean {
	return finding.kind !== 'dataset_summary';
}

/** The prompt a reporter opens in chat to work one lead. Cites rows and pages, not conclusions. */
export function leadPrompt(finding: ProjectFindingView): string {
	const refs = finding.evidence
		.filter((item) => !item.withdrawn)
		.map((item) => item.kind === 'page'
			? `${item.documentName}, page ${item.pageNumber}`
			: `${item.documentName}, rows ${(item.rows ?? []).map((row) => row.ordinal).join(', ')}`)
		.slice(0, 6);
	return [
		`Help me check this lead from the project evidence: ${finding.title}.`,
		`What the analysis observed: ${finding.claim}`,
		`How it was calculated: ${finding.calculation.method}`,
		refs.length ? `Evidence to inspect: ${refs.join('; ')}.` : '',
		`Known limits: ${finding.limitations}`,
		`Start with: ${finding.nextQuestion} Cite the exact rows or pages you rely on and say what remains unverified.`
	].filter(Boolean).join('\n\n');
}

