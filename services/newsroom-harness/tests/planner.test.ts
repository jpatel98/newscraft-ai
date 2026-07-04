import { describe, expect, it } from 'vitest';
import { normalizeEvidence } from '../src/agents/evidence.js';
import { DisciplinedNewsroomAgent, type AgentPlanEvent } from '../src/agents/newsroom-agent.js';
import {
	defaultStepLabel,
	parseResearchPlan,
	planFromRoute,
	readingLabelForUrl,
	type PlannerRequest
} from '../src/agents/planner.js';
import { routeNewsroomRequest } from '../src/agents/router.js';
import { ToolRegistry, type NewsroomTool, type ToolCategory, type ToolRunOutput } from '../src/agents/tools.js';

const PARSE_CONTEXT: Pick<PlannerRequest, 'tools' | 'maxSteps'> = {
	tools: [
		{ name: 'openai_web_search', when_to_use: 'broad discovery' },
		{ name: 'configured_source_monitor', when_to_use: 'official monitors' },
		{ name: 'url_fetch_read', when_to_use: 'read one page' }
	],
	maxSteps: 4
};

describe('research plan parsing', () => {
	it('parses a fenced JSON plan and sanitizes labels', () => {
		const plan = parseResearchPlan(
			[
				'```json',
				JSON.stringify({
					reason: 'Check official sources first.',
					steps: [
						{ tool: 'configured_source_monitor', input: 'Toronto police releases', label: '**Checking** Toronto police releases https://tps.ca' },
						{ tool: 'openai_web_search', input: 'Toronto shooting Rexdale June 2026', label: 'Searching recent coverage' }
					]
				}),
				'```'
			].join('\n'),
			PARSE_CONTEXT
		);

		expect(plan.source).toBe('model');
		expect(plan.steps).toHaveLength(2);
		expect(plan.steps[0].label).toBe('Checking Toronto police releases');
		expect(plan.steps[1].input).toBe('Toronto shooting Rexdale June 2026');
	});

	it('rejects plans that use unavailable tools', () => {
		expect(() =>
			parseResearchPlan(
				JSON.stringify({ steps: [{ tool: 'shell_exec', input: 'rm -rf', label: 'Doing things' }] }),
				PARSE_CONTEXT
			)
		).toThrow(/not available/);
	});

	it('rejects replies without a JSON plan', () => {
		expect(() => parseResearchPlan('Sure! I will search the web for you.', PARSE_CONTEXT)).toThrow();
	});

	it('derives router fallback plans with human labels', () => {
		const route = routeNewsroomRequest('Check the latest Toronto Police releases and summarize anything newsworthy');
		const plan = planFromRoute(route, 'Check the latest Toronto Police releases and summarize anything newsworthy');

		expect(plan.source).toBe('router');
		expect(plan.steps.map((step) => step.tool)).toEqual(['configured_source_monitor', 'openai_web_search']);
		expect(plan.steps[0].label).toBe('Checking configured sources');
	});

	it('labels url fetch steps with the hostname', () => {
		expect(readingLabelForUrl('https://www.cbc.ca/news/story')).toBe('Reading cbc.ca');
		expect(defaultStepLabel('url_fetch_read', 'https://tps.ca/releases/1')).toBe('Reading tps.ca');
	});
});

function evidenceItem(url: string, text: string, publishedAt: string | null = null) {
	return normalizeEvidence({
		source_name: 'stub',
		source_url: url,
		accessed_at: '2026-06-10T12:00:00.000Z',
		tool_used: 'stub',
		title: `Story at ${url}`,
		published_at: publishedAt,
		extracted_text: text,
		summary: text,
		confidence: 0.7,
		limitations: [],
		source_kind: 'media_report'
	});
}

function stubTool(
	name: string,
	category: ToolCategory,
	run: (input: unknown) => ToolRunOutput | Promise<ToolRunOutput>
): NewsroomTool {
	return {
		name,
		description: `${name} stub`,
		when_to_use: 'test only',
		category,
		input_schema: { type: 'object' },
		output_schema: { type: 'object' },
		run: async (input) => run(input)
	};
}

const LONG_TEXT =
	'Police confirmed the seizure of counterfeit jerseys downtown after a months-long investigation involving several storefronts.';

describe('planned agent loop', () => {
	it('uses the model planner steps and emits plan snapshots', async () => {
		const registry = new ToolRegistry();
		const searchInputs: string[] = [];
		registry.register(
			stubTool('openai_web_search', 'web_search_provider', (input) => {
				searchInputs.push((input as { query: string }).query);
				return { status: 'ok', evidence: [evidenceItem('https://example.com/a', LONG_TEXT, '2026-06-09')], answer: LONG_TEXT };
			})
		);
		const planEvents: AgentPlanEvent[] = [];
		const agent = new DisciplinedNewsroomAgent({
			registry,
			config: { enabled_tools: ['openai_web_search'], planner_enabled: true },
			planner: async () => ({
				source: 'model',
				reason: 'One focused search.',
				steps: [{ tool: 'openai_web_search', input: 'Toronto city hall vote June 10 2026', label: 'Searching city hall coverage' }]
			})
		});

		const result = await agent.run('What happened at city hall this week?', {
			openAiApiKey: 'test-key',
			onPlanEvent: (event) => planEvents.push(event)
		});

		expect(searchInputs).toEqual(['Toronto city hall vote June 10 2026']);
		expect(planEvents[0].source).toBe('model');
		expect(planEvents[0].steps).toEqual([
			expect.objectContaining({ label: 'Searching city hall coverage', status: 'pending' })
		]);
		const statuses = planEvents.map((event) => event.steps[0].status);
		expect(statuses).toContain('running');
		expect(statuses[statuses.length - 1]).toBe('ok');
		expect(result.plan.steps[0].status).toBe('ok');
	});

	it('falls back to the router plan when the planner fails', async () => {
		const registry = new ToolRegistry();
		registry.register(stubTool('openai_web_search', 'web_search_provider', () => ({
			status: 'ok',
			evidence: [evidenceItem('https://example.com/a', LONG_TEXT, '2026-06-09')],
			answer: LONG_TEXT
		})));
		const planEvents: AgentPlanEvent[] = [];
		const agent = new DisciplinedNewsroomAgent({
			registry,
			config: { enabled_tools: ['openai_web_search'], planner_enabled: true },
			planner: async () => {
				throw new Error('planner exploded');
			}
		});

		const result = await agent.run('Latest Mark Carney news', {
			openAiApiKey: 'test-key',
			onPlanEvent: (event) => planEvents.push(event)
		});

		expect(planEvents[0].source).toBe('router');
		expect(result.tool_calls.map((call) => call.name)).toEqual(['openai_web_search']);
	});

	it('appends a web-search fallback step when a planned source step fails', async () => {
		const registry = new ToolRegistry();
		registry.register(stubTool('configured_source_monitor', 'source_monitor', () => ({
			status: 'unavailable',
			limitations: ['Fixture source unavailable']
		})));
		registry.register(stubTool('openai_web_search', 'web_search_provider', () => ({
			status: 'ok',
			evidence: [evidenceItem('https://example.com/a', LONG_TEXT, '2026-06-09')],
			answer: LONG_TEXT
		})));
		const agent = new DisciplinedNewsroomAgent({
			registry,
			config: { enabled_tools: ['configured_source_monitor', 'openai_web_search'], planner_enabled: true },
			planner: async () => ({
				source: 'model',
				reason: 'Monitor only.',
				steps: [{ tool: 'configured_source_monitor', input: 'Toronto police releases', label: 'Checking police releases' }]
			})
		});

		const result = await agent.run('Check the latest Toronto Police releases', { openAiApiKey: 'test-key' });

		expect(result.tool_calls.map((call) => call.name)).toEqual(['configured_source_monitor', 'openai_web_search']);
		expect(result.plan.steps.map((step) => step.tool)).toEqual(['configured_source_monitor', 'openai_web_search']);
		expect(result.plan.steps[1].label).toBe('Searching recent coverage');
	});

	it('follows up undated web-search results with article fetches for report outputs', async () => {
		const registry = new ToolRegistry();
		const fetchedUrls: string[] = [];
		registry.register(stubTool('openai_web_search', 'web_search_provider', () => ({
			status: 'ok',
			evidence: [evidenceItem('https://example.com/story', LONG_TEXT, null)],
			answer: LONG_TEXT
		})));
		registry.register(
			stubTool('url_fetch_read', 'custom', (input) => {
				fetchedUrls.push((input as { url: string }).url);
				return { status: 'ok', evidence: [evidenceItem('https://example.com/story', LONG_TEXT, '2026-06-09')] };
			})
		);
		const agent = new DisciplinedNewsroomAgent({
			registry,
			config: { enabled_tools: ['openai_web_search', 'url_fetch_read'], planner_enabled: false }
		});

		const result = await agent.run('What happened at city hall this week?', { outputStyle: 'report' });

		expect(fetchedUrls).toEqual(['https://example.com/story']);
		expect(result.tool_calls.map((call) => call.name)).toEqual(['openai_web_search', 'url_fetch_read']);
		expect(result.plan.steps.at(-1)).toMatchObject({ tool: 'url_fetch_read', label: 'Reading example.com', status: 'ok' });
	});

	it('does not run follow-up fetches for chat outputs', async () => {
		const registry = new ToolRegistry();
		const fetchedUrls: string[] = [];
		registry.register(stubTool('openai_web_search', 'web_search_provider', () => ({
			status: 'ok',
			evidence: [evidenceItem('https://example.com/story', LONG_TEXT, null)],
			answer: LONG_TEXT
		})));
		registry.register(
			stubTool('url_fetch_read', 'custom', (input) => {
				fetchedUrls.push((input as { url: string }).url);
				return { status: 'ok', evidence: [] };
			})
		);
		const agent = new DisciplinedNewsroomAgent({
			registry,
			config: { enabled_tools: ['openai_web_search', 'url_fetch_read'], planner_enabled: false }
		});

		const result = await agent.run('What happened at city hall this week?', { outputStyle: 'chat' });

		expect(fetchedUrls).toEqual([]);
		expect(result.tool_calls.map((call) => call.name)).toEqual(['openai_web_search']);
	});

	it('marks steps beyond the budget as skipped in the final plan', async () => {
		const registry = new ToolRegistry();
		registry.register(stubTool('source_feed_fetcher', 'source_feed_fetcher', () => ({
			status: 'ok',
			evidence: [evidenceItem('https://official.example/release', LONG_TEXT, '2026-06-09')]
		})));
		registry.register(stubTool('openai_web_search', 'web_search_provider', () => ({
			status: 'ok',
			evidence: [evidenceItem('https://example.com/a', LONG_TEXT, '2026-06-09')]
		})));
		const agent = new DisciplinedNewsroomAgent({
			registry,
			config: {
				enabled_tools: ['source_feed_fetcher', 'openai_web_search'],
				planner_enabled: false,
				default_tool_budget: {
					max_total_tool_calls: 1,
					max_custom_tool_calls: 1,
					max_web_searches: 1,
					max_browser_tasks: 1,
					max_runtime_seconds: 30
				}
			}
		});

		const result = await agent.run(
			'Verify this police release against official sources and what other outlets are reporting: https://example.com/story'
		);

		expect(result.tool_calls).toHaveLength(1);
		expect(result.limitations).toContain('max_total_tool_calls exhausted');
		expect(result.plan.steps[1]).toMatchObject({ tool: 'openai_web_search', status: 'skipped' });
	});
});
