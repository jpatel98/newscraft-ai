import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToolBudgetLedger, mergeToolBudget } from '../src/agents/budget.js';
import { cleanVisibleChatOutput, generateFinalAnswer } from '../src/agents/answer.js';
import { createDefaultToolRegistry } from '../src/agents/default-tools.js';
import { classifyEvidenceSource, normalizeEvidence } from '../src/agents/evidence.js';
import { createNewsroomAgentConfig } from '../src/agents/harness-config.js';
import { createModelPolicyConfig } from '../src/agents/model-policy.js';
import { NEWSROOM_TOOL_NAMES, routeNewsroomRequest } from '../src/agents/router.js';
import type { ToolRunContext } from '../src/agents/tools.js';

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe('citation and source-quality web research', () => {
	it('preserves more than eight Sonar citations in marker order with metadata', async () => {
		const urls = Array.from({ length: 12 }, (_, index) => `https://www.reuters.com/world/story-${index + 1}`);
		vi.stubGlobal(
			'fetch',
			vi.fn(async () =>
				jsonResponse({
					choices: [{ message: { content: 'A sourced answer [1] [12].' } }],
					citations: urls,
					search_results: [...urls].reverse().map((url) => {
						const number = Number(url.match(/story-(\d+)/)?.[1]);
						return {
							url,
							title: `Reuters story ${number}`,
							snippet: `Supporting excerpt ${number}`,
							date: number === 12 ? undefined : `2026-07-${String(number).padStart(2, '0')}`
						};
					})
				})
			)
		);

		const result = await runWebSearch('Compare reporting on semiconductor manufacturing');

		expect(result.evidence).toHaveLength(12);
		expect(result.evidence?.map((source) => source.source_url)).toEqual(urls);
		expect(result.evidence?.map((source) => source.citation_number)).toEqual(
			Array.from({ length: 12 }, (_, index) => index + 1)
		);
		expect(result.evidence?.[0]).toMatchObject({
			title: 'Reuters story 1',
			published_at: '2026-07-01',
			source_kind: 'news_report'
		});
		expect(result.evidence?.[11]).toMatchObject({ title: 'Reuters story 12', published_at: null });
	});

	it('keeps a distinct evidence record for every Sonar marker even when URLs repeat', async () => {
		const repeatedUrl = 'https://www.reuters.com/world/repeated-source';
		vi.stubGlobal(
			'fetch',
			vi.fn(async () =>
				jsonResponse({
					choices: [{ message: { content: 'Two claims use the same source [1] [2].' } }],
					citations: [repeatedUrl, repeatedUrl],
					search_results: [{ url: repeatedUrl, title: 'Repeated Reuters source', date: '2026-07-10' }]
				})
			)
		);

		const result = await runWebSearch('Compare two claims in current reporting');

		expect(result.evidence?.map((source) => source.citation_number)).toEqual([1, 2]);
		expect(result.evidence?.map((source) => source.source_url)).toEqual([repeatedUrl, repeatedUrl]);
	});

	it('turns OpenAI URL annotations into ordered markers and excludes action-only sources', async () => {
		const urls = Array.from({ length: 9 }, (_, index) => `https://www.reuters.com/world/annotated-${index + 1}`);
		const segments = urls.map((_, index) => `Claim ${index + 1} uses source ${index + 1}`);
		const text = `${segments.join('. ')}.`;
		let cursor = 0;
		const annotations = segments.map((segment, index) => {
			const start = text.indexOf(segment, cursor);
			const end = start + segment.length;
			cursor = end;
			return {
				type: 'url_citation',
				url: urls[index],
				title: `Reuters annotated ${index + 1}`,
				start_index: start,
				end_index: end
			};
		});
		vi.stubGlobal(
			'fetch',
			vi.fn(async () =>
				jsonResponse({
					output_text: text,
					output: [
						{
							type: 'web_search_call',
							action: {
								sources: [
									{
										url: 'https://example.com/action-only',
										title: 'Action-only source'
									}
								]
							}
						},
						{
							type: 'message',
							content: [{ type: 'output_text', text, annotations }]
						}
					],
					search_results: urls.map((url, index) => ({
						url,
						title: `Search result ${index + 1}`,
						snippet: `Supporting excerpt ${index + 1}`,
						date: `2026-07-${String(index + 1).padStart(2, '0')}`
					}))
				})
			)
		);

		const result = await runWebSearch('Summarize annotated OpenAI coverage', { provider: 'openai' });

		expect(result.answer).toContain('source 1 [1]');
		expect(result.answer).toContain('source 9 [9]');
		expect(result.answer).not.toContain('[10]');
		expect(result.evidence).toHaveLength(9);
		expect(result.evidence?.map((source) => source.citation_number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
		expect(result.evidence?.map((source) => source.source_url)).toEqual(urls);
		expect(result.evidence?.some((source) => source.source_url === 'https://example.com/action-only')).toBe(false);
	});

	it('preserves meaningful query-string and fragment identity for OpenAI annotations', async () => {
		const urls = [
			'https://example.com/story?edition=morning',
			'https://example.com/story?edition=evening',
			'https://example.com/story?edition=morning#correction'
		];
		const segments = ['Morning edition claim', 'Evening edition claim', 'Correction fragment claim'];
		const text = `${segments.join('. ')}.`;
		vi.stubGlobal(
			'fetch',
			vi.fn(async () =>
				jsonResponse({
					output_text: text,
					output: [
						{
							type: 'message',
							content: [
								{
									type: 'output_text',
									text,
									annotations: annotationFixtures(text, segments, urls)
								}
							]
						}
					],
					search_results: urls.map((url, index) => ({
						url,
						title: `Exact source ${index + 1}`,
						snippet: `Supporting excerpt ${index + 1}`
					}))
				})
			)
		);

		const result = await runWebSearch('Summarize annotated OpenAI source identity', { provider: 'openai' });

		expect(result.answer).toContain('Morning edition claim [1]');
		expect(result.answer).toContain('Evening edition claim [2]');
		expect(result.answer).toContain('Correction fragment claim [3]');
		expect(result.evidence?.map((source) => source.source_url)).toEqual(urls);
		expect(result.evidence?.map((source) => source.citation_number)).toEqual([1, 2, 3]);
	});

	it('dedupes exact and tracking-only repeated OpenAI annotations without losing visible resolution', async () => {
		const canonical = 'https://example.com/story?id=123#section';
		const tracking = 'https://example.com/story?id=123&utm_source=newscraft#section';
		const repeated = 'https://example.com/other?id=456';
		const segments = ['First exact-source claim', 'Tracking duplicate claim', 'Repeated annotation claim', 'Repeated annotation follow-up'];
		const text = `${segments.join('. ')}.`;
		vi.stubGlobal(
			'fetch',
			vi.fn(async () =>
				jsonResponse({
					output_text: text,
					output: [
						{
							type: 'message',
							content: [
								{
									type: 'output_text',
									text,
									annotations: annotationFixtures(text, segments, [canonical, tracking, repeated, repeated])
								}
							]
						}
					],
					search_results: [
						{ url: canonical, title: 'Canonical source', snippet: 'Canonical evidence' },
						{ url: repeated, title: 'Repeated source', snippet: 'Repeated evidence' }
					]
				})
			)
		);

		const result = await runWebSearch('Summarize repeated annotated OpenAI source identity', {
			provider: 'openai'
		});

		expect(result.answer).toContain('First exact-source claim [1]');
		expect(result.answer).toContain('Tracking duplicate claim [1]');
		expect(result.answer).toContain('Repeated annotation claim [2]');
		expect(result.answer).toContain('Repeated annotation follow-up [2]');
		expect(result.evidence?.map((source) => source.citation_number)).toEqual([1, 2]);
		expect(result.evidence?.map((source) => source.source_url)).toEqual([canonical, repeated]);
	});

	it('retains raw URLs when the user asks for direct links', () => {
		const answer = 'Direct link: https://example.com/story?story=1 [1].';

		expect(cleanVisibleChatOutput(answer, 'Give me the direct URLs for the citations.')).toContain(
			'https://example.com/story?story=1'
		);
		expect(cleanVisibleChatOutput(answer, 'Summarize the story.')).not.toContain('https://example.com/story');
	});

	it('classifies web sources independently with the journalist source contract', () => {
		expect(classifyEvidenceSource('City of Toronto', 'https://www.toronto.ca/news/mayor-statement')).toBe('official');
		expect(classifyEvidenceSource('FIFA match schedule', 'https://www.fifa.com/tournaments/schedule')).toBe('primary');
		expect(classifyEvidenceSource('Reuters', 'https://www.reuters.com/world/example')).toBe('news_report');
		expect(classifyEvidenceSource('ESPN schedule', 'https://www.espn.com/soccer/schedule')).toBe('news_report');
		expect(classifyEvidenceSource('Reporter post', 'https://x.com/reporter/status/123')).toBe('social_post');
		expect(classifyEvidenceSource('Ticketmaster', 'https://www.ticketmaster.ca/event/123')).toBe('commercial');
		expect(classifyEvidenceSource('Ticket schedule', 'https://www.ticketmaster.ca/schedule/123')).toBe('commercial');
		expect(classifyEvidenceSource('Match schedule', 'https://example.test/schedule')).toBe('unknown');
		expect(classifyEvidenceSource('Independent report', 'https://example.test/report')).toBe('unknown');
		expect(classifyEvidenceSource('Research roundup', 'https://example.test/research')).toBe('unknown');
		expect(classifyEvidenceSource('Public records index', 'https://example.test/records')).toBe('unknown');
		expect(classifyEvidenceSource('City of Toronto official statement', 'https://example.test/statement')).toBe(
			'unknown'
		);
		expect(classifyEvidenceSource('Police update', 'https://police.example.test/update')).toBe('unknown');
		expect(classifyEvidenceSource('Unfamiliar source', 'https://example.test/item')).toBe('unknown');
	});

	it('adds named-domain and explicit recency filters only to Sonar requests', async () => {
		const fetchMock = vi.fn(async () =>
			jsonResponse({
				choices: [{ message: { content: 'Coverage differs in emphasis.' } }],
				citations: ['https://www.cbc.ca/news/story'],
				search_results: [{ url: 'https://www.cbc.ca/news/story', title: 'CBC News story', date: '2026-07-10' }]
			})
		);
		vi.stubGlobal('fetch', fetchMock);

		await runWebSearch('Compare CBC and CTV coverage today', {
			newsroomContext: {
				timezone: 'America/Vancouver',
				homeMarket: 'Vancouver',
				preferredDomains: ['thetyee.ca']
			}
		});
		await runWebSearch('Compare Reuters and AP coverage this week');

		const todayBody = requestBody(fetchMock, 0);
		expect(todayBody.search_domain_filter).toEqual(['cbc.ca', 'ctvnews.ca']);
		expect(todayBody.search_recency_filter).toBe('day');
		expect(JSON.stringify(todayBody.messages)).toContain('America/Vancouver');
		expect(JSON.stringify(todayBody.messages)).toContain('Vancouver');
		expect(JSON.stringify(todayBody.messages)).toContain('thetyee.ca');
		expect(JSON.stringify(todayBody.messages)).toContain('Do not add a Current as of label');
		expect(JSON.stringify(todayBody.messages)).toContain('Never present either as a source publication date');

		const weekBody = requestBody(fetchMock, 1);
		expect(weekBody.search_domain_filter).toEqual(['reuters.com', 'apnews.com']);
		expect(weekBody.search_recency_filter).toBe('week');

		fetchMock.mockClear();
		await runWebSearch('Compare CBC and CTV coverage today', { provider: 'openai' });
		const openAiBody = requestBody(fetchMock, 0);
		expect(openAiBody).not.toHaveProperty('search_domain_filter');
		expect(openAiBody).not.toHaveProperty('search_recency_filter');
		expect(openAiBody.tools).toEqual([{ type: 'web_search' }]);
	});

	it('runs one bounded official-source retry for a high-risk schedule without primary evidence', async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				jsonResponse({
					choices: [{ message: { content: 'A report lists a match [1].' } }],
					citations: ['https://www.reuters.com/sports/reported-match'],
					search_results: [
						{ url: 'https://www.reuters.com/sports/reported-match', title: 'Reported match', date: '2026-07-10' }
					]
				})
			)
			.mockResolvedValueOnce(
				jsonResponse({
					choices: [{ message: { content: 'The official schedule lists the match [1].' } }],
					citations: ['https://www.fifa.com/tournaments/match-center'],
					search_results: [
						{
							url: 'https://www.fifa.com/tournaments/match-center',
							title: 'FIFA match schedule',
							date: '2026-07-10'
						}
					]
				})
			);
		vi.stubGlobal('fetch', fetchMock);

		const result = await runWebSearch('what fifa games are being played today');

		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(requestBody(fetchMock, 1)).toMatchObject({
			search_domain_filter: ['fifa.com'],
			search_recency_filter: 'day'
		});
		expect(result.answer).toBe('The official schedule lists the match [1].');
		expect(result.evidence).toEqual([
			expect.objectContaining({
				source_url: 'https://www.fifa.com/tournaments/match-center',
				source_kind: 'primary',
				citation_number: 1,
				published_at: '2026-07-10'
			})
		]);
	});

	it('labels a high-risk schedule as unconfirmed when only commercial evidence is available', () => {
		const prompt = 'What games are on the schedule today?';
		const answer = generateFinalAnswer({
			prompt,
			decision: routeNewsroomRequest(prompt),
			evidence: [
				normalizeEvidence({
					source_name: 'Ticket seller',
					source_url: 'https://www.ticketmaster.ca/schedule/123',
					tool_used: NEWSROOM_TOOL_NAMES.webSearch,
					title: 'Match listing',
					extracted_text: 'A ticket listing says the match starts at 7 PM.',
					summary: 'A ticket listing says the match starts at 7 PM.',
					confidence: 0.7,
					limitations: [],
					source_kind: 'commercial',
					citation_number: 1
				})
			],
			limitations: [],
			budget: new ToolBudgetLedger(mergeToolBudget()).snapshot(),
			toolAnswers: ['A ticket listing says the match starts at 7 PM [1].'],
			outputStyle: 'chat'
		});

		expect(answer).toContain('could not confirm this from a readable official or primary source');
	});
});

describe('private document evidence', () => {
	it('emits page-level user-document evidence with stable citation numbers and no network request', async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);
		const context = toolContext('Summarize the uploaded PDF', {
			documents: [
				{
					id: 'doc-1',
					filename: 'council-report.pdf',
					downloadUrl: '/api/conversations/conversation-1/documents/doc-1/download',
					pageCount: 2,
					pages: [
						{ pageNumber: 1, text: 'Council staff recommend approving the pilot.' },
						{ pageNumber: 2, text: 'The estimated first-year cost is $2 million.' }
					]
				},
				{
					id: 'doc-2',
					filename: 'appendix.pdf',
					pageCount: 1,
					pages: [{ pageNumber: 7, text: 'The appendix lists the affected wards.' }]
				}
			]
		});

		const tool = createDefaultToolRegistry().require(NEWSROOM_TOOL_NAMES.pdfTextExtractor);
		const result = await tool.run({ url: null, text: null }, context);

		expect(fetchMock).not.toHaveBeenCalled();
		expect(result.evidence?.map((source) => source.citation_number)).toEqual([1, 2, 3]);
		expect(result.evidence).toEqual([
			expect.objectContaining({
				title: 'council-report.pdf, page 1',
				document_page: 1,
				source_kind: 'user_document',
				published_at: null
			}),
			expect.objectContaining({ title: 'council-report.pdf, page 2', document_page: 2 }),
			expect.objectContaining({ title: 'appendix.pdf, page 7', document_page: 7 })
		]);
	});

	it('does not invoke web research for attached documents unless external corroboration is requested', async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);
		const tool = createDefaultToolRegistry().require(NEWSROOM_TOOL_NAMES.webSearch);
		const result = await tool.run(
			{ query: 'Summarize the uploaded document' },
			toolContext('Summarize the uploaded document', {
				documents: [{ id: 'doc-1', filename: 'report.pdf', pageCount: 1, pages: [{ pageNumber: 1, text: 'Text' }] }]
			})
		);

		expect(result).toEqual({ status: 'ok', evidence: [] });
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

async function runWebSearch(
	query: string,
	options: {
		provider?: 'perplexity' | 'openai';
		newsroomContext?: ToolRunContext['newsroomContext'];
	} = {}
) {
	const provider = options.provider || 'perplexity';
	const tool = createDefaultToolRegistry().require(NEWSROOM_TOOL_NAMES.webSearch);
	return tool.run(
		{ query },
		toolContext(query, {
			provider,
			newsroomContext: options.newsroomContext
		})
	);
}

function toolContext(
	prompt: string,
	options: {
		provider?: 'perplexity' | 'openai';
		newsroomContext?: ToolRunContext['newsroomContext'];
		documents?: ToolRunContext['documents'];
	} = {}
): ToolRunContext {
	const provider = options.provider || 'perplexity';
	const openAiModelPolicy = createModelPolicyConfig({
		models: {
			nano: 'openai/gpt-5-mini',
			mini: 'openai/gpt-5-mini',
			standard: 'openai/gpt-5-mini',
			web_search: 'openai/gpt-5-mini'
		}
	});
	const config = createNewsroomAgentConfig({
		enabled_tools: [NEWSROOM_TOOL_NAMES.webSearch, NEWSROOM_TOOL_NAMES.pdfTextExtractor],
		model_provider: provider,
		planner_enabled: false,
		...(provider === 'openai' ? { model_policy: openAiModelPolicy, web_search_model: 'openai/gpt-5-mini' } : {})
	});
	return {
		prompt,
		decision: routeNewsroomRequest(prompt),
		config,
		evidence: [],
		budget: new ToolBudgetLedger(mergeToolBudget()).snapshot(),
		modelProvider: provider,
		modelApiKey: 'fake-key',
		openAiApiKey: provider === 'openai' ? 'fake-key' : '',
		trigger: 'test',
		newsroomContext: options.newsroomContext,
		documents: options.documents
	};
}

function jsonResponse(value: unknown): Response {
	return new Response(JSON.stringify(value), {
		status: 200,
		headers: { 'content-type': 'application/json' }
	});
}

function annotationFixtures(text: string, segments: string[], urls: string[]) {
	let cursor = 0;
	return segments.map((segment, index) => {
		const start = text.indexOf(segment, cursor);
		const end = start + segment.length;
		cursor = end;
		return {
			type: 'url_citation',
			url: urls[index],
			title: `Annotated source ${index + 1}`,
			start_index: start,
			end_index: end
		};
	});
}

function requestBody(fetchMock: ReturnType<typeof vi.fn>, index: number): Record<string, any> {
	const init = fetchMock.mock.calls[index]?.[1] as RequestInit | undefined;
	return JSON.parse(String(init?.body || '{}')) as Record<string, any>;
}
