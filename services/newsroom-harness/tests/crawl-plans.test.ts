import { afterEach, describe, expect, it, vi } from 'vitest';
import { executeCrawlPlan } from '../src/crawl-plans/executor.js';
import { openDatabase, type HarnessDb } from '../src/db/database.js';
import { HarnessRepository } from '../src/db/repository.js';
import { resetPoliteFetchStateForTests } from '../src/tools/polite-fetch.js';

let db: HarnessDb | null = null;
let repository: HarnessRepository | null = null;

afterEach(() => {
	resetPoliteFetchStateForTests();
	vi.restoreAllMocks();
	repository?.close();
	repository = null;
	db = null;
});

describe('crawl plan versions and execution', () => {
	it('stores crawl plans as versioned beat memory entries', () => {
		const repo = createRepository();
		const first = repo.saveCrawlPlanVersion({
			beat_id: 'city-hall',
			id: 'plan-city',
			seed_url: 'https://city.example/news',
			link_follow_rule: 'Follow same-site links under /news that look like articles.',
			polling_cadence: 'every 3h',
			jitter_ms: 900000,
			change_detection: 'structured_diff',
			polite_fetch: {
				respect_robots: true,
				host_delay_ms: 1000,
				archive_web: false
			},
			candidate_links: [
				{
					title: 'Council approves late-night transit expansion',
					url: 'https://city.example/news/transit-expansion',
					reason: 'Same-site story candidate',
					score: 9
				}
			],
			created_by: 'monitor'
		});
		const second = repo.saveCrawlPlanVersion({
			beat_id: 'city-hall',
			id: 'plan-city',
			seed_url: 'https://city.example/news',
			link_follow_rule: 'Follow same-site links under /news/transit.',
			created_by: 'editor'
		});

		expect(first).toMatchObject({
			id: 'plan-city',
			beat_id: 'city-hall',
			version: 1,
			jitter_ms: 900000,
			change_detection: 'structured_diff',
			polite_fetch: {
				respect_robots: true,
				robots_override: false,
				host_delay_ms: 1000,
				failure_budget: 3,
				archive_web: false
			},
			supersedes_version: null
		});
		expect(second).toMatchObject({ version: 2, supersedes_version: 1 });
		expect(repo.listCrawlPlanVersions('city-hall', 'plan-city').map((plan) => plan.version)).toEqual([1, 2]);
		expect(repo.requireCrawlPlanVersion('city-hall', 'plan-city', 1).link_follow_rule).toContain('/news');
		expect(repo.inspectBeatMemory('city-hall').current.crawl_plans).toHaveLength(2);
	});

	it('executes one crawl pass and emits source events tied to the producing plan version', async () => {
		const repo = createRepository();
		const plan = repo.saveCrawlPlanVersion({
			beat_id: 'city-hall',
			id: 'plan-city',
			seed_url: 'https://city.example/news',
			link_follow_rule: 'Follow same-site links under /news that look like articles.',
			polite_fetch: {
				respect_robots: false,
				host_delay_ms: 0,
				archive_web: false
			},
			candidate_links: [
				{
					title: 'Council approves late-night transit expansion',
					url: 'https://city.example/news/transit-expansion',
					reason: 'Same-site story candidate',
					score: 9
				}
			]
		});
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.endsWith('/news')) {
				return new Response('<html><title>City News</title><a href="/news/transit-expansion">Transit expansion</a></html>', {
					status: 200,
					headers: { 'content-type': 'text/html' }
				});
			}
			return new Response(
				`
				<html>
					<head><title>Transit expansion approved</title></head>
					<body><article>
						<p>Council approved the late-night transit expansion after a budget vote that ran into the evening.</p>
						<p>The plan adds buses every fifteen minutes on two overnight routes while repair crews close part of the downtown rail tunnel.</p>
						<p>Transit staff said the shuttle network will start next month and remain in place until signal work is finished.</p>
					</article></body>
				</html>
			`,
				{
					status: 200,
					headers: { 'content-type': 'text/html', etag: '"article-v1"' }
				}
			);
		});

		const result = await executeCrawlPlan(
			repo,
			'city-hall',
			'plan-city',
			{ workspace_id: 'workspace-city', max_links: 1 },
			{ fetchImpl: fetchMock as typeof fetch }
		);

		expect(result.plan).toMatchObject({ id: plan.id, version: 1 });
		expect(result.sources).toEqual([
			expect.objectContaining({
				url: 'https://city.example/news/transit-expansion',
				title: 'Transit expansion approved',
				adapter: 'html_article',
				plan_version: 1,
				metadata: expect.objectContaining({
					title: 'Transit expansion approved',
					metadataSources: expect.arrayContaining(['html'])
				}),
				provenance: expect.objectContaining({
					adapter: 'html_article',
					extraction_method: 'readability'
				})
			})
		]);
		expect(result.events.map((event) => event.kind)).toEqual(['source.discovered', 'crawl_plan.executed']);
		expect(result.events[0].payload).toMatchObject({
			via: 'crawl_plan',
			plan_id: 'plan-city',
			plan_version: 1,
			beat_id: 'city-hall',
			plan_memory_entry_id: plan.source_memory_entry_id,
			provenance: expect.objectContaining({
				extraction_method: 'readability'
			})
		});
		expect(repo.listEvents({ workspaceId: 'workspace-city' }).map((event) => event.kind)).toEqual([
			'source.discovered',
			'crawl_plan.executed'
		]);
	});
});

function createRepository(): HarnessRepository {
	db = openDatabase(':memory:');
	repository = new HarnessRepository(db);
	return repository;
}
