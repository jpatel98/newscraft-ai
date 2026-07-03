import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	NEWSCRAFT_USER_AGENT,
	createFilePoliteFetchCache,
	politeFetch,
	resetPoliteFetchStateForTests
} from '../src/tools/polite-fetch.js';

describe('politeFetch', () => {
	const tempDirs: string[] = [];

	afterEach(async () => {
		resetPoliteFetchStateForTests();
		vi.restoreAllMocks();
		await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
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
			rateLimit: { hostDelayMs: 0 },
			robots: { respect: false },
			ssrf: { resolveHost: async () => ['93.184.216.34'] },
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

	it('respects robots.txt by default and supports explicit override', async () => {
		let articleFetches = 0;
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const requestUrl = String(input);
			if (requestUrl.endsWith('/robots.txt')) {
				return new Response('User-agent: *\nDisallow: /blocked\n', { status: 200 });
			}

			articleFetches += 1;
			return new Response('blocked story', { status: 200 });
		});

		const blocked = await politeFetch('https://example.test/blocked/story', {
			fetchImpl: fetchMock as typeof fetch,
			rateLimit: { hostDelayMs: 0 },
			ssrf: { resolveHost: async () => ['93.184.216.34'] }
		});
		expect(blocked.statusCode).toBe(451);
		expect(blocked.ok).toBe(false);
		expect(blocked.robots).toMatchObject({
			checked: true,
			allowed: false,
			matchedRule: 'disallow: /blocked'
		});
		expect(articleFetches).toBe(0);

		const override = await politeFetch('https://example.test/blocked/story', {
			fetchImpl: fetchMock as typeof fetch,
			rateLimit: { hostDelayMs: 0 },
			robots: { override: true },
			ssrf: { resolveHost: async () => ['93.184.216.34'] }
		});
		expect(override.statusCode).toBe(200);
		expect(override.robots).toMatchObject({ checked: true, allowed: true, override: true });
		expect(articleFetches).toBe(1);
	});

	it('persists a content-addressed cache and revalidates with stored validators', async () => {
		const cacheDir = await mkdtemp(path.join(tmpdir(), 'polite-fetch-cache-'));
		tempDirs.push(cacheDir);
		const cache = createFilePoliteFetchCache(cacheDir);
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				new Response('cached newsroom body', {
					status: 200,
					headers: {
						'content-type': 'text/plain',
						etag: '"cache-v1"',
						'last-modified': 'Sun, 24 May 2026 12:00:00 GMT'
					}
				})
			)
			.mockResolvedValueOnce(new Response(null, { status: 304 }));

		const first = await politeFetch('https://example.test/cache-me', {
			fetchImpl: fetchMock as typeof fetch,
			rateLimit: { hostDelayMs: 0 },
			robots: { respect: false },
			ssrf: { resolveHost: async () => ['93.184.216.34'] },
			cache: { store: cache }
		});
		const second = await politeFetch('https://example.test/cache-me', {
			fetchImpl: fetchMock as typeof fetch,
			rateLimit: { hostDelayMs: 0 },
			robots: { respect: false },
			ssrf: { resolveHost: async () => ['93.184.216.34'] },
			cache: { store: cache }
		});
		const secondHeaders = new Headers(fetchMock.mock.calls[1]?.[1]?.headers);

		expect(first.cacheStatus).toBe('stored');
		expect(second.cacheStatus).toBe('revalidated');
		expect(second.body).toBe('cached newsroom body');
		expect(second.statusCode).toBe(200);
		expect(secondHeaders.get('if-none-match')).toBe('"cache-v1"');
		expect(secondHeaders.get('if-modified-since')).toBe('Sun, 24 May 2026 12:00:00 GMT');
	});

	it('can request a web.archive.org snapshot for fetched documents', async () => {
		const fetchMock = vi.fn(async () => new Response('archive me', { status: 200 }));
		const archiveFetch = vi.fn(async () => {
			return new Response('', {
				status: 200,
				headers: { location: '/web/20260524120000/https://example.test/story' }
			});
		});

		const result = await politeFetch('https://example.test/story', {
			fetchImpl: fetchMock as typeof fetch,
			rateLimit: { hostDelayMs: 0 },
			robots: { respect: false },
			ssrf: { resolveHost: async () => ['93.184.216.34'] },
			archive: { webArchive: true, fetchImpl: archiveFetch as typeof fetch }
		});

		expect(archiveFetch).toHaveBeenCalledTimes(1);
		expect(String(archiveFetch.mock.calls[0]?.[0])).toContain('https://web.archive.org/save/');
		expect(result.archiveSnapshot).toMatchObject({
			attempted: true,
			ok: true,
			snapshotUrl: 'https://web.archive.org/web/20260524120000/https://example.test/story'
		});
	});

	it('applies per-host delay and response backoff hints', async () => {
		let now = 1_000;
		const wait = vi.fn(async (ms: number) => {
			now += ms;
		});
		vi.spyOn(Date, 'now').mockImplementation(() => now);
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(new Response('first', { status: 200 }))
			.mockResolvedValueOnce(new Response('busy', { status: 429, headers: { 'retry-after': '2' } }))
			.mockResolvedValueOnce(new Response('third', { status: 200 }));

		const options = {
			fetchImpl: fetchMock as typeof fetch,
			rateLimit: {
				hostDelayMs: 100,
				wait
			},
			robots: { respect: false },
			ssrf: { resolveHost: async () => ['93.184.216.34'] }
		};

		await politeFetch('https://example.test/one', options);
		await politeFetch('https://example.test/two', options);
		await politeFetch('https://example.test/three', options);

		expect(wait).toHaveBeenNthCalledWith(1, 100);
		expect(wait).toHaveBeenNthCalledWith(2, 2000);
	});

	it('checks resolved host addresses even when a fetch implementation is supplied', async () => {
		const fetchMock = vi.fn(async () => new Response('should not fetch'));

		await expect(
			politeFetch('https://metadata.example/story', {
				fetchImpl: fetchMock as typeof fetch,
				robots: { respect: false },
				ssrf: { resolveHost: async () => ['169.254.169.254'] }
			})
		).rejects.toThrow(/Blocked private fetch target/);

		expect(fetchMock).not.toHaveBeenCalled();
	});
});
