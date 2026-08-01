import { afterEach, describe, expect, it, vi } from 'vitest';
import { deriveResearchRequestContract } from '@newscraft/shared';

const fetchSourceUrlMock = vi.fn();
const discoverSourceItemsMock = vi.fn();

vi.mock('../src/tools/sources.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../src/tools/sources.js')>();
	return {
		...actual,
		fetchSourceUrl: (...args: Parameters<typeof actual.fetchSourceUrl>) => fetchSourceUrlMock(...args),
		discoverSourceItems: (...args: Parameters<typeof actual.discoverSourceItems>) => discoverSourceItemsMock(...args)
	};
});

const { fetchEvidenceUrls, fetchSourceIndexEvidence, sourceFetchTimeoutMs } = await import('../src/agents/default-tools.js');

function stubSource(url: string) {
	return {
		url,
		title: `Title for ${url}`,
		fetchedAt: new Date().toISOString(),
		contentText:
			'City council approved the 2026 operating budget after a six-hour debate, with the mayor calling it a tough but necessary decision for residents across the region.',
		summary: 'Council approved the 2026 operating budget after extended debate.',
		snippet: 'Council approved the 2026 operating budget.',
		statusCode: 200,
		metadata: { publishedAt: '2026-06-01T12:00:00.000Z' }
	};
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

const context = { signal: undefined } as Parameters<typeof fetchEvidenceUrls>[2];

afterEach(() => {
	fetchSourceUrlMock.mockReset();
	discoverSourceItemsMock.mockReset();
	vi.unstubAllEnvs();
});

describe('fetchEvidenceUrls', () => {
	it('fetches different hosts concurrently (max of fetch times, not sum)', async () => {
		const delayMs = 150;
		fetchSourceUrlMock.mockImplementation(async (url: string) => {
			await sleep(delayMs);
			return stubSource(url);
		});
		const urls = ['https://a.test/one', 'https://b.test/two', 'https://c.test/three'];

		const started = Date.now();
		const evidence = await fetchEvidenceUrls(urls, 'configured_source_monitor', context);
		const elapsed = Date.now() - started;

		expect(evidence).toHaveLength(3);
		expect(elapsed).toBeLessThan(delayMs * 2);
	});

	it('serializes URLs on the same host while other hosts run in parallel', async () => {
		const active = new Map<string, number>();
		const peak = new Map<string, number>();
		fetchSourceUrlMock.mockImplementation(async (url: string) => {
			const host = new URL(url).host;
			active.set(host, (active.get(host) ?? 0) + 1);
			peak.set(host, Math.max(peak.get(host) ?? 0, active.get(host) as number));
			await sleep(50);
			active.set(host, (active.get(host) as number) - 1);
			return stubSource(url);
		});
		const urls = [
			'https://same.test/one',
			'https://same.test/two',
			'https://other.test/three'
		];

		const started = Date.now();
		await fetchEvidenceUrls(urls, 'configured_source_monitor', context);
		const elapsed = Date.now() - started;

		expect(peak.get('same.test')).toBe(1);
		// other.test overlaps with same.test's sequential pair
		expect(elapsed).toBeLessThan(150);
	});

	it('preserves input order and keeps the failure placeholder for unreadable URLs', async () => {
		fetchSourceUrlMock.mockImplementation(async (url: string) => {
			if (url.includes('broken')) {
				await sleep(10);
				throw new Error('connection refused');
			}
			await sleep(30);
			return stubSource(url);
		});
		const urls = ['https://a.test/first', 'https://b.test/broken', 'https://c.test/last'];

		const evidence = await fetchEvidenceUrls(urls, 'configured_source_monitor', context);

		expect(evidence.map((item) => item.source_url)).toEqual(urls);
		expect(evidence[1].limitations).toContain('Source could not be read during this run.');
		expect(evidence[1].confidence).toBe(0);
		expect(evidence[0].extracted_text).not.toBe('');
	});

	it('filters excluded hubs, search pages, forums, and event pages before metadata fetch', async () => {
		fetchSourceUrlMock.mockImplementation(async (url: string) => stubSource(url));
		const prompt =
			'Toronto stories published today with direct article citations; exclude hubs, forums, Reddit and search pages.';
		const researchContract = deriveResearchRequestContract(prompt, {
			homeMarket: 'Toronto',
			timezone: 'America/Toronto'
		});
		const urls = [
			'https://www.cbc.ca/news/canada/toronto/direct-story',
			'https://www.cbc.ca/news',
			'https://www.cbc.ca/search?q=toronto',
			'https://www.reddit.com/r/toronto/comments/story',
			'https://events.example/toronto-calendar'
		];

		const evidence = await fetchEvidenceUrls(urls, 'openai_web_search', {
			...context,
			prompt,
			researchContract
		} as Parameters<typeof fetchEvidenceUrls>[2]);

		expect(fetchSourceUrlMock).toHaveBeenCalledTimes(1);
		expect(evidence.map((item) => item.source_url)).toEqual([urls[0]]);
	});
});

describe('fetchSourceIndexEvidence', () => {
	it('emits diverse item-level citations from direct publisher feeds, never feed URLs', async () => {
		discoverSourceItemsMock.mockImplementation(async (url: string) => ({
			sourceUrl: url,
			fetchedAt: '2026-08-01T18:30:00.000Z',
			contentType: 'application/rss+xml',
			statusCode: 200,
			adapter: 'rss',
			items: [0, 1].map((index) => ({
				id: `${url}-${index}`,
				url: `${url.replace(/\/feed\/?$/, '')}/story-${index + 1}`,
				title: `Toronto publisher story ${index + 1}`,
				summary: `The publisher reports substantive direct details for Toronto story ${index + 1} today.`,
				contentText: `The publisher reports substantive direct details for Toronto story ${index + 1} today.`,
				publishedAt: `2026-08-01T1${8 - index}:00:00.000Z`,
				updatedAt: null,
				provenance: { adapter: 'rss', sourceUrl: url, discoveredAt: '2026-08-01T18:30:00.000Z' }
			}))
		}));
		const prompt = 'Latest consequential Toronto news today; exclude sports and cite direct articles.';
		const researchContract = deriveResearchRequestContract(prompt, {
			homeMarket: 'Toronto',
			timezone: 'America/Toronto'
		});
		const feeds = ['https://one.test/feed/', 'https://two.test/feed/'];

		const evidence = await fetchSourceIndexEvidence(feeds, 'configured_source_monitor', {
			...context,
			prompt,
			researchContract,
			newsroomContext: { timezone: 'America/Toronto', homeMarket: 'Toronto' }
		} as Parameters<typeof fetchSourceIndexEvidence>[2], new Map([
			[feeds[0], 'Publisher One'],
			[feeds[1], 'Publisher Two']
		]));

		expect(evidence.map((item) => item.source_name)).toEqual([
			'Publisher One',
			'Publisher Two',
			'Publisher One',
			'Publisher Two'
		]);
		expect(evidence.every((item) => !feeds.includes(item.source_url))).toBe(true);
		expect(evidence.every((item) => item.page_role === 'article' && item.published_at)).toBe(true);
		expect(evidence.map((item) => item.provenance?.url)).toEqual([
			feeds[0], feeds[1], feeds[0], feeds[1]
		]);
		expect(discoverSourceItemsMock).toHaveBeenCalledWith(
			feeds[0],
			expect.any(AbortSignal),
			{ trustedSourceIndex: true }
		);
	});

	it('keeps market aliases such as TTC while excluding off-market feed items', async () => {
		discoverSourceItemsMock.mockResolvedValue({
			sourceUrl: 'https://publisher.test/feed/',
			fetchedAt: '2026-08-01T18:30:00.000Z',
			contentType: 'application/rss+xml',
			statusCode: 200,
			adapter: 'rss',
			items: [
				{
					id: 'ttc',
					url: 'https://publisher.test/news/ttc-streetcar-collision',
					title: 'Pedestrian injured after collision with TTC streetcar',
					summary: 'Emergency crews responded after the collision on King Street East.',
					contentText: 'Emergency crews responded after the collision on King Street East.',
					publishedAt: '2026-08-01T18:00:00.000Z',
					updatedAt: null,
					provenance: { adapter: 'rss', sourceUrl: 'https://publisher.test/feed/', discoveredAt: '2026-08-01T18:30:00.000Z' }
				},
				{
					id: 'hamilton',
					url: 'https://publisher.test/news/hamilton-assault',
					title: 'Hamilton police investigate fatal assault',
					summary: 'Investigators responded on Wentworth Street in Hamilton.',
					contentText: 'Investigators responded on Wentworth Street in Hamilton.',
					publishedAt: '2026-08-01T17:00:00.000Z',
					updatedAt: null,
					provenance: { adapter: 'rss', sourceUrl: 'https://publisher.test/feed/', discoveredAt: '2026-08-01T18:30:00.000Z' }
				}
			]
		});
		const prompt = 'Latest consequential Toronto news today with direct articles.';
		const researchContract = deriveResearchRequestContract(prompt, {
			homeMarket: 'Toronto',
			timezone: 'America/Toronto'
		});

		const evidence = await fetchSourceIndexEvidence(
			['https://publisher.test/feed/'],
			'configured_source_monitor',
			{
				...context,
				prompt,
				researchContract,
				newsroomContext: { timezone: 'America/Toronto', homeMarket: 'Toronto' }
			} as Parameters<typeof fetchSourceIndexEvidence>[2]
		);

		expect(evidence.map((item) => item.title)).toEqual([
			'Pedestrian injured after collision with TTC streetcar'
		]);
	});
});

describe('sourceFetchTimeoutMs', () => {
	it('defaults to 8000ms when the env var is unset or empty', () => {
		vi.stubEnv('NEWSROOM_SOURCE_FETCH_TIMEOUT_MS', '');
		expect(sourceFetchTimeoutMs()).toBe(8000);
	});

	it('honours a numeric override', () => {
		vi.stubEnv('NEWSROOM_SOURCE_FETCH_TIMEOUT_MS', '3000');
		expect(sourceFetchTimeoutMs()).toBe(3000);
	});

	it('clamps overrides below the 1000ms floor', () => {
		vi.stubEnv('NEWSROOM_SOURCE_FETCH_TIMEOUT_MS', '200');
		expect(sourceFetchTimeoutMs()).toBe(1000);
	});

	it('ignores non-numeric overrides', () => {
		vi.stubEnv('NEWSROOM_SOURCE_FETCH_TIMEOUT_MS', 'fast');
		expect(sourceFetchTimeoutMs()).toBe(8000);
	});
});
