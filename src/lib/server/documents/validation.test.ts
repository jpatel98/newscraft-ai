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

	describe('show memory fields', () => {
		const base = { timezone: 'America/Toronto' };

		it('omits show-memory fields the caller did not send so older clients cannot erase them', () => {
			const profile = normalizeNewsroomProfile(base);
			for (const key of ['showName', 'airTimeLocal', 'audience', 'beats', 'styleNotes', 'recentlyCovered']) {
				expect(profile).not.toHaveProperty(key);
			}
		});

		it('trims, collapses whitespace and dedupes list fields', () => {
			const profile = normalizeNewsroomProfile(
				{
					...base,
					showName: '  CityNews   at Six ',
					airTimeLocal: ' 18:00 ',
					audience: ' GTA  general ',
					beats: [' Transit ', 'transit', 'Police and courts', '  '],
					styleNotes: '  No "alleged" twice.\r\nNumbers as words.  ',
					recentlyCovered: ['Subway strike', ' subway STRIKE ', { subject: 'Water main', coveredAt: 5 }, '']
				},
				1000
			);
			expect(profile).toMatchObject({
				showName: 'CityNews at Six',
				airTimeLocal: '18:00',
				audience: 'GTA general',
				beats: ['Transit', 'Police and courts'],
				styleNotes: 'No "alleged" twice.\nNumbers as words.',
				recentlyCovered: [
					{ subject: 'Subway strike', coveredAt: 1000 },
					{ subject: 'Water main', coveredAt: 5 }
				]
			});
		});

		it('keeps the recorded covered date for a subject that was already saved', () => {
			const profile = normalizeNewsroomProfile(
				{ ...base, recentlyCovered: ['Subway Strike', 'New story'] },
				9000,
				new Map([['subway strike', 42]])
			);
			expect(profile.recentlyCovered).toEqual([
				{ subject: 'Subway Strike', coveredAt: 42 },
				{ subject: 'New story', coveredAt: 9000 }
			]);
		});

		it('accepts a blank air time and rejects malformed ones', () => {
			expect(normalizeNewsroomProfile({ ...base, airTimeLocal: '' }).airTimeLocal).toBe('');
			expect(normalizeNewsroomProfile({ ...base, airTimeLocal: '00:00' }).airTimeLocal).toBe('00:00');
			for (const bad of ['6pm', '24:00', '18:60', '9:00', '18:00:00', 1800, null]) {
				expect(() => normalizeNewsroomProfile({ ...base, airTimeLocal: bad })).toThrowError(
					expect.objectContaining({ status: 400, code: 'invalid_air_time' })
				);
			}
		});

		it('rejects oversize and mistyped input', () => {
			const rejects = (input: Record<string, unknown>, code: string) =>
				expect(() => normalizeNewsroomProfile({ ...base, ...input })).toThrowError(
					expect.objectContaining({ status: 400, code })
				);
			rejects({ showName: 'x'.repeat(121) }, 'invalid_show_name');
			rejects({ showName: 5 }, 'invalid_show_name');
			rejects({ audience: 'x'.repeat(161) }, 'invalid_audience');
			rejects({ styleNotes: 'x'.repeat(1201) }, 'invalid_style_notes');
			rejects({ styleNotes: ['no'] }, 'invalid_style_notes');
			rejects({ beats: 'transit, courts' }, 'invalid_beats');
			rejects({ beats: ['x'.repeat(61)] }, 'invalid_beats');
			rejects({ beats: Array.from({ length: 13 }, (_, i) => `beat ${i}`) }, 'invalid_beats');
			rejects({ beats: [{ name: 'transit' }] }, 'invalid_beats');
			rejects({ recentlyCovered: 'Subway strike' }, 'invalid_recently_covered');
			rejects({ recentlyCovered: ['x'.repeat(161)] }, 'invalid_recently_covered');
			rejects({ recentlyCovered: [{ subject: 'ok', coveredAt: -1 }] }, 'invalid_recently_covered');
			rejects({ recentlyCovered: [{ subject: 'ok', coveredAt: 'yesterday' }] }, 'invalid_recently_covered');
			rejects(
				{ recentlyCovered: Array.from({ length: 31 }, (_, i) => `story ${i}`) },
				'invalid_recently_covered'
			);
		});

		it('allows the maximum list sizes', () => {
			const profile = normalizeNewsroomProfile({
				...base,
				beats: Array.from({ length: 12 }, (_, i) => `beat ${i}`),
				recentlyCovered: Array.from({ length: 30 }, (_, i) => `story ${i}`),
				styleNotes: 'x'.repeat(1200)
			});
			expect(profile.beats).toHaveLength(12);
			expect(profile.recentlyCovered).toHaveLength(30);
		});
	});
});
