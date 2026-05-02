import { describe, expect, it } from 'vitest';
import type { ChannelSource, HermesJob } from '$lib/types';
import {
	compileChannelPrompt,
	normalizeChannelSources,
	overlayChannelSourceConfigs,
	validateSourceUrl
} from './channel-sources';

function source(overrides: Partial<ChannelSource> = {}): ChannelSource {
	return {
		id: 'source-1',
		type: 'url',
		name: 'FDA newsroom',
		url: 'https://www.fda.gov/news-events',
		enabled: true,
		sortOrder: 0,
		...overrides
	};
}

function job(overrides: Partial<HermesJob> = {}): HermesJob {
	return {
		id: 'job-1',
		name: 'Morning policy monitor',
		prompt: 'Compiled prompt from Hermes',
		scheduleDisplay: 'every 1d',
		state: 'scheduled',
		enabled: true,
		nextRunAt: null,
		lastRunAt: null,
		lastStatus: null,
		lastError: null,
		lastDeliveryError: null,
		deliver: 'database',
		...overrides
	};
}

describe('channel source utilities', () => {
	it('accepts http and https source URLs', () => {
		expect(validateSourceUrl('https://example.com/news')).toBe('https://example.com/news');
		expect(validateSourceUrl('http://example.com/rss')).toBe('http://example.com/rss');
	});

	it('rejects empty, malformed, and non-http URLs', () => {
		for (const value of ['', 'not a url', 'file:///tmp/source', 'javascript:alert(1)']) {
			expect(() => validateSourceUrl(value)).toThrow();
		}
	});

	it('normalizes URL source entries', () => {
		expect(
			normalizeChannelSources([
				{ name: ' SEC ', url: 'https://www.sec.gov/newsroom', enabled: true }
			])
		).toEqual([
			{
				id: '',
				type: 'url',
				name: 'SEC',
				url: 'https://www.sec.gov/newsroom',
				enabled: true,
				sortOrder: 0
			}
		]);
	});

	it('leaves prompts unchanged when no sources are enabled', () => {
		expect(compileChannelPrompt('Scan the latest updates.', [])).toBe('Scan the latest updates.');
		expect(compileChannelPrompt('Scan the latest updates.', [source({ enabled: false })])).toBe(
			'Scan the latest updates.'
		);
	});

	it('appends enabled sources as a configured watchlist', () => {
		const prompt = compileChannelPrompt('Scan the latest updates.', [
			source({ name: 'CMS announcements', url: 'https://www.cms.gov/newsroom', sortOrder: 1 }),
			source({ name: 'FDA newsroom', url: 'https://www.fda.gov/news-events', sortOrder: 0 }),
			source({ name: 'Hidden source', enabled: false, sortOrder: 2 })
		]);

		expect(prompt).toContain('Scan the latest updates.');
		expect(prompt).toContain('## Configured Watchlist');
		expect(prompt).toContain('- FDA newsroom: https://www.fda.gov/news-events');
		expect(prompt).toContain('- CMS announcements: https://www.cms.gov/newsroom');
		expect(prompt).not.toContain('Hidden source');
	});

	it('overlays local source config onto Hermes jobs', () => {
		const jobs = [job(), job({ id: 'old-job', prompt: 'Legacy prompt' })];
		const sources = [source()];
		const overlaid = overlayChannelSourceConfigs(
			jobs,
			new Map([
				[
					'job-1',
					{
						basePrompt: 'Base prompt from local config',
						sources
					}
				]
			])
		);

		expect(overlaid[0]?.prompt).toBe('Base prompt from local config');
		expect(overlaid[0]?.sources).toEqual(sources);
		expect(overlaid[1]?.prompt).toBe('Legacy prompt');
		expect(overlaid[1]?.sources).toEqual([]);
	});
});
