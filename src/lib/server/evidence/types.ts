export type EvidenceKind = 'pdf' | 'csv';
export type EvidenceState = 'uploading' | 'processing' | 'ready' | 'failed';
export type FindingStatus = 'proposed' | 'saved' | 'reviewed' | 'dismissed' | 'stale';
export type AnalysisRunStatus = 'running' | 'succeeded' | 'failed' | 'cancelled';

export interface OwnedProject {
	id: string;
	accountId: string;
	orgId: string | null;
}

export interface EvidenceUploadInput {
	filename: string;
	mimeType: string;
	sizeBytes: number;
	checksumSha256: string;
}

export interface ValidatedEvidenceUpload extends EvidenceUploadInput {
	kind: EvidenceKind;
	/** The MIME type the sealed object is stored and served with. */
	storedMimeType: string;
}

export interface ProjectDocumentRow {
	id: string;
	accountId: string;
	projectId: string;
	orgId: string | null;
	kind: EvidenceKind;
	displayName: string;
	mimeType: string;
	declaredSizeBytes: number;
	declaredSha256: string;
	storageBucket: string;
	storagePath: string;
	state: EvidenceState;
	sealedSha256: string | null;
	sealedSizeBytes: number | null;
	sealedAt: number | null;
	extractionVersion: number;
	pageCount: number | null;
	rowCount: number | null;
	columnCount: number | null;
	failureCode: string | null;
	failureMessage: string | null;
	processingStartedAt: number | null;
	processedAt: number | null;
	createdAt: number;
	updatedAt: number;
}

export interface ProjectDocumentPageRow {
	documentId: string;
	pageNumber: number;
	pageText: string;
	charCount: number;
}

export interface RankedProjectPage extends ProjectDocumentPageRow {
	rank: number;
}

export type CsvColumnType = 'integer' | 'decimal' | 'date' | 'text' | 'empty' | 'mixed';

export interface DatasetColumn {
	/** Stable id within the extraction version, `c1`, `c2`, ... in source order. */
	id: string;
	name: string;
	inferredType: CsvColumnType;
	nonEmptyCount: number;
	distinctCount: number;
}

export interface DatasetRow {
	ordinal: number;
	sourceLine: number;
	cells: string[];
}

export interface ProjectDatasetRow {
	documentId: string;
	delimiter: string;
	hasHeader: boolean;
	encoding: string;
	parserVersion: string;
	columns: DatasetColumn[];
	rowCount: number;
	rejectedRows: number;
}

export interface EvidenceRowRef {
	ordinal: number;
	cells: Record<string, string>;
}

/** One inspectable pointer from a finding into a sealed source revision. */
export interface FindingEvidence {
	documentId: string;
	documentName: string;
	sha256: string;
	kind: 'rows' | 'page';
	columnIds?: string[];
	/** Display names parallel to columnIds, so cards never show raw ids. */
	columnNames?: string[];
	rows?: EvidenceRowRef[];
	pageNumber?: number;
	excerpt?: string;
	/** Set when the cited source was deleted after the finding was recorded. */
	withdrawn?: boolean;
}

export interface FindingCalculation {
	method: string;
	parameters: Record<string, string | number | boolean | string[]>;
	counts: Record<string, number>;
}

export interface ProjectFindingRow {
	id: string;
	accountId: string;
	projectId: string;
	runId: string | null;
	kind: string;
	rank: number;
	title: string;
	claim: string;
	evidence: FindingEvidence[];
	calculation: FindingCalculation;
	limitations: string;
	nextQuestion: string;
	fingerprint: string;
	status: FindingStatus;
	reviewNote: string;
	dismissalReason: string;
	reviewedBy: string | null;
	reviewedAt: number | null;
	createdAt: number;
	updatedAt: number;
}

export interface AnalysisRunRow {
	id: string;
	accountId: string;
	projectId: string;
	status: AnalysisRunStatus;
	trigger: 'manual' | 'auto';
	analyzerVersion: string;
	inputDocuments: Array<{ id: string; sha256: string; extractionVersion: number }>;
	findingCount: number;
	errorCode: string | null;
	errorMessage: string | null;
	startedAt: number;
	finishedAt: number | null;
}

export interface SignedEvidenceUpload {
	path: string;
	token: string;
	signedUrl: string;
	contentType: string;
}

export interface EvidenceStorage {
	createSignedUpload(kind: EvidenceKind, path: string, maxBytes: number, contentType: string): Promise<SignedEvidenceUpload>;
	download(kind: EvidenceKind, path: string): Promise<Uint8Array>;
	createSignedDownload(kind: EvidenceKind, path: string, expiresInSeconds: number): Promise<string>;
	remove(kind: EvidenceKind, path: string): Promise<void>;
	bucketFor(kind: EvidenceKind): string;
	verifyCapability(): Promise<void>;
}

export interface EvidenceRepository {
	createDocument(row: ProjectDocumentRow): Promise<void>;
	getDocument(accountId: string, projectId: string, documentId: string): Promise<ProjectDocumentRow | undefined>;
	listDocuments(accountId: string, projectId: string): Promise<ProjectDocumentRow[]>;
	projectUsage(accountId: string, projectId: string): Promise<{ count: number; bytes: number }>;
	claimForProcessing(accountId: string, projectId: string, documentId: string, now: number): Promise<ProjectDocumentRow | undefined>;
	markFailed(accountId: string, projectId: string, documentId: string, failure: { code: string; message: string; now: number }): Promise<void>;
	sealPdf(document: ProjectDocumentRow, seal: { sha256: string; sizeBytes: number; pages: string[]; now: number }): Promise<ProjectDocumentRow>;
	sealCsv(document: ProjectDocumentRow, seal: { sha256: string; sizeBytes: number; dataset: Omit<ProjectDatasetRow, 'documentId'>; rows: DatasetRow[]; now: number }): Promise<ProjectDocumentRow>;
	deleteDocument(accountId: string, projectId: string, documentId: string): Promise<void>;
	getPage(accountId: string, projectId: string, documentId: string, pageNumber: number): Promise<ProjectDocumentPageRow | undefined>;
	listPages(accountId: string, projectId: string, documentIds: string[]): Promise<ProjectDocumentPageRow[]>;
	searchPages(accountId: string, projectId: string, documentIds: string[], query: string, limit: number): Promise<RankedProjectPage[]>;
	listPagesPrefix(accountId: string, projectId: string, documentIds: string[], limit: number): Promise<ProjectDocumentPageRow[]>;
	getDataset(accountId: string, projectId: string, documentId: string): Promise<ProjectDatasetRow | undefined>;
	listRows(accountId: string, projectId: string, documentId: string, offset: number, limit: number): Promise<DatasetRow[]>;
	listRowsByOrdinals(accountId: string, projectId: string, documentId: string, ordinals: number[]): Promise<DatasetRow[]>;
	searchRows(accountId: string, projectId: string, documentId: string, terms: string[], limit: number): Promise<DatasetRow[]>;
	createRun(run: AnalysisRunRow): Promise<void>;
	finishRun(accountId: string, projectId: string, runId: string, result: { status: AnalysisRunStatus; findingCount: number; errorCode?: string | null; errorMessage?: string | null; now: number }): Promise<void>;
	latestRun(accountId: string, projectId: string): Promise<AnalysisRunRow | undefined>;
	listFindings(accountId: string, projectId: string): Promise<ProjectFindingRow[]>;
	getFinding(accountId: string, projectId: string, findingId: string): Promise<ProjectFindingRow | undefined>;
	upsertFindings(accountId: string, projectId: string, findings: ProjectFindingRow[]): Promise<ProjectFindingRow[]>;
	updateFindingStatus(accountId: string, projectId: string, findingId: string, patch: { status: FindingStatus; reviewNote?: string; dismissalReason?: string; reviewedBy: string | null; now: number }): Promise<ProjectFindingRow | undefined>;
	withdrawDocumentFromFindings(accountId: string, projectId: string, documentId: string, now: number): Promise<void>;
}

export interface PublicEvidenceDocument {
	id: string;
	projectId: string;
	kind: EvidenceKind;
	name: string;
	mimeType: string;
	sizeBytes: number;
	state: EvidenceState;
	sha256: string | null;
	pageCount: number | null;
	rowCount: number | null;
	columnCount: number | null;
	error: string | null;
	createdAt: number;
	updatedAt: number;
}
