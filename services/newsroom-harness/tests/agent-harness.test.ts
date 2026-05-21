import { describe, expect, it } from 'vitest';
import { generateFinalAnswer } from '../src/agents/answer.js';
import { mergeToolBudget, ToolBudgetLedger } from '../src/agents/budget.js';
import { normalizeEvidence } from '../src/agents/evidence.js';
import { DisciplinedNewsroomAgent } from '../src/agents/newsroom-agent.js';
import { routeNewsroomRequest } from '../src/agents/router.js';
import { ToolRegistry, type NewsroomTool, type ToolCategory } from '../src/agents/tools.js';

describe('disciplined newsroom agent harness', () => {
	it('routes sample prompts to expected modes with at least 80% accuracy', () => {
		const samples = [
			['What is a nut graf?', 'answer_from_memory'],
			['Use the newsroom brief generator for these notes: council approved a pilot.', 'custom_tool'],
			['Summarize the latest mission output', 'custom_tool'],
			['Check the latest Toronto Police releases and summarize anything newsworthy', 'source_monitor'],
			['Scan our configured source monitors for updates', 'source_monitor'],
			['What are other outlets reporting about this story?', 'web_search'],
			['Search the web for broader coverage of Ontario housing policy', 'web_search'],
			['Open this dynamic page and click the latest release', 'browser_automation'],
			[
				'Verify this police release against official sources and what other outlets are reporting: https://example.com/story',
				'hybrid_research'
			],
			['Summarize this', 'clarification_needed']
		] as const;

		const matches = samples.filter(([prompt, expected]) => routeNewsroomRequest(prompt).selected_mode === expected);
		expect(matches.length / samples.length).toBeGreaterThanOrEqual(0.8);
		expect(matches).toHaveLength(samples.length);
	});

	it('enforces hard budget counters before tool calls', () => {
		const ledger = new ToolBudgetLedger(
			mergeToolBudget({
				max_total_tool_calls: 2,
				max_custom_tool_calls: 1,
				max_web_searches: 1,
				max_browser_tasks: 1
			})
		);

		ledger.consume('custom');
		expect(ledger.canUse('custom')).toMatchObject({ ok: false, reason: 'max_custom_tool_calls exhausted' });
		expect(ledger.canUse('web_search')).toMatchObject({ ok: true });
		ledger.consume('web_search');
		expect(ledger.canUse('browser_automation')).toMatchObject({ ok: false, reason: 'max_total_tool_calls exhausted' });
		expect(ledger.snapshot().usage.total_tool_calls).toBe(2);
	});

	it('registers and calls custom tools dynamically', async () => {
		const registry = new ToolRegistry();
		for (const name of ['assignment_notes', 'slug_lookup', 'source_ranker']) {
			registry.register(stubTool(name, 'custom', `Evidence from ${name}`));
		}

		expect(registry.list().map((tool) => tool.name)).toEqual(['assignment_notes', 'slug_lookup', 'source_ranker']);
		const outputs = await Promise.all(
			registry.list().map((tool) =>
				tool.run({}, {
					prompt: 'test',
					decision: routeNewsroomRequest('Use internal custom tool for this brief'),
					config: { ...defaultAgentConfig(), enabled_tools: registry.list().map((candidate) => candidate.name) },
					evidence: [],
					budget: new ToolBudgetLedger(mergeToolBudget()).snapshot()
				})
			)
		);
		expect(outputs).toHaveLength(3);
		expect(outputs.every((output) => output.status === 'ok' && output.evidence?.length === 1)).toBe(true);
	});

	it('normalizes tool output into evidence objects', () => {
		const evidence = normalizeEvidence({
			source_name: 'Toronto Police Service',
			source_url: 'https://www.tps.ca/media-centre/news-releases/',
			accessed_at: '2026-05-20T12:00:00.000Z',
			tool_used: 'configured_source_monitor',
			title: 'TPS news releases',
			published_at: null,
			extracted_text: 'Police said details were not specified in the release.',
			confidence: 0.8,
			limitations: []
		});

		expect(evidence).toMatchObject({
			source_name: 'Toronto Police Service',
			source_url: 'https://www.tps.ca/media-centre/news-releases/',
			accessed_at: '2026-05-20T12:00:00.000Z',
			tool_used: 'configured_source_monitor',
			title: 'TPS news releases',
			published_at: null,
			confidence: 0.8,
			limitations: [],
			source_kind: 'official'
		});
		expect(evidence.summary).toContain('Police said');
	});

	it('generates final answers from evidence with attribution, uncertainty, and police/legal caution', () => {
		const decision = routeNewsroomRequest('Check the latest Toronto Police releases');
		const evidence = [
			normalizeEvidence({
				source_name: 'Toronto Police Service',
				source_url: 'https://www.tps.ca/media-centre/news-releases/item/123',
				accessed_at: '2026-05-20T12:00:00.000Z',
				tool_used: 'configured_source_monitor',
				title: 'Police release about an arrest',
				published_at: '2026-05-20T10:00:00.000Z',
				extracted_text: 'Police said a person was arrested and charged. The allegations have not been tested in court.',
				confidence: 0.9,
				limitations: [],
				source_kind: 'official'
			}),
			normalizeEvidence({
				source_name: 'Local News Outlet',
				source_url: 'https://example.com/story',
				accessed_at: '2026-05-20T12:05:00.000Z',
				tool_used: 'openai_web_search',
				title: 'Outlet reports related coverage',
				published_at: '2026-05-20T11:00:00.000Z',
				extracted_text: 'The outlet reported additional neighbourhood reaction.',
				confidence: 0.6,
				limitations: ['Verify against the source page.'],
				source_kind: 'media_report'
			})
		];

		const answer = generateFinalAnswer({
			prompt: 'Check the latest Toronto Police releases',
			decision,
			evidence,
			limitations: [],
			budget: new ToolBudgetLedger(mergeToolBudget()).snapshot()
		});

		expect(answer).toContain('## Summary');
		expect(answer).toContain('[Police release about an arrest](https://www.tps.ca/media-centre/news-releases/item/123)');
		expect(answer).toContain('published 2026-05-20T10:00:00.000Z');
		expect(answer).toContain('Police/legal caution');
		expect(answer).toContain('media report');
		expect(answer).toContain('Tool budget used');
	});

	it('does not exceed the configured tool budget during a hybrid run', async () => {
		const registry = new ToolRegistry();
		registry.register(stubTool('configured_source_monitor', 'source_monitor', 'Official release evidence'));
		registry.register(stubTool('source_feed_fetcher', 'source_feed_fetcher', 'Direct source evidence'));
		registry.register(stubTool('openai_web_search', 'web_search_provider', 'Other outlet evidence'));
		const agent = new DisciplinedNewsroomAgent({
			registry,
			config: {
				...defaultAgentConfig(),
				enabled_tools: ['configured_source_monitor', 'source_feed_fetcher', 'openai_web_search'],
				default_tool_budget: mergeToolBudget({ max_total_tool_calls: 1, max_custom_tool_calls: 1 })
			}
		});

		const result = await agent.run(
			'Verify this police release against official sources and what other outlets are reporting: https://example.com/story'
		);

		expect(result.tool_calls).toHaveLength(1);
		expect(result.budget.usage.total_tool_calls).toBe(1);
		expect(result.limitations).toContain('max_total_tool_calls exhausted');
		expect(result.final_answer.length).toBeGreaterThan(0);
	});

	it('returns a clear limitation when a selected source is unavailable', async () => {
		const registry = new ToolRegistry();
		registry.register(unavailableTool('configured_source_monitor', 'source_monitor'));
		const agent = new DisciplinedNewsroomAgent({
			registry,
			config: {
				...defaultAgentConfig(),
				enabled_tools: ['configured_source_monitor']
			}
		});

		const result = await agent.run('Check the latest Toronto Police releases');

		expect(result.tool_calls).toHaveLength(1);
		expect(result.final_answer).toContain('not have enough sourced evidence');
		expect(result.limitations).toContain('Fixture source unavailable');
	});

	it('finishes finite runs even when tools return no useful evidence', async () => {
		const registry = new ToolRegistry();
		registry.register(emptyTool('configured_source_monitor', 'source_monitor'));
		const agent = new DisciplinedNewsroomAgent({
			registry,
			config: {
				...defaultAgentConfig(),
				enabled_tools: ['configured_source_monitor'],
				default_tool_budget: mergeToolBudget({ max_total_tool_calls: 6 })
			}
		});

		const result = await agent.run('Check the latest Toronto Police releases');

		expect(result.tool_calls).toHaveLength(1);
		expect(result.budget.usage.total_tool_calls).toBe(1);
		expect(result.final_answer.length).toBeGreaterThan(0);
	});
});

function stubTool(name: string, category: ToolCategory, text: string): NewsroomTool {
	return {
		name,
		description: `${name} stub`,
		when_to_use: 'test only',
		category,
		input_schema: { type: 'object' },
		output_schema: { type: 'object' },
		async run() {
			return {
				status: 'ok',
				evidence: [
					normalizeEvidence({
						source_name: name,
						source_url: `newsroom://${name}`,
						accessed_at: '2026-05-20T12:00:00.000Z',
						tool_used: name,
						title: name,
						published_at: null,
						extracted_text: text,
						summary: text,
						confidence: 0.7,
						limitations: [],
						source_kind: category === 'web_search_provider' ? 'media_report' : 'official'
					})
				]
			};
		}
	};
}

function unavailableTool(name: string, category: ToolCategory): NewsroomTool {
	return {
		...stubTool(name, category, ''),
		async run() {
			return { status: 'unavailable', limitations: ['Fixture source unavailable'] };
		}
	};
}

function emptyTool(name: string, category: ToolCategory): NewsroomTool {
	return {
		...stubTool(name, category, ''),
		async run() {
			return { status: 'ok', evidence: [] };
		}
	};
}

function defaultAgentConfig() {
	return {
		enabled_tools: [],
		default_tool_budget: mergeToolBudget(),
		source_priority: ['official', 'primary', 'source_monitor', 'internal', 'media_report', 'unknown'] as const,
		routing_rules: {},
		stop_conditions: [],
		required_citation_behavior: {
			citations_required_for_research: true,
			list_sources: true,
			preserve_timestamps: true,
			flag_conflicts: true,
			distinguish_official_sources: true,
			answer_with_limitations_when_incomplete: true
		},
		source_monitors: [],
		web_search_model: 'gpt-5'
	};
}
