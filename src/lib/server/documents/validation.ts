import {
	MAX_DOCUMENTS_PER_UPLOAD,
	MAX_PDF_BYTES,
	PDF_MIME_TYPE
} from './constants';
import { DocumentError } from './errors';
import type { PdfUploadInput } from './types';

const SHA256_RE = /^[a-f0-9]{64}$/;
const DOMAIN_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

export function validatePdfUploads(value: unknown): PdfUploadInput[] {
	if (!Array.isArray(value) || value.length < 1) {
		throw new DocumentError(400, 'documents_required', 'Select at least one PDF.');
	}
	if (value.length > MAX_DOCUMENTS_PER_UPLOAD) {
		throw new DocumentError(
			400,
			'too_many_documents',
			`Attach no more than ${MAX_DOCUMENTS_PER_UPLOAD} PDFs at a time.`
		);
	}
	return value.map(validatePdfUpload);
}

export function validatePdfUpload(value: unknown): PdfUploadInput {
	if (!value || typeof value !== 'object') {
		throw new DocumentError(400, 'invalid_document', 'The selected PDF is invalid.');
	}
	const input = value as Record<string, unknown>;
	const filename = typeof input.filename === 'string' ? input.filename.trim() : '';
	const mimeType = typeof input.mimeType === 'string' ? input.mimeType.trim().toLowerCase() : '';
	const sizeBytes = typeof input.sizeBytes === 'number' ? input.sizeBytes : Number.NaN;
	const checksumSha256 =
		typeof input.checksumSha256 === 'string' ? input.checksumSha256.trim().toLowerCase() : '';

	if (!filename || filename.length > 255 || /[\u0000-\u001f\u007f]/.test(filename)) {
		throw new DocumentError(400, 'invalid_filename', 'The PDF filename is invalid.');
	}
	if (mimeType !== PDF_MIME_TYPE || !filename.toLowerCase().endsWith('.pdf')) {
		throw new DocumentError(415, 'pdf_only', 'Only PDF files are supported.');
	}
	if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 1) {
		throw new DocumentError(400, 'invalid_file_size', 'The PDF file size is invalid.');
	}
	if (sizeBytes > MAX_PDF_BYTES) {
		throw new DocumentError(413, 'pdf_too_large', 'PDFs must be 20 MB or smaller.');
	}
	if (!SHA256_RE.test(checksumSha256)) {
		throw new DocumentError(400, 'invalid_checksum', 'The PDF checksum is invalid.');
	}

	return { filename, mimeType: PDF_MIME_TYPE, sizeBytes, checksumSha256 };
}

export function safeStorageFilename(filename: string): string {
	const withoutExtension = filename.replace(/\.pdf$/i, '');
	const base = withoutExtension
		.normalize('NFKD')
		.replace(/[^a-zA-Z0-9._-]+/g, '-')
		.replace(/^[._-]+|[._-]+$/g, '')
		.slice(0, 120);
	return `${base || 'document'}.pdf`;
}

export function normalizeNewsroomProfile(input: {
	timezone: unknown;
	homeMarket?: unknown;
	preferredDomains?: unknown;
}): { timezone: string; homeMarket: string; preferredDomains: string[] } {
	const timezone = typeof input.timezone === 'string' ? input.timezone.trim() : '';
	if (!isIanaTimezone(timezone)) {
		throw new DocumentError(400, 'invalid_timezone', 'Choose a valid newsroom timezone.');
	}
	const homeMarket = typeof input.homeMarket === 'string' ? input.homeMarket.trim() : '';
	if (homeMarket.length > 120) {
		throw new DocumentError(400, 'invalid_home_market', 'Home market must be 120 characters or fewer.');
	}
	const rawDomains = input.preferredDomains ?? [];
	if (!Array.isArray(rawDomains) || rawDomains.length > 20) {
		throw new DocumentError(400, 'invalid_preferred_domains', 'Add no more than 20 preferred domains.');
	}
	const preferredDomains = Array.from(
		new Set(
			rawDomains.map((value) => {
				if (typeof value !== 'string') {
					throw new DocumentError(400, 'invalid_preferred_domains', 'A preferred domain is invalid.');
				}
				const domain = value.trim().toLowerCase().replace(/^www\./, '');
				if (!DOMAIN_RE.test(domain)) {
					throw new DocumentError(400, 'invalid_preferred_domains', 'A preferred domain is invalid.');
				}
				return domain;
			})
		)
	);
	return { timezone, homeMarket, preferredDomains };
}

function isIanaTimezone(value: string): boolean {
	if (!value) return false;
	try {
		new Intl.DateTimeFormat('en-US', { timeZone: value }).format();
		return true;
	} catch {
		return false;
	}
}
