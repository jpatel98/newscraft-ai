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
	vi.useRealTimers();
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

		const result = await runWebSearch('Compare two claims in reporting');

		expect(result.evidence?.map((source) => source.citation_number)).toEqual([1, 2]);
		expect(result.evidence?.map((source) => source.source_url)).toEqual([repeatedUrl, repeatedUrl]);
	});

	it('keeps dated evidence from the full requested seven-day window', async () => {
		const sixDaysAgo = new Date(Date.now() - 6 * 24 * 60 * 60 * 1000).toISOString();
		const url = 'https://www.canada.ca/en/news/policy-announcement.html';
		vi.stubGlobal(
			'fetch',
			vi.fn(async () =>
				jsonResponse({
					choices: [{ message: { content: 'The government announced the policy this week [1].' } }],
					citations: [url],
					search_results: [
						{
							url,
							title: 'Policy announcement',
							snippet: 'The government announced a new public policy.',
							date: sixDaysAgo
						}
					]
				})
			)
		);

		const result = await runWebSearch(
			'Build a policy roundup from the seven calendar days ending today.'
		);

		expect(result.evidence).toHaveLength(1);
		expect(result.evidence?.[0].published_at).toBe(sixDaysAgo);
	});

	it('aborts provider work at the shared web-search deadline', async () => {
		const fetchMock = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
			return new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener(
					'abort',
					() => reject(init.signal?.reason || new DOMException('Aborted', 'AbortError')),
					{ once: true }
				);
			});
		});
		vi.stubGlobal('fetch', fetchMock);

		const pending = runWebSearch('Verify this claim against official sources.', {
			signal: AbortSignal.timeout(20)
		});

		await expect(pending).rejects.toMatchObject({ name: 'TimeoutError' });
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('excludes encyclopedia results unless the user explicitly requests them', async () => {
		const officialUrl = 'https://www.who.int/news/item/17-10-2023-hospital-statement';
		const wikipediaUrl = 'https://en.wikipedia.org/wiki/Hospital_explosion';
		vi.stubGlobal(
			'fetch',
			vi.fn(async () =>
				jsonResponse({
					choices: [{ message: { content: 'WHO documented the blast [1]. Wikipedia summarizes competing claims [2].' } }],
					citations: [officialUrl, wikipediaUrl],
					search_results: [
						{ url: officialUrl, title: 'WHO statement', snippet: 'WHO documented the hospital blast.', date: '2023-10-17' },
						{ url: wikipediaUrl, title: 'Hospital explosion', snippet: 'Wikipedia summary.', date: '2023-10-18' }
					]
				})
			)
		);

		const result = await runWebSearch('Compare reputable reports about the hospital blast.');

		expect(result.evidence?.map((item) => item.source_url)).toEqual([officialUrl]);
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
		expect(result.answer).not.toContain('utm_source=');
		expect(result.evidence?.map((source) => source.citation_number)).toEqual([1, 2]);
		expect(result.evidence?.map((source) => source.source_url)).toEqual([canonical, repeated]);
	});

	it('drops empty provider query values from visible answers and evidence', async () => {
		const canonical = 'https://weather.gc.ca/warnings/report_e.html';
		const malformed = 'https://weather.gc.ca/warnings/report_e.html?on61=undefined';
		const segment = 'No alerts are in effect';
		const text = `${segment}. ${malformed}`;
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
									annotations: annotationFixtures(text, [segment], [malformed])
								}
							]
						}
					],
					search_results: [
						{ url: malformed, title: 'Toronto alerts', snippet: 'No alerts are in effect.' }
					]
				})
			)
		);

		const result = await runWebSearch('Check Toronto alerts now', { provider: 'openai' });

		expect(result.answer).toContain(canonical);
		expect(result.answer).not.toContain('undefined');
		expect(result.evidence?.[0]?.source_url).toBe(canonical);
	});

	it('preserves meaningful bare query parameters in exact source links', async () => {
		const direct = 'https://weather.gc.ca/warnings/report_e.html?on61';
		const segment = 'Toronto has no alerts in effect';
		const text = `${segment}.`;
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
									annotations: annotationFixtures(text, [segment], [direct])
								}
							]
						}
					],
					search_results: [{ url: direct, title: 'Toronto alerts', snippet: segment }]
				})
			)
		);

		const result = await runWebSearch('Check Toronto alerts now', { provider: 'openai' });

		expect(result.evidence?.[0]?.source_url).toBe(direct);
	});

	it('uses annotation order when mixed provider citation arrays disagree', async () => {
		const sourceA = 'https://example.com/source-a';
		const sourceB = 'https://example.com/source-b';
		const segments = ['Source A supports the first claim', 'Source B supports the second claim'];
		const sourceExcerpts = ['Primary source excerpt A', 'Primary source excerpt B'];
		const text = `${segments[0]}. ${segments[1]}.`;
		vi.stubGlobal(
			'fetch',
			vi.fn(async () =>
				jsonResponse({
					citations: [sourceB, sourceA],
					search_results: [
						{ url: sourceA, title: 'Source A', snippet: sourceExcerpts[0], date: '2026-07-27' },
						{ url: sourceB, title: 'Source B', snippet: sourceExcerpts[1], date: '2026-07-27' }
					],
					output_text: text,
					output: [
						{
							type: 'message',
							content: [
								{
									type: 'output_text',
									text,
									annotations: annotationFixtures(text, segments, [sourceA, sourceB])
								}
							]
						}
					]
				})
			)
		);

		const result = await runWebSearch('Compare two annotated claims', { provider: 'openai' });

		expect(result.answer).toContain(`${segments[0]} [1]`);
		expect(result.answer).toContain(`${segments[1]} [2]`);
		expect(result.evidence?.map((source) => source.source_url)).toEqual([sourceA, sourceB]);
		expect(result.evidence?.map((source) => source.citation_number)).toEqual([1, 2]);
		expect(result.evidence?.map((source) => source.extracted_text)).toEqual(sourceExcerpts);
	});

	it('removes provider citation markers when no source record can resolve them', () => {
		const prompt = 'Summarize the reported policy update.';
		const answer = generateFinalAnswer({
			prompt,
			decision: routeNewsroomRequest(prompt),
			evidence: [],
			limitations: ['No usable source links were returned.'],
			budget: new ToolBudgetLedger(mergeToolBudget()).snapshot(),
			toolAnswers: ['The policy changed today [1].'],
			outputStyle: 'chat'
		});

		expect(answer).toContain('The policy changed today.');
		expect(answer).not.toContain('[1]');
	});

	it('numbers mixed explicit and unnumbered evidence without leaving uncited claims', () => {
		const prompt = 'Summarize the confirmed update.';
		const evidence = [
			normalizeEvidence({
				source_name: 'Official source',
				source_url: 'https://example.gov/first',
				tool_used: NEWSROOM_TOOL_NAMES.webSearch,
				title: 'First update',
				extracted_text: 'The first official update is confirmed.',
				summary: 'The first official update is confirmed.',
				confidence: 0.9,
				limitations: [],
				source_kind: 'official',
				citation_number: 1
			}),
			normalizeEvidence({
				source_name: 'Second source',
				source_url: 'https://example.com/second',
				tool_used: NEWSROOM_TOOL_NAMES.urlFetchRead,
				title: 'Second update',
				extracted_text: 'The second direct update is confirmed.',
				summary: 'The second direct update is confirmed.',
				confidence: 0.9,
				limitations: [],
				source_kind: 'news_report'
			})
		];
		const answer = generateFinalAnswer({
			prompt,
			decision: routeNewsroomRequest(prompt),
			evidence,
			limitations: [],
			budget: new ToolBudgetLedger(mergeToolBudget()).snapshot(),
			outputStyle: 'chat'
		});

		expect(answer).toContain('[1]');
		expect(answer).toContain('[2]');
	});

	it('surfaces conflicting current-status evidence instead of choosing one source', () => {
		const prompt = 'What is the current Toronto weather alert status?';
		const evidence = [
			normalizeEvidence({
				source_name: 'Official alerts',
				source_url: 'https://weather.gc.ca/toronto/alerts',
				tool_used: NEWSROOM_TOOL_NAMES.webSearch,
				title: 'Toronto alerts',
				extracted_text: 'Toronto has no weather alerts in effect.',
				summary: 'Toronto has no weather alerts in effect.',
				confidence: 0.9,
				limitations: [],
				source_kind: 'official',
				citation_number: 1
			}),
			normalizeEvidence({
				source_name: 'Official warning',
				source_url: 'https://weather.gc.ca/toronto/warning',
				tool_used: NEWSROOM_TOOL_NAMES.webSearch,
				title: 'Toronto warning',
				extracted_text: 'A weather warning is active for Toronto.',
				summary: 'A weather warning is active for Toronto.',
				confidence: 0.9,
				limitations: [],
				source_kind: 'official',
				citation_number: 2
			})
		];
		const answer = generateFinalAnswer({
			prompt,
			decision: routeNewsroomRequest(prompt),
			evidence,
			limitations: [],
			budget: new ToolBudgetLedger(mergeToolBudget()).snapshot(),
			outputStyle: 'chat',
			conversationContext: {
				version: 1,
				intent: 'research',
				activeTopic: { subject: 'Toronto weather alert status', location: 'Toronto' }
			}
		});

			expect(answer).toContain('remains uncertain');
		expect(answer).toContain('conflict');
		expect(answer).toContain('[1]');
		expect(answer).toContain('[2]');
	});

	it('labels an explicitly requested missing publication date as unknown', () => {
		const prompt = 'What does the latest official notice say, and when was it published?';
		const evidence = [
			normalizeEvidence({
				source_name: 'Official notice',
				source_url: 'https://example.gov/notices/status',
				tool_used: NEWSROOM_TOOL_NAMES.urlFetchRead,
				title: 'Official status notice',
				extracted_text: 'The east entrance remains closed until further notice.',
				summary: 'The east entrance remains closed until further notice.',
				confidence: 0.9,
				limitations: [],
				source_kind: 'official',
				citation_number: 1,
				published_at: null
			})
		];
		const answer = generateFinalAnswer({
			prompt,
			decision: routeNewsroomRequest(prompt),
			evidence,
			limitations: [],
			budget: new ToolBudgetLedger(mergeToolBudget()).snapshot(),
			outputStyle: 'chat'
		});

		expect(answer).toContain('Publication date: Date unknown.');
	});

	it('retains raw URLs when the user asks for direct links', () => {
		const answer = 'Direct link: https://example.com/story?story=1 [1].';

		expect(cleanVisibleChatOutput(answer, 'Give me the direct URLs for the citations.')).toContain(
			'https://example.com/story?story=1'
		);
		expect(cleanVisibleChatOutput(answer, 'Summarize the story.')).not.toContain('https://example.com/story');
	});

	it('preserves an explicit publication date encoded in a direct article URL', async () => {
		const url = 'https://www.bankofcanada.ca/2024/01/fad-press-release-2024-01-24/';
		vi.stubGlobal(
			'fetch',
			vi.fn(async () =>
				new Response(
					`<html><head><title>Policy decision</title></head><body><article><h1>Policy decision</h1><p>${'The Bank held its target for the overnight rate and continued quantitative tightening. '.repeat(6)}</p></article></body></html>`,
					{ status: 200, headers: { 'content-type': 'text/html' } }
				)
			)
		);
		const tool = createDefaultToolRegistry().require(NEWSROOM_TOOL_NAMES.urlFetchRead);

		const result = await tool.run({ url }, toolContext(`Summarize ${url}`));

		expect(result.evidence?.[0]).toMatchObject({
			source_url: url,
			published_at: '2024-01-24'
		});
	});

	it('removes unsolicited trailing next-step offers', () => {
		const answer = [
			'No active warning was confirmed from the official alert page.',
			'',
			'If you want, I can also check the seven-day forecast.',
			'',
			'- If you need to verify within the hour, I can re-check the official alert page.'
		].join('\n');

		expect(cleanVisibleChatOutput(answer, 'Is a warning active?')).toBe(
			'No active warning was confirmed from the official alert page.'
		);
	});

	it('removes multi-paragraph next-step menus without dropping attached-document evidence', () => {
		const answer = [
			'No public TTC announcement confirms the memo claim [1].',
			'',
			'If you want one clear next step (pick one)',
			'- I can search board minutes or check whether the memo was later posted.',
			'',
			'If you prefer immediate verification: tell me whether to search again or contact media relations.',
			'',
			'**Attached document evidence**',
			'',
			'- The memo states that weekend service will end at 11 p.m. [2].'
		].join('\n');

		const cleaned = cleanVisibleChatOutput(answer, 'Corroborate this memo externally.');

		expect(cleaned).toContain('No public TTC announcement confirms the memo claim [1].');
		expect(cleaned).toContain('Attached document evidence');
		expect(cleaned).toContain('weekend service will end at 11 p.m. [2]');
		expect(cleaned).not.toContain('next step');
		expect(cleaned).not.toContain('contact media relations');
	});

	it('does not state an absolute schedule absence when only a live listing was checked', () => {
		const cleaned = cleanVisibleChatOutput(
			[
				'There are no FIFA-run matches scheduled for Tuesday. The official Match Centre shows no fixtures [1].',
				'',
				'- If you meant non-FIFA competitions, say which league and I’ll pull today’s schedule.'
			].join('\n'),
			'What FIFA games are being played today?'
		);

		expect(cleaned).toContain('I found no FIFA-run matches listed as scheduled for Tuesday.');
		expect(cleaned).toContain('The official Match Centre did not show any fixtures [1].');
		expect(cleaned).not.toContain('There are no');
		expect(cleaned).not.toContain('I’ll pull');
	});

	it('keeps long newsroom roundups complete instead of ending with a generated ellipsis', () => {
		const paragraphs = Array.from(
			{ length: 30 },
			(_, index) =>
				`${index + 1}) Department announcement ${index + 1} includes a complete sourced policy summary with operational, funding, implementation, regional, and accountability detail [${index + 1}].`
		);
		const cleaned = cleanVisibleChatOutput(
			paragraphs.join('\n\n'),
			'Build a sourced roundup with one citation per item.'
		);

		expect(cleaned.length).toBeGreaterThan(4000);
		expect(cleaned).toContain('30) Department announcement 30');
		expect(cleaned.endsWith('…')).toBe(false);
		expect(cleaned).toMatch(/\[30\]\.$/);
	});

	it('drops an unfinished provider paragraph without damaging the last complete cited claim', () => {
		const cleaned = cleanVisibleChatOutput(
			[
				'Human Rights Watch reached one conclusion [1].',
				'',
				'Al Jazeera reported a conflicting analysis [2].',
				'',
				'Points of disagreement',
				'- Direction and origin differed because the available crater evidence was interpreted as'
			].join('\n'),
			'Compare the reports.'
		);

		expect(cleaned).toBe(
			'Human Rights Watch reached one conclusion [1].\n\nAl Jazeera reported a conflicting analysis [2].'
		);
	});

	it('repairs a model-compressed separator between confirmed facts', () => {
		expect(
			cleanVisibleChatOutput(
				'Confirmed facts: The warning was issued July 17.: A temperature was observed July 28.',
				'Assess the inherited evidence.'
			)
		).toBe('Confirmed facts: The warning was issued July 17.\n- A temperature was observed July 28.');
	});

	it('classifies web sources independently with the journalist source contract', () => {
		expect(classifyEvidenceSource('City of Toronto', 'https://www.toronto.ca/news/mayor-statement')).toBe('official');
		expect(classifyEvidenceSource('Japan Meteorological Agency', 'https://www.data.jma.go.jp/multi/quake/')).toBe(
			'official'
		);
		expect(classifyEvidenceSource('TTC service advisory', 'https://www.ttc.ca/service-advisories')).toBe('official');
		expect(classifyEvidenceSource('RCMP review', 'https://rcmp.ca/en/publications/review')).toBe('official');
		expect(classifyEvidenceSource('Human Rights Watch', 'https://www.hrw.org/news/investigation')).toBe('primary');
		expect(classifyEvidenceSource('Al Jazeera', 'https://www.aljazeera.com/news/story')).toBe('news_report');
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
		expect(openAiBody.tool_choice).toBe('required');
	});

	it('does not run a topic-specific retry when the first search returns usable evidence', async () => {
		const today = new Date().toISOString();
		const fetchMock = vi.fn().mockResolvedValueOnce(
			jsonResponse({
				choices: [{ message: { content: 'Reuters reports that council approved the motion [1].' } }],
				citations: ['https://www.reuters.com/world/americas/council-motion'],
				search_results: [
					{
						url: 'https://www.reuters.com/world/americas/council-motion',
						title: 'Council approves motion',
						date: today
					}
				]
			})
		);
		vi.stubGlobal('fetch', fetchMock);

		const result = await runWebSearch('what happened in the council vote today');

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(result.answer).toBe('Reuters reports that council approved the motion [1].');
		expect(result.evidence).toEqual([
			expect.objectContaining({
				source_url: 'https://www.reuters.com/world/americas/council-motion',
				source_kind: 'news_report',
				citation_number: 1,
				published_at: today
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
		signal?: AbortSignal;
	} = {}
) {
	const provider = options.provider || 'perplexity';
	const tool = createDefaultToolRegistry().require(NEWSROOM_TOOL_NAMES.webSearch);
	return tool.run(
		{ query },
		toolContext(query, {
			provider,
			newsroomContext: options.newsroomContext,
			signal: options.signal
		})
	);
}

function toolContext(
	prompt: string,
	options: {
		provider?: 'perplexity' | 'openai';
		newsroomContext?: ToolRunContext['newsroomContext'];
		documents?: ToolRunContext['documents'];
		signal?: AbortSignal;
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
		documents: options.documents,
		signal: options.signal
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
