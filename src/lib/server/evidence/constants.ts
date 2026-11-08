/** Pilot ceilings for the project evidence library. Benchmarks, not promises. */
export const EVIDENCE_PDF_MIME = 'application/pdf';
export const EVIDENCE_CSV_MIME = 'text/csv';
/** Browsers report CSVs under several types; the extension and bytes decide. */
export const EVIDENCE_CSV_DECLARED_MIMES = new Set([
	'text/csv',
	'application/csv',
	'text/plain',
	'application/vnd.ms-excel',
	'text/comma-separated-values',
	''
]);
export const MAX_EVIDENCE_PDF_BYTES = 20 * 1024 * 1024;
export const MAX_EVIDENCE_PDF_PAGES = 250;
/** The CSV bucket policy on the storage gateway caps objects at 20 MiB. */
export const MAX_EVIDENCE_CSV_BYTES = 20 * 1024 * 1024;
export const MAX_CSV_RECORDS = 50_000;
export const MAX_CSV_COLUMNS = 200;
export const MAX_CSV_CELL_CHARS = 10_000;
export const MAX_DOCUMENTS_PER_PROJECT = 100;
export const MAX_PROJECT_SOURCE_BYTES = 1024 * 1024 * 1024;
export const MAX_UPLOADS_PER_REQUEST = 5;
export const SIGNED_DOWNLOAD_TTL_SECONDS = 60;
/** Characters of evidence text a project chat may receive per turn. */
export const EVIDENCE_CONTEXT_CHAR_LIMIT = 24_000;
export const EVIDENCE_CONTEXT_PAGE_LIMIT = 6;
export const EVIDENCE_CONTEXT_ROW_LIMIT = 24;
export const EVIDENCE_ROW_BLOCK_SIZE = 12;
export const ANALYZER_VERSION = 'deterministic-v1';
export const MAX_LEADS_PER_RUN = 3;
/** A run older than this with no terminal state is treated as abandoned. */
export const ANALYSIS_RUN_STALE_MS = 5 * 60 * 1000;
export const PROCESSING_CLAIM_STALE_MS = 5 * 60 * 1000;
export const MAX_ANALYSIS_SOURCE_BYTES = 64 * 1024 * 1024;
export const MAX_ANALYSIS_CELLS = 2_000_000;
export const MAX_ANALYSIS_PAGES = 1000;
export const MAX_EXTRACTED_DOCUMENT_CHARS = 8 * 1024 * 1024;
export const MAX_ANALYSIS_EXTRACTED_CHARS = 32 * 1024 * 1024;
export const CSV_PARSER_VERSION = 'csv-v1';

