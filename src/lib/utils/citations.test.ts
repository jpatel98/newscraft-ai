import { describe, expect, it } from 'vitest';
import {
	archiveFallbackUrl,
	draftReviewPayloadFromValue,
	segmentDraftWithCitations,
	type CitationRecord
} from './citations';

const citations: CitationRecord[] = [
	{
		marker: 1,
		factId: 'fact-1',
		claim: 'Council approved the shuttle plan.',
		sourceTitle: 'Council agenda',
		sourceName: 'City Clerk',
		sourceUrl: 'https://city.example/agenda',
		archiveUrl: 'https://web.archive.org/web/20260529010000/https://city.example/agenda',
		contentHash: 'hash-1'
	},
	{
		marker: 2,
		factId: 'fact-2',
		claim: 'Buses run every fifteen minutes.',
		sourceTitle: 'Transit memo',
		sourceName: 'Transit agency',
		sourceUrl: 'https://transit.example/memo',
		archiveUrl: 'https://web.archive.org/web/*/https://transit.example/memo'
	}
];

describe('citation utilities', () => {
	it('segments only markers backed by citation records', () => {
		expect(segmentDraftWithCitations('Lead sentence [1]. Unsupported marker [9]. Follow-up [2].', citations)).toEqual([
			{ kind: 'text', text: 'Lead sentence ' },
			{ kind: 'citation', marker: 1, label: '[1]', citation: citations[0] },
			{ kind: 'text', text: '. Unsupported marker [9]. Follow-up ' },
			{ kind: 'citation', marker: 2, label: '[2]', citation: citations[1] },
			{ kind: 'text', text: '.' }
		]);
	});

	it('uses a real snapshot when available and otherwise points to Wayback history', () => {
		expect(archiveFallbackUrl('https://example.com/source', 'https://web.archive.org/web/1/https://example.com/source')).toBe(
			'https://web.archive.org/web/1/https://example.com/source'
		);
		expect(archiveFallbackUrl('https://example.com/source')).toBe('https://web.archive.org/web/*/https://example.com/source');
	});

	it('normalizes draft review payload citations from harness snake-case records', () => {
		expect(
			draftReviewPayloadFromValue({
				draft_markdown: 'Story body [3]',
				headline: 'Story body',
				word_count: 301,
				target_word_count: 300,
				citations: [
					{
						marker: 3,
						fact_id: 'fact-3',
						claim: 'The source-backed claim.',
						source_title: 'Council agenda',
						source_name: 'City Clerk',
						source_url: 'https://city.example/agenda',
						archive_snapshot_url: 'https://web.archive.org/web/20260529010000/https://city.example/agenda',
						content_hash: 'hash-3',
						event_id: 'evt-3'
					}
				]
			})
		).toEqual({
			markdown: 'Story body [3]',
			headline: 'Story body',
			wordCount: 301,
			targetWordCount: 300,
			citations: [
				{
					marker: 3,
					factId: 'fact-3',
					claim: 'The source-backed claim.',
					sourceTitle: 'Council agenda',
					sourceName: 'City Clerk',
					sourceUrl: 'https://city.example/agenda',
					archiveUrl: 'https://web.archive.org/web/20260529010000/https://city.example/agenda',
					contentHash: 'hash-3',
					eventId: 'evt-3'
				}
			]
		});
	});

	it('drops draft review citations with non-http original source URLs', () => {
		expect(
			draftReviewPayloadFromValue({
				draft_markdown: 'Story body [1] [2]',
				citations: [
					{
						marker: 1,
						fact_id: 'unsafe',
						claim: 'Unsafe claim.',
						source_title: 'Bad source',
						source_url: 'javascript:alert(1)'
					},
					{
						marker: 2,
						fact_id: 'safe',
						claim: 'Safe claim.',
						source_title: 'Good source',
						source_url: 'https://safe.example/source',
						archive_snapshot_url: 'javascript:alert(2)'
					}
				]
			})?.citations
		).toEqual([
			{
				marker: 2,
				factId: 'safe',
				claim: 'Safe claim.',
				sourceTitle: 'Good source',
				sourceName: 'Good source',
				sourceUrl: 'https://safe.example/source',
				archiveUrl: 'https://web.archive.org/web/*/https://safe.example/source',
				contentHash: null,
				eventId: null
			}
		]);
	});
});
