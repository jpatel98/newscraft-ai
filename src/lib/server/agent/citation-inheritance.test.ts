import { describe, expect, it } from 'vitest';
import type { CitationRecord } from '@newscraft/shared';
import { selectCitationInheritanceToolCalls, threadCitations } from './citation-inheritance';

describe('citation inheritance', () => {
	it('resumes with the partial answer source instead of an older citation with the same number', () => {
		const messages = [
			{ id: 'completed-y', toolCalls: '{"citations":[{"citationNumber":1,"url":"source-y"}]}' },
			{ id: 'partial-x', toolCalls: '{"citations":[{"citationNumber":1,"url":"source-x"}]}' }
		];

		const selected = selectCitationInheritanceToolCalls({ messages, resumeMessageId: 'partial-x' });
		expect(selected).toContain('source-x');
		expect(selected).not.toContain('source-y');
	});

	it('does not select raw prior metadata for a normal turn', () => {
		const messages = [{ id: 'completed-y', toolCalls: '{"citations":[{"citationNumber":1}]}' }];

		expect(selectCitationInheritanceToolCalls({ messages })).toBeNull();
	});
});

describe('thread citations', () => {
	const record = (citationNumber: number, url: string): CitationRecord => ({
		citationNumber,
		title: url,
		url: `https://example.com/${url}`,
		domain: 'example.com',
		publicationDate: '2026-10-12',
		sourceType: 'news_report',
		supportingExcerpt: `excerpt for ${url}`
	});
	const envelope = (...citations: CitationRecord[]) =>
		JSON.stringify({ version: 1, tools: [], sources: [], citations });

	it('keeps every earlier source on its number, not just the last answer', () => {
		const messages = [
			{ role: 'user', toolCalls: null },
			{ role: 'assistant', partial: 0, toolCalls: envelope(record(1, 'cbc'), record(2, 'toronto-ca')) },
			{ role: 'user', toolCalls: null },
			{ role: 'assistant', partial: 0, toolCalls: envelope(record(3, 'ontario-news')) }
		];

		expect(threadCitations(messages).map((c) => [c.citationNumber, c.url])).toEqual([
			[1, 'https://example.com/cbc'],
			[2, 'https://example.com/toronto-ca'],
			[3, 'https://example.com/ontario-news']
		]);
	});

	it('prefers the given records, then newer answers, and skips partial answers', () => {
		const messages = [
			{ role: 'assistant', partial: 0, toolCalls: envelope(record(1, 'old'), record(2, 'two')) },
			{ role: 'assistant', partial: 0, toolCalls: envelope(record(1, 'newer')) },
			{ role: 'assistant', partial: 1, toolCalls: envelope(record(4, 'cut-off')) }
		];

		expect(threadCitations(messages).find((c) => c.citationNumber === 1)?.url).toBe(
			'https://example.com/newer'
		);
		expect(threadCitations(messages, [record(2, 'chosen')]).find((c) => c.citationNumber === 2)?.url).toBe(
			'https://example.com/chosen'
		);
		expect(threadCitations(messages).some((c) => c.citationNumber === 4)).toBe(false);
	});
});
