import { afterEach, describe, expect, it, vi } from 'vitest';
import { draftCrawlPlan } from './crawl-plans';

describe('crawl plan inspector', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('drafts a crawl plan with same-site candidate links', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () => new Response(`
				<html>
					<head><title>City Hall News</title></head>
					<body>
						<a href="/news/transit-service-expansion-approved">Council approves the late-night transit service expansion</a>
						<a href="/privacy">Privacy policy and terms</a>
						<a href="https://other.example/story">A related external story that should score lower</a>
					</body>
				</html>`, { status: 200 }))
		);

		const plan = await draftCrawlPlan({
			seedUrl: 'https://city.example/news',
			missionSchedule: 'every 3h'
		});

		expect(plan.siteName).toBe('City Hall News');
		expect(plan.linkFollowRule).toContain('/news');
		expect(plan.pollingCadence).toBe('every 3h');
		expect(plan.candidateLinks).toEqual([
			expect.objectContaining({
				title: 'Council approves the late-night transit service expansion',
				url: 'https://city.example/news/transit-service-expansion-approved',
				reason: 'Same-site story candidate'
			})
		]);
	});
});
