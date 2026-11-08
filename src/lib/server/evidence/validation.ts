import {
	EVIDENCE_CSV_DECLARED_MIMES,
	EVIDENCE_CSV_MIME,
	EVIDENCE_PDF_MIME,
	MAX_EVIDENCE_CSV_BYTES,
	MAX_EVIDENCE_PDF_BYTES,
	MAX_UPLOADS_PER_REQUEST
} from './constants';
import { DocumentError } from '$lib/server/documents/errors';
import type { EvidenceUploadInput, ValidatedEvidenceUpload } from './types';

const SHA256_RE = /^[a-f0-9]{64}$/;

export function validateEvidenceUploads(value: unknown): ValidatedEvidenceUpload[] {
	if (!Array.isArray(value) || value.length < 1) {
		throw new DocumentError(400, 'documents_required', 'Select at least one PDF or CSV.');
	}
	if (value.length > MAX_UPLOADS_PER_REQUEST) {
		throw new DocumentError(400, 'too_many_documents', `Add no more than ${MAX_UPLOADS_PER_REQUEST} files at a time.`);
	}
	return value.map(validateEvidenceUpload);
}

export function validateEvidenceUpload(value: unknown): ValidatedEvidenceUpload {
	if (!value || typeof value !== 'object') {
		throw new DocumentError(400, 'invalid_document', 'The selected file is invalid.');
	}
	const input = value as Record<string, unknown>;
	const filename = typeof input.filename === 'string' ? input.filename.trim() : '';
	const mimeType = typeof input.mimeType === 'string' ? input.mimeType.trim().toLowerCase() : '';
	const sizeBytes = typeof input.sizeBytes === 'number' ? input.sizeBytes : Number.NaN;
	const checksumSha256 = typeof input.checksumSha256 === 'string' ? input.checksumSha256.trim().toLowerCase() : '';

	if (!filename || filename.length > 255 || /[\u0000-\u001f\u007f/\\]/.test(filename)) {
		throw new DocumentError(400, 'invalid_filename', 'The filename is invalid.');
	}
	const lower = filename.toLowerCase();
	let kind: ValidatedEvidenceUpload['kind'];
	let storedMimeType: string;
	let maxBytes: number;
	if (lower.endsWith('.pdf') && mimeType === EVIDENCE_PDF_MIME) {
		kind = 'pdf';
		storedMimeType = EVIDENCE_PDF_MIME;
		maxBytes = MAX_EVIDENCE_PDF_BYTES;
	} else if (lower.endsWith('.csv') && EVIDENCE_CSV_DECLARED_MIMES.has(mimeType)) {
		kind = 'csv';
		storedMimeType = EVIDENCE_CSV_MIME;
		maxBytes = MAX_EVIDENCE_CSV_BYTES;
	} else {
		throw new DocumentError(415, 'unsupported_evidence_type', 'Only PDF and CSV files are supported.');
	}
	if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 1) {
		throw new DocumentError(400, 'invalid_file_size', 'The file size is invalid.');
	}
	if (sizeBytes > maxBytes) {
		throw new DocumentError(413, 'evidence_too_large', `${kind === 'pdf' ? 'PDFs' : 'CSVs'} must be ${Math.floor(maxBytes / (1024 * 1024))} MB or smaller.`);
	}
	if (!SHA256_RE.test(checksumSha256)) {
		throw new DocumentError(400, 'invalid_checksum', 'The file checksum is invalid.');
	}
	return { filename, mimeType, sizeBytes, checksumSha256, kind, storedMimeType } satisfies ValidatedEvidenceUpload & EvidenceUploadInput;
}

export function validateFindingPatch(value: unknown): { status: 'saved' | 'reviewed' | 'dismissed' | 'proposed'; reviewNote: string; dismissalReason: string } {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new DocumentError(400, 'invalid_finding_patch', 'Expected an object.');
	}
	const input = value as Record<string, unknown>;
	const status = input.status;
	if (status !== 'saved' && status !== 'reviewed' && status !== 'dismissed' && status !== 'proposed') {
		throw new DocumentError(400, 'invalid_finding_status', 'Status must be saved, reviewed, dismissed or proposed.');
	}
	const reviewNote = singleText(input.reviewNote, 1000, 'invalid_review_note', 'Review note');
	const dismissalReason = singleText(input.dismissalReason, 300, 'invalid_dismissal_reason', 'Dismissal reason');
	if (status === 'dismissed' && !dismissalReason) {
		throw new DocumentError(400, 'dismissal_reason_required', 'Say why this lead is being dismissed.');
	}
	return { status, reviewNote, dismissalReason };
}

function singleText(value: unknown, max: number, code: string, label: string): string {
	if (value === undefined || value === null) return '';
	if (typeof value !== 'string') throw new DocumentError(400, code, `${label} must be text.`);
	const text = value.replace(/\s+/g, ' ').trim();
	if (text.length > max) throw new DocumentError(400, code, `${label} must be ${max} characters or fewer.`);
	return text;
}
