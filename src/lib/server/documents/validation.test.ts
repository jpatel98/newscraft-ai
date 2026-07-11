import { describe, expect, it } from 'vitest';
import { MAX_PDF_BYTES } from './constants';
import { DocumentError } from './errors';
import { normalizeNewsroomProfile, safeStorageFilename, validatePdfUploads } from './validation';

const validPdf = {
	filename: 'Council agenda.pdf',
	mimeType: 'application/pdf',
	sizeBytes: 1200,
	checksumSha256: 'a'.repeat(64)
};

describe('document validation', () => {
	it('normalizes a valid PDF upload', () => {
		expect(validatePdfUploads([validPdf])).toEqual([validPdf]);
	});

	it('limits each upload request to three PDFs', () => {
		expect(() => validatePdfUploads([validPdf, validPdf, validPdf, validPdf])).toThrowError(
			expect.objectContaining({ status: 400, code: 'too_many_documents' })
		);
	});

	it('rejects non-PDF and oversized files with safe errors', () => {
		expect(() =>
			validatePdfUploads([{ ...validPdf, filename: 'notes.txt', mimeType: 'text/plain' }])
		).toThrowError(expect.objectContaining({ status: 415, code: 'pdf_only' }));
		expect(() =>
			validatePdfUploads([{ ...validPdf, sizeBytes: MAX_PDF_BYTES + 1 }])
		).toThrowError(expect.objectContaining({ status: 413, code: 'pdf_too_large' }));
	});

	it('creates path-safe storage filenames', () => {
		expect(safeStorageFilename('../../City Budget (final).pdf')).toBe('City-Budget-final.pdf');
	});

	it('validates IANA timezone and preferred domains', () => {
		expect(
			normalizeNewsroomProfile({
				timezone: 'America/Toronto',
				homeMarket: 'Toronto',
				preferredDomains: ['WWW.CBC.CA', 'cbc.ca', 'toronto.ca']
			})
		).toEqual({
			timezone: 'America/Toronto',
			homeMarket: 'Toronto',
			preferredDomains: ['cbc.ca', 'toronto.ca']
		});
		expect(() => normalizeNewsroomProfile({ timezone: 'Toronto-ish' })).toThrow(DocumentError);
	});
});
