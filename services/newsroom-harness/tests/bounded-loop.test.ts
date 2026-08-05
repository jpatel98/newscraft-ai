import { describe, expect, it } from 'vitest';
import { normalizeEvidence } from '../src/agents/evidence.js';
import { DisciplinedNewsroomAgent } from '../src/agents/newsroom-agent.js';
import { parseLoopDecision } from '../src/agents/planner.js';
import { ToolRegistry, type NewsroomTool, type ToolCategory, type ToolRunOutput } from '../src/agents/tools.js';

const FIXED_NOW = new Date('2026-08-04T16:00:00.000Z');
const LONG_TEXT =
	'Officials confirmed the development after reviewing the relevant records and said the next public update will follow the normal newsroom process.';

describe('bounded newsroom observe-act-observe loop', () => {
	it('only parses registered read-only actions and bounded synthesis actions', () => {
		const request = {
			tools: [
				{ name: 'openai_web_search', when_to_use: 'broad discovery' },
				{ name: 'url_fetch_read', when_to_use: 'read a direct page' }
			],
			skills: [{ id: 'source_verification' as const, summary: 'verify a source' }],
			maxActions: 2
		};

		const decision = parseLoopDecision(
			JSON.stringify({
				reason: 'Read two independent pages.',
				actions: [
					{ kind: 'research', tool: 'openai_web_search', input: 'focused query', label: 'Search coverage', parallel: true },
					{ kind: 'research', tool: 'url_fetch_read', input: 'https://example.com/story', label: 'Read source', skill: 'source_verification', parallel: true },
					{ kind: 'research', tool: 'shell_exec', input: 'unsafe', label: 'Never run' }
				]
			}),
			request
		);

		expect(decision.actions).toHaveLength(2);
		expect(decision.actions[1]).toMatchObject({ kind: 'research', tool: 'url_fetch_read', skill: 'source_verification' });
		expect(() => parseLoopDecision(JSON.stringify({ actions: [{ kind: 'research', tool: 'shell_exec', input: 'rm -rf', label: 'unsafe' }] }), request)).toThrow(
			/not available/
		);
		expect(parseLoopDecision(JSON.stringify({ actions: [{ kind: 'synthesize', reason: 'Enough verified evidence.' }] }), request).actions[0]).toEqual(
			expect.objectContaining({ kind: 'synthesize' })
		);
	});

	it('runs independent actions concurrently and folds observations in deterministic order', async () => {
		const registry = new ToolRegistry();
		let active = 0;
		let maximumActive = 0;
		const calls: string[] = [];
		registry.register(stubTool('openai_web_search', 'web_search_provider', () => ({ status: 'unavailable', limitations: ['No initial provider result'] })));
		registry.register(
			stubTool('source_feed_fetcher', 'custom', async () => {
				active += 1;
				maximumActive = Math.max(maximumActive, active);
				calls.push('source_feed_fetcher:start');
				await delay(25);
				active -= 1;
				calls.push('source_feed_fetcher:end');
				return { status: 'ok', evidence: [evidenceItem('https://example.com/source-feed-story', 'Source feed report')] };
			})
		);
		registry.register(
			stubTool('url_fetch_read', 'custom', async () => {
				active += 1;
				maximumActive = Math.max(maximumActive, active);
				calls.push('url_fetch_read:start');
				await delay(5);
				active -= 1;
				calls.push('url_fetch_read:end');
				return { status: 'ok', evidence: [evidenceItem('https://example.com/direct-story', 'Direct article report')] };
			})
		);

		const agent = new DisciplinedNewsroomAgent({
			registry,
			clock: () => FIXED_NOW,
			config: {
				enabled_tools: ['openai_web_search', 'source_feed_fetcher', 'url_fetch_read'],
				planner_enabled: true,
				default_tool_budget: {
					max_total_tool_calls: 4,
					max_custom_tool_calls: 2,
					max_web_searches: 1,
					max_browser_tasks: 1,
					max_runtime_seconds: 10
				}
			},
			loopDecision: async (request) => {
				expect(request.evaluation.gaps).toContain('no readable evidence currently supports the request');
				return {
					source: 'model',
					reason: 'Use two independent read-only observations.',
					actions: [
						{ kind: 'research', tool: 'source_feed_fetcher', input: 'feed lane', label: 'Read feed lane', parallel: true },
						{ kind: 'research', tool: 'url_fetch_read', input: 'https://example.com/direct-story', label: 'Read direct lane', parallel: true }
					]
				};
			}
		});

		const result = await agent.run('Find two verified reports about the city hall vote.', { outputStyle: 'chat' });

		expect(maximumActive).toBe(2);
		expect(calls).toEqual([
			'source_feed_fetcher:start',
			'url_fetch_read:start',
			'url_fetch_read:end',
			'source_feed_fetcher:end'
		]);
		expect(result.tool_calls.map((call) => call.name)).toEqual([
			'openai_web_search',
			'source_feed_fetcher',
			'url_fetch_read'
		]);
		expect(result.evidence.map((item) => item.source_url)).toEqual([
			'https://example.com/direct-story',
			'https://example.com/source-feed-story'
		]);
		expect(result.evidence.map((item) => item.citation_number)).toEqual([1, 2]);
	});

	it('uses the latest turn and request-scoped time in the loop contract', async () => {
		let receivedQuery = '';
		let loopRequest: Parameters<NonNullable<ConstructorParameters<typeof DisciplinedNewsroomAgent>[0]>['loopDecision']>[0] | undefined;
		const registry = new ToolRegistry();
		registry.register(
			stubTool('openai_web_search', 'web_search_provider', (input) => {
				receivedQuery = (input as { query: string }).query;
				return { status: 'unavailable', limitations: ['No readable result'] };
			})
		);
		const agent = new DisciplinedNewsroomAgent({
			registry,
			clock: () => FIXED_NOW,
			config: { enabled_tools: ['openai_web_search'], planner_enabled: true },
			loopDecision: async (request) => {
				loopRequest = request;
				return { source: 'model', reason: 'No safe improvement remains.', actions: [{ kind: 'synthesize' }] };
			}
		});

		await agent.run('Ignore this stale routing prompt about the old story.', {
			outputStyle: 'chat',
			conversationContext: {
				version: 1,
				intent: 'research',
				currentTurn: {
					messageId: 'latest',
					content: 'Check the latest newsroom update about the new story.',
					resolvedRequest: 'Check the latest newsroom update about the new story.',
					operation: 'send',
					researchRequired: true,
					freshness: 'current'
				}
			}
		});

		expect(receivedQuery).toContain('new story');
		expect(receivedQuery).not.toContain('old story');
		expect(loopRequest?.request).toBe('Check the latest newsroom update about the new story.');
		expect(loopRequest?.promptLayers.context).toContain('new story');
		expect(loopRequest?.promptLayers.context).not.toContain('old story');
		expect(loopRequest?.promptLayers.volatile).toContain('2026-08-04');
	});

	it('stops before another loop decision when the latest request aborts the signal', async () => {
		const controller = new AbortController();
		let decisionCalls = 0;
		const registry = new ToolRegistry();
		registry.register(
			stubTool('openai_web_search', 'web_search_provider', () => {
				controller.abort();
				return { status: 'error', limitations: ['interrupted'] };
			})
		);
		const agent = new DisciplinedNewsroomAgent({
			registry,
			config: { enabled_tools: ['openai_web_search'], planner_enabled: true },
			loopDecision: async () => {
				decisionCalls += 1;
				return { source: 'model', reason: 'Should not run.', actions: [{ kind: 'synthesize' }] };
			}
		});

		const result = await agent.run('Find the latest report about the interrupted update.', { signal: controller.signal });

		expect(decisionCalls).toBe(0);
		expect(result.stopped_reason).toContain('interrupted');
		expect(result.budget.usage.total_tool_calls).toBe(1);
	});

	it('returns a cited partial answer when the contract asks for more than the budget/evidence can provide', async () => {
		const registry = new ToolRegistry();
		registry.register(
			stubTool('openai_web_search', 'web_search_provider', () => ({
				status: 'ok',
				evidence: [evidenceItem('https://example.com/one', 'One verified city hall report')],
				answer: 'The verified report describes the vote outcome [1].'
			}))
		);
		const agent = new DisciplinedNewsroomAgent({
			registry,
			config: {
				enabled_tools: ['openai_web_search'],
				planner_enabled: true,
				default_tool_budget: { max_total_tool_calls: 1, max_custom_tool_calls: 1, max_web_searches: 1, max_browser_tasks: 1, max_runtime_seconds: 10 }
			},
			loopDecision: async () => ({ source: 'model', reason: 'Synthesize the verified subset.', actions: [{ kind: 'synthesize' }] })
		});

		const result = await agent.run('Find three verified stories about the city hall vote.', { outputStyle: 'chat' });

		expect(result.evidence).toHaveLength(1);
		expect(result.final_answer).toContain('[1]');
		expect(result.limitations.some((item) => /three|3|coverage/i.test(item))).toBe(true);
	});

	it('rejects stale current evidence and preserves the visible freshness limitation', async () => {
		const registry = new ToolRegistry();
		registry.register(
			stubTool('openai_web_search', 'web_search_provider', () => ({
				status: 'ok',
				evidence: [evidenceItem('https://example.com/stale-report', 'An older report outside the requested current window', '2026-08-03T10:00:00.000Z')]
			}))
		);
		const agent = new DisciplinedNewsroomAgent({
			registry,
			clock: () => FIXED_NOW,
			config: { enabled_tools: ['openai_web_search'], planner_enabled: true },
			loopDecision: async () => ({ source: 'model', reason: 'Synthesize with the stated gap.', actions: [{ kind: 'synthesize' }] })
		});

		const result = await agent.run('What is the latest report about today\'s city hall vote?', { outputStyle: 'chat' });

		expect(result.evidence).toHaveLength(0);
		expect(result.limitations.some((item) => /out-of-window|no readable|excluded/i.test(item))).toBe(true);
	});

	it('falls back to deterministic route actions when the loop controller fails', async () => {
		const registry = new ToolRegistry();
		let calls = 0;
		registry.register(
			stubTool('openai_web_search', 'web_search_provider', () => {
				calls += 1;
				return { status: 'unavailable', limitations: ['provider unavailable'] };
			})
		);
		const agent = new DisciplinedNewsroomAgent({
			registry,
			config: { enabled_tools: ['openai_web_search'], planner_enabled: true },
			loopDecision: async () => {
				throw new Error('controller unavailable');
			}
		});

		const result = await agent.run('Find the latest report about the provider outage.');

		expect(calls).toBe(1);
		expect(result.tool_calls[0]?.name).toBe('openai_web_search');
		expect(result.final_answer).toMatch(/couldn|unable|unavailable|source/i);
	});
});

function stubTool(
	name: string,
	category: ToolCategory,
	run: (input: unknown) => ToolRunOutput | Promise<ToolRunOutput>
): NewsroomTool {
	return {
		name,
		description: `${name} test tool`,
		when_to_use: `Use ${name} for bounded test research.`,
		category,
		input_schema: { type: 'object' },
		output_schema: { type: 'object' },
		run: async (input) => run(input)
	};
}

function evidenceItem(url: string, text: string, publishedAt = '2026-08-04T14:00:00.000Z') {
	return normalizeEvidence({
		source_name: 'Test newsroom source',
		source_url: url,
		accessed_at: FIXED_NOW.toISOString(),
		tool_used: 'test_tool',
		title: `Direct report at ${url}`,
		published_at: publishedAt,
		extracted_text: `${text}. ${LONG_TEXT}`,
		summary: `${text}.`,
		confidence: 0.9,
		limitations: [],
		source_kind: 'media_report',
		citation_number: 1
	});
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
