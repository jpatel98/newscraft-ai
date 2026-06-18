import { afterEach, describe, expect, it, vi } from 'vitest';

const fetchSourceUrlMock = vi.fn();

vi.mock('../src/tools/sources.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../src/tools/sources.js')>();
	return {
		...actual,
		fetchSourceUrl: (...args: Parameters<typeof actual.fetchSourceUrl>) => fetchSourceUrlMock(...args)
	};
});

const { fetchEvidenceUrls, sourceFetchTimeoutMs } = await import('../src/agents/default-tools.js');

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
