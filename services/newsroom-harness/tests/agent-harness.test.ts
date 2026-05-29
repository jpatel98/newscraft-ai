import { describe, expect, it } from 'vitest';
import { AssignmentDesk } from '../src/agents/assignment-desk.js';
import { generateFinalAnswer } from '../src/agents/answer.js';
import { mergeToolBudget, ToolBudgetLedger } from '../src/agents/budget.js';
import { normalizeEvidence } from '../src/agents/evidence.js';
import { DisciplinedNewsroomAgent } from '../src/agents/newsroom-agent.js';
import { routeNewsroomRequest } from '../src/agents/router.js';
import { ToolRegistry, type NewsroomTool, type ToolCategory } from '../src/agents/tools.js';
import { assessSourceQuality } from '../src/util/source-quality.js';

describe('disciplined newsroom agent harness', () => {
	it('triages editor commands through the Assignment Desk stub', () => {
		const decision = new AssignmentDesk().triage('Who is the mayor of Toronto?');

		expect(decision.role).toBe('research');
		expect(decision.route.selected_mode).toBe('web_search');
		expect(decision.event).toMatchObject({
			agent: 'assignment_desk',
			kind: 'assignment.triaged',
			payload: {
				routed_role: 'research',
				selected_mode: 'web_search',
				tools_to_use: ['openai_web_search']
			}
		});
	});

	it('keeps intent-driven desks for drafting, verification, and monitoring', () => {
		const desk = new AssignmentDesk();
		expect(desk.triage('Draft a headline for this story').role).toBe('production');
		expect(desk.triage('Verify this claim against sources').role).toBe('verification');
		expect(desk.triage('Monitor the police feed for changes').role).toBe('monitoring');
	});

	it('routes sample prompts to expected modes with at least 80% accuracy', () => {
		const samples = [
			['What is a nut graf?', 'answer_from_memory'],
			['Use the newsroom brief generator for these notes: council approved a pilot.', 'custom_tool'],
			['Summarize the latest mission output', 'custom_tool'],
			['Check the latest Toronto Police releases and summarize anything newsworthy', 'source_monitor'],
			['Scan our configured source monitors for updates', 'source_monitor'],
			['Latest Mark Carney news', 'web_search'],
			['what are the gas prices in toronto tomorrow', 'web_search'],
			['can you find gas prices in Toronto for the past week and present it to me as a table?', 'web_search'],
			['Who is the mayor of Toronto?', 'web_search'],
			['What happened at city hall this week?', 'web_search'],
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
		expect(
			routeNewsroomRequest(
				'Verify this police release against official sources and what other outlets are reporting: https://example.com/story'
			).tools_to_use
		).toEqual(['configured_source_monitor', 'openai_web_search']);
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

	it('classifies blocked, boilerplate, and nav-only source text as unusable', () => {
		expect(
			assessSourceQuality({
				title: 'Just a moment...',
				text: 'Enable JavaScript and cookies to continue',
				statusCode: 403
			})
		).toMatchObject({ usable: false, state: 'blocked_unusable' });

		expect(
			assessSourceQuality({
				title: 'Just a moment...',
				text: 'Just a moment... Checking your browser before accessing the site. Cloudflare'
			})
		).toMatchObject({ usable: false, state: 'boilerplate_unusable' });

		expect(
			assessSourceQuality({
				title: 'News Releases & Other Resources',
				text: 'News Releases & Other Resources - City of Toronto Skip to content I want to... Search Menu'
			})
		).toMatchObject({ usable: false, state: 'nav_unusable' });

		expect(
			assessSourceQuality({
				title: 'Mission report copied into source',
				text: [
					'## Summary',
					'No publishable lead was found in this run.',
					'## Lead Candidates',
					'No lead candidates met the source threshold.',
					'## Source Notes',
					'Tool budget used: configured_source_monitor.'
				].join('\n')
			})
		).toMatchObject({ usable: false, state: 'recycled_report_unusable' });

		expect(
			assessSourceQuality({
				title: 'Repeated outlet boilerplate',
				text: Array.from({ length: 10 }, () => 'Subscribe now Sign in Search Menu Newsletter alerts').join('\n')
			})
		).toMatchObject({ usable: false, state: 'repeated_boilerplate_unusable' });

		expect(
			assessSourceQuality({
				title: 'NewsCraft Local Fixture',
				text: 'City desk confirms river inspection. Officials scheduled a levee inspection after overnight rain. Editors should verify timing with the public works office.'
			})
		).toMatchObject({ usable: true, state: 'usable' });
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
		expect(answer).not.toContain('Tool budget used');
	});

	it('treats latest as the freshest usable result even when it is not from today', () => {
		const decision = routeNewsroomRequest('Latest Mark Carney news');
		const answer = generateFinalAnswer({
			prompt: 'Latest Mark Carney news',
			decision,
			evidence: [
				normalizeEvidence({
					source_name: 'Official archive',
					source_url: 'https://example.com/official-old',
					accessed_at: '2026-05-27T13:00:00.000Z',
					tool_used: 'configured_source_monitor',
					title: 'Older official background',
					published_at: '2026-05-25T12:00:00.000Z',
					extracted_text: 'Older official background about Mark Carney.',
					confidence: 0.9,
					limitations: [],
					source_kind: 'official'
				}),
				normalizeEvidence({
					source_name: 'Newswire',
					source_url: 'https://example.com/carney-last-night',
					accessed_at: '2026-05-27T13:00:00.000Z',
					tool_used: 'openai_web_search',
					title: 'Carney update from last night',
					published_at: '2026-05-26T23:15:00.000Z',
					extracted_text: 'The latest readable report from last night says Carney met provincial officials.',
					confidence: 0.7,
					limitations: ['Verify against primary sources before publication.'],
					source_kind: 'media_report'
				})
			],
			limitations: [],
			budget: new ToolBudgetLedger(mergeToolBudget()).snapshot()
		});

		expect(answer).toContain('The freshest usable source found in this run was published 2026-05-26T23:15:00.000Z');
		expect(answer.indexOf('Carney update from last night')).toBeLessThan(answer.indexOf('Older official background'));
		expect(answer).not.toContain('No publishable lead was found');
	});

	it('uses a compact answer shape for chat source runs', () => {
		const decision = routeNewsroomRequest('latest on gas prices in GTA');
		const answer = generateFinalAnswer({
			prompt: 'latest on gas prices in GTA',
			decision,
			evidence: [
				normalizeEvidence({
					source_name: 'CityNews',
					source_url: 'https://toronto.citynews.ca/toronto-gta-gas-prices',
					accessed_at: '2026-05-27T13:00:00.000Z',
					tool_used: 'openai_web_search',
					title: 'Toronto & GTA Gas Prices',
					published_at: null,
					extracted_text: 'GTA pump prices are expected to hold today.',
					summary: 'GTA pump prices are expected to hold today.',
					confidence: 0.7,
					limitations: [],
					source_kind: 'media_report'
				})
			],
			limitations: [],
			budget: new ToolBudgetLedger(mergeToolBudget()).snapshot(),
			toolAnswers: ['GTA pump prices are expected to hold today, according to the CityNews fuel tracker.'],
			outputStyle: 'chat'
		});

		expect(answer).toContain('GTA pump prices are expected to hold today');
		expect(answer).toContain('Sources:');
		expect(answer).not.toContain('## Lead Candidates');
		expect(answer).not.toContain('## Source Notes');
		expect(answer).not.toContain('Human Review');
	});

	it('preserves requested tables in compact chat source runs', () => {
		const decision = routeNewsroomRequest('can you find gas prices in Toronto for the past week and present it to me as a table?');
		const answer = generateFinalAnswer({
			prompt: 'can you find gas prices in Toronto for the past week and present it to me as a table?',
			decision,
			evidence: [
				normalizeEvidence({
					source_name: 'CityNews',
					source_url: 'https://toronto.citynews.ca/toronto-gta-gas-prices',
					accessed_at: '2026-05-27T13:00:00.000Z',
					tool_used: 'openai_web_search',
					title: 'Toronto & GTA Gas Prices',
					published_at: null,
					extracted_text: 'Toronto pump prices over the past week.',
					summary: 'Toronto pump prices over the past week.',
					confidence: 0.7,
					limitations: [],
					source_kind: 'media_report'
				})
			],
			limitations: [],
			budget: new ToolBudgetLedger(mergeToolBudget()).snapshot(),
			toolAnswers: ['| Date | Price |\n|---|---:|\n| 2026-05-21 | 145.9 cents/L |\n| 2026-05-22 | 137.9 cents/L |'],
			outputStyle: 'chat'
		});

		expect(answer).toContain('| Date | Price |');
		expect(answer).toContain('| 2026-05-22 | 137.9 cents/L |');
		expect(answer).not.toContain('## Lead Candidates');
	});

	it('keeps evidence-heavy reports compact instead of repeating every source body', () => {
		const decision = routeNewsroomRequest('What are the latest Canada stories today?');
		const repeated = 'Slug: Canada-clean-electricity-strategy Date: May 14, 2026 Description: '.repeat(25);
		const evidence = Array.from({ length: 20 }, (_, index) =>
			normalizeEvidence({
				source_name: `Outlet ${index}`,
				source_url: `https://example.com/story-${index}`,
				accessed_at: '2026-05-21T12:00:00.000Z',
				tool_used: 'openai_web_search',
				title: `Story ${index}`,
				published_at: null,
				extracted_text: repeated,
				summary: repeated,
				confidence: 0.65,
				limitations: [],
				source_kind: 'media_report'
			})
		);

		const answer = generateFinalAnswer({
			prompt: 'What are the latest Canada stories today?',
			decision,
			evidence,
			limitations: [],
			budget: new ToolBudgetLedger(mergeToolBudget()).snapshot()
		});

		expect(answer).toContain('additional usable sources were recorded');
		expect(answer.length).toBeLessThan(9000);
		expect(answer.match(/Canada-clean-electricity-strategy/g)?.length ?? 0).toBeLessThan(20);
	});

	it('does not turn homepage headline blobs into report prose', () => {
		const decision = routeNewsroomRequest('Track competitor coverage across Canadian politics and energy');
		const homepageBlob =
			'Alberta’s referendum question could chill private investment, expert says Canada 11 mins 3 min read. globalnews.ca/news/11860428/alberta-referendum-pipeline-investment/ Alberta must be at the centre of making Canada better, Carney says Canada 5 hours 2 min read. globalnews.ca/news/11860220/alberta-separatism-referendum-mark-carney/ Canadian couples want money for wedding gifts to buy a home: survey';
		const answer = generateFinalAnswer({
			prompt: 'Track competitor coverage across Canadian politics and energy',
			decision,
			evidence: [
				normalizeEvidence({
					source_name: 'Global News',
					source_url: 'https://globalnews.ca/',
					accessed_at: '2026-05-22T19:31:04.249Z',
					tool_used: 'configured_source_monitor',
					title: 'Global News | Breaking, Latest News and Video for Canada',
					published_at: null,
					extracted_text: homepageBlob,
					summary: homepageBlob,
					confidence: 0.7,
					limitations: [],
					source_kind: 'media_report'
				}),
				normalizeEvidence({
					source_name: 'CTV News',
					source_url: 'https://www.ctvnews.ca/',
					accessed_at: '2026-05-22T19:31:04.174Z',
					tool_used: 'configured_source_monitor',
					title: 'CTV News - Breaking News and Video, Canada News Today',
					published_at: null,
					extracted_text:
						'Canada Revenue Agency to require public servants in office 4 days a week. ctvnews.ca/ottawa/article/canada-revenue-agency-office-four-days-week-union/ One runner’s journey to return to Ottawa Race Weekend after beating cancer.',
					summary:
						'Canada Revenue Agency to require public servants in office 4 days a week. ctvnews.ca/ottawa/article/canada-revenue-agency-office-four-days-week-union/ One runner’s journey to return to Ottawa Race Weekend after beating cancer.',
					confidence: 0.7,
					limitations: [],
					source_kind: 'media_report'
				})
			],
			limitations: [],
			budget: new ToolBudgetLedger(mergeToolBudget()).snapshot()
		});

		expect(answer).toContain('This run found 2 usable sources for editor review.');
		expect(answer).toContain('**Global News | Breaking, Latest News and Video for Canada**');
		expect(answer).toContain('[Global News | Breaking, Latest News and Video for Canada](https://globalnews.ca/)');
		expect(answer).not.toContain('Alberta must be at the centre');
		expect(answer).not.toContain('Canadian couples want money');
		expect(answer).not.toContain('3 min read');
	});

	it('does not turn blocked source evidence into a lead candidate', () => {
		const decision = routeNewsroomRequest('Check the latest City of Toronto releases');
		const answer = generateFinalAnswer({
			prompt: 'Check the latest City of Toronto releases',
			decision,
			evidence: [
				normalizeEvidence({
					source_name: 'City of Toronto',
					source_url: 'https://www.toronto.ca/news/',
					accessed_at: '2026-05-21T14:08:22.000Z',
					tool_used: 'configured_source_monitor',
					title: 'Just a moment...',
					published_at: null,
					extracted_text: 'Enable JavaScript and cookies to continue',
					summary: 'Enable JavaScript and cookies to continue',
					confidence: 0,
					limitations: ['Source could not be read during this run.'],
					source_kind: 'official'
				})
			],
			limitations: ['Source returned HTTP 403'],
			budget: new ToolBudgetLedger(mergeToolBudget()).snapshot()
		});

		expect(answer).toContain('No publishable lead was found');
		expect(answer).toContain('No lead candidates');
		expect(answer).not.toContain('Enable JavaScript');
		expect(answer).not.toContain('HTTP 403');
		expect(answer).not.toContain('Tool budget used');
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
		expect(result.final_answer).toContain('No publishable lead was found');
		expect(result.limitations).toContain('Fixture source unavailable');
	});

	it('returns a clean no-lead report when configured sources fail and search is unavailable', async () => {
		const registry = new ToolRegistry();
		registry.register(unavailableTool('configured_source_monitor', 'source_monitor'));
		registry.register(unavailableTool('openai_web_search', 'web_search_provider'));
		const agent = new DisciplinedNewsroomAgent({
			registry,
			config: {
				...defaultAgentConfig(),
				enabled_tools: ['configured_source_monitor', 'openai_web_search']
			}
		});

		const result = await agent.run('Check the latest City of Toronto releases');

		expect(result.tool_calls.map((call) => call.name)).toEqual(['configured_source_monitor', 'openai_web_search']);
		expect(result.final_answer).toContain('No publishable lead was found');
		expect(result.final_answer).not.toMatch(/Tool budget used|job_|SDK|API|database|harness|HTTP/i);
	});

	it('uses web-search fallback evidence when configured sources fail', async () => {
		const registry = new ToolRegistry();
		registry.register(unavailableTool('configured_source_monitor', 'source_monitor'));
		registry.register(stubTool('openai_web_search', 'web_search_provider', 'Other outlet reports that council will revisit the item next week.'));
		const agent = new DisciplinedNewsroomAgent({
			registry,
			config: {
				...defaultAgentConfig(),
				enabled_tools: ['configured_source_monitor', 'openai_web_search']
			}
		});

		const result = await agent.run('Check the latest City of Toronto releases');

		expect(result.tool_calls.map((call) => call.name)).toEqual(['configured_source_monitor', 'openai_web_search']);
		expect(result.final_answer).toContain('## Lead Candidates');
		expect(result.final_answer).toContain('media report');
		expect(result.final_answer).toContain('Secondary or media source material is available');
		expect(result.final_answer).not.toContain('No publishable lead was found');
	});

	it('uses web-search fallback evidence when a configured source tool errors', async () => {
		const registry = new ToolRegistry();
		registry.register(errorTool('configured_source_monitor', 'source_monitor'));
		registry.register(
			stubTool('openai_web_search', 'web_search_provider', 'CTV and CBC are both leading with federal energy policy reaction.')
		);
		const agent = new DisciplinedNewsroomAgent({
			registry,
			config: {
				...defaultAgentConfig(),
				enabled_tools: ['configured_source_monitor', 'openai_web_search']
			}
		});

		const result = await agent.run('Check the latest City of Toronto releases');

		expect(result.tool_calls.map((call) => call.name)).toEqual(['configured_source_monitor', 'openai_web_search']);
		expect(result.final_answer).toContain('## Lead Candidates');
		expect(result.final_answer).toContain('CTV and CBC');
		expect(result.final_answer).not.toContain('No publishable lead was found');
	});

	it('summarizes saved mission output before reusing it as evidence', async () => {
		const hugeMarkdown = [
			'## Summary',
			'This is the reusable part.',
			'## Source Notes',
			'Unique tail marker should not survive compacting. '.repeat(200)
		].join('\n');
		const agent = new DisciplinedNewsroomAgent({
			config: {
				...defaultAgentConfig(),
				enabled_tools: ['mission_result_reader']
			}
		});

		const result = await agent.run('Summarize the latest mission output', {
			repository: {
				listReports: () => [
					{
						id: 'report-1',
						run_id: 'run-1',
						job_id: 'job-1',
						title: 'Saved report',
						markdown: hugeMarkdown,
						created_at: '2026-05-21T12:00:00.000Z',
						ingest_status: 'sent',
						ingest_error: null
					}
				]
			} as any
		});

		expect(result.evidence[0]?.extracted_text.length).toBeLessThanOrEqual(901);
		expect(result.final_answer).toContain('Saved report');
		expect(result.final_answer).not.toContain('Unique tail marker should not survive compacting');
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

function errorTool(name: string, category: ToolCategory): NewsroomTool {
	return {
		...stubTool(name, category, ''),
		async run() {
			return { status: 'error', limitations: ['Fixture source error'] };
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
