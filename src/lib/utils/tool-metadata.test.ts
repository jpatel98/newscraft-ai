import { describe, expect, it } from 'vitest';
import {
	buildAnswerProvenanceBundle,
	parseToolMetadata,
	serializeAnswerProvenance,
	serializeToolMetadata,
	sourceContextForFollowup,
	usedSources
} from './tool-metadata';

describe('tool metadata', () => {
	it('parses legacy tool-call arrays', () => {
		const metadata = parseToolMetadata('[{"id":"t1","name":"web_search","status":"ok"}]');
		expect(metadata.tools).toMatchObject([{ id: 't1', name: 'web_search', status: 'ok' }]);
		expect(metadata.sources).toEqual([]);
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

	it('returns empty metadata for malformed json', () => {
		expect(parseToolMetadata('{nope')).toEqual({ tools: [], sources: [] });
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
			usedSourceCount: 1
		});
		expect(bundle.stream).toMatchObject({
			elapsedMs: 500,
			finishStatus: 'completed',
			events: { message: 3, 'agent.source': 2 }
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
