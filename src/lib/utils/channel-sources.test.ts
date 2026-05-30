import { describe, expect, it } from 'vitest';
import type { ChannelSource, AgentJob, CrawlPlanProposal } from '$lib/types';
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

function job(overrides: Partial<AgentJob> = {}): AgentJob {
	return {
		id: 'job-1',
		name: 'Morning policy monitor',
		prompt: 'Compiled prompt from Agent',
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

function crawlPlan(overrides: Partial<CrawlPlanProposal> = {}): CrawlPlanProposal {
	return {
		id: 'plan-1',
		missionId: 'job-1',
		version: 1,
		seedUrl: 'https://example.com/news',
		siteName: 'Example News',
		status: 'approved',
		linkFollowRule: 'Follow same-site links that look like recent articles.',
		articleBodyStrategy: 'auto',
		pollingCadence: 'every 3h',
		jitterMs: 900000,
		changeDetection: 'hash',
		politeFetch: {
			respectRobots: true,
			robotsOverride: false,
			hostDelayMs: 250,
			failureBudget: 3,
			archiveWeb: true
		},
		candidateLinks: [
			{
				title: 'Council approves the late-night transit service expansion',
				url: 'https://example.com/news/transit-service-expansion',
				reason: 'Same-site story candidate',
				score: 9
			}
		],
		createdAt: 1,
		updatedAt: 1,
		approvedAt: 1,
		rejectedAt: null,
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

	it('adds the default broad source strategy when no sources are enabled', () => {
		expect(compileChannelPrompt('Scan the latest updates.', [])).toContain('## Source Strategy');
		expect(compileChannelPrompt('Scan the latest updates.', [source({ enabled: false })])).toContain(
			'Default to broad source discovery'
		);
	});

	it('appends enabled sources as a configured watchlist', () => {
		const prompt = compileChannelPrompt('Scan the latest updates.', [
			source({ name: 'CMS announcements', url: 'https://www.cms.gov/newsroom', sortOrder: 1 }),
			source({ name: 'FDA newsroom', url: 'https://www.fda.gov/news-events', sortOrder: 0 }),
			source({ name: 'Hidden source', enabled: false, sortOrder: 2 })
		]);

		expect(prompt).toContain('Scan the latest updates.');
		expect(prompt).toContain('## Source Strategy');
		expect(prompt).toContain('Search reputable news/media coverage');
		expect(prompt).toContain('## Configured Watchlist');
		expect(prompt).toContain('- FDA newsroom: https://www.fda.gov/news-events');
		expect(prompt).toContain('- CMS announcements: https://www.cms.gov/newsroom');
		expect(prompt).not.toContain('Hidden source');
	});

	it('appends approved crawl plans to the compiled prompt', () => {
		const prompt = compileChannelPrompt('Scan the latest updates.', [], [
			crawlPlan(),
			crawlPlan({ id: 'plan-2', status: 'rejected', siteName: 'Rejected plan' })
		]);

		expect(prompt).toContain('Scan the latest updates.');
		expect(prompt).toContain('## Approved Crawl Plans');
		expect(prompt).toContain('Example News');
		expect(prompt).toContain('Polling jitter: 900s');
		expect(prompt).toContain('Polite fetch: robots respected, host delay 250ms, archive on');
		expect(prompt).toContain('https://example.com/news/transit-service-expansion');
		expect(prompt).not.toContain('Rejected plan');
	});

	it('overlays local source config onto Agent jobs', () => {
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
