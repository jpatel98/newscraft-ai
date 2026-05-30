import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { runBeatMonitor } from '../src/agents/beat-monitor.js';
import type { NewsroomAgentRuntime } from '../src/agents/runtime.js';
import { openDatabase, type HarnessDb } from '../src/db/database.js';
import { HarnessRepository } from '../src/db/repository.js';
import { JobRunner } from '../src/jobs/runner.js';
import { resetPoliteFetchStateForTests } from '../src/tools/polite-fetch.js';

let db: HarnessDb | null = null;
let repository: HarnessRepository | null = null;

afterEach(() => {
	resetPoliteFetchStateForTests();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	repository?.close();
	repository = null;
	db = null;
});

describe('beat monitor standing brief runs', () => {
	it('reads a configured watchlist through adapters, updates beat memory, and queues a pitch gate', async () => {
		const repo = createRepository();
		const job = repo.createJob({
			name: 'City Hall Monitor',
			prompt: [
				'Scan the city hall beat for fresh leads.',
				'',
				'## Configured Watchlist',
				'Use these configured sources as starting points for this scheduled run.',
				'',
				'- Council RSS: https://city.example/rss.xml'
			].join('\n'),
			schedule: 'every 60m'
		});
		const run = repo.createRun(job.id, 'test');
		const fetchMock = fetchFixture({
			'https://city.example/rss.xml': rssFixture([
				{
					title: 'Council approves late-night transit expansion after budget vote',
					link: 'https://city.example/news/transit-expansion',
					description: 'The city council approved late-night transit expansion after a budget vote, with service changes expected this fall.'
				}
			])
		});

		const result = await runBeatMonitor(repo, job, { runId: run.id }, { fetchImpl: fetchMock, maxPitches: 1 });
		const gate = result.gates[0];
		const payload = gate?.payload as Record<string, unknown>;

		expect(result).toMatchObject({ beatId: job.id, sourceCount: 1, pitchCount: 1 });
		expect(gate).toMatchObject({
			type: 'pitch',
			job_id: job.id,
			run_id: run.id,
			created_by: 'beat_monitor',
			status: 'open'
		});
		expect(payload).toMatchObject({
			beat_id: job.id,
			beat_name: 'City Hall Monitor',
			title: 'Council approves late-night transit expansion after budget vote',
			confidence: expect.any(Number),
			why_now: expect.stringContaining('Standing Brief'),
			suggested_angle: expect.stringContaining('transit expansion'),
			source_set: [
				expect.objectContaining({
					url: 'https://city.example/news/transit-expansion',
					adapter: 'rss',
					source_name: 'Council RSS'
				})
			]
		});
		expect(repo.inspectBeatMemory(job.id).current.prior_coverage).toEqual([
			expect.objectContaining({
				beat_id: job.id,
				run_id: run.id,
				pitch_gate_ids: [gate?.id],
				source_urls: ['https://city.example/news/transit-expansion']
			})
		]);
		expect(repo.listEvents({ runId: run.id }).map((event) => event.kind)).toEqual([
			'run.created',
			'beat_monitor.pass.started',
			'source.stored',
			'gate.queued',
			'beat_monitor.pass.completed'
		]);
	});

	it('fetches discovered article pages before pitching so dates come from article metadata', async () => {
		const repo = createRepository();
		const job = repo.createJob({
			name: 'Canada FIFA Newswatch',
			prompt: [
				'Scan for FIFA 2026 host-city updates.',
				'',
				'## Configured Watchlist',
				'Use these configured sources as starting points for this scheduled run.',
				'',
				'- Toronto news: https://www.toronto.ca/news/'
			].join('\n'),
			schedule: 'every 5m'
		});
		const run = repo.createRun(job.id, 'test');
		const articleUrl =
			'https://www.toronto.ca/news/one-month-to-kickoff-toronto-prepares-to-welcome-fifa-world-cup-2026/';
		const fetchMock = fetchFixture({
			'https://www.toronto.ca/news/': [
				'<html><head><title>City of Toronto news</title></head><body><main>',
				`<a href="${articleUrl}">Toronto: One month to kickoff as city prepares for FIFA World Cup 2026</a>`,
				'</main></body></html>'
			].join(''),
			[articleUrl]: [
				'<html><head>',
				'<meta property="article:published_time" content="2026-05-12T14:00:00Z">',
				'<meta property="og:description" content="City of Toronto update on final preparations for FIFA World Cup 2026.">',
				'<title>Toronto: One month to kickoff as city prepares for FIFA World Cup 2026</title>',
				'</head><body><article>',
				'<p>The City of Toronto says final hosting preparations are continuing one month before kickoff.</p>',
				'<p>Officials outlined local readiness work, public activations, and civic planning for FIFA World Cup 2026.</p>',
				'</article></body></html>'
			].join('')
		});

		const result = await runBeatMonitor(repo, job, { runId: run.id }, { fetchImpl: fetchMock, maxPitches: 1 });
		const sourceSet = (result.gates[0]?.payload as { source_set?: Array<Record<string, unknown>> }).source_set;

		expect(fetchMock.mock.calls.map((call) => String(call[0]))).toContain(articleUrl);
		expect(sourceSet?.[0]).toMatchObject({
			url: articleUrl,
			adapter: 'html_article',
			published_at: '2026-05-12T14:00:00.000Z',
			summary: 'City of Toronto update on final preparations for FIFA World Cup 2026.'
		});
		expect(sourceSet?.[0]?.published_at).not.toContain('2026-05-29');
	});

	it('executes only approved crawl plans assigned to the beat', async () => {
		const repo = createRepository();
		const job = repo.createJob({
			name: 'Transit Monitor',
			prompt: 'Scan the transit beat.',
			schedule: 'every 60m'
		});
		const run = repo.createRun(job.id, 'test');
		repo.saveCrawlPlanVersion({
			beat_id: job.id,
			id: 'pending-plan',
			status: 'pending',
			seed_url: 'https://city.example/pending',
			link_follow_rule: 'Follow same-site links.',
			candidate_links: [
				{
					title: 'Pending lead should not run',
					url: 'https://city.example/pending/story',
					reason: 'Pending candidate',
					score: 8
				}
			],
			polite_fetch: { respect_robots: false, host_delay_ms: 0, archive_web: false }
		});
		repo.saveCrawlPlanVersion({
			beat_id: job.id,
			id: 'approved-plan',
			status: 'approved',
			seed_url: 'https://city.example/news',
			link_follow_rule: 'Follow same-site links under /news that look like articles.',
			candidate_links: [
				{
					title: 'Agency releases new subway closure plan for weekend repairs',
					url: 'https://city.example/news/subway-closure-plan',
					reason: 'Same-site story candidate',
					score: 9
				}
			],
			polite_fetch: { respect_robots: false, host_delay_ms: 0, archive_web: true }
		});
		const fetchMock = fetchFixture({
			'https://city.example/news': '<html><title>Transit news</title></html>',
			'https://city.example/news/subway-closure-plan': [
				'<html><head><title>Subway closure plan released</title></head>',
				'<body><article><p>The transit agency released a weekend subway closure plan for repairs that will redirect riders to shuttle buses.</p></article></body></html>'
			].join('')
		});

		const result = await runBeatMonitor(repo, job, { runId: run.id }, { fetchImpl: fetchMock });
		const calledUrls = fetchMock.mock.calls.map((call) => String(call[0]));

		expect(calledUrls).not.toContain('https://city.example/pending');
		expect(result.gates).toHaveLength(1);
		expect(result.gates[0]?.payload).toMatchObject({
			source_set: [
				expect.objectContaining({
					url: 'https://city.example/news/subway-closure-plan',
					adapter: 'html_article',
					archive_snapshot_url: 'https://web.archive.org/web/20260529010101/https://city.example/news/subway-closure-plan',
					provenance: expect.objectContaining({
						source_url: 'https://city.example/news/subway-closure-plan',
						discovered_at: expect.any(String),
						fetched_at: expect.any(String),
						content_type: 'text/html',
						status_code: 200,
						content_hash: expect.any(String),
						archive_snapshot_url:
							'https://web.archive.org/web/20260529010101/https://city.example/news/subway-closure-plan'
					})
				})
			]
		});
		expect(repo.listEvents({ runId: run.id }).map((event) => event.kind)).toContain('crawl_plan.executed');
	});

	it('omits failed archive saves from pitch citation sources', async () => {
		const repo = createRepository();
		const job = repo.createJob({
			name: 'City Hall Monitor',
			prompt: [
				'Scan the city hall beat for fresh leads.',
				'',
				'## Configured Watchlist',
				'Use these configured sources as starting points for this scheduled run.',
				'',
				'- Council article: https://city.example/news/council-budget'
			].join('\n'),
			schedule: 'every 60m'
		});
		const run = repo.createRun(job.id, 'test');
		const fetchMock = fetchFixture(
			{
				'https://city.example/news/council-budget': [
					'<html><head><title>Council budget vote set</title></head>',
					'<body><article><p>Council set a budget vote after staff published the final operating plan for transit and housing services.</p></article></body></html>'
				].join('')
			},
			{ archiveStatus: 503 }
		);

		const result = await runBeatMonitor(repo, job, { runId: run.id }, { fetchImpl: fetchMock, maxPitches: 1 });
		const sourceSet = (result.gates[0]?.payload as { source_set?: Array<Record<string, unknown>> }).source_set;

		expect(result.gates).toHaveLength(1);
		expect(sourceSet?.[0]).toMatchObject({
			url: 'https://city.example/news/council-budget',
			adapter: 'html_article'
		});
		expect(sourceSet?.[0]).not.toHaveProperty('archive_snapshot_url');
	});

	it('keeps unpitched candidate leads eligible for the next monitor pass', async () => {
		const repo = createRepository();
		const job = repo.createJob({
			name: 'City Desk Monitor',
			prompt: [
				'Scan the city desk beat for fresh leads.',
				'',
				'## Configured Watchlist',
				'Use these configured sources as starting points for this scheduled run.',
				'',
				'- City RSS: https://city.example/rss.xml'
			].join('\n'),
			schedule: 'every 60m'
		});
		const items = [
			{
				title: 'Council confirms waterfront housing vote',
				link: 'https://city.example/news/waterfront-housing',
				description: 'Council confirmed a waterfront housing vote with zoning changes that affect several neighbourhoods.'
			},
			{
				title: 'Transit agency adds overnight shuttle service',
				link: 'https://city.example/news/overnight-shuttles',
				description: 'The transit agency added overnight shuttle service while track repairs continue this month.'
			},
			{
				title: 'School board releases new enrolment forecast',
				link: 'https://city.example/news/enrolment-forecast',
				description: 'The school board released an enrolment forecast showing pressure on elementary classrooms.'
			},
			{
				title: 'Province opens applications for flood grants',
				link: 'https://city.example/news/flood-grants',
				description: 'The province opened flood grant applications for households affected by spring storms.'
			}
		];
		const fetchMock = fetchFixture({ 'https://city.example/rss.xml': rssFixture(items) });
		const firstRun = repo.createRun(job.id, 'test');

		const first = await runBeatMonitor(repo, job, { runId: firstRun.id }, { fetchImpl: fetchMock, maxPitches: 2 });
		const firstMemory = repo.inspectBeatMemory(job.id).current.prior_coverage as Array<{ source_urls?: string[] }>;
		const secondRun = repo.createRun(job.id, 'test');
		const second = await runBeatMonitor(repo, job, { runId: secondRun.id }, { fetchImpl: fetchMock, maxPitches: 2 });
		const secondUrls = second.gates.map((gate) => {
			const payload = gate.payload as { source_set?: Array<{ url?: string }> };
			return payload.source_set?.[0]?.url;
		});

		expect(first.gates).toHaveLength(2);
		expect(firstMemory[firstMemory.length - 1]?.source_urls).toEqual([
			'https://city.example/news/waterfront-housing',
			'https://city.example/news/overnight-shuttles'
		]);
		expect(secondUrls).toEqual([
			'https://city.example/news/enrolment-forecast',
			'https://city.example/news/flood-grants'
		]);
	});

	it('lets source-only missions run through the broader mission agent and save output', async () => {
		const repo = createRepository();
		const job = repo.createJob({
			workspace_id: 'account:editor-1',
			name: 'Morning Policy Monitor',
			prompt: [
				'Scan the policy beat for fresh leads.',
				'',
				'## Configured Watchlist',
				'Use these configured sources as starting points for this scheduled run.',
				'',
				'- Policy RSS: https://policy.example/rss.xml'
			].join('\n'),
			schedule: 'every 60m'
		});
		const fetchMock = fetchFixture({
			'https://policy.example/rss.xml': rssFixture([
				{
					title: 'Ministry announces new housing permit dashboard',
					link: 'https://policy.example/news/housing-dashboard',
					description: 'The ministry announced a new housing permit dashboard that tracks application timelines across municipalities.'
				}
			])
		});
		vi.stubGlobal('fetch', fetchMock);
		const runtime = {
			runMission: vi.fn(async () => ({
				role: 'research',
				markdown: '## Summary\n\nBroad source discovery found one policy update.',
				sources: [],
				evidence: []
			}))
		} as unknown as NewsroomAgentRuntime;
		const runner = new JobRunner(repo, runtime, loadConfig({ openAiApiKey: '', runTimeoutMs: 5000 }));

		const run = runner.start(job.id, 'test');
		await runner.waitFor(run.id);

		expect(runtime.runMission).toHaveBeenCalledOnce();
		expect(repo.requireRun(run.id)).toMatchObject({ status: 'completed', last_error: null });
		const reports = repo.listReports();
		expect(reports).toHaveLength(1);
		expect(reports[0].markdown).toContain('# Cron Job: Morning Policy Monitor');
		expect(reports[0].markdown).toContain('## Summary');
		expect(reports[0].markdown).toContain('Broad source discovery found one policy update.');
		expect(repo.listGates({ workspaceId: 'account:editor-1', jobId: job.id })).toHaveLength(0);
		expect(repo.listGates({ workspaceId: 'default', jobId: job.id })).toHaveLength(0);
	});

	it('counts crawl-plan source events in runner progress', async () => {
		const repo = createRepository();
		const job = repo.createJob({
			workspace_id: 'account:editor-1',
			name: 'Transit Crawl Monitor',
			prompt: 'Scan the transit beat.',
			schedule: 'every 60m'
		});
		repo.saveCrawlPlanVersion({
			beat_id: job.id,
			id: 'approved-plan',
			status: 'approved',
			seed_url: 'https://city.example/news',
			link_follow_rule: 'Follow same-site links under /news that look like articles.',
			candidate_links: [
				{
					title: 'Agency releases new subway closure plan for weekend repairs',
					url: 'https://city.example/news/subway-closure-plan',
					reason: 'Same-site story candidate',
					score: 9
				}
			],
			polite_fetch: { respect_robots: false, host_delay_ms: 0, archive_web: false }
		});
		const fetchMock = fetchFixture({
			'https://city.example/news': '<html><title>Transit news</title></html>',
			'https://city.example/news/subway-closure-plan': [
				'<html><head><title>Subway closure plan released</title></head>',
				'<body><article><p>The transit agency released a weekend subway closure plan for repairs that will redirect riders to shuttle buses.</p></article></body></html>'
			].join('')
		});
		vi.stubGlobal('fetch', fetchMock);
		const runtime = { runMission: vi.fn() } as unknown as NewsroomAgentRuntime;
		const runner = new JobRunner(repo, runtime, loadConfig({ openAiApiKey: '', runTimeoutMs: 5000 }));

		const run = runner.start(job.id, 'test');
		await runner.waitFor(run.id);

		expect(repo.listRuns({ includeCompleted: true }).find((candidate) => candidate.id === run.id)).toMatchObject({
			source_count: 1
		});
	});

	it('lets the job runner replace stale active runs with a fresh manual run', async () => {
		const repo = createRepository();
		const job = repo.createJob({
			workspace_id: 'account:editor-1',
			name: 'Stale Run Watch',
			prompt: 'Write a short monitor update.',
			schedule: 'every 5m'
		});
		const stale = repo.createRun(job.id, 'schedule');
		db?.prepare(
			`UPDATE runs
			 SET status = 'running',
				 queued_at = '2026-05-29T18:00:00.000Z',
				 started_at = '2026-05-29T18:00:00.000Z',
				 updated_at = '2026-05-29T18:00:00.000Z'
			 WHERE id = ?`
		).run(stale.id);
		const runtime = {
			runMission: vi.fn(async () => ({
				role: 'assignment_desk',
				markdown: '## Summary\n\nFresh manual output.',
				sources: [],
				evidence: []
			}))
		} as unknown as NewsroomAgentRuntime;
		const runner = new JobRunner(repo, runtime, loadConfig({ openAiApiKey: '', runTimeoutMs: 1000 }));

		const fresh = runner.start(job.id, 'manual');
		await runner.waitFor(fresh.id);
		const runs = repo.listRuns({ includeCompleted: true }).filter((run) => run.job_id === job.id);

		expect(fresh.id).not.toBe(stale.id);
		expect(repo.requireRun(stale.id)).toMatchObject({
			status: 'failed',
			last_error: 'Run marked failed because the runner no longer has active execution for it.'
		});
		expect(runs.map((run) => run.status)).toContain('completed');
		expect(runtime.runMission).toHaveBeenCalledOnce();
	});
});

function createRepository(): HarnessRepository {
	db = openDatabase(':memory:');
	repository = new HarnessRepository(db);
	return repository;
}

function fetchFixture(responses: Record<string, string>, options: { archiveStatus?: number } = {}) {
	return vi.fn(async (input: RequestInfo | URL) => {
		const url = String(input);
		if (url.startsWith('https://web.archive.org/save/')) {
			const archivedUrl = decodeURIComponent(url.slice('https://web.archive.org/save/'.length));
			if (options.archiveStatus && options.archiveStatus >= 400) {
				return new Response('', { status: options.archiveStatus });
			}
			return new Response('', {
				status: 200,
				headers: { 'content-location': `/web/20260529010101/${archivedUrl}` }
			});
		}
		if (url.endsWith('/robots.txt')) {
			return new Response('User-agent: *\nAllow: /\n', { status: 200, headers: { 'content-type': 'text/plain' } });
		}
		const body = responses[url];
		if (body === undefined) return new Response('not found', { status: 404 });
		const contentType = url.endsWith('.xml') ? 'application/rss+xml' : 'text/html';
		return new Response(body, { status: 200, headers: { 'content-type': contentType } });
	});
}

function rssFixture(items: Array<{ title: string; link: string; description: string }>): string {
	const pubDate = new Date().toUTCString();
	return `<?xml version="1.0"?>
<rss version="2.0">
	<channel>
		<title>Fixture RSS</title>
		${items
			.map(
				(item) => `<item>
			<title>${item.title}</title>
			<link>${item.link}</link>
			<description>${item.description}</description>
			<pubDate>${pubDate}</pubDate>
		</item>`
			)
			.join('\n')}
	</channel>
</rss>`;
}
