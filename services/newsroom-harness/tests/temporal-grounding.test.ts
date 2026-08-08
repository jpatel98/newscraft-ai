import { describe, expect, it } from 'vitest';
import { normalizeEvidence, preparePublishableEvidence } from '../src/agents/evidence.js';
import { DisciplinedNewsroomAgent } from '../src/agents/newsroom-agent.js';
import { NEWSROOM_TOOL_NAMES } from '../src/agents/router.js';
import { createNewsroomTemporalContext, formatNewsroomTemporalContext } from '../src/agents/time-context.js';
import { ToolRegistry, type NewsroomTool } from '../src/agents/tools.js';

const frozenNow = new Date('2026-07-31T17:20:00.000Z');
const temporal = createNewsroomTemporalContext({ now: frozenNow, timeZone: 'America/Toronto' });

describe('request-scoped temporal grounding and citation integrity', () => {
	it('uses the frozen Jul 31 Toronto date and classifies discovery versus publishable evidence', () => {
		expect(temporal.localDate).toBe('2026-07-31');
		expect(temporal.windowStart).toBe('2026-07-31T04:00:00.000Z');
		expect(formatNewsroomTemporalContext(temporal)).toContain('Local newsroom date: 2026-07-31');

		const prepared = preparePublishableEvidence(fixtureEvidence(), temporal, true);
		expect(prepared.accepted.map((item) => item.title)).toEqual([
			'Toronto transit service restored',
			'City emergency status',
			'Ontario housing announcement'
		]);
		expect(prepared.accepted.map((item) => item.temporal_scope)).toEqual(['primary', 'primary', 'fallback']);
		expect(prepared.accepted.map((item) => item.citation_number)).toEqual([1, 2, 3]);
		expect(prepared.excluded.map((item) => item.title)).toEqual(expect.arrayContaining([
			'July 27 consulate shooting',
			'Toronto News',
			'Reddit Toronto lead',
			'Toronto City Council schedule PDF'
		]));
	});

	it('keeps date-only current articles and labels readable unknown-date articles as partial evidence', () => {
		const dateOnly = normalizeEvidence({
			source_name: 'Toronto Star',
			source_kind: 'news_report',
			source_url: 'https://www.thestar.com/news/gta/date-only-current-story.html',
			title: 'Date-only current Toronto story',
			published_at: '2026-07-31',
			extracted_text: 'The outlet published a consequential Toronto update on the current local newsroom date.',
			summary: 'A consequential Toronto update published on the current local newsroom date.',
			accessed_at: frozenNow.toISOString(),
			tool_used: NEWSROOM_TOOL_NAMES.webSearch,
			confidence: 0.8,
			limitations: []
		});
		const unknownDate = normalizeEvidence({
			source_name: 'CBC News',
			source_kind: 'news_report',
			source_url: 'https://www.cbc.ca/news/canada/toronto/readable-current-lead-1.1',
			title: 'Readable Toronto lead with unknown publication time',
			published_at: null,
			extracted_text: 'CBC reports a new Toronto development, but the provider did not return its publication time.',
			summary: 'A readable, citation-linked Toronto development with an unknown publication time.',
			supporting_excerpt: 'CBC reports a new Toronto development, but the provider did not return its publication time.',
			citation_number: 1,
			accessed_at: frozenNow.toISOString(),
			tool_used: NEWSROOM_TOOL_NAMES.webSearch,
			confidence: 0.7,
			limitations: []
		});

		const prepared = preparePublishableEvidence([dateOnly, unknownDate], temporal, true);

		expect(prepared.excluded).toHaveLength(0);
		expect(prepared.accepted).toEqual([
			expect.objectContaining({ title: dateOnly.title, temporal_scope: 'primary', ledger_status: 'accepted' }),
			expect.objectContaining({
				title: unknownDate.title,
				temporal_scope: 'background',
				ledger_status: 'accepted',
				uncertainty: expect.arrayContaining(['publication time unknown'])
			})
		]);
		expect(prepared.accepted[1].limitations.join(' ')).toContain('do not present this source as confirmed');
	});

	it('synthesizes three search passes once and assigns only contiguous supporting citations', async () => {
		const registry = new ToolRegistry();
		const batches = [fixtureEvidence().slice(0, 3), fixtureEvidence().slice(3, 5), fixtureEvidence().slice(5)];
		const seenTemporalContracts: unknown[] = [];
		let pass = 0;
		const searchTool: NewsroomTool<{ query: string }> = {
			name: NEWSROOM_TOOL_NAMES.webSearch,
			description: 'fixture search',
			when_to_use: 'fixture search',
			category: 'web_search_provider',
			input_schema: { type: 'object' },
			output_schema: { type: 'object' },
			async run(_input, context) {
				seenTemporalContracts.push(context.temporalContext);
				const evidence = batches[pass++] || [];
				return { status: 'ok', evidence, answer: `SEARCH MINI-ANSWER ${pass} [1]` };
			}
		};
		registry.register(searchTool);

		const agent = new DisciplinedNewsroomAgent({
			registry,
			clock: () => frozenNow,
			modelProvider: 'openai',
			modelApiKey: 'fixture-key',
			config: {
				enabled_tools: [NEWSROOM_TOOL_NAMES.webSearch],
				default_tool_budget: {
					max_total_tool_calls: 3,
					max_custom_tool_calls: 0,
					max_web_searches: 3,
					max_browser_tasks: 0,
					max_runtime_seconds: 10
				}
			},
			planner: async (request) => ({
				source: 'model',
				reason: 'three bounded coverage passes',
				steps: ['top stories', 'public impact', 'other coverage'].map((input) => ({
					tool: NEWSROOM_TOOL_NAMES.webSearch,
					input,
					label: `Searching ${input}`
				}))
			})
		});

		const result = await agent.run('Latest Toronto news', {
			forcePlanner: true,
			modelProvider: 'openai',
			modelApiKey: 'fixture-key',
			outputStyle: 'chat',
			newsroomContext: { timezone: 'America/Toronto' }
		});

		expect(result.tool_calls).toHaveLength(3);
		expect(seenTemporalContracts).toEqual([temporal, temporal, temporal]);
		expect(result.final_answer).toContain('## Latest producer roundup');
		expect(result.final_answer).not.toContain('SEARCH MINI-ANSWER');
		expect(result.final_answer).not.toContain('July 27 consulate shooting');
		expect(result.final_answer).not.toContain('Reddit Toronto lead');
		expect(result.final_answer).toContain('Earlier (last 24 hours)');
		const markers = Array.from(result.final_answer.matchAll(/\[(\d+)\]/g), (match) => Number(match[1]));
		// Citation numbers are assigned after editorial selection, so first visible
		// appearance is always the canonical [1], [2], [3] sequence.
		expect(markers).toEqual([1, 2, 3]);
		const evidenceNumbers = result.evidence.map((item) => item.citation_number);
		expect([...evidenceNumbers].sort((left, right) => (left || 0) - (right || 0))).toEqual([1, 2, 3]);
		expect(result.evidence.every((item) => Boolean(item.evidence_id))).toBe(true);
	});

	it('does not reproduce the citation-17 council-PDF mismatch', () => {
		const prepared = preparePublishableEvidence(fixtureEvidence(), temporal, true);
		const pdf = prepared.excluded.find((item) => item.title === 'Toronto City Council schedule PDF');
		expect(pdf?.page_role).toBe('document');
		expect(pdf?.citation_number).toBeUndefined();
		expect(prepared.accepted.some((item) => item.source_url.endsWith('/council-schedule.pdf'))).toBe(false);
	});
});

function fixtureEvidence() {
	const make = (input: Parameters<typeof normalizeEvidence>[0]) => normalizeEvidence({
		accessed_at: frozenNow.toISOString(),
		tool_used: NEWSROOM_TOOL_NAMES.webSearch,
		confidence: 0.9,
		limitations: [],
		...input
	});
	return [
		make({
			source_name: 'CBC News', source_kind: 'news_report',
			source_url: 'https://cbc.ca/news/canada/toronto/transit-restored-1.1',
			title: 'Toronto transit service restored', published_at: '2026-07-31T16:30:00.000Z',
			extracted_text: 'Toronto transit service was restored after a morning interruption.',
			summary: 'Toronto transit service was restored after a morning interruption.'
		}),
		make({
			source_name: 'City of Toronto', source_kind: 'official', page_role: 'official_live',
			source_url: 'https://toronto.ca/status/emergency', title: 'City emergency status', published_at: null,
			extracted_text: 'The city status page reports no active city-wide emergency.',
			summary: 'The city status page reports no active city-wide emergency.'
		}),
		make({
			source_name: 'Global News', source_kind: 'news_report',
			source_url: 'https://globalnews.ca/news/ontario-housing-announcement/',
			title: 'Ontario housing announcement', published_at: '2026-07-30T20:00:00.000Z',
			extracted_text: 'Ontario announced a housing funding change late Wednesday.',
			summary: 'Ontario announced a housing funding change late Wednesday.'
		}),
		make({
			source_name: 'Toronto outlet', source_kind: 'news_report',
			source_url: 'https://example.com/toronto/consulate-shooting', title: 'July 27 consulate shooting',
			published_at: '2026-07-27T14:00:00.000Z', extracted_text: 'Police investigated a shooting on July 27.',
			summary: 'Police investigated a shooting on July 27.'
		}),
		make({
			source_name: 'CTV News', source_kind: 'news_report', source_url: 'https://ctvnews.ca/toronto',
			title: 'Toronto News', published_at: null, extracted_text: 'Toronto section landing page.',
			summary: 'Toronto section landing page.'
		}),
		make({
			source_name: 'Reddit', source_kind: 'social_post', source_url: 'https://reddit.com/r/toronto/comments/lead',
			title: 'Reddit Toronto lead', published_at: '2026-07-31T15:00:00.000Z',
			extracted_text: 'A forum user posted an unverified claim.', summary: 'A forum user posted an unverified claim.'
		}),
		make({
			source_name: 'City of Toronto', source_kind: 'official',
			source_url: 'https://toronto.ca/legdocs/council-schedule.pdf', title: 'Toronto City Council schedule PDF',
			published_at: null, extracted_text: 'A council meeting schedule document.', summary: 'A council meeting schedule document.'
		})
	];
}
