import { describe, expect, it } from 'vitest';
import { parseToolMetadata, serializeToolMetadata, usedSources } from './tool-metadata';

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
});
