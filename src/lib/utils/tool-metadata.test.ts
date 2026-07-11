import { describe, expect, it } from 'vitest';
import {
	buildAnswerProvenanceBundle,
	allCitationMarkersResolve,
	citationRecordsForAnswer,
	mergeToolMetadata,
	parseToolMetadata,
	resolvedCitationNumbersForAnswer,
	serializeAnswerProvenance,
	serializeToolMetadata,
	sourceReceiptsForAnswer,
	sourceContextForFollowup,
	usedSources
} from './tool-metadata';

describe('tool metadata', () => {
	it('parses legacy tool-call arrays', () => {
		const metadata = parseToolMetadata('[{"id":"t1","name":"web_search","status":"ok"}]');
		expect(metadata.tools).toMatchObject([{ id: 't1', name: 'web_search', status: 'ok' }]);
		expect(metadata.sources).toEqual([]);
		expect(metadata.citations).toEqual([]);
	});

	it('parses v1 envelopes with persisted sources', () => {
		const raw = serializeToolMetadata(
			[{ id: 't1', name: 'browser_navigate', url: 'https://example.com/story' }],
			[
				{
					id: 'https://example.com/story',
					url: 'https://example.com/story',
					title: 'Story',
					domain: 'example.com',
					status: 'used',
					firstSeenAt: 1000,
					lastSeenAt: 1200,
					used: true
				}
			]
		);

		expect(parseToolMetadata(raw)).toMatchObject({
			tools: [{ id: 't1', name: 'browser_navigate' }],
			sources: [{ url: 'https://example.com/story', used: true }]
		});
	});

	it('sanitizes persisted source urls and infers used receipts from source status', () => {
		const raw = JSON.stringify({
			version: 1,
			tools: [],
			sources: [
				{
					id: 'source_123456',
					url: 'https://user:pass@example.com/story?token=secret&utm_source=test#section',
					title: 'Story',
					status: 'read',
					firstSeenAt: 1000,
					lastSeenAt: 1200
				}
			]
		});

		expect(parseToolMetadata(raw).sources).toMatchObject([
			{
				url: 'https://example.com/story',
				used: true
			}
		]);
	});

	it('returns empty metadata for malformed json', () => {
		expect(parseToolMetadata('{nope')).toEqual({ tools: [], sources: [], citations: [] });
	});

	it('persists ordered citation records and resolves visible markers', () => {
		const citations = Array.from({ length: 10 }, (_, index) => ({
			citationNumber: index + 1,
			title: `Source ${index + 1}`,
			url: `https://example.com/${index + 1}`,
			domain: 'example.com',
			publicationDate: index === 9 ? null : '2026-07-10',
			sourceType: index === 0 ? ('official' as const) : ('news_report' as const),
			supportingExcerpt: `Evidence ${index + 1}`
		}));
		const raw = serializeToolMetadata([], [], citations);

		expect(citationRecordsForAnswer(raw)).toHaveLength(10);
		expect(citationRecordsForAnswer(raw).map((citation) => citation.citationNumber)).toEqual([
			1, 2, 3, 4, 5, 6, 7, 8, 9, 10
		]);
		expect(allCitationMarkersResolve(raw, 'Confirmed [1], with another record [10].')).toBe(true);
		expect(allCitationMarkersResolve(raw, 'A dangling marker [11].')).toBe(false);
		expect(
			allCitationMarkersResolve(
				serializeToolMetadata([], [], [{ ...citations[0], supportingExcerpt: '' }]),
				'Incomplete evidence [1].'
			)
		).toBe(false);
		const conflicting = [citations[0], { ...citations[0], url: 'https://elsewhere.test/1' }];
		expect(allCitationMarkersResolve(serializeToolMetadata([], [], conflicting), 'Conflict [1].')).toBe(
			false
		);
		expect(mergeToolMetadata(null, [], [], conflicting).citations).toHaveLength(2);
		expect(resolvedCitationNumbersForAnswer('Repeated [1], then [1].', [citations[0]])).toEqual([
			1,
			1
		]);
		expect(
			resolvedCitationNumbersForAnswer('Not markers: [1](https://example.com), `[1]`, \\[1].', [
				citations[0]
			])
		).toEqual([]);
		expect(sourceContextForFollowup(raw)).toContain('[10] Source 10');
		expect(mergeToolMetadata(raw, [], [], []).citations).toHaveLength(10);
	});

	it('filters source strips to used sources', () => {
		expect(
			usedSources([
				{
					id: 'a',
					url: 'https://example.com/a',
					title: 'A',
					domain: 'example.com',
					status: 'queued',
					firstSeenAt: 1000,
					lastSeenAt: 1000,
					used: false
				},
				{
					id: 'b',
					url: 'https://example.com/b',
					title: 'B',
					domain: 'example.com',
					status: 'used',
					firstSeenAt: 900,
					lastSeenAt: 1200,
					used: true
				}
			])
			).toMatchObject([{ url: 'https://example.com/b' }]);
	});

	it('builds display source receipts without duplicating inline links', () => {
		const raw = serializeToolMetadata(
			[{ id: 'call_internal_123', name: 'openai_web_search', status: 'ok' }],
			[
				{
					id: 'already-linked',
					url: 'https://example.com/already-linked',
					title: 'Already linked',
					domain: 'example.com',
					status: 'used',
					firstSeenAt: 1000,
					lastSeenAt: 1100,
					used: true
				},
				{
					id: 'visible-source',
					url: 'https://news.example.com/story?token=secret&utm_source=test#fragment',
					title: 'Reuters Canada update',
					domain: 'news.example.com',
					status: 'used',
					firstSeenAt: 1200,
					lastSeenAt: 1300,
					used: true
				},
				{
					id: 'search-result',
					url: 'https://search.example.com/result',
					title: 'Search result only',
					domain: 'search.example.com',
					status: 'search_result',
					firstSeenAt: 900,
					lastSeenAt: 900,
					used: false
				}
			]
		);

		const receipts = sourceReceiptsForAnswer(
			raw,
			'The main citation is already inline [Already linked](https://example.com/already-linked).'
		);

		expect(receipts).toEqual([
			{
				url: 'https://news.example.com/story',
				label: 'Reuters Canada update',
				domain: 'news.example.com'
			}
		]);
	});

	it('falls back to domains for technical source labels and includes live sources', () => {
		const receipts = sourceReceiptsForAnswer(null, 'Live answer without inline source links.', [
			{
				id: 'src_internal_123456',
				url: 'https://example.com/live',
				title: 'openai_web_search',
				domain: 'example.com',
				status: 'used',
				firstSeenAt: 1000,
				lastSeenAt: 1100,
				used: true
			}
		]);

		expect(receipts).toEqual([
			{
				url: 'https://example.com/live',
				label: 'example.com',
				domain: 'example.com'
			}
		]);
	});

	it('builds fallback source receipts from inherited citations, including private document routes', () => {
		const raw = serializeToolMetadata(
			[],
			[],
			[
				{
					citationNumber: 1,
					title: 'Council minutes',
					url: 'https://city.example/minutes',
					domain: 'city.example',
					publicationDate: '2026-07-10',
					sourceType: 'official',
					supportingExcerpt: 'Council approved the motion.'
				},
				{
					citationNumber: 2,
					title: 'budget.pdf, page 7',
					url: '/api/conversations/c-1/documents/d-1/download#page=7',
					domain: 'Attached document',
					publicationDate: null,
					sourceType: 'user_document',
					supportingExcerpt: 'The budget is $2 million.',
					documentPage: 7
				}
			]
		);

		expect(sourceReceiptsForAnswer(raw, 'A transformed answer without markers.')).toEqual([
			{
				url: 'https://city.example/minutes',
				label: 'Council minutes',
				domain: 'city.example'
			},
			{
				url: '/api/conversations/c-1/documents/d-1/download#page=7',
				label: 'budget.pdf, page 7',
				domain: 'Attached document'
			}
		]);
	});

	it('builds compact source context for follow-up questions', () => {
		const raw = serializeToolMetadata(
			[],
			[
				{
					id: 'https://investing.test/carney',
					url: 'https://investing.test/carney',
					title: 'Carney says some Canadian economic data will be uneven',
					domain: 'investing.test',
					status: 'used',
					detail: 'Reuters reported Carney was pressed on technical recession questions.',
					firstSeenAt: 1000,
					lastSeenAt: 1200,
					used: true
				},
				{
					id: 'https://example.com/skipped',
					url: 'https://example.com/skipped',
					title: 'Skipped',
					domain: 'example.com',
					status: 'skipped',
					firstSeenAt: 900,
					lastSeenAt: 900,
					used: false
				}
			]
		);

		const context = sourceContextForFollowup(raw);

		expect(context).toContain('NewsCraft source context');
		expect(context).toContain('Carney says some Canadian economic data will be uneven');
		expect(context).toContain('investing.test');
		expect(context).not.toContain('Skipped');
	});

	it('serializes provenance with deduped tools and sources', () => {
		const bundle = buildAnswerProvenanceBundle({
			messageId: 'msg_1',
			conversationId: 'convo_1',
			startedAt: 1000,
			endedAt: 1500,
			assistantChars: 42,
			done: true,
			events: { message: 3, 'agent.source': 2 },
			transport: 'chat_completions',
			reasoningEffort: 'medium',
			model: 'gpt-test',
			tools: [
				{ id: 'search-1', name: 'web_search', status: 'running', startedAt: 1010 },
				{ id: 'search-1', name: 'web_search', status: 'ok', endedAt: 1200, result: { count: 2 } }
			],
			answerText: 'The result is confirmed [1], but this marker is unresolved [2].',
			citations: [
				{
					citationNumber: 1,
					title: 'Official result',
					url: 'https://example.gov/result',
					domain: 'example.gov',
					publicationDate: null,
					sourceType: 'official',
					supportingExcerpt: 'The official result.'
				}
			],
			sources: [
				{
					id: 'result-1',
					url: 'https://example.com/story',
					title: 'Story',
					domain: 'example.com',
					status: 'queued',
					firstSeenAt: 1010,
					lastSeenAt: 1010,
					used: false
				},
				{
					id: 'result-1',
					url: 'https://example.com/story',
					title: 'Story',
					domain: 'example.com',
					status: 'read',
					firstSeenAt: 1010,
					lastSeenAt: 1300,
					used: true
				}
			]
		});

		expect(bundle.tools).toMatchObject([{ id: 'search-1', name: 'web_search', status: 'ok' }]);
		expect(bundle.tools).toHaveLength(1);
		expect(bundle.sources).toMatchObject([
			{
				url: 'https://example.com/story',
				firstSeenAt: 1010,
				lastSeenAt: 1300,
				used: true
			}
		]);
		expect(bundle.metadata).toMatchObject({
			transport: 'chat_completions',
			reasoningEffort: 'medium',
			model: 'gpt-test',
			toolCount: 1,
			sourceCount: 1,
			usedSourceCount: 1,
			citationCount: 2,
			resolvedCitationCount: 1,
			danglingCitationCount: 1,
			primarySourceCount: 1,
			unknownDateCount: 1
		});
		expect(bundle.stream).toMatchObject({
			elapsedMs: 500,
			finishStatus: 'completed',
			events: { message: 3, 'agent.source': 2 }
		});
	});

	it('counts incomplete and conflicting citation evidence as dangling provenance', () => {
		const base = {
			citationNumber: 1,
			title: 'Official result',
			url: 'https://example.gov/result',
			domain: 'example.gov',
			publicationDate: '2026-07-10',
			sourceType: 'official' as const,
			supportingExcerpt: 'The official result.'
		};
		const build = (citations: typeof base[]) =>
			buildAnswerProvenanceBundle({
				messageId: 'msg_1',
				conversationId: 'convo_1',
				tools: [],
				sources: [],
				citations,
				answerText: 'Claim [1].',
				startedAt: 1000,
				endedAt: 1100,
				assistantChars: 10,
				done: true
			});

		expect(build([{ ...base, supportingExcerpt: '' }]).metadata).toMatchObject({
			resolvedCitationCount: 0,
			danglingCitationCount: 1
		});
		expect(build([base, { ...base, url: 'https://example.org/result' }]).metadata).toMatchObject({
			resolvedCitationCount: 0,
			danglingCitationCount: 1
		});
	});

	it('redacts sensitive tool payloads without removing source urls', () => {
		const raw = serializeAnswerProvenance({
			messageId: 'msg_1',
			conversationId: 'convo_1',
			startedAt: 1000,
			endedAt: 1100,
			assistantChars: 12,
			done: true,
			tools: [
				{
					id: 'tool-1',
					name: 'fetch',
					arguments: {
						url: 'https://example.com/story',
						apiKey: 'sk-testsecret123',
						headers: { authorization: 'Bearer abc123' }
					},
					result: 'connected to postgresql://user:pass@example.com/db'
				}
			],
			sources: [
				{
					id: 'https://example.com/story',
					url: 'https://example.com/story',
					title: 'Story',
					domain: 'example.com',
					status: 'used',
					firstSeenAt: 1000,
					lastSeenAt: 1100,
					used: true
				}
			]
		});

		expect(raw).toContain('https://example.com/story');
		expect(raw).toContain('[redacted]');
		expect(raw).toContain('[redacted-database-url]');
		expect(raw).not.toContain('sk-testsecret123');
		expect(raw).not.toContain('Bearer abc123');
		expect(raw).not.toContain('user:pass');
	});
});
