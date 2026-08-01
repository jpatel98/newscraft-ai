import { describe, expect, it } from 'vitest';
import {
	deriveResearchRequestContract,
	mergeLatestResearchContract,
	type ConversationContext,
	type ResearchRequestContract
} from '@newscraft/shared';
import { draftNewsroomOcvoFromConversation } from '../src/agents/answer.js';
import { buildProducerCoverageLanes } from '../src/agents/coverage-planner.js';
import { classifyEvidencePageRole, normalizeEvidence, type EvidenceObject } from '../src/agents/evidence.js';
import { DisciplinedNewsroomAgent } from '../src/agents/newsroom-agent.js';
import { ToolRegistry, type NewsroomTool, type ToolCategory, type ToolRunOutput } from '../src/agents/tools.js';

const NOW = '2026-08-01T16:00:00.000Z';
const REQUEST =
	'Broad Toronto assignment-desk briefing requesting six verified non-sports stories published or updated today, with direct article/official citations; exclude sports, event listings, traffic aggregators, homepages, category pages, hubs, forums, Reddit and evergreen material.';
const VERBOSE_PRODUCER_REQUEST =
	'Act as a Toronto newsroom producer. Give me a same-day briefing for August 1, 2026 in America/Toronto of the latest consequential Toronto stories. Search broadly across major local outlets and official sources. Exclude sports. Return five to eight items, newest first, each with published or updated time, why it matters, and a direct article or official URL. Do not cite homepages, section pages, aggregators, social posts, or event listings. If coverage is incomplete, say what you found instead of failing.';

function contractFor(request = REQUEST): ResearchRequestContract {
	return deriveResearchRequestContract(request, { timezone: 'America/Toronto', homeMarket: 'Toronto' });
}

function article(input: {
	url: string;
	title: string;
	source: string;
	text: string;
	publishedAt?: string | null;
	location?: string;
	categories?: string[];
	pageRole?: EvidenceObject['page_role'];
	sourceKind?: EvidenceObject['source_kind'];
}): EvidenceObject {
	return normalizeEvidence({
		source_name: input.source,
		publisher: input.source,
		source_url: input.url,
		accessed_at: NOW,
		tool_used: 'fixture_web_search',
		title: input.title,
		published_at: input.publishedAt === undefined ? NOW : input.publishedAt,
		extracted_text: input.text,
		summary: input.text,
		confidence: 0.9,
		limitations: [],
		source_kind: input.sourceKind || 'news_report',
		location: input.location || 'Toronto',
		categories: input.categories || ['community'],
		page_role: input.pageRole || 'article'
	});
}

function stubSearchTool(run: (query: string, context: Parameters<NewsroomTool['run']>[1]) => ToolRunOutput): NewsroomTool {
	return {
		name: 'openai_web_search',
		description: 'Deterministic producer fixture search',
		when_to_use: 'Use for deterministic acceptance coverage.',
		category: 'web_search_provider' as ToolCategory,
		input_schema: { type: 'object' },
		output_schema: { type: 'object' },
		run: async (input, context) => run(String((input as { query?: string }).query || ''), context)
	};
}

function evidenceForLane(query: string): EvidenceObject[] {
	if (/Check official or first-party releases/i.test(query)) {
		return [
			article({
				url: 'https://www.toronto.ca/news/city-release-august-1',
				title: 'City of Toronto announces same-day housing intake changes',
				source: 'City of Toronto',
				text: 'The City of Toronto announced housing intake changes in a release issued today.',
				categories: ['government'],
				pageRole: 'official_live',
				sourceKind: 'official'
			}),
			article({
				url: 'https://www.ontario.ca/page/toronto-public-health-update-august-1',
				title: 'Ontario public health update for Toronto',
				source: 'Government of Ontario',
				text: 'Ontario published a public health update affecting Toronto residents today.',
				categories: ['health'],
				pageRole: 'official_live',
				sourceKind: 'official'
			})
		];
	}
	if (/Search (?:the relevant assignment desks|established local publishers across)/i.test(query)) {
		return [
			article({
				url: 'https://www.citynews.ca/2026/08/01/toronto-community-program',
				title: 'Toronto community program expands after city funding vote',
				source: 'CityNews',
				text: 'CityNews reports that a Toronto community program will expand after a funding vote today.',
				categories: ['community']
			}),
			article({
				url: 'https://www.cp24.com/news/toronto-schools-update-august-1',
				title: 'Toronto schools outline new support plan',
				source: 'CP24',
				text: 'CP24 reports that Toronto schools outlined a new student support plan today.',
				categories: ['education']
			})
		];
	}
	if (/Cross-check the strongest candidate stories/i.test(query)) {
		return [
			article({
				url: 'https://globalnews.ca/toronto/2026/08/01/transport-update',
				title: 'Toronto transit agency publishes service update',
				source: 'Global News',
				text: 'Global News reports that a Toronto transit agency published a service update today.',
				categories: ['transit']
			})
		];
	}
	return [
		article({
			url: 'https://www.cbc.ca/news/canada/toronto/council-housing-vote-1.000001',
			title: 'Toronto council approves a new housing measure',
			source: 'CBC News',
			text: 'CBC News reports that Toronto council approved a new housing measure today.',
			categories: ['government']
		}),
		article({
			url: 'https://www.ctvnews.ca/toronto/assignment/uncited-lead-1.000003',
			title: 'CTV News Toronto assignment lead',
			source: 'CTV News',
			text: 'CTV News has a Toronto assignment lead that needs direct page verification.',
			publishedAt: null,
			categories: ['community']
		})
	];
}

function excludedFixtureEvidence(): EvidenceObject[] {
	return [
		article({
			url: 'https://sports.example.com/toronto-baseball',
			title: 'Toronto baseball club wins tonight',
			source: 'Sports Desk',
			text: 'The Toronto baseball club won tonight.',
			categories: ['sports']
		}),
		article({
			url: 'https://events.example.com/toronto-calendar',
			title: 'Toronto event listing calendar',
			source: 'Event Calendar',
			text: 'A calendar listing for Toronto events.',
			categories: ['events'],
			pageRole: 'event_listing'
		}),
		article({
			url: 'https://traffic.example.com/toronto-traffic-map',
			title: 'Toronto traffic aggregator',
			source: 'Traffic Aggregator',
			text: 'A live traffic aggregator for Toronto roads.',
			categories: ['traffic'],
			pageRole: 'traffic_aggregator'
		}),
		article({
			url: 'https://cbc.ca/news',
			title: 'CBC News homepage',
			source: 'CBC News',
			text: 'CBC News homepage and section links.',
			categories: ['community'],
			pageRole: 'hub'
		}),
		article({
			url: 'https://forum.example.com/toronto-thread',
			title: 'Toronto forum thread',
			source: 'Forum',
			text: 'A forum discussion about Toronto.',
			categories: ['community'],
			pageRole: 'forum',
			sourceKind: 'social_post'
		}),
		article({
			url: 'https://montreal.example.com/story',
			title: 'Montreal story unrelated to Toronto',
			source: 'Montreal Desk',
			text: 'A Montreal story with no Toronto connection.',
			location: 'Montreal',
			categories: ['community']
		}),
		article({
			url: 'https://archive.example.com/toronto-evergreen',
			title: 'Evergreen Toronto background explainer',
			source: 'Archive Desk',
			text: 'Evergreen background material about Toronto.',
			publishedAt: '2025-01-01T12:00:00.000Z',
			categories: ['evergreen']
		})
	];
}

describe('producer-grade research architecture', () => {
	it('separates a verbose producer assignment from search and output instructions', () => {
		const contract = contractFor(VERBOSE_PRODUCER_REQUEST);
		expect(contract.subject).toBe('latest consequential Toronto stories');
		expect(contract).toMatchObject({
			location: 'Toronto',
			requestedItemCount: 8,
			allowFewerThanRequested: true
		});
		expect(contract.excludedCategories).toContain('sports');
		expect(contract.requiredOutputFields).toEqual(expect.arrayContaining([
			'direct_article_or_official_citations',
			'publication_time'
		]));

		const lanes = buildProducerCoverageLanes(contract, {
			homeMarket: 'Toronto',
			preferredDomains: ['cbc.ca', 'ctvnews.ca'],
			sourceProfile: { officialSourceDomains: ['toronto.ca'] }
		});
		expect(lanes[0].query).toContain('latest consequential Toronto stories');
		expect(lanes[0].query).toContain('cbc.ca, ctvnews.ca');
		expect(lanes[1].sourcePurpose).toBe('desk_focus');
		expect(lanes[2].query).toContain('toronto.ca');
		expect(lanes.every((lane) => !/Act as|Return five|Do not cite|coverage is incomplete/i.test(lane.query))).toBe(true);

		const boundedLanes = buildProducerCoverageLanes(contract, { homeMarket: 'Toronto' }, { maxLanes: 2 });
		expect(boundedLanes.map((lane) => lane.sourcePurpose)).toEqual(['major_publishers', 'desk_focus']);
		expect(boundedLanes[1].targetDesks).toEqual(expect.arrayContaining(['public safety', 'government', 'housing']));
	});

	it('accepts unfamiliar direct article paths without admitting hubs or documents', () => {
		expect(classifyEvidencePageRole(
			'https://localpublisher.example/news/toronto/council-approves-housing-measure',
			'Toronto council approves housing measure',
			'unknown'
		)).toBe('article');
		expect(classifyEvidencePageRole('https://localpublisher.example/news', 'Latest news', 'unknown')).toBe('hub');
		expect(classifyEvidencePageRole('https://localpublisher.example/files/council-report.pdf', 'Council report', 'unknown')).toBe('document');
	});

	it('derives a durable latest-turn contract and distinct compliant coverage lanes', () => {
		const contract = contractFor();
		expect(contract).toMatchObject({
			location: 'Toronto',
			requestedItemCount: 6,
			temporalWindow: { kind: 'current', phrase: 'today' },
			partialAnswerPolicy: 'verified_subset_with_leads'
		});
		expect(contract.excludedCategories).toContain('sports');
		expect(contract.excludedPageTypes).toEqual(expect.arrayContaining(['event_listing', 'traffic_aggregator', 'hub', 'homepage', 'category', 'forum']));
		expect(contract.excludedSourceTypes).toEqual(expect.arrayContaining(['forum', 'traffic_aggregator', 'event_listing', 'evergreen']));
		expect(contract.requiredOutputFields).toEqual(expect.arrayContaining(['direct_article_or_official_citations', 'publication_time']));

		const lanes = buildProducerCoverageLanes(contract, {
			timezone: 'America/Toronto',
			homeMarket: 'Toronto',
			preferredDomains: ['cbc.ca', 'ctvnews.ca'],
			sourceProfile: { officialSourceDomains: ['toronto.ca', 'ontario.ca'], relevantDesks: ['government', 'health'] }
		}, { maxLanes: 5 });
		expect(lanes.map((lane) => lane.sourcePurpose)).toEqual([
			'major_publishers',
			'desk_focus',
			'official_public_impact',
			'corroboration'
		]);
		expect(new Set(lanes.map((lane) => lane.query)).size).toBe(lanes.length);
		expect(lanes.every((lane) => !lane.targetDesks.some((desk) => /sports/i.test(desk)))).toBe(true);
	});

	it('lets a correction reinforce exclusions and permit a verified partial answer without changing the subject', () => {
		const base = contractFor();
		const corrected = mergeLatestResearchContract(base, 'Correction: reinforce excluding sports; allow fewer than six.', {
			timezone: 'America/Toronto'
		});
		expect(corrected.subject).toBe(base.subject);
		expect(corrected.location).toBe('Toronto');
		expect(corrected.excludedCategories).toContain('sports');
		expect(corrected.allowFewerThanRequested).toBe(true);
		expect(corrected.partialAnswerPolicy).toBe('verified_subset_with_leads');
	});

	it('returns only direct, in-window, diverse evidence and preserves useful uncited leads', async () => {
		const registry = new ToolRegistry();
		let calls = 0;
		registry.register(
			stubSearchTool((query) => {
				calls += 1;
				return {
					status: 'ok',
					evidence: [...evidenceForLane(query), ...excludedFixtureEvidence()],
					answer: 'The fixture search returned candidate stories [1].'
				};
			})
		);
		const agent = new DisciplinedNewsroomAgent({
			registry,
			clock: () => new Date(NOW),
			config: {
				enabled_tools: ['openai_web_search'],
				planner_enabled: false,
				default_tool_budget: { max_total_tool_calls: 6, max_custom_tool_calls: 1, max_web_searches: 4, max_browser_tasks: 1, max_runtime_seconds: 30 }
			}
		});
		const result = await agent.run(REQUEST, { outputStyle: 'chat' });

		expect(result.plan.steps[0]).toMatchObject({
			tool: 'configured_source_monitor',
			label: 'Scanning direct newsroom sources'
		});
		expect(calls).toBe(4);
		expect(result.evidence.length).toBe(6);
		expect(result.evidence.every((item) => item.page_role === 'article' || item.page_role === 'official_live')).toBe(true);
		expect(result.evidence.every((item) => !item.categories?.some((category) => /sports|event|traffic|evergreen/i.test(category)))).toBe(true);
		expect(result.evidence.every((item) => item.location === 'Toronto')).toBe(true);
		expect(new Set(result.evidence.map((item) => item.publisher || item.source_name)).size).toBeGreaterThanOrEqual(4);
		expect(result.evidence.every((item) => {
			const time = Date.parse(item.published_at || item.updated_at || '');
			return time >= Date.parse(result.research_contract?.temporalWindow.start || '') && time <= Date.parse(result.research_contract?.temporalWindow.end || '') + 5 * 60 * 1000;
		})).toBe(true);
		expect(result.discovery_leads?.some((item) => item.source_url === 'https://www.ctvnews.ca/toronto/assignment/uncited-lead-1.000003')).toBe(true);
		expect(result.evidence.some((item) => item.source_kind === 'official')).toBe(true);
		const citedNumbers = [...result.final_answer.matchAll(/\[(\d+)\]/g)].map((match) => Number(match[1]));
		expect(citedNumbers.every((number) => result.evidence.some((item) => item.citation_number === number))).toBe(true);
		expect(result.evidence.map((item) => item.citation_number)).toEqual(Array.from({ length: 6 }, (_, index) => index + 1));
		expect(result.final_answer).toContain('**Why it matters:**');
		expect(result.final_answer).toMatch(/Aug 1, 2026, \d{1,2}:\d{2} [ap]\.m\. EDT/);
	});

	it('gracefully returns a thin verified subset and stops after overlapping lanes', async () => {
		const registry = new ToolRegistry();
		let calls = 0;
		registry.register(
			stubSearchTool(() => {
				calls += 1;
				return {
					status: 'ok',
					evidence: [article({
						url: 'https://cbc.ca/news/toronto-only-story',
						title: 'Toronto verified assignment story',
						source: 'CBC News',
						text: 'CBC News reports one verified Toronto assignment story today.',
						categories: ['community']
					})],
					answer: 'One directly supported story [1].'
				};
			})
		);
		const agent = new DisciplinedNewsroomAgent({
			registry,
			clock: () => new Date(NOW),
			config: {
				enabled_tools: ['openai_web_search'],
				planner_enabled: false,
				default_tool_budget: { max_total_tool_calls: 6, max_custom_tool_calls: 1, max_web_searches: 4, max_browser_tasks: 1, max_runtime_seconds: 30 }
			}
		});
		const result = await agent.run(REQUEST, { outputStyle: 'chat' });

		expect(calls).toBe(3);
		expect(result.stopped_reason).toContain('coverage lanes overlapped');
		expect(result.plan.steps.some((step) => /Reformulated around an uncovered source lane/.test(step.detail || ''))).toBe(true);
		expect(result.limitations.some((item) => /Only 1 of 6 requested item/.test(item))).toBe(true);
	});

	it('preserves citation markers when transforming the strongest verified story into OC/VO', () => {
		const context: ConversationContext = {
			version: 1,
			intent: 'transform',
			activeTopic: { subject: 'Toronto housing measure today', location: 'Toronto', relevantDate: 'today' },
			lastSourceBackedAnswer: {
				messageId: 'answer-1',
				content: 'Toronto council approved a housing measure today [1]. The measure changes intake timing [1].',
				citations: [{
					citationNumber: 1,
					title: 'CBC housing article',
					url: 'https://cbc.ca/news/toronto/housing',
					domain: 'cbc.ca',
					sourceType: 'news_report',
					supportingExcerpt: 'Council approved the housing measure today.'
				}]
			}
		};
		const script = draftNewsroomOcvoFromConversation('Write a 20-second OC/VO from the strongest verified story.', context);
		expect(script).toMatch(/^ON CAM:/);
		expect(script).toContain('\n\nVO:');
		expect(script).toContain('[1]');
		expect(script).not.toContain('Sources');
	});
});
