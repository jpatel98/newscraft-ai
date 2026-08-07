import { describe, expect, it } from 'vitest';
import {
	decomposeResearchRequirements,
	deriveResearchRequestContract,
	mergeLatestResearchContract,
	type ResearchRequestContract
} from '@newscraft/shared';
import {
	clusterEvidence,
	normalizeEvidence,
	type EvidenceObject
} from '../src/agents/evidence.js';
import { DisciplinedNewsroomAgent } from '../src/agents/newsroom-agent.js';
import { researchActionKey } from '../src/agents/planner.js';
import { filterEvidenceForResearchContract } from '../src/agents/research-policy.js';
import { ToolRegistry, type NewsroomTool, type ToolRunOutput } from '../src/agents/tools.js';

const NOW = '2026-08-05T16:00:00.000Z';
const EXACT_PRODUCTION_PROMPT =
	'What are the latest developing stories in Toronto? And give me the latest developing stories in Ontario. And then one for Canada national, and then one for international.';

const STORY_FIXTURES: Record<string, Array<{ id: string; title: string; body: string; publishers: string[] }>> = {
	Toronto: [
		{
			id: 'transit',
			title: 'Toronto transit expansion announced',
			body: 'Toronto transit officials announced an expansion that changes service on two routes and begins this week.',
			publishers: ['CBC News', 'CP24']
		},
		{
			id: 'housing',
			title: 'Toronto housing intake changes approved',
			body: 'Toronto council approved housing intake changes after a public vote, with the new process taking effect this week.',
			publishers: ['Global News']
		},
		{
			id: 'health',
			title: 'Toronto health network opens urgent clinic',
			body: 'A Toronto health network opened an urgent clinic and described the staffing plan for residents this week.',
			publishers: ['CityNews']
		}
	],
	Ontario: [
		{
			id: 'wildfire',
			title: 'Ontario wildfire response expands',
			body: 'Ontario expanded its wildfire response after crews reported new activity and issued a public safety update today.',
			publishers: ['Global News', 'CTV News']
		},
		{
			id: 'schools',
			title: 'Ontario schools add heat protections',
			body: 'Ontario school boards added heat protections for students and published implementation guidance this week.',
			publishers: ['CBC News']
		},
		{
			id: 'energy',
			title: 'Ontario energy regulator opens review',
			body: 'Ontario energy officials opened a review and asked utilities to provide updated reliability information today.',
			publishers: ['CityNews']
		}
	],
	Canada: [
		{
			id: 'federal-budget',
			title: 'Canada federal budget talks resume',
			body: 'Federal officials resumed Canada budget talks and said the next negotiating session will focus on housing measures.',
			publishers: ['CBC News', 'Reuters']
		}
	],
	International: [
		{
			id: 'shipping',
			title: 'International shipping corridor reopens',
			body: 'An international shipping corridor reopened after authorities announced a monitored safety arrangement today.',
			publishers: ['BBC', 'Reuters']
		}
	]
};

describe('general multi-requirement research architecture', () => {
	it('decomposes the complete latest turn and preserves every requested scope and count', () => {
		const contract = deriveResearchRequestContract(EXACT_PRODUCTION_PROMPT, {
			timezone: 'America/Toronto',
			homeMarket: 'Toronto'
		});
		const requirements = contract.requirements || [];

		expect(requirements.map((requirement) => [requirement.label, requirement.requestedItemCount, requirement.level])).toEqual([
			['Toronto local', 3, 'local'],
			['Ontario provincial', 3, 'provincial'],
			['Canada national', 1, 'national'],
			['International', 1, 'international']
		]);
		expect(contract.outputType).toBe('producer_roundup');
		expect(requirements.every((requirement) => requirement.temporalWindow.kind === 'current')).toBe(true);
		expect(decomposeResearchRequirements(EXACT_PRODUCTION_PROMPT, { timezone: 'America/Toronto' })).toHaveLength(4);

		const countries = deriveResearchRequestContract('Give me two latest stories in France, and five latest stories in Japan.', {
			timezone: 'America/Toronto'
		});
		expect(countries.requirements?.map((requirement) => [requirement.geography, requirement.requestedItemCount])).toEqual([
			['France', 2],
			['Japan', 5]
		]);

		const localAndInternational = deriveResearchRequestContract(
			'Give me four local stories in Toronto and one international story about shipping.',
			{ timezone: 'America/Toronto' }
		);
		expect(localAndInternational.requirements?.map((requirement) => requirement.level)).toEqual(['local', 'international']);
		const internationalRequirement = localAndInternational.requirements?.find((requirement) => requirement.level === 'international');
		const foreignCountryEvidence = fixtureArticle(
			'France shipping corridor reopens',
			'https://reuters.example/world/france-shipping-corridor',
			'Reuters',
			'Authorities in France reopened a shipping corridor after announcing a monitored safety arrangement.',
			'France',
			internationalRequirement?.id
		);
		expect(filterEvidenceForResearchContract([foreignCountryEvidence], localAndInternational).accepted).toHaveLength(1);

		const named = deriveResearchRequestContract('Give me two stories in Toronto from CBC and CP24, and one international story from Reuters.', {
			timezone: 'America/Toronto'
		});
		expect(named.namedOutlets).toEqual(expect.arrayContaining(['CBC', 'CP24', 'Reuters']));
		expect(named.requirements?.every((requirement) => requirement.namedOutlets.length > 0)).toBe(true);
	});

	it('supports replacement, removal, and correction turns without dropping neighboring requirements', () => {
		const base = deriveResearchRequestContract(EXACT_PRODUCTION_PROMPT, { timezone: 'America/Toronto' });
		const followUp = mergeLatestResearchContract(base, 'Correction: replace Ontario with Quebec and remove international.', {
			timezone: 'America/Toronto'
		});
		expect(followUp.requirements?.map((requirement) => requirement.label)).toEqual([
			'Toronto local',
			'Quebec provincial',
			'Canada national'
		]);

		const correction = mergeLatestResearchContract(base, 'Correction: exclude sports, allow fewer than requested, and require direct official sources.', {
			timezone: 'America/Toronto'
		});
		expect(correction.requirements?.every((requirement) => requirement.excludedCategories.includes('sports'))).toBe(true);
		expect(correction.allowFewerThanRequested).toBe(true);
		expect(correction.requiredOutputFields).toContain('direct_article_or_official_citations');
	});

	it('renders one truthful section per requirement, honors counts, clusters duplicate coverage, and keeps citations contiguous', async () => {
		const result = await fixtureAgent().run(EXACT_PRODUCTION_PROMPT, { outputStyle: 'chat' });
		const contract = result.research_contract as ResearchRequestContract;
		const requirements = contract.requirements || [];

		expect(result.assignment_status).toBe('complete');
		expect(result.requirement_coverage.map((row) => [row.label, row.accepted_count, row.requested_count, row.state])).toEqual([
			['Toronto local', 3, 3, 'satisfied'],
			['Ontario provincial', 3, 3, 'satisfied'],
			['Canada national', 1, 1, 'satisfied'],
			['International', 1, 1, 'satisfied']
		]);
		expect(result.final_answer.match(/^### /gm)).toHaveLength(4);
		expect(result.final_answer).toContain('### Toronto local');
		expect(result.final_answer).toContain('### Ontario provincial');
		expect(result.final_answer).toContain('### Canada national');
		expect(result.final_answer).toContain('### International');
		expect(result.final_answer).toMatch(/Coverage: Complete — 3\/3 requested items/);
		expect(result.final_answer).toMatch(/Coverage: Complete — 1\/1 requested item/);
		expect(result.final_answer).toContain('What happened:');
		expect(result.final_answer).toContain('Why it matters:');
		expect(result.final_answer).toContain('Source time:');

		const torontoSection = section(result.final_answer, 'Toronto local', 'Ontario provincial');
		const ontarioSection = section(result.final_answer, 'Ontario provincial', 'Canada national');
		expect((torontoSection.match(/^- \*\*/gm) || []).length).toBe(3);
		expect((ontarioSection.match(/^- \*\*/gm) || []).length).toBe(3);
		expect(torontoSection).toContain('Toronto transit expansion announced');
		expect(torontoSection).not.toContain('Ontario wildfire response expands');
		expect(ontarioSection).toContain('Ontario wildfire response expands');
		expect(ontarioSection).not.toContain('Toronto transit expansion announced');

		const clusterWithCorroboration = result.story_clusters.find((cluster) => cluster.corroborating_evidence_ids.length > 0);
		expect(clusterWithCorroboration).toBeDefined();
		expect(clusterWithCorroboration?.evidence_ids.length).toBeGreaterThan(1);
		expect(result.evidence.map((item) => item.citation_number)).toEqual(
			Array.from({ length: result.evidence.length }, (_, index) => index + 1)
		);
		const markers = [...result.final_answer.matchAll(/\[(\d+)\]/g)].map((match) => Number(match[1]));
		expect(markers.every((number) => result.evidence.some((item) => item.citation_number === number))).toBe(true);
		expect(requirements.every((requirement) =>
			result.evidence.filter((item) => item.requirement_ids?.includes(requirement.id)).every((item) =>
				!requirement.geography || item.location === requirement.geography
			)
		)).toBe(true);
	});

	it('keeps breadth visible when the shared budget exhausts or one lane has no readable source', async () => {
		const budgetResult = await fixtureAgent('complete', 2).run(EXACT_PRODUCTION_PROMPT, { outputStyle: 'chat' });
		expect(budgetResult.assignment_status).toBe('exhausted');
		expect(budgetResult.final_answer).toContain('### International');
		expect(budgetResult.final_answer).not.toMatch(/8\/8 complete/i);
		expect(budgetResult.requirement_coverage.some((row) => row.state === 'skipped' || row.state === 'exhausted')).toBe(true);

		const unreadableResult = await fixtureAgent('unreadable', 4).run(EXACT_PRODUCTION_PROMPT, { outputStyle: 'chat' });
		const ontario = unreadableResult.requirement_coverage.find((row) => row.label === 'Ontario provincial');
		expect(unreadableResult.final_answer).toContain('### Ontario provincial');
		expect(unreadableResult.final_answer).toMatch(/Ontario provincial\nCoverage: Incomplete — 0\/3/);
		expect(ontario).toMatchObject({ accepted_count: 0, requested_count: 3 });
		expect(ontario?.state).not.toBe('satisfied');
	});

	it('clusters the same story across publishers while retaining corroborating evidence', () => {
		const contract = deriveResearchRequestContract('Give me the latest stories in Toronto.', { timezone: 'America/Toronto' });
		const requirementId = contract.requirements?.[0]?.id;
		const first = fixtureArticle('Toronto transit expansion announced', 'https://cbc.example/toronto/transit', 'CBC News', 'Toronto transit officials announced an expansion with details for riders.', 'Toronto', requirementId);
		const second = fixtureArticle('Toronto transit expansion announced', 'https://cp24.example/toronto/transit', 'CP24', 'Toronto transit officials announced an expansion with the same route changes.', 'Toronto', requirementId);
		const clustered = clusterEvidence([first, second]);
		expect(clustered.clusters).toHaveLength(1);
		expect(clustered.clusters[0].evidence_ids).toHaveLength(2);
		expect(clustered.clusters[0].corroborating_evidence_ids).toHaveLength(1);
		expect(clustered.evidence.every((item) => item.story_cluster_id === clustered.clusters[0].id)).toBe(true);
	});

	it('deduplicates semantically equivalent actions within a requirement and capability lane', () => {
		const shared = {
			tool: 'openai_web_search',
			requirementId: 'req_toronto',
			phase: 'discovery' as const,
			capability: 'web_search'
		};
		expect(researchActionKey({ ...shared, input: 'Search the latest Toronto stories' })).toBe(
			researchActionKey({ ...shared, input: 'Find current Toronto news' })
		);
		expect(researchActionKey({ ...shared, requirementId: 'req_ontario', input: 'Find current Toronto news' })).not.toBe(
			researchActionKey({ ...shared, input: 'Find current Toronto news' })
		);
	});
});

function fixtureAgent(mode: 'complete' | 'unreadable' = 'complete', maxWebSearches = 8): DisciplinedNewsroomAgent {
	const registry = new ToolRegistry();
	registry.register({
		name: 'openai_web_search',
		description: 'Deterministic multi-requirement fixture search',
		when_to_use: 'Test-only fixture coverage',
		category: 'web_search_provider',
		input_schema: { type: 'object' },
		output_schema: { type: 'object' },
		run: async (input): Promise<ToolRunOutput> => {
			const query = String((input as { query?: unknown }).query || '');
			if (mode === 'unreadable' && /Scope: Ontario\b/i.test(query)) {
				return { status: 'unavailable', limitations: ['No readable source was available for Ontario in this research pass.'] };
			}
			const scope = /Scope: Ontario\b/i.test(query)
				? 'Ontario'
				: /Scope: Canada\b/i.test(query)
					? 'Canada'
					: /Scope: international\b/i.test(query)
						? 'International'
						: 'Toronto';
			const evidence = (STORY_FIXTURES[scope] || []).flatMap((story) =>
				story.publishers.map((publisher, index) =>
					fixtureArticle(
						story.title,
						`https://${publisher.toLowerCase().replace(/[^a-z0-9]+/g, '')}.example/${scope.toLowerCase()}/${story.id}-${index + 1}`,
						publisher,
						story.body,
						scope
					)
				)
			);
			return { status: 'ok', evidence };
		}
	} satisfies NewsroomTool);
	return new DisciplinedNewsroomAgent({
		registry,
		clock: () => new Date(NOW),
		config: {
			enabled_tools: ['openai_web_search'],
			planner_enabled: false,
			default_tool_budget: {
				max_total_tool_calls: 20,
				max_custom_tool_calls: 0,
				max_web_searches: maxWebSearches,
				max_browser_tasks: 0,
				max_runtime_seconds: 30
			}
		}
	});
}

function fixtureArticle(
	title: string,
	url: string,
	publisher: string,
	body: string,
	location: string,
	requirementId?: string
): EvidenceObject {
	return normalizeEvidence({
		source_name: publisher,
		publisher,
		source_url: url,
		accessed_at: NOW,
		tool_used: 'fixture_web_search',
		title,
		published_at: NOW,
		extracted_text: body,
		summary: body,
		confidence: 0.95,
		limitations: [],
		source_kind: 'news_report',
		location,
		topic: 'latest developing stories',
		categories: ['general'],
		page_role: 'article',
		requirement_ids: requirementId ? [requirementId] : []
	});
}

function section(answer: string, label: string, nextLabel: string): string {
	const start = answer.indexOf(`### ${label}`);
	const end = answer.indexOf(`### ${nextLabel}`);
	return answer.slice(start, end < 0 ? undefined : end);
}
