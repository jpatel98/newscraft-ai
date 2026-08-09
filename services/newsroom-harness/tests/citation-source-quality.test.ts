import { afterEach, describe, expect, it, vi } from 'vitest';
import { deriveResearchRequestContract } from '@newscraft/shared';
import { ToolBudgetLedger, mergeToolBudget } from '../src/agents/budget.js';
import {
	cleanVisibleChatOutput,
	generateFinalAnswer,
	isProducerRoundupPrompt
} from '../src/agents/answer.js';
import { createDefaultToolRegistry } from '../src/agents/default-tools.js';
import { classifyEvidenceSource, dedupeEvidence, normalizeEvidence } from '../src/agents/evidence.js';
import { createNewsroomAgentConfig } from '../src/agents/harness-config.js';
import { createModelPolicyConfig } from '../src/agents/model-policy.js';
import { NEWSROOM_CHARTER, NEWSROOM_CHARTER_VERSION } from '../src/agents/roles.js';
import { NEWSROOM_TOOL_NAMES, routeNewsroomRequest } from '../src/agents/router.js';
import { createNewsroomTemporalContext, type NewsroomTemporalContext } from '../src/agents/time-context.js';
import type { ToolRunContext } from '../src/agents/tools.js';

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe('citation and source-quality web research', () => {
	it('keeps direct-page prose when a provider discovery duplicate has a longer excerpt', () => {
		const url = 'https://publisher.example/story';
		const merged = dedupeEvidence([
			normalizeEvidence({
				source_name: 'Provider search',
				source_url: url,
				tool_used: NEWSROOM_TOOL_NAMES.webSearch,
				title: 'Provider result',
				extracted_text: 'Provider annotation label and stale search snippet.',
				summary: 'Provider annotation label and stale search snippet.',
				supporting_excerpt: 'Provider annotation label and stale search snippet with extra words.',
				direct_verified: false,
				limitations: ['Provider web_search result; cite and verify source page before publication.']
			}),
			normalizeEvidence({
				source_name: 'Publisher',
				source_url: url,
				tool_used: NEWSROOM_TOOL_NAMES.urlFetchRead,
				title: 'Verified story',
				extracted_text: 'The verified page reports a new safety measure after a recorded public meeting.',
				summary: 'The verified page reports a new safety measure after a recorded public meeting.',
				supporting_excerpt: 'The verified page reports a new safety measure after a recorded public meeting.',
				direct_verified: true,
				limitations: []
			})
		]);

		expect(merged).toHaveLength(1);
		expect(merged[0]).toMatchObject({ direct_verified: true, title: 'Verified story' });
		expect(merged[0]?.supporting_excerpt).toContain('verified page reports');
		expect(merged[0]?.supporting_excerpt).not.toContain('Provider annotation label');
		expect(merged[0]?.summary).not.toContain('Provider annotation label');
	});

	it('does not fall back to provider snippet residue when a direct page is readable', async () => {
		const url = 'https://publisher.example/municipal-notice';
		const providerResidue = 'Provider-only snippet residue with budget label and no page prose.';
		vi.stubGlobal(
			'fetch',
			vi.fn(async (request: string | URL | Request) => {
				if (!isProviderRequest(request)) {
					return directArticleResponse(
						url,
						'Municipal notice',
						'2026-08-08',
						'Officials described a six-month implementation timetable and invited residents to review the technical appendix before the meeting. Staff will phase the work across three sites and publish progress reports after each milestone. The document also explains how residents can submit questions before the public session.'
					);
				}
				return jsonResponse({
					output_text: providerResidue,
					citations: [url],
					search_results: [{ url, title: 'Provider result', snippet: providerResidue, date: '2026-08-08' }]
				});
			})
		);

		const result = await runWebSearch('Summarize this announcement', { provider: 'openai' });
		const evidence = result.evidence?.[0];
		expect(result.evidence).toHaveLength(1);
		expect(evidence).toMatchObject({ direct_verified: true, published_at: '2026-08-08' });
		expect(evidence?.extracted_text).toContain('six-month implementation timetable');
		expect(evidence?.summary).not.toContain(providerResidue);
		expect(evidence?.supporting_excerpt).not.toContain(providerResidue);
	});

	it('preserves more than eight Sonar citations in marker order with metadata', async () => {
		const urls = Array.from({ length: 12 }, (_, index) => `https://www.reuters.com/world/story-${index + 1}`);
		vi.stubGlobal(
			'fetch',
			vi.fn(async (request: string | URL | Request) => {
				if (!isProviderRequest(request)) {
					const url = String(request);
					const number = Number(url.match(/story-(\d+)/)?.[1]);
					return directArticleResponse(
						url,
						`Reuters story ${number}`,
						`2026-07-${String(number).padStart(2, '0')}`,
						`The verified Reuters article ${number} reports a material development in semiconductor manufacturing with consequences for the supply chain.`
					);
				}
				return jsonResponse({
					choices: [{ message: { content: 'A sourced answer [1] [12].' } }],
					citations: urls,
					search_results: [...urls].reverse().map((url) => {
						const number = Number(url.match(/story-(\d+)/)?.[1]);
						return {
							url,
							title: `Reuters story ${number}`,
							snippet: `Supporting excerpt ${number}`,
							date: number === 12 ? undefined : `2030-07-${String(number).padStart(2, '0')}`
						};
					})
				});
			})
		);

		const result = await runWebSearch('Compare reporting on semiconductor manufacturing');

		expect(result.evidence).toHaveLength(8);
		expect(result.evidence?.map((source) => source.source_url)).toEqual(urls.slice(0, 8).reverse());
		expect(result.evidence?.map((source) => source.citation_number)).toEqual(
			Array.from({ length: 8 }, (_, index) => index + 1)
		);
		expect(result.evidence?.[0]).toMatchObject({
			title: 'Reuters story 8',
			published_at: expect.stringContaining('2026-07-08'),
			source_kind: 'news_report',
			direct_verified: true
		});
		expect(result.evidence?.[7]).toMatchObject({
			title: 'Reuters story 1',
			published_at: expect.stringContaining('2026-07-01'),
			direct_verified: true
		});
		expect(result.evidence?.every((source) => source.published_at?.startsWith('2030') !== true)).toBe(true);
	});

	it('deduplicates repeated Sonar URLs into one stable evidence record', async () => {
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

		// Provider-local prose is not a visible-answer authority when the only
		// normalized record is a title with no readable claim text.
		expect(result.answer).toBe('');
		expect(result.evidence?.map((source) => source.citation_number)).toEqual([1]);
		expect(result.evidence?.map((source) => source.source_url)).toEqual([repeatedUrl]);
	});

	it('drops provider citation prose when the provider returns no normalized evidence record', async () => {
		vi.stubGlobal(
			'fetch',
			vi.fn(async () =>
				jsonResponse({
					choices: [{ message: { content: 'A provider claim without a source record [1].' } }],
					citations: [],
					search_results: []
				})
			)
		);

		const result = await runWebSearch('Summarize a historical policy change');

		expect(result.evidence).toBeUndefined();
		expect(result.answer).toBeUndefined();
	});

	it('does not return citation-free provider narrative when direct page reads fail', async () => {
		const url = 'https://publisher.example/unreadable-story';
		const providerText = '(publisher.example). Direct answer — story ideas (lead first). Budget Notes - HS 2026 Budget.';
		vi.stubGlobal(
			'fetch',
			vi.fn(async (request: string | URL | Request) => {
				if (isProviderRequest(request)) {
					return jsonResponse({
						choices: [{ message: { content: providerText } }],
						citations: [url],
						search_results: [{ url, title: 'Unreadable candidate', snippet: 'Provider-only candidate residue.' }]
					});
				}
				return new Response('', { status: 403, headers: { 'content-type': 'text/html' } });
			})
		);

		const result = await runWebSearch('Give me story ideas for climate and transit reporters.', { provider: 'openai' });

		expect(result.status).toBe('unavailable');
		expect(result.evidence).toBeUndefined();
		expect(result.answer).toBeUndefined();
		expect(result.discovery_leads?.some((item) => item.source_url === url)).toBe(true);
	});

	it('fails closed for a structured current producer assignment when direct reads fail', async () => {
		const url = 'https://publisher.example/structured-unreadable-story';
		vi.stubGlobal(
			'fetch',
			vi.fn(async (request: string | URL | Request) =>
				isProviderRequest(request)
					? jsonResponse({
							choices: [{ message: { content: 'Provider-only assignment prose.' } }],
							citations: [url],
							search_results: [{ url, title: 'Structured unreadable candidate', snippet: 'Provider-only residue.' }]
						})
					: new Response('', { status: 403, headers: { 'content-type': 'text/html' } })
			)
		);
		const researchContract = {
			...deriveResearchRequestContract('Latest local assignment stories', { timezone: 'America/Toronto' }),
			outputType: 'producer_roundup' as const
		};

		const result = await runWebSearch('Check the assigned coverage.', {
			provider: 'openai',
			researchContract
		});

		expect(result.status).toBe('unavailable');
		expect(result.answer).toBeUndefined();
		expect(result.discovery_leads?.some((item) => item.source_url === url)).toBe(true);
	});

	it('keeps dated evidence from the full requested seven-day window', async () => {
		const sixDaysAgo = new Date(Date.now() - 6 * 24 * 60 * 60 * 1000).toISOString();
		const url = 'https://www.canada.ca/en/news/policy-announcement.html';
		vi.stubGlobal(
			'fetch',
			vi.fn(async (request: string | URL | Request) =>
				isProviderRequest(request)
					? jsonResponse({
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
					: directArticleResponse(url, 'Policy announcement', sixDaysAgo, 'The government announced a new public policy after review.')
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

	it('does not repeat an identical broad search after a provider timeout', async () => {
		const fetchMock = vi.fn(async () => {
			throw new DOMException('Timed out', 'TimeoutError');
		});
		vi.stubGlobal('fetch', fetchMock);

		const result = await runWebSearch('Latest Toronto news briefing across major outlets', { provider: 'openai' });

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(result.status).toBe('unavailable');
		expect(result.diagnostics?.attempts).toEqual([
			expect.objectContaining({ role: 'primary', status: 'failed', failureCategory: 'timeout' })
		]);
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
			vi.fn(async (request: string | URL | Request) => {
				if (!isProviderRequest(request)) {
					const url = String(request);
					const index = urls.indexOf(url);
					return directArticleResponse(
						url,
						`Reuters annotated ${index + 1}`,
						`2026-07-${String(index + 1).padStart(2, '0')}`,
						`The verified article for story ${index + 1} describes a material development in semiconductor manufacturing and its effect on the supply chain.`
					);
				}
				return jsonResponse({
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
				});
			})
		);

		const result = await runWebSearch('Summarize annotated OpenAI coverage', { provider: 'openai' });

		expect(result.answer).toContain('The verified article for story 1 describes a material development');
		expect(result.answer).toContain('The verified article for story 8 describes a material development');
		expect(result.answer).not.toContain('Claim 1 uses source 1');
		expect(result.evidence).toHaveLength(8);
		expect(result.evidence?.map((source) => source.citation_number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
		expect(result.evidence?.map((source) => source.source_url)).toEqual(urls.slice(0, 8).reverse());
		expect(result.evidence?.some((source) => source.source_url === 'https://example.com/action-only')).toBe(false);
	});

	it('preserves OpenAI citation claim text and explicit publication dates when no snippets are returned', async () => {
		const urls = [
			'https://www.cbc.ca/news/canada/toronto/council-housing-vote-1.1',
			'https://toronto.citynews.ca/2026/08/01/transit-service-update/'
		];
		const segments = [
			'Toronto council approved the housing measure. Published August 1, 2026.',
			'The TTC restored service after a signal issue. Updated August 1, 2026.'
		];
		const text = segments.join('\n');
		const fetchMock = vi.fn(async (url: string | URL | Request) => {
			if (String(url).includes('api.openai.com')) {
				return jsonResponse({
					output_text: text,
						output: [
							{
								type: 'message',
								content: [{ type: 'output_text', text, annotations: annotationFixtures(text, segments, urls) }]
							}
						],
						search_results: urls.map((url, index) => ({
							url,
							title: `Provider result ${index + 1}`,
							snippet: `Provider annotation label ${index + 1}`,
							date: '2035-08-01'
						}))
					});
				}
				return directArticleResponse(
				String(url),
				String(url).includes('council') ? 'Council housing vote' : 'Transit service update',
					'2026-08-01',
					String(url).includes('council')
						? 'Toronto council approved the housing measure after a recorded vote.'
						: 'The TTC restored service after resolving a signal issue.',
					'2026-08-01T12:00:00.000Z'
				);
		});
		vi.stubGlobal('fetch', fetchMock);

		const temporalContext = createNewsroomTemporalContext({
			now: new Date('2026-08-01T18:00:00.000Z'),
			timeZone: 'America/Toronto',
			request: 'Latest Toronto news today'
		});
		const result = await runWebSearch('Latest Toronto news today', { provider: 'openai', temporalContext });
		expect(result.status).toBe('ok');
		expect(result.evidence).toHaveLength(2);
		expect(result.evidence?.map((source) => source.published_at)).toEqual([
			'2026-08-01',
			'2026-08-01'
		]);
		expect(result.evidence?.map((source) => source.updated_at)).toEqual([
			'2026-08-01T12:00:00.000Z',
			'2026-08-01T12:00:00.000Z'
		]);
		expect(result.evidence?.map((source) => source.extracted_text)).toEqual([
			expect.stringContaining('Toronto council approved the housing measure after a recorded vote.'),
			expect.stringContaining('The TTC restored service after resolving a signal issue.')
		]);
		expect(result.evidence?.every((source) => !source.extracted_text.includes('No source excerpt was returned'))).toBe(true);
		expect(result.evidence?.every((source) => source.supporting_excerpt.includes('recorded vote') || source.supporting_excerpt.includes('signal issue'))).toBe(true);
		expect(result.evidence?.every((source) => !source.supporting_excerpt.includes('Provider annotation label'))).toBe(true);
		expect(result.evidence?.every((source) => source.published_at?.startsWith('2035') !== true)).toBe(true);
	});

	it('maps ordered OpenAI research notes when URL annotations omit character offsets', async () => {
		const urls = [
			'https://www.cbc.ca/news/canada/toronto/council-housing-vote-1.2',
			'https://toronto.citynews.ca/2026/08/01/transit-service-restored/'
		];
		const notes = [
			'Toronto council approved a housing measure after a recorded vote. Published August 1, 2026.',
			'The TTC restored subway service after resolving a signal issue. Updated August 1, 2026.'
		];
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: string | URL | Request) => {
				if (String(url).includes('api.openai.com')) {
					return jsonResponse({
						output_text: notes.join('\n'),
						output: [{
							type: 'message',
							content: [{
								type: 'output_text',
								text: notes.join('\n'),
								annotations: urls.map((sourceUrl, index) => ({
									type: 'url_citation',
									url: sourceUrl,
									title: `Direct article ${index + 1}`
								}))
							}]
						}]
					});
				}
				return directArticleResponse(
					String(url),
					String(url).includes('council') ? 'Council housing vote' : 'Transit service restored',
					'2026-08-01',
					String(url).includes('council')
						? 'Toronto council approved a housing measure after a recorded vote.'
						: 'The TTC restored subway service after resolving a signal issue.'
				);
			})
		);

		const temporalContext = createNewsroomTemporalContext({
			now: new Date('2026-08-01T18:00:00.000Z'),
			timeZone: 'America/Toronto',
			request: 'Latest Toronto news today'
		});
		const result = await runWebSearch('Latest Toronto news today', { provider: 'openai', temporalContext });

		expect(result.status).toBe('ok');
		expect(result.evidence?.map((source) => source.extracted_text)).toEqual([
			expect.stringContaining('Toronto council approved a housing measure after a recorded vote.'),
			expect.stringContaining('The TTC restored subway service after resolving a signal issue.')
		]);
		expect(result.evidence?.map((source) => source.published_at)).toEqual([
			'2026-08-01',
			'2026-08-01'
		]);
	});

	it('keeps unknown-date and explicitly old direct pages out of current evidence', async () => {
		const unknownUrl = 'https://www.cbc.ca/news/canada/toronto/current-development';
		const oldUrl = 'https://www.ago.ca/press-release/2026-exhibition-line-up';
		const fetchMock = vi.fn(async (request: string | URL | Request) => {
			if (isProviderRequest(request)) {
				return jsonResponse({
					output_text: 'Two candidate stories [1] [2].',
					output: [{
						type: 'message',
						content: [{
							type: 'output_text',
							text: 'Two candidate stories [1] [2].',
							annotations: [
								{ type: 'url_citation', url: unknownUrl, title: 'Current development' },
								{ type: 'url_citation', url: oldUrl, title: 'AGO announces 2026 exhibition line-up' }
							]
						}]
					}]
				});
			}
			if (String(request).includes('ago.ca')) {
				return directArticleResponse(
					oldUrl,
					'AGO announces 2026 exhibition line-up',
					'2025-10-22T15:00:00.000Z',
					'The AGO announced an exhibition line-up in October 2025.'
				);
			}
			return directArticleResponse(
				unknownUrl,
				'Current development',
				null,
				'CBC describes a developing Toronto story, but the page exposes no publication or update time.'
			);
		});
		vi.stubGlobal('fetch', fetchMock);

		const temporalContext = createNewsroomTemporalContext({
			now: new Date('2026-08-08T18:00:00.000Z'),
			timeZone: 'America/Toronto',
			request: 'Latest developing stories in Toronto today'
		});
		const result = await runWebSearch('Latest developing stories in Toronto today', {
			provider: 'openai',
			temporalContext
		});

		expect(result.evidence || []).toHaveLength(0);
		expect(result.discovery_leads?.some((item) => item.rejection_reason === 'publication or update time is unknown')).toBe(true);
		expect(result.discovery_leads?.some((item) => item.rejection_reason === 'publication or event time is outside the request window')).toBe(true);
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
			vi.fn(async (request: string | URL | Request) => {
				if (!isProviderRequest(request)) {
					const url = String(request);
					return directArticleResponse(
						url,
						`Direct page ${url}`,
						'2026-08-08',
						`The verified page at ${url} reports a distinct documented development with readable context for the assignment.`
					);
				}
				return jsonResponse({
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
				});
			})
		);

		const result = await runWebSearch('Summarize annotated OpenAI source identity', { provider: 'openai' });

		expect(result.answer).toMatch(/^- .* \[1\]\n- .* \[2\]$/);
		expect(result.evidence?.map((source) => source.source_url)).toEqual(urls.slice(0, 2));
		expect(result.evidence?.map((source) => source.citation_number)).toEqual([1, 2]);
	});

	it('dedupes exact and tracking-only repeated OpenAI annotations without losing visible resolution', async () => {
		const canonical = 'https://example.com/story?id=123#section';
		const tracking = 'https://example.com/story?id=123&utm_source=newscraft#section';
		const repeated = 'https://example.com/other?id=456';
		const segments = ['First exact-source claim', 'Tracking duplicate claim', 'Repeated annotation claim', 'Repeated annotation follow-up'];
		const text = `${segments.join('. ')}.`;
		vi.stubGlobal(
			'fetch',
			vi.fn(async (request: string | URL | Request) => {
				if (!isProviderRequest(request)) {
					const url = String(request);
					return directArticleResponse(
						url,
						`Direct page ${url}`,
						'2026-08-08',
						`The verified page at ${url} confirms a distinct documented development with readable context for the assignment.`
					);
				}
				return jsonResponse({
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
				});
			})
		);

		const result = await runWebSearch('Summarize repeated annotated OpenAI source identity', {
			provider: 'openai'
		});

		expect(result.answer).toContain('The verified page at https://example.com/story?id=123');
		expect(result.answer).toContain('The verified page at https://example.com/other?id=456');
		expect(result.answer).not.toContain('First exact-source claim');
		expect(result.answer).not.toContain('Repeated annotation claim');
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
			vi.fn(async (request: string | URL | Request) => {
				if (!isProviderRequest(request)) {
					const url = String(request);
					return directArticleResponse(
						url,
						'Weather alerts',
						'2026-08-08',
						'No alerts are in effect for the monitored region, according to the verified public notice.'
					);
				}
				return jsonResponse({
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
				});
			})
		);

		const result = await runWebSearch('Check Toronto alerts now', { provider: 'openai' });

		expect(result.answer).toContain('No alerts are in effect for the monitored region');
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
			vi.fn(async (request: string | URL | Request) => {
				if (!isProviderRequest(request)) {
					const url = String(request);
					const body = url.includes('source-a')
						? 'Source A supports the first claim with a verified public record.'
						: 'Source B supports the second claim with a verified public record.';
					return directArticleResponse(url, url.includes('source-a') ? 'Source A' : 'Source B', '2026-08-08', body);
				}
				return jsonResponse({
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
				});
			})
		);

		const result = await runWebSearch('Compare two annotated claims', { provider: 'openai' });

		expect(result.answer).toContain('Source A supports the first claim with a verified public record');
		expect(result.answer).toContain('Source B supports the second claim with a verified public record');
		expect(result.answer).not.toContain(sourceExcerpts[0]);
		expect(result.answer).not.toContain(sourceExcerpts[1]);
		expect(result.evidence?.map((source) => source.source_url)).toEqual([sourceA, sourceB]);
		expect(result.evidence?.map((source) => source.citation_number)).toEqual([1, 2]);
		expect(result.evidence?.map((source) => source.extracted_text)).toEqual([
			expect.stringContaining('Source A supports the first claim with a verified public record.'),
			expect.stringContaining('Source B supports the second claim with a verified public record.')
		]);
	});

	it('drops provider-authored claims when no structured source record can resolve them', () => {
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

		expect(answer).toContain("I couldn't verify this from readable sources right now.");
		expect(answer).not.toContain('The policy changed today.');
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

	it('prioritizes consequential same-day producer items and includes requested direct URLs', () => {
		const prompt =
			'Give me a same-day briefing of the latest consequential Toronto news, each with a direct article or official URL.';
		const inputs = [
			['weather-warning', 'Toronto weather warning affects evening travel', 'A weather warning is in effect for Toronto and could disrupt evening travel.'],
			['council-housing', 'Toronto council approves housing policy', 'Toronto council approved a housing policy affecting thousands of residents.'],
			['ttc-collision', 'Pedestrian injured in TTC collision', 'A pedestrian was taken to hospital after a collision involving a TTC streetcar.'],
			['fraud-charges', 'Police lay fraud charges', 'Toronto police charged two people in a fraud investigation.'],
			['hospital-plan', 'Hospital announces emergency capacity plan', 'A Toronto hospital announced an emergency capacity plan for this weekend.'],
			['cute-puppy', 'Cute puppy needs a home', 'A cute puppy is available for pet adoption in Toronto.']
		];
		const evidence = inputs.map(([slug, title, summary], index) =>
			normalizeEvidence({
				source_name: 'Toronto Publisher',
				source_url: `https://publisher.test/2026/08/01/${slug}`,
				tool_used: NEWSROOM_TOOL_NAMES.sourceMonitor,
				title,
				extracted_text: summary,
				summary,
				published_at: `2026-08-01T${String(18 - index).padStart(2, '0')}:00:00.000Z`,
				confidence: 0.9,
				limitations: [],
				direct_verified: true,
				source_kind: 'news_report',
				citation_number: index + 1,
				temporal_scope: 'primary',
				ledger_status: 'accepted'
			})
		);

		const answer = generateFinalAnswer({
			prompt,
			decision: routeNewsroomRequest(prompt),
			evidence,
			limitations: ['OpenAI web_search is not configured because OPENAI_API_KEY is missing.'],
			budget: new ToolBudgetLedger(mergeToolBudget()).snapshot(),
			outputStyle: 'chat'
		});

		expect(answer).toContain('https://publisher.test/2026/08/01/weather-warning');
		expect(answer).toContain('https://publisher.test/2026/08/01/ttc-collision');
		expect(answer).not.toContain('Cute puppy');
		expect(answer).not.toContain('Live research is temporarily unavailable');
	});

	it('keeps same-day briefings unique and never pads them with stale background', () => {
		const prompt =
			'Give me a same-day Toronto briefing for August 1, 2026 with direct article URLs. If coverage is incomplete, say what you found.';
		const inputs = [
			['https://one.test/2026/08/01/east-york-church', 'Man allegedly tossed rocks through East York church window three times', 'Investigators are treating the church incidents as hate-motivated mischief.', '2026-08-01T20:25:00.000Z', 'primary'],
			['https://two.test/2026/08/01/east-york-church', 'Man charged after rocks thrown through East York church window', 'Police charged a man after rocks were thrown through an East York church window.', '2026-08-01T20:15:00.000Z', 'primary'],
			['https://three.test/2026/08/01/weather', 'Toronto under heavy rainfall statement', 'A special weather statement warns of heavy rainfall in Toronto.', '2026-08-01T19:38:00.000Z', 'primary'],
			['https://four.test/2026/08/01/streetcar-collision', 'Pedestrian seriously injured after TTC streetcar collision', 'A pedestrian was taken to hospital after a TTC streetcar collision.', '2026-08-01T18:45:00.000Z', 'primary'],
			['https://five.test/live/annual-plan', '2026 annual transit plan', 'The transit agency publishes its annual network plan.', null, 'primary'],
			['https://six.test/2026/07/27/old-story', 'Older Toronto background story', 'An older background story was published several days ago.', '2026-07-27T12:00:00.000Z', 'background']
		] as const;
		const evidence = inputs.map(([url, title, summary, publishedAt, temporalScope], index) =>
			normalizeEvidence({
				source_name: `Publisher ${index + 1}`,
				source_url: url,
				tool_used: NEWSROOM_TOOL_NAMES.sourceMonitor,
				title,
				extracted_text: summary,
				summary,
				published_at: publishedAt,
				confidence: 0.9,
				limitations: [],
				direct_verified: true,
				source_kind: 'news_report',
				citation_number: index + 1,
				temporal_scope: temporalScope,
				ledger_status: 'accepted'
			})
		);

		const answer = generateFinalAnswer({
			prompt,
			decision: routeNewsroomRequest(prompt),
			evidence,
			limitations: [],
			budget: new ToolBudgetLedger(mergeToolBudget()).snapshot(),
			outputStyle: 'chat',
			timeZone: 'America/Toronto'
		});

		expect(answer.match(/east-york-church/g)).toHaveLength(1);
		expect(answer).toContain('https://three.test/2026/08/01/weather');
		expect(answer).toContain('https://four.test/2026/08/01/streetcar-collision');
		expect(answer.indexOf('/weather')).toBeLessThan(answer.indexOf('/streetcar-collision'));
		expect(answer).not.toContain('/live/annual-plan');
		expect(answer).not.toContain('2026/07/27/old-story');
		expect(answer).toContain('Coverage is incomplete; I found 3 distinct same-day items');
	});

	it('does not synthesize a current story from readable evidence whose date remains unknown', () => {
		const prompt = 'What are the latest developing stories in Vancouver?';
		const undated = normalizeEvidence({
			source_name: 'Verified publisher',
			source_url: 'https://publisher.test/undated-developing-story',
			tool_used: NEWSROOM_TOOL_NAMES.urlFetchRead,
			title: 'Undated emergency response story',
			extracted_text:
				'Crews closed two roads after heavy rain, while officials assess drainage capacity and residents await a repair timetable.',
			summary:
				'Crews closed two roads after heavy rain, while officials assess drainage capacity and residents await a repair timetable.',
			published_at: null,
			updated_at: null,
			event_at: null,
			confidence: 0.9,
			limitations: [],
			direct_verified: true,
			source_kind: 'news_report',
			temporal_scope: 'primary',
			ledger_status: 'accepted'
		});

		const answer = generateFinalAnswer({
			prompt,
			decision: routeNewsroomRequest(prompt),
			evidence: [undated],
			limitations: [],
			budget: new ToolBudgetLedger(mergeToolBudget()).snapshot(),
			outputStyle: 'chat'
		});

		expect(answer).toContain("I couldn't verify a complete claim");
		expect(answer).not.toContain('Undated emergency response story');
		expect(answer).not.toContain('Crews closed two roads');
	});

	it('canonicalizes duplicate provider-local numbers through structured rendering', () => {
		const prompt =
			'Give me a same-day briefing of the latest consequential Toronto news, each with a direct article URL.';
		const evidence = Array.from({ length: 5 }, (_, index) =>
			normalizeEvidence({
				source_name: `Toronto Publisher ${index + 1}`,
				source_url: `https://publisher${index + 1}.test/2026/08/01/story-${index + 1}`,
				tool_used: NEWSROOM_TOOL_NAMES.webSearch,
				title: `Consequential Toronto story ${index + 1}`,
				extracted_text: `Toronto officials confirmed a consequential public-impact development in story ${index + 1}.`,
				summary: `Toronto officials confirmed a consequential public-impact development in story ${index + 1}.`,
				published_at: `2026-08-01T${String(19 - index).padStart(2, '0')}:00:00.000Z`,
				confidence: 0.9,
				limitations: [],
				direct_verified: true,
				source_kind: 'news_report',
				citation_number: 1,
				temporal_scope: 'primary',
				ledger_status: 'accepted'
			})
		);

		const generated = generateFinalAnswer({
			prompt,
			decision: routeNewsroomRequest(prompt),
			evidence,
			limitations: [],
			budget: new ToolBudgetLedger(mergeToolBudget()).snapshot(),
			outputStyle: 'chat'
		});
		expect(evidence.map((item) => item.citation_number)).toEqual([1, 2, 3, 4, 5]);
		expect(new Set(generated.match(/https:\/\/publisher\d\.test\/2026\/08\/01\/story-\d/g))).toHaveLength(5);
		expect(generated.match(/\[(\d+)\]/g)).toEqual(['[1]', '[2]', '[3]', '[4]', '[5]']);
		expect(generated).toContain('https://publisher1.test/2026/08/01/story-1');
		expect(generated).toContain('https://publisher5.test/2026/08/01/story-5');
	});

	it('does not turn conversational follow-ups, corrections, or transformations into producer roundups', () => {
		const evidence = [
			normalizeEvidence({
				source_name: 'Verified local desk',
				source_url: 'https://verified.example/story',
				tool_used: NEWSROOM_TOOL_NAMES.urlFetchRead,
				title: 'Verified local story',
				extracted_text: 'The verified local story remains available for the ordinary follow-up question.',
				summary: 'The verified local story remains available for the ordinary follow-up question.',
				confidence: 0.9,
				limitations: [],
				direct_verified: true,
				source_kind: 'news_report',
				published_at: '2026-08-08T14:00:00.000Z'
			})
		];
		for (const prompt of [
			'Follow up on your last answer.',
			'Correction: the previous answer misstated the source.',
			'Turn the previous answer into a producer brief without researching again.'
		]) {
			const answer = generateFinalAnswer({
				prompt,
				decision: routeNewsroomRequest(prompt),
				evidence,
				limitations: [],
				budget: new ToolBudgetLedger(mergeToolBudget()).snapshot(),
				outputStyle: 'chat'
			});
			expect(answer).not.toContain('## Latest producer roundup');
			expect(answer).not.toContain('## Story ideas');
			expect(answer).not.toContain('**Why it matters:**');
		}
	});

	it('uses structured producer output intent for shorthand assignments', () => {
		const contract = {
			...deriveResearchRequestContract('Latest local coverage', { timezone: 'America/Toronto' }),
			outputType: 'producer_roundup' as const
		};
		const prompt = 'Check the assigned coverage.';
		const evidence = [
			normalizeEvidence({
				source_name: 'Verified local desk',
				source_url: 'https://verified.example/assigned-story',
				tool_used: NEWSROOM_TOOL_NAMES.urlFetchRead,
				title: 'Local service changes announced',
				extracted_text: 'The city announced service changes after a public meeting, with implementation beginning this week.',
				summary: 'The city announced service changes after a public meeting, with implementation beginning this week.',
				supporting_excerpt: 'The city announced service changes after a public meeting, with implementation beginning this week.',
				confidence: 0.9,
				limitations: [],
				direct_verified: true,
				source_kind: 'news_report',
				published_at: '2026-08-08T14:00:00.000Z',
				temporal_scope: 'primary'
			})
		];

		expect(isProducerRoundupPrompt(prompt, contract)).toBe(true);
		const answer = generateFinalAnswer({
			prompt,
			decision: routeNewsroomRequest(prompt),
			evidence,
			limitations: [],
			budget: new ToolBudgetLedger(mergeToolBudget()).snapshot(),
			outputStyle: 'chat',
			researchContract: contract
		});

		expect(answer).toContain('## Latest producer roundup');
		expect(answer).toContain('**Why it matters:**');
	});

	it('builds varied producer ideas from direct page prose instead of provider labels or budget fragments', async () => {
		const urls = [
			'https://pacific.example/climate/flooding-update',
			'https://lisbon.example/transit/repair-plan',
			'https://civic.example/budget/notes'
		];
		const providerText = '(pacific.example). Direct answer — story ideas (lead first). Budget Notes - HS 2026 Budget Notes - HS 2026 Budget.';
		vi.stubGlobal(
			'fetch',
			vi.fn(async (request: string | URL | Request) => {
				if (!isProviderRequest(request)) {
					const url = String(request);
					const index = urls.indexOf(url);
					const bodies = [
						'Heavy rain overwhelmed two neighbourhood drainage systems, prompting emergency crews to close several roads. Residents are asking whether the infrastructure plan is keeping pace with more frequent storms.',
						'Transit officials paused a corridor repair after an inspection found a structural defect. The delay could change commute patterns and raises questions about the project timeline.',
						'Council documents show a new resilience allocation alongside deferred maintenance spending. The gap gives reporters a concrete way to test whether the public budget matches the city\'s climate promises.'
					];
					return directArticleResponse(
						url,
						['Flooding closes roads after heavy rain', 'Transit repair paused after inspection', 'Budget shifts resilience spending'][index],
						'2026-08-08',
						bodies[index],
						'2026-08-08T16:00:00.000Z'
					);
				}
				return jsonResponse({
					output_text: providerText,
					output: [{
						type: 'message',
						content: [{
							type: 'output_text',
							text: providerText,
							annotations: urls.map((url, index) => ({
								type: 'url_citation',
								url,
								title: `Candidate ${index + 1}`,
								start_index: index === 0 ? 0 : providerText.length - 1,
								end_index: index === 0 ? '(pacific.example).'.length : providerText.length
							}))
						}]
					}]
				});
			})
		);

		const prompt = 'Give me story ideas for climate and transit reporters across Vancouver and Lisbon.';
		const result = await runWebSearch(prompt, { provider: 'openai' });
		const answer = generateFinalAnswer({
			prompt,
			decision: routeNewsroomRequest(prompt),
			evidence: result.evidence || [],
			limitations: [],
			budget: new ToolBudgetLedger(mergeToolBudget()).snapshot(),
			outputStyle: 'chat',
			timeZone: 'America/Toronto'
		});

		expect(result.evidence).toHaveLength(3);
		expect(result.evidence?.every((item) => item.direct_verified === true)).toBe(true);
		expect(answer).toContain('## Story ideas');
		expect(answer).toContain('Heavy rain overwhelmed two neighbourhood drainage systems');
		expect(answer).toContain('**Why it matters:**');
		expect(answer).toContain('Source time:');
		expect(answer).not.toContain('(pacific.example)');
		expect(answer).not.toContain('Direct answer — story ideas');
		expect(answer).not.toContain('Budget Notes - HS 2026 Budget');
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
		const fetchMock = vi.fn(async (request: string | URL | Request) =>
			isProviderRequest(request)
				? jsonResponse({
						choices: [{ message: { content: 'Coverage differs in emphasis.' } }],
						citations: ['https://www.cbc.ca/news/story'],
						search_results: [{ url: 'https://www.cbc.ca/news/story', title: 'CBC News story', date: '2026-07-10' }]
					})
				: directArticleResponse(String(request), 'CBC News story', new Date().toISOString(), 'Coverage differs in emphasis across the requested outlets.')
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

		const providerCallIndexes = () =>
			fetchMock.mock.calls
				.map((call, index) => (isProviderRequest(call[0]) ? index : -1))
				.filter((index) => index >= 0);
		const providerIndexes = providerCallIndexes();
		const todayBody = requestBody(fetchMock, providerIndexes[0]);
		expect(todayBody.search_domain_filter).toEqual(['cbc.ca', 'ctvnews.ca']);
		expect(todayBody.search_recency_filter).toBe('day');
		expect(JSON.stringify(todayBody.messages)).toContain('America/Vancouver');
		expect(JSON.stringify(todayBody.messages)).toContain('Vancouver');
		expect(JSON.stringify(todayBody.messages)).toContain('thetyee.ca');
		expect(JSON.stringify(todayBody.messages)).toContain('Do not add a Current as of label');
		expect(JSON.stringify(todayBody.messages)).toContain('Never present either as a source publication date');

		const weekBody = requestBody(fetchMock, providerIndexes[1]);
		expect(weekBody.search_domain_filter).toEqual(['reuters.com', 'apnews.com']);
		expect(weekBody.search_recency_filter).toBe('week');

		fetchMock.mockClear();
		await runWebSearch('Compare CBC and CTV coverage today', { provider: 'openai' });
		const openAiBody = requestBody(fetchMock, providerCallIndexes()[0]);
		expect(openAiBody).not.toHaveProperty('search_domain_filter');
		expect(openAiBody).not.toHaveProperty('search_recency_filter');
		expect(openAiBody.tools).toEqual([{ type: 'web_search' }]);
		expect(openAiBody.tool_choice).toBe('required');
	});

	it('gives every web-search provider the canonical browsing workflow', async () => {
		const fetchMock = vi.fn(async () =>
			jsonResponse({
				choices: [{ message: { content: 'A readable article was found.' } }],
				citations: ['https://www.cbc.ca/news/story'],
				search_results: [
					{
						url: 'https://www.cbc.ca/news/story',
						title: 'CBC article',
						snippet: 'A dated article excerpt.',
						date: '2026-07-31T14:00:00.000Z'
					}
				]
			})
		);
		vi.stubGlobal('fetch', fetchMock);

		await runWebSearch('Latest Toronto news today');
		const sonarBody = requestBody(fetchMock, 0);
		const sonarText = JSON.stringify(sonarBody.messages);
		expect(NEWSROOM_CHARTER_VERSION).toBe('1.1.0');
		expect(sonarText).toContain('Treat the search provider as a retrieval mechanism');
		expect(sonarText).toContain('Search-result snippets, previews, publisher landing pages');
		expect(sonarText).toContain('Return normalized research notes');

		fetchMock.mockClear();
		await runWebSearch('Latest Toronto news today', { provider: 'openai' });
		const openAiBody = requestBody(fetchMock, 0);
		expect(openAiBody.instructions).toBe(NEWSROOM_CHARTER);
		expect(String(openAiBody.input)).toContain('Return normalized research notes');
		expect(openAiBody.max_output_tokens).toBe(4_000);
	});

	it('does not run a topic-specific retry when the first search returns usable evidence', async () => {
		const today = new Date().toISOString();
		const fetchMock = vi.fn(async (request: string | URL | Request) =>
			isProviderRequest(request)
				? jsonResponse({
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
				: directArticleResponse(
						String(request),
						'Council approves motion',
						today,
						'Reuters reports that council approved the motion after a recorded vote.'
					)
		);
		vi.stubGlobal('fetch', fetchMock);

		const result = await runWebSearch('what happened in the council vote today');

		expect(fetchMock.mock.calls.filter((call) => isProviderRequest(call[0]))).toHaveLength(1);
		expect(result.answer).toContain('Council approves motion');
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
		temporalContext?: NewsroomTemporalContext;
		researchContract?: ToolRunContext['researchContract'];
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
			temporalContext: options.temporalContext,
			researchContract: options.researchContract,
			signal: options.signal
		})
	);
}

function toolContext(
	prompt: string,
	options: {
		provider?: 'perplexity' | 'openai';
		newsroomContext?: ToolRunContext['newsroomContext'];
		temporalContext?: NewsroomTemporalContext;
		documents?: ToolRunContext['documents'];
		researchContract?: ToolRunContext['researchContract'];
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
		temporalContext: options.temporalContext,
		documents: options.documents,
		researchContract: options.researchContract,
		signal: options.signal
	};
}

function jsonResponse(value: unknown): Response {
	return new Response(JSON.stringify(value), {
		status: 200,
		headers: { 'content-type': 'application/json' }
	});
}

function isProviderRequest(value: string | URL | Request): boolean {
	return /api\.(?:openai\.com|perplexity\.ai)/i.test(String(value));
}

function directArticleResponse(
	url: string,
	title: string,
	publishedAt: string | null,
	body: string,
	updatedAt?: string | null
): Response {
	const metadata = {
		'@context': 'https://schema.org',
		'@type': 'NewsArticle',
		headline: title,
		...(publishedAt ? { datePublished: publishedAt } : {}),
		...(updatedAt ? { dateModified: updatedAt } : {}),
		articleBody: body
	};
	const html =
		'<html><head><title>' +
		title +
		'</title><script type="application/ld+json">' +
		JSON.stringify(metadata) +
		'</script></head><body><article><h1>' +
		title +
		'</h1><p>' +
		body +
		'</p></article></body></html>';
	return new Response(html, {
		status: 200,
		headers: { 'content-type': 'text/html; charset=utf-8' }
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
