import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NEWSCRAFT_USER_AGENT, politeFetch, resetPoliteFetchStateForTests } from '../src/tools/polite-fetch.js';

describe('politeFetch', () => {
	afterEach(() => {
		resetPoliteFetchStateForTests();
		vi.restoreAllMocks();
	});

	it('adds polite request headers and returns cache metadata without failing on archive errors', async () => {
		const archiveSnapshot = vi.fn(async () => {
			throw new Error('archive unavailable');
		});
		const fetchMock = vi.fn(async () => {
			return new Response('hello newsroom', {
				status: 200,
				headers: {
					'content-type': 'text/plain',
					etag: '"next"',
					'last-modified': 'Sun, 24 May 2026 12:00:00 GMT',
					'cache-control': 'max-age=60'
				}
			});
		});

		const result = await politeFetch('https://example.test/story', {
			fetchImpl: fetchMock as typeof fetch,
			etag: '"previous"',
			lastModified: 'Sat, 23 May 2026 12:00:00 GMT',
			rateLimit: { minDelayMs: 0 },
			archive: { snapshot: archiveSnapshot }
		});

		const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
		expect(headers.get('user-agent')).toBe(NEWSCRAFT_USER_AGENT);
		expect(headers.get('if-none-match')).toBe('"previous"');
		expect(headers.get('if-modified-since')).toBe('Sat, 23 May 2026 12:00:00 GMT');
		expect(result.cache).toMatchObject({
			contentHash: createHash('sha256').update('hello newsroom').digest('hex'),
			etag: '"next"',
			lastModified: 'Sun, 24 May 2026 12:00:00 GMT',
			cacheControl: 'max-age=60'
		});
		expect(result.archiveSnapshot).toMatchObject({
			attempted: true,
			ok: false,
			error: 'archive unavailable'
		});
		expect(archiveSnapshot).toHaveBeenCalledTimes(1);
	});

	it('applies per-host delay and reports response backoff hints', async () => {
		let now = 1_000;
		const sleep = vi.fn(async (ms: number) => {
			now += ms;
		});
		const onBackoff = vi.fn();
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(new Response('first', { status: 200 }))
			.mockResolvedValueOnce(new Response('busy', { status: 429, headers: { 'retry-after': '2' } }));

		const options = {
			fetchImpl: fetchMock as typeof fetch,
			rateLimit: {
				minDelayMs: 100,
				now: () => now,
				sleep,
				onBackoff
			}
		};

		await politeFetch('https://example.test/one', options);
		await politeFetch('https://example.test/two', options);

		expect(sleep).toHaveBeenCalledWith(100, undefined);
		expect(onBackoff).toHaveBeenCalledWith(
			expect.objectContaining({
				host: 'example.test',
				statusCode: 429,
				backoffMs: 2000,
				retryAfter: '2'
			})
		);
	});
});
