import { describe, expect, it } from 'vitest';
import {
	ANSWER_USE_ACTIONS,
	MAX_PDF_BYTES,
	answerExportUrl,
	citationResolution,
	citationSourceTypeLabel,
	pdfSelectionError,
	publicationDateLabel,
	resolvedCitationRecords,
	visibleCitationNumbers
} from './journalist-ui';

const citation = {
	citationNumber: 1,
	title: 'FIFA match schedule',
	url: 'https://inside.fifa.com/match-centre',
	domain: 'inside.fifa.com',
	publicationDate: '2026-07-10',
	sourceType: 'official' as const,
	supportingExcerpt: 'The match begins at 19:00 local time.'
};

describe('journalist citation UI helpers', () => {
	it('resolves only markers with exactly one matching record', () => {
		const duplicate = [citation, { ...citation, url: 'https://fifa.com' }];
		expect(citationResolution('Confirmed [1].', [citation]).allResolved).toBe(true);
		expect(citationResolution('Conflict [1].', duplicate)).toMatchObject({
			allResolved: false,
			dangling: [1]
		});
		expect(citationResolution('Missing [2].', [citation])).toMatchObject({
			allResolved: false,
			dangling: [2]
		});
		expect(
			citationResolution('Incomplete [1].', [{ ...citation, supportingExcerpt: '' }])
		).toMatchObject({ allResolved: false, dangling: [1] });
		expect(
			citationResolution('Unknown [1].', [{ ...citation, domain: 'Unknown source' }])
		).toMatchObject({ allResolved: false, dangling: [1] });
	});

	it('returns only complete, uniquely matched citations that appear in the answer', () => {
		const unused = { ...citation, citationNumber: 2, title: 'Unused source' };
		const incomplete = { ...citation, citationNumber: 3, supportingExcerpt: '' };
		expect(
			resolvedCitationRecords('Confirmed [1]. Missing details [3].', [unused, incomplete, citation])
		).toEqual([citation]);
	});

	it('ignores numeric text inside links, inline code, fenced code, and escaped markers', () => {
		const markdown = [
			'Visible [1].',
			'[2](https://example.com)',
			'`[3]`',
			'\\[4\\]',
			'```text',
			'[5]',
			'```',
			'Also visible [6][7].'
		].join('\n');
		expect(visibleCitationNumbers(markdown)).toEqual([1, 6, 7]);
	});

	it('formats source metadata without replacing unknown dates', () => {
		expect(citationSourceTypeLabel('user_document')).toBe('User document');
		expect(publicationDateLabel(null)).toBe('Date unknown');
		expect(publicationDateLabel('not-a-date')).toBe('not-a-date');
	});

	it('exposes the four newsroom output actions and the authenticated export URL', () => {
		expect(ANSWER_USE_ACTIONS.map((action) => action.action)).toEqual([
			'producer_brief',
			'thirty_second_script',
			'interview_questions',
			'copy_with_citations'
		]);
		expect(answerExportUrl('conversation 1', 'message/1')).toBe(
			'/api/conversations/conversation%201/messages/message%2F1/export'
		);
		expect(answerExportUrl('conversation-1', 'tmp-answer')).toBeNull();
	});
});

describe('PDF selection constraints', () => {
	const pdf = (overrides: Partial<{ name: string; type: string; size: number }> = {}) => ({
		name: 'notes.pdf',
		type: 'application/pdf',
		size: 1024,
		...overrides
	});

	it('enforces PDF type, 20 MB size, and three-document limit', () => {
		expect(pdfSelectionError([pdf()], 2)).toBeNull();
		expect(pdfSelectionError([pdf(), pdf({ name: 'second.pdf' })], 2)).toBe(
			'You can attach up to 3 PDFs per message.'
		);
		expect(pdfSelectionError([pdf({ size: MAX_PDF_BYTES + 1 })], 0)).toBe(
			'Each PDF must be 20 MB or smaller.'
		);
		expect(pdfSelectionError([{ name: 'notes.txt', type: 'text/plain', size: 10 }], 0)).toBe(
			'Only PDF documents are allowed.'
		);
	});
});
