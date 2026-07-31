import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	buildDisciplinedChatPrompt,
	NewsroomAgentRuntime,
	type RuntimeProgressEvent
} from '../src/agents/runtime.js';
import type { ConversationContext } from '@newscraft/shared';
import { normalizeEvidence } from '../src/agents/evidence.js';
import { createModelPolicyConfig } from '../src/agents/model-policy.js';
import { ToolRegistry, type NewsroomTool, type ToolCategory } from '../src/agents/tools.js';
import { newsroomTimeContext } from '../src/agents/time-context.js';
import { openDatabase, type HarnessDb } from '../src/db/database.js';
import { HarnessRepository } from '../src/db/repository.js';

let db: HarnessDb | null = null;
let repository: HarnessRepository | null = null;

afterEach(() => {
	repository?.close();
	repository = null;
	db = null;
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe('newsroom agent runtime', () => {
	it('answers simple greetings without running disciplined research', async () => {
		const runtime = new NewsroomAgentRuntime({
			maxToolCalls: 1,
			runTimeoutMs: 5000,
			retryLimit: 0,
			modelProvider: 'perplexity',
			modelApiKey: 'fake-key',
			openAiApiKey: ''
		});

		await expect(runtime.completeChat([{ role: 'user', content: 'hi' }])).resolves.toBe(
			'Hi. What should NewsCraft work on?'
		);
	});

	it('answers general writing and planning prompts directly without research progress', async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						output_text:
							'Package it as three recurring segments: the reported scene, the stakes for families, and a practical next-step sidebar.'
					}),
					{ status: 200, headers: { 'content-type': 'application/json' } }
				)
		);
		vi.stubGlobal('fetch', fetchMock);
		const progress: RuntimeProgressEvent[] = [];
		const runtime = new NewsroomAgentRuntime({
			maxToolCalls: 1,
			runTimeoutMs: 5000,
			retryLimit: 0,
			modelProvider: 'openai',
			modelApiKey: 'fake-key',
			openAiApiKey: '',
			agentConfig: {
				model_policy: createModelPolicyConfig({
					models: {
						nano: 'openai/gpt-5-mini',
						mini: 'openai/gpt-5-mini',
						standard: 'openai/gpt-5-mini',
						web_search: 'openai/gpt-5-mini'
					}
				})
			}
		});

		const answer = await runtime.completeChat(
			[{ role: 'user', content: 'Help me plan a three-part feature package about youth sports.' }],
			{ onProgress: (event) => progress.push(event) }
		);

		expect(answer).toContain('three recurring segments');
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
		const body = JSON.parse(String(init?.body || '{}')) as Record<string, unknown>;
		expect(body).not.toHaveProperty('disable_search');
		expect(progress).toEqual([]);
	});

	it('disables Sonar search for direct answer transformations', async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						choices: [{ message: { content: 'Producer brief: confirmed facts remain attributed [1].' } }]
					}),
					{ status: 200, headers: { 'content-type': 'application/json' } }
				)
		);
		vi.stubGlobal('fetch', fetchMock);
		const runtime = new NewsroomAgentRuntime({
			maxToolCalls: 1,
			runTimeoutMs: 5000,
			retryLimit: 0,
			modelProvider: 'perplexity',
			modelApiKey: 'fake-key',
			openAiApiKey: ''
		});

		const answer = await runtime.completeChat([
			{
				role: 'user',
				content: 'Turn the previous answer into a producer brief without researching again.'
			}
		]);

		const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
		const body = JSON.parse(String(init?.body || '{}')) as Record<string, unknown>;
		expect(answer).toContain('Producer brief');
		expect(body.disable_search).toBe(true);
		expect(body).not.toHaveProperty('tools');
	});

	it('keeps current newsroom prompts on the research tool path', async () => {
		const registry = new ToolRegistry();
		registry.register(stubRuntimeTool('openai_web_search', 'web_search_provider', 'Latest Canada story from a readable source.'));
		const progress: RuntimeProgressEvent[] = [];
		const runtime = new NewsroomAgentRuntime({
			maxToolCalls: 2,
			runTimeoutMs: 5000,
			retryLimit: 0,
			modelProvider: 'perplexity',
			modelApiKey: 'fake-key',
			openAiApiKey: '',
			agentConfig: { enabled_tools: ['openai_web_search'], planner_enabled: false },
			registry
		});

		const answer = await runtime.completeChat(
			[{ role: 'user', content: 'What are the latest Canada stories today?' }],
			{
				plannerEnabled: false,
				onProgress: (event) => progress.push(event)
			}
		);

		expect(answer).toContain('Latest Canada story');
		expect(progress.some((event) => event.type === 'tool' && event.name === 'openai_web_search')).toBe(true);
		expect(
			progress.some(
				(event) =>
					event.type === 'source' &&
					event.source.url === 'https://example.com/story' &&
					event.source.used
			)
		).toBe(true);
	});

	it('immediately researches an initial current-events request and filters stale evidence', async () => {
		let receivedQuery = '';
		const registry = new ToolRegistry();
		registry.register({
			name: 'openai_web_search',
			description: 'web fixture',
			when_to_use: 'test only',
			category: 'web_search_provider',
			input_schema: { type: 'object' },
			output_schema: { type: 'object' },
			async run(input) {
				receivedQuery = String((input as { query?: string }).query || '');
				const now = new Date().toISOString();
				return {
					status: 'ok',
					answer:
						'Japan reported a newly reviewed earthquake update [1]. A 2023 earthquake article is also available [2].',
					evidence: [
						normalizeEvidence({
							source_name: 'Japan earthquake authority',
							source_url: 'https://example.go.jp/earthquake-update',
							accessed_at: now,
							tool_used: 'openai_web_search',
							title: 'Latest Japan earthquake update',
							published_at: now,
							extracted_text: 'Japan reported a newly reviewed earthquake update.',
							summary: 'Japan reported a newly reviewed earthquake update.',
							confidence: 0.9,
							limitations: [],
							source_kind: 'official',
							citation_number: 1
						}),
						normalizeEvidence({
							source_name: 'Old Japan earthquake article',
							source_url: 'https://example.com/japan-earthquake-2023',
							accessed_at: now,
							tool_used: 'openai_web_search',
							title: 'Japan earthquake article from 2023',
							published_at: '2023-01-01T12:00:00.000Z',
							extracted_text: 'A 2023 earthquake article is also available.',
							summary: 'A 2023 earthquake article is also available.',
							confidence: 0.8,
							limitations: [],
							source_kind: 'media_report',
							citation_number: 2
						})
					]
				};
			}
		});
		const runtime = new NewsroomAgentRuntime({
			maxToolCalls: 1,
			runTimeoutMs: 5000,
			retryLimit: 0,
			modelProvider: 'perplexity',
			modelApiKey: 'fake-key',
			openAiApiKey: '',
			agentConfig: { enabled_tools: ['openai_web_search'], planner_enabled: false },
			registry
		});
		const progress: RuntimeProgressEvent[] = [];
		const context: ConversationContext = {
			version: 1,
			intent: 'research',
			currentTurn: {
				messageId: 'm1',
				content: "What's the latest on earthquakes in Japan?",
				resolvedRequest: "What's the latest on earthquakes in Japan?",
				operation: 'send',
				researchRequired: true,
				freshness: 'current'
			},
			activeTopic: {
				subject: "What's the latest on earthquakes in Japan?",
				location: 'Japan',
				relevantDate: 'latest'
			}
		};

		const answer = await runtime.completeChat(
			[{ role: 'user', content: "What's the latest on earthquakes in Japan?" }],
			{
				plannerEnabled: false,
				conversationContext: context,
				onProgress: (event) => progress.push(event)
			}
		);

		expect(receivedQuery).toContain('earthquakes in Japan');
		expect(answer).toContain('Japan reported');
		expect(answer).not.toMatch(/2023 earthquake article|\[2\]/);
		const plans = progress.filter((event) => event.type === 'plan');
		expect(plans.length).toBeGreaterThan(1);
		const finalPlan = plans.at(-1);
		expect(finalPlan?.type === 'plan' ? finalPlan.steps.map((step) => step.status) : []).toEqual(['ok']);
	});

	it('keeps structured newsroom context out of the routed tool query', async () => {
		let receivedQuery = '';
		const registry = new ToolRegistry();
		registry.register({
			name: 'openai_web_search',
			description: 'web fixture',
			when_to_use: 'test only',
			category: 'web_search_provider',
			input_schema: { type: 'object' },
			output_schema: { type: 'object' },
			async run(input) {
				receivedQuery = String((input as { query?: string }).query || '');
				return {
					status: 'ok',
					answer: 'The transit agency posted an update [1].',
					evidence: [
						normalizeEvidence({
							source_name: 'Transit agency',
							source_url: 'https://transit.example.gov/update',
							tool_used: 'openai_web_search',
							title: 'Service update',
							extracted_text: 'Service changes begin tonight.',
							summary: 'Service changes begin tonight.',
							confidence: 0.9,
							limitations: [],
							source_kind: 'official',
							citation_number: 1
						})
					]
				};
			}
		});
		const runtime = new NewsroomAgentRuntime({
			maxToolCalls: 1,
			runTimeoutMs: 5000,
			retryLimit: 0,
			modelProvider: 'perplexity',
			modelApiKey: 'fake-key',
			openAiApiKey: '',
			registry
		});
		const question = 'What is the latest transit update today?';

		await runtime.completeChat([{ role: 'user', content: question }], {
			plannerEnabled: false,
			newsroomContext: {
				timezone: 'America/Vancouver',
				homeMarket: 'Vancouver',
				preferredDomains: ['transit.example.gov']
			}
		});

		expect(receivedQuery).toBe(question);
	});

	it('does not answer a Toronto weather follow-up with unrelated Santo Domingo baseball evidence', async () => {
		const registry = new ToolRegistry();
		let webToolCalls = 0;
		registry.register({
			name: 'openai_web_search',
			description: 'web fixture',
			when_to_use: 'test only',
			category: 'web_search_provider',
			input_schema: { type: 'object' },
			output_schema: { type: 'object' },
			async run() {
				webToolCalls += 1;
				return {
					status: 'ok',
					answer: 'Santo Domingo baseball clubs play tonight [1].',
					evidence: [
						normalizeEvidence({
							source_name: 'Sports feed',
							source_url: 'https://example.com/santo-domingo-baseball',
							accessed_at: '2026-07-28T12:00:00.000Z',
							tool_used: 'openai_web_search',
							title: 'Santo Domingo baseball schedule',
							published_at: '2026-07-28',
							extracted_text: 'Santo Domingo baseball clubs play tonight.',
							summary: 'Santo Domingo baseball clubs play tonight.',
							confidence: 0.8,
							limitations: [],
							source_kind: 'media_report',
							citation_number: 1
						})
					]
				};
			}
		});
		const context: ConversationContext = {
			intent: 'verify',
			activeTopic: {
				subject: 'ECCC weather alert for Toronto on July 28, 2026',
				entities: ['ECCC'],
				location: 'Toronto',
				relevantDate: '2026-07-28'
			},
			lastSourceBackedAnswer: {
				messageId: 'message-weather',
				content: 'No active Toronto ECCC alert was verified [1].',
				citations: [
					{
						citationNumber: 1,
						title: 'Toronto weather alerts',
						url: 'https://weather.gc.ca/warnings/report_e.html?on61',
						domain: 'weather.gc.ca',
						publicationDate: '2026-07-28',
						sourceType: 'official',
						supportingExcerpt: 'ECCC warning page for Toronto.'
					}
				],
				publicationDates: ['2026-07-28']
			}
		};
		const progress: RuntimeProgressEvent[] = [];
		const runtime = new NewsroomAgentRuntime({
			maxToolCalls: 1,
			runTimeoutMs: 5000,
			retryLimit: 0,
			modelProvider: 'perplexity',
			modelApiKey: 'fake-key',
			openAiApiKey: '',
			registry
		});

		const answer = await runtime.completeChat([{ role: 'user', content: 'Search sources and verify whether it is still active today.' }], {
			plannerEnabled: false,
			conversationContext: context,
			onProgress: (event) => progress.push(event)
		});

		expect(answer).not.toMatch(/Santo Domingo|baseball|clubs play/i);
		expect(answer).toMatch(/couldn't verify|No gathered evidence|no usable source/i);
		expect(webToolCalls).toBe(1);
		expect(progress.some((event) => event.type === 'source')).toBe(false);
	});

	it('drafts Toronto transit OCVO from the selected answer without researching a heat warning', async () => {
		const fetchMock = vi.fn(async () =>
			new Response(JSON.stringify({ output_text: 'A heat warning script should not be used.' }), {
				status: 200,
				headers: { 'content-type': 'application/json' }
			})
		);
		vi.stubGlobal('fetch', fetchMock);
		const progress: RuntimeProgressEvent[] = [];
		const context: ConversationContext = {
			intent: 'transform',
			sourceMessageId: 'message-transit',
			activeTopic: {
				subject: 'Toronto transit service changes tonight',
				entities: ['TTC'],
				location: 'Toronto'
			},
			lastSourceBackedAnswer: {
				messageId: 'message-transit',
				content:
					'The TTC lists Toronto transit service changes for tonight [2]. Riders should check the affected routes before leaving.',
				citations: [
					{
						citationNumber: 2,
						title: 'TTC service advisories',
						url: 'https://www.ttc.ca/service-advisories',
						domain: 'ttc.ca',
						publicationDate: '2026-07-28',
						sourceType: 'official',
						supportingExcerpt: 'Service changes are listed for tonight.'
					}
				],
				publicationDates: ['2026-07-28']
			}
		};
		const runtime = new NewsroomAgentRuntime({
			maxToolCalls: 1,
			runTimeoutMs: 5000,
			retryLimit: 0,
			modelProvider: 'openai',
			modelApiKey: 'fake-key',
			openAiApiKey: ''
		});

		const answer = await runtime.completeChat(
			[{ role: 'user', content: 'Write a 30-second OC/VO from this answer.' }],
			{ conversationContext: context, onProgress: (event) => progress.push(event) }
		);

		expect(fetchMock).not.toHaveBeenCalled();
		expect(progress).toEqual([
			{
				type: 'citations',
				citations: context.lastSourceBackedAnswer?.citations
			}
		]);
		expect(answer).toMatch(/^ON CAM:\n/);
		expect(answer).toContain('\n\nVO:\n');
		expect(answer).toContain('\n\nBANNER:\n');
		expect(answer).toContain('TTC');
		expect(answer).toContain('Toronto transit');
		expect(answer).toContain('[2]');
		expect(answer).not.toMatch(/heat warning|weather\.gc\.ca|Sources|End|If you/i);
	});

	it('does not duplicate or un-cite a one-line selected source in OCVO fallback', async () => {
		const fetchMock = vi.fn(async () =>
			new Response(JSON.stringify({ output_text: 'Provider text should not be used.' }), {
				status: 200,
				headers: { 'content-type': 'application/json' }
			})
		);
		vi.stubGlobal('fetch', fetchMock);
		const claim = 'The TTC says Line 1 service changes start tonight';
		const context: ConversationContext = {
			intent: 'transform',
			sourceMessageId: 'message-transit',
			activeTopic: {
				subject: 'Toronto transit service changes tonight',
				entities: ['TTC'],
				location: 'Toronto'
			},
			lastSourceBackedAnswer: {
				messageId: 'message-transit',
				content: `${claim} [1].`,
				citations: [
					{
						citationNumber: 1,
						title: 'TTC service advisory',
						url: 'https://www.ttc.ca/service-advisories/line-1',
						domain: 'ttc.ca',
						publicationDate: '2026-07-28',
						sourceType: 'official',
						supportingExcerpt: 'Line 1 service changes start tonight.'
					}
				],
				publicationDates: ['2026-07-28']
			}
		};
		const runtime = new NewsroomAgentRuntime({
			maxToolCalls: 1,
			runTimeoutMs: 5000,
			retryLimit: 0,
			modelProvider: 'openai',
			modelApiKey: 'fake-key',
			openAiApiKey: ''
		});

		const answer = await runtime.completeChat(
			[{ role: 'user', content: 'Write a 30-second OC/VO from this answer.' }],
			{ conversationContext: context }
		);

		expect(fetchMock).not.toHaveBeenCalled();
		expect(answer).toMatch(/^ON CAM:\n/);
		expect(answer).toContain('\n\nVO:\nNo additional sourced VO detail is confirmed in the selected answer.');
		expect(answer.match(new RegExp(claim, 'g'))).toHaveLength(1);
		expect(answer).toContain(`${claim} [1].`);
		expect(answer.match(/\[1\]/g)).toHaveLength(1);
		expect(answer).not.toContain('Provider text should not be used');
	});

	it('preserves a tail citation when shortening a long one-source OCVO line', async () => {
		const fetchMock = vi.fn(async () =>
			new Response(JSON.stringify({ output_text: 'Provider text should not be used.' }), {
				status: 200,
				headers: { 'content-type': 'application/json' }
			})
		);
		vi.stubGlobal('fetch', fetchMock);
		const longClaim = [
			'The TTC says overnight Line 1 work will close several downtown stations after the evening rush',
			'with replacement shuttle buses assigned to the corridor and customer-service staff posted at key transfer points',
			'while crews complete signal testing, track inspections, platform repairs, and accessibility checks before morning service resumes'
		].join(' ');
		const sourceSentence = `${longClaim} [1].`;
		expect(sourceSentence.indexOf('[1]')).toBeGreaterThan(260);
		const context: ConversationContext = {
			intent: 'transform',
			sourceMessageId: 'message-long-transit',
			activeTopic: {
				subject: 'Toronto transit service changes tonight',
				entities: ['TTC'],
				location: 'Toronto'
			},
			lastSourceBackedAnswer: {
				messageId: 'message-long-transit',
				content: sourceSentence,
				citations: [
					{
						citationNumber: 1,
						title: 'TTC service advisory',
						url: 'https://www.ttc.ca/service-advisories/line-1',
						domain: 'ttc.ca',
						publicationDate: '2026-07-28',
						sourceType: 'official',
						supportingExcerpt: 'Overnight Line 1 work will close several downtown stations.'
					}
				],
				publicationDates: ['2026-07-28']
			}
		};
		const runtime = new NewsroomAgentRuntime({
			maxToolCalls: 1,
			runTimeoutMs: 5000,
			retryLimit: 0,
			modelProvider: 'openai',
			modelApiKey: 'fake-key',
			openAiApiKey: ''
		});

		const answer = await runtime.completeChat(
			[{ role: 'user', content: 'Write a 30-second OC/VO from this answer.' }],
			{ conversationContext: context }
		);

		const onCam = answer.split('\n')[1] || '';
		expect(fetchMock).not.toHaveBeenCalled();
		expect(answer).toMatch(/^ON CAM:\n/);
		expect(onCam.length).toBeLessThanOrEqual(260);
		expect(onCam).toMatch(/\[1\]\.$/);
		expect(answer.match(/\[1\]/g)).toHaveLength(1);
		expect(onCam).toMatch(/^The TTC says overnight Line 1 work/);
		expect(answer).toContain('\n\nVO:\nNo additional sourced VO detail is confirmed in the selected answer.');
		expect(answer).not.toContain('Provider text should not be used');
	});

	it('preserves all tail citations when shortening a long multi-marker OCVO line', async () => {
		const fetchMock = vi.fn(async () =>
			new Response(JSON.stringify({ output_text: 'Provider text should not be used.' }), {
				status: 200,
				headers: { 'content-type': 'application/json' }
			})
		);
		vi.stubGlobal('fetch', fetchMock);
		const longClaim = [
			'Transit officials say the downtown service plan includes Line 1 station closures, Queen Street shuttle routing',
			'and unchanged GO Transit connections for late-night riders moving between Union Station, Saint George, and the west-end bus bridge',
			'with agencies advising passengers to check platform signs, route notices, and posted supervisor instructions before leaving'
		].join(' ');
		const sourceSentence = `${longClaim} [1] [2] [3].`;
		expect(sourceSentence.indexOf('[1]')).toBeGreaterThan(260);
		const context: ConversationContext = {
			intent: 'transform',
			sourceMessageId: 'message-long-transit',
			activeTopic: {
				subject: 'Toronto transit service changes tonight',
				entities: ['TTC', 'City of Toronto', 'Metrolinx'],
				location: 'Toronto'
			},
			lastSourceBackedAnswer: {
				messageId: 'message-long-transit',
				content: sourceSentence,
				citations: [
					{
						citationNumber: 1,
						title: 'TTC service advisory',
						url: 'https://www.ttc.ca/service-advisories/line-1',
						domain: 'ttc.ca',
						publicationDate: '2026-07-28',
						sourceType: 'official',
						supportingExcerpt: 'Line 1 station closures are listed.'
					},
					{
						citationNumber: 2,
						title: 'Queen Street shuttle update',
						url: 'https://www.toronto.ca/news/queen-shuttle',
						domain: 'toronto.ca',
						publicationDate: '2026-07-28',
						sourceType: 'official',
						supportingExcerpt: 'Queen Street shuttle routing is listed.'
					},
					{
						citationNumber: 3,
						title: 'GO Transit update',
						url: 'https://www.gotransit.com/service-updates',
						domain: 'gotransit.com',
						publicationDate: '2026-07-28',
						sourceType: 'primary',
						supportingExcerpt: 'GO Transit connections are unchanged.'
					}
				],
				publicationDates: ['2026-07-28']
			}
		};
		const runtime = new NewsroomAgentRuntime({
			maxToolCalls: 1,
			runTimeoutMs: 5000,
			retryLimit: 0,
			modelProvider: 'openai',
			modelApiKey: 'fake-key',
			openAiApiKey: ''
		});

		const answer = await runtime.completeChat(
			[{ role: 'user', content: 'Write a 30-second OC/VO from this answer.' }],
			{ conversationContext: context }
		);

		const onCam = answer.split('\n')[1] || '';
		expect(fetchMock).not.toHaveBeenCalled();
		expect(answer).toMatch(/^ON CAM:\n/);
		expect(onCam.length).toBeLessThanOrEqual(260);
		expect(onCam).toMatch(/\[1\] \[2\] \[3\]\.$/);
		expect(answer.match(/\[\d+\]/g)).toEqual(['[1]', '[2]', '[3]']);
		expect(onCam).toMatch(/^Transit officials say the downtown service plan/);
		expect(answer).toContain('\n\nVO:\nNo additional sourced VO detail is confirmed in the selected answer.');
		expect(answer).not.toContain('Provider text should not be used');
	});

	it('preserves multi-source OCVO claim citations from the selected answer without research', async () => {
		const fetchMock = vi.fn(async () =>
			new Response(JSON.stringify({ output_text: 'Provider text should not be used.' }), {
				status: 200,
				headers: { 'content-type': 'application/json' }
			})
		);
		vi.stubGlobal('fetch', fetchMock);
		const context: ConversationContext = {
			intent: 'transform',
			sourceMessageId: 'message-transit',
			activeTopic: {
				subject: 'Toronto transit service changes tonight',
				entities: ['TTC'],
				location: 'Toronto'
			},
			lastSourceBackedAnswer: {
				messageId: 'message-transit',
				content: [
					'The TTC says Line 1 service changes start tonight [1].',
					'The City of Toronto says shuttle buses will run on Queen Street [2].',
					'Metrolinx says GO Transit connections are not affected [3].'
				].join(' '),
				citations: [
					{
						citationNumber: 1,
						title: 'TTC service advisory',
						url: 'https://www.ttc.ca/service-advisories/line-1',
						domain: 'ttc.ca',
						publicationDate: '2026-07-28',
						sourceType: 'official',
						supportingExcerpt: 'Line 1 service changes start tonight.'
					},
					{
						citationNumber: 2,
						title: 'Queen Street shuttle update',
						url: 'https://www.toronto.ca/news/queen-shuttle',
						domain: 'toronto.ca',
						publicationDate: '2026-07-28',
						sourceType: 'official',
						supportingExcerpt: 'Shuttle buses will run on Queen Street.'
					},
					{
						citationNumber: 3,
						title: 'GO Transit update',
						url: 'https://www.gotransit.com/service-updates',
						domain: 'gotransit.com',
						publicationDate: '2026-07-28',
						sourceType: 'primary',
						supportingExcerpt: 'GO Transit connections are not affected.'
					}
				],
				publicationDates: ['2026-07-28']
			}
		};
		const runtime = new NewsroomAgentRuntime({
			maxToolCalls: 1,
			runTimeoutMs: 5000,
			retryLimit: 0,
			modelProvider: 'openai',
			modelApiKey: 'fake-key',
			openAiApiKey: ''
		});

		const answer = await runtime.completeChat(
			[{ role: 'user', content: 'Write a 30-second OC/VO from this answer.' }],
			{ conversationContext: context }
		);

		expect(fetchMock).not.toHaveBeenCalled();
		expect(answer).toMatch(/^ON CAM:\n/);
		expect(answer).toContain('\n\nVO:\n');
		expect(answer).toMatch(/TTC says Line 1 service changes start tonight \[1\]\./);
		expect(answer).toMatch(/shuttle buses will run on Queen Street \[2\]\./);
		expect(answer).toMatch(/GO Transit connections are not affected \[3\]\./);
		for (const number of [1, 2, 3]) {
			expect(answer.match(new RegExp(`\\[${number}\\]`, 'g'))).toHaveLength(1);
		}
		expect(answer).not.toMatch(/Provider text|openai|web_search|Would you like|Sources|End/i);
	});

	it('routes the current user question without letting system tool guidance hijack it', async () => {
		const registry = new ToolRegistry();
		registry.register(
			stubRuntimeTool(
				'openai_web_search',
				'web_search_provider',
				'Spain vs Belgium is scheduled for 3:00 PM EDT today.'
			)
		);
		registry.register(
			stubRuntimeTool(
				'browser_automation_provider',
				'browser_automation_provider',
				'Browser automation should not run for a schedule lookup.'
			)
		);
		const progress: RuntimeProgressEvent[] = [];
		const runtime = new NewsroomAgentRuntime({
			maxToolCalls: 1,
			runTimeoutMs: 5000,
			retryLimit: 0,
			modelProvider: 'perplexity',
			modelApiKey: 'fake-key',
			openAiApiKey: '',
			registry
		});

		const answer = await runtime.completeChat(
			[
				{
					role: 'system',
					content: 'Use available browser, search, file, and terminal tools when the user requests them.'
				},
				{ role: 'user', content: 'what fifa games are being played today' }
			],
			{
				plannerEnabled: false,
				onProgress: (event) => progress.push(event)
			}
		);

		expect(answer).toContain('Spain vs Belgium');
		expect(progress.some((event) => event.type === 'tool' && event.name === 'openai_web_search')).toBe(true);
		expect(
			progress.some((event) => event.type === 'tool' && event.name === 'browser_automation_provider')
		).toBe(false);
	});

	it('treats attached pages as document evidence and emits resolvable page citations', async () => {
		const registry = new ToolRegistry();
		registry.register({
			name: 'pdf_text_extractor',
			description: 'document fixture',
			when_to_use: 'test only',
			category: 'pdf_text_extractor',
			input_schema: { type: 'object' },
			output_schema: { type: 'object' },
			async run(_input, context) {
				const document = context.documents?.[0];
				const page = document?.pages[0];
				return {
					status: 'ok',
					evidence: [
						normalizeEvidence({
							source_name: document?.filename || 'memo.pdf',
							source_url: `${document?.downloadUrl || '/api/document'}#page=${page?.pageNumber || 1}`,
							tool_used: 'pdf_text_extractor',
							title: `${document?.filename || 'memo.pdf'}, page ${page?.pageNumber || 1}`,
							extracted_text: page?.text || '',
							summary: page?.text || '',
							confidence: 0.9,
							limitations: ['User-provided document; not independently verified.'],
							source_kind: 'user_document',
							citation_number: 1,
							document_page: page?.pageNumber || 1
						})
					]
				};
			}
		});
		const progress: RuntimeProgressEvent[] = [];
		const runtime = new NewsroomAgentRuntime({
			maxToolCalls: 1,
			runTimeoutMs: 5000,
			retryLimit: 0,
			modelProvider: 'perplexity',
			modelApiKey: 'fake-key',
			openAiApiKey: '',
			registry
		});

		const answer = await runtime.completeChat([{ role: 'user', content: 'Summarize this.' }], {
			plannerEnabled: false,
			documents: [
				{
					id: 'doc_1',
					filename: 'memo.pdf',
					downloadUrl: '/api/conversations/convo/documents/doc_1/download',
					pageCount: 2,
					pages: [{ pageNumber: 2, text: 'The memo allocates $4 million to transit safety.' }]
				}
			],
			onProgress: (event) => progress.push(event)
		});

		expect(answer).toContain('allocates $4 million');
		expect(answer).toContain('[1]');
		expect(
			progress.find((event) => event.type === 'citations')
		).toMatchObject({
			type: 'citations',
			citations: [
				{
					citationNumber: 1,
					sourceType: 'user_document',
					documentPage: 2
				}
			]
		});
	});

	it('keeps web and attached-document citation numbers distinct during corroboration', async () => {
		const registry = new ToolRegistry();
		let webQuery = '';
		registry.register({
			name: 'pdf_text_extractor',
			description: 'document fixture',
			when_to_use: 'test only',
			category: 'pdf_text_extractor',
			input_schema: { type: 'object' },
			output_schema: { type: 'object' },
			async run() {
				return {
					status: 'ok',
					evidence: [
						normalizeEvidence({
							source_name: 'memo.pdf',
							source_url: '/api/conversations/convo/documents/doc_1/download#page=1',
							tool_used: 'pdf_text_extractor',
							title: 'memo.pdf, page 1',
							extracted_text: 'The memo says the program begins Monday.',
							summary: 'The memo says the program begins Monday.',
							confidence: 0.9,
							limitations: [],
							source_kind: 'user_document',
							citation_number: 1,
							document_page: 1
						})
					]
				};
			}
		});
		registry.register({
			name: 'openai_web_search',
			description: 'official web fixture',
			when_to_use: 'test only',
			category: 'web_search_provider',
			input_schema: { type: 'object' },
			output_schema: { type: 'object' },
			async run(input) {
				webQuery = String((input as { query?: string }).query || '');
				return {
					status: 'ok',
					answer: 'The official notice confirms the Monday start. [1]',
					evidence: [
						normalizeEvidence({
							source_name: 'City notice',
							source_url: 'https://city.example.gov/notice',
							tool_used: 'openai_web_search',
							title: 'Official notice',
							extracted_text: 'The program begins Monday.',
							summary: 'The program begins Monday.',
							confidence: 0.9,
							limitations: [],
							source_kind: 'official',
							citation_number: 1
						})
					]
				};
			}
		});
		const progress: RuntimeProgressEvent[] = [];
		const runtime = new NewsroomAgentRuntime({
			maxToolCalls: 2,
			runTimeoutMs: 5000,
			retryLimit: 0,
			modelProvider: 'perplexity',
			modelApiKey: 'fake-key',
			openAiApiKey: '',
			registry
		});

		const answer = await runtime.completeChat(
			[{ role: 'user', content: 'Verify this attached document against external sources.' }],
			{
				plannerEnabled: false,
				documents: [
					{
						id: 'doc_1',
						filename: 'memo.pdf',
						downloadUrl: '/api/conversations/convo/documents/doc_1/download',
						pageCount: 1,
						pages: [{ pageNumber: 1, text: 'The memo says the program begins Monday.' }]
					}
				],
				onProgress: (event) => progress.push(event)
			}
		);

		expect(answer).toContain('program begins Monday');
		expect(webQuery).toContain('The memo says the program begins Monday.');
		expect(answer).toContain('[1]');
		expect(answer).toContain('Attached document evidence');
		expect(answer).toContain('[2]');
		const citations = progress.find((event) => event.type === 'citations');
		expect(citations).toMatchObject({
			type: 'citations',
			citations: [
				{ citationNumber: 1, sourceType: 'official' },
				{ citationNumber: 2, sourceType: 'user_document', documentPage: 1 }
			]
		});
	});

		it('asks for clarification on ambiguous follow-ups without prior context', async () => {
			const fetchMock = vi.fn();
			vi.stubGlobal('fetch', fetchMock);
			const progress: RuntimeProgressEvent[] = [];
			const runtime = new NewsroomAgentRuntime({
				maxToolCalls: 1,
				runTimeoutMs: 5000,
				retryLimit: 0,
				modelProvider: 'openai',
				modelApiKey: 'fake-key',
				openAiApiKey: ''
			});

			const answer = await runtime.completeChat(
				[{ role: 'user', content: 'What did they say about it?' }],
				{ onProgress: (event) => progress.push(event) }
			);

			expect(answer).toContain('Could you clarify');
			expect(answer).toContain('story, source, or statement');
			expect(fetchMock).not.toHaveBeenCalled();
			expect(progress).toEqual([]);
		});

		it('runs direct URL summaries through the direct page reader', async () => {
			const registry = new ToolRegistry();
			registry.register(stubRuntimeTool('url_fetch_read', 'custom', 'Reader handled the supplied URL.'));
		registry.register(stubRuntimeTool('openai_web_search', 'web_search_provider', 'Web search should not run for direct URLs.'));
		const progress: RuntimeProgressEvent[] = [];
		const runtime = new NewsroomAgentRuntime({
			maxToolCalls: 2,
			runTimeoutMs: 5000,
			retryLimit: 0,
			modelProvider: 'perplexity',
			modelApiKey: 'fake-key',
			openAiApiKey: '',
			registry
		});

		const answer = await runtime.completeChat(
			[{ role: 'user', content: 'summarize http://127.0.0.1/latest' }],
			{
				plannerEnabled: false,
				onProgress: (event) => progress.push(event)
			}
		);

			expect(answer).toContain('Reader handled');
			expect(progress.some((event) => event.type === 'tool' && event.name === 'url_fetch_read')).toBe(true);
		expect(progress.some((event) => event.type === 'tool' && event.name === 'openai_web_search')).toBe(false);
	});

	it('anchors relative dates to Toronto local time instead of UTC', () => {
		const utcAfterMidnight = new Date(Date.UTC(2026, 5, 24, 3, 10));
		const context = newsroomTimeContext({
			now: utcAfterMidnight,
			timeZone: 'America/Toronto'
		});

		expect(context).toContain('Tuesday, June 23, 2026');
		expect(context).toContain('11:10 PM EDT');
		expect(context).toContain('Newsroom timezone: America/Toronto');

		const prompt = buildDisciplinedChatPrompt(
			[{ role: 'user', content: 'what are the fifa games played in toronto today' }],
			{ now: utcAfterMidnight, timeZone: 'America/Toronto' }
		);

		expect(prompt).toContain('Current local newsroom time: Tuesday, June 23, 2026 at 11:10 PM EDT.');
		expect(prompt).toContain('Interpret relative date phrases');
		expect(prompt).toContain('Current user question:');
		expect(prompt).toContain('what are the fifa games played in toronto today');
	});

	it('enforces one local Current as of label on current-event answers', async () => {
		const registry = new ToolRegistry();
		registry.register(
			stubRuntimeTool(
				'openai_web_search',
				'web_search_provider',
				'The fixture answer reports the latest confirmed development [1].'
			)
		);
		const runtime = new NewsroomAgentRuntime({
			maxToolCalls: 1,
			runTimeoutMs: 5000,
			retryLimit: 0,
			modelProvider: 'perplexity',
			modelApiKey: 'fake-key',
			openAiApiKey: '',
			registry
		});
		const messages = [{ role: 'user' as const, content: 'What are the latest confirmed stories today?' }];
		const context = {
			plannerEnabled: false,
			newsroomContext: { timezone: 'America/Vancouver' }
		};

		const answer = await runtime.completeChat(messages, context);
		expect(answer).toMatch(/^\*\*Current as of:\*\*/);
		expect(answer.match(/Current as of/g)).toHaveLength(1);

		let streamed = '';
		for await (const delta of runtime.streamChat(messages, context)) streamed += delta;
		expect(streamed).toMatch(/^\*\*Current as of:\*\*/);
		expect(streamed.match(/Current as of/g)).toHaveLength(1);
	});

	it('builds a bounded follow-up prompt from recent conversation context', () => {
		const prompt = buildDisciplinedChatPrompt(
			[
				{ role: 'system', content: 'System instructions should not become follow-up context.' },
				{ role: 'user', content: 'What did Mark Carney say about recession in Canada today?' },
				{
					role: 'assistant',
					content: [
						'Pressed on GDP data showing a technical recession, Mark Carney said the data will be uneven.',
						'[NewsCraft source context for follow-up questions]',
						'Sources used:',
						'- Carney says some Canadian economic data will be uneven (investing.com)'
					].join('\n')
				},
				{ role: 'user', content: 'what are the policy shifts he is referring to?' }
			],
			{},
			undefined,
			[],
			{
				version: 1,
				intent: 'research',
				activeTopic: { subject: 'Mark Carney policy shifts in Canada' }
			}
		);

		expect(prompt).toContain('Current user question:');
		expect(prompt).toContain('what are the policy shifts he is referring to?');
		expect(prompt).toContain('Recent conversation context');
		expect(prompt).toContain('Mark Carney');
		expect(prompt).toContain('investing.com');
		expect(prompt).toContain('System and newsroom instructions:');
		expect(prompt).toContain('System instructions should not become follow-up context.');
		expect(prompt.indexOf('System instructions should not become follow-up context.')).toBeLessThan(
			prompt.indexOf('Recent conversation context')
		);
	});

	it('formats fixture follow-ups from prior assistant content without rerunning research', async () => {
		const runtime = new NewsroomAgentRuntime({
			maxToolCalls: 1,
			runTimeoutMs: 5000,
			retryLimit: 0,
			modelProvider: 'perplexity',
			modelApiKey: 'fake-key',
			openAiApiKey: ''
		});

		const answer = await runtime.completeChat([
			{ role: 'user', content: 'what fifa games are scheduled for today' },
			{
				role: 'assistant',
				content: [
					'FIFA World Cup 2026 - Tuesday, June 16, 2026',
					'',
					'- Group G - Iran vs New Zealand',
					' - Kick-off: 2:00 a.m.',
					' - Venue: Los Angeles / Inglewood area stadium',
					'',
					'- Group I - France vs Senegal',
					' - Kick-off: 3:00 p.m.',
					' - Venue: New York / New Jersey area stadium'
				].join('\n')
			},
			{ role: 'user', content: 'give it in a proper table' }
		]);

		expect(answer).toContain('| Group | Match | Kick-off | Venue |');
		expect(answer).toContain('| Group G | Iran vs New Zealand | 2:00 a.m. | Los Angeles / Inglewood area stadium |');
		expect(answer).toContain('| Group I | France vs Senegal | 3:00 p.m. | New York / New Jersey area stadium |');
		expect(answer).not.toContain('This research update found');
	});

	it('emits assignment desk triage events before running a mission', async () => {
		db = openDatabase(':memory:');
		repository = new HarnessRepository(db);
		const job = repository.createJob({
			name: 'Mayor lookup',
			prompt: 'Who is the mayor of Toronto?',
			schedule: 'every 60m'
		});
		const run = repository.createRun(job.id, 'test');
		const progress: RuntimeProgressEvent[] = [];
		const runtime = new NewsroomAgentRuntime({
			maxToolCalls: 1,
			runTimeoutMs: 5000,
			retryLimit: 0,
			openAiApiKey: ''
		});

		const result = await runtime.runMission(job.prompt, {
			repository,
			runId: run.id,
			jobId: job.id,
			onProgress: (event) => progress.push(event)
		});

		expect(result.role).toBe('research');
		expect(
			progress
				.filter((event) => event.type === 'tool' && event.name === 'assignment_desk')
				.map((event) => event.status)
		).toEqual(['running', 'ok']);
		const triage = repository.listEvents({ runId: run.id }).find((event) => event.kind === 'assignment.triaged');
		expect(triage).toMatchObject({
			agent: 'assignment_desk',
			job_id: job.id,
			run_id: run.id,
			payload: {
				routed_role: 'research',
				selected_mode: 'web_search',
				tools_to_use: ['openai_web_search']
			}
		});
	});

	it('skips scheduled synthesis model calls through model policy', async () => {
		db = openDatabase(':memory:');
		repository = new HarnessRepository(db);
		const job = repository.createJob({
			name: 'Scheduled lookup',
			prompt: 'Who is the mayor of Toronto?',
			schedule: 'every 60m'
		});
		const run = repository.createRun(job.id, 'schedule');
		const runtime = new NewsroomAgentRuntime({
			maxToolCalls: 1,
			runTimeoutMs: 5000,
			retryLimit: 0,
			openAiApiKey: 'fake-key'
		});

		await runtime.runMission(job.prompt, {
			repository,
			runId: run.id,
			jobId: job.id,
			trigger: 'schedule'
		});

		expect(
			repository.listEvents({ runId: run.id }).filter((event) => event.kind === 'model.call.skipped')
		).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					agent: 'model_policy',
					payload: expect.objectContaining({
						task: 'scheduled_research_update',
						reason: 'Scheduled model calls are disabled by model policy.'
					})
				})
			])
		);
	});

	const liveSmoke = process.env.NEWSROOM_HARNESS_LIVE_OPENAI_SMOKE === '1';
	const liveIt = liveSmoke ? it : it.skip;

	liveIt('streams a short live OpenAI response without empty output or adjacent duplicate chunks', async () => {
		expect(process.env.OPENAI_API_KEY, 'OPENAI_API_KEY must be set for live smoke').toBeTruthy();
		const runtime = new NewsroomAgentRuntime({
			maxToolCalls: 1,
			runTimeoutMs: 30_000,
			retryLimit: 0,
			openAiApiKey: process.env.OPENAI_API_KEY || ''
		});
		const chunks: string[] = [];
		for await (const delta of runtime.streamChat(
			[{ role: 'user', content: 'Reply with exactly: Producer smoke OK' }],
			{ model: process.env.NEWSROOM_HARNESS_SMOKE_MODEL }
		)) {
			chunks.push(delta);
		}

		const output = chunks.join('').trim();
		expect(output.length).toBeGreaterThan(0);
		expect(chunks.some((chunk, index) => chunk && index > 0 && chunks[index - 1] === chunk)).toBe(false);
	});

	const liveResearchSmoke = process.env.NEWSROOM_HARNESS_LIVE_RESEARCH_SMOKE === '1';
	const liveResearchIt = liveResearchSmoke ? it : it.skip;

	liveResearchIt('returns fresh readable evidence for a basic current-news research request', async () => {
		expect(process.env.OPENAI_API_KEY, 'OPENAI_API_KEY must be set for live research smoke').toBeTruthy();
		const progress: RuntimeProgressEvent[] = [];
		const runtime = new NewsroomAgentRuntime({
			maxToolCalls: 4,
			runTimeoutMs: 120_000,
			retryLimit: 1,
			modelProvider: 'openai',
			modelApiKey: process.env.OPENAI_API_KEY || '',
			openAiApiKey: process.env.OPENAI_API_KEY || '',
			perplexityApiKey: process.env.PERPLEXITY_API_KEY || '',
			agentConfig: {
				enabled_tools: ['openai_web_search'],
				planner_enabled: false,
				model_provider: 'openai',
				model_policy: createModelPolicyConfig({
					models: {
						nano: 'openai/gpt-5-mini',
						mini: 'openai/gpt-5-mini',
						standard: 'openai/gpt-5-mini',
						web_search: 'openai/gpt-5-mini'
					}
				})
			}
		});

		const answer = await runtime.completeChat(
			[{ role: 'user', content: "What's the latest on earthquakes in Japan?" }],
			{
				newsroomContext: { timezone: 'America/Toronto' },
				onProgress: (event) => progress.push(event)
			}
		);

		expect(answer).not.toMatch(/couldn't verify this from readable sources|temporarily unavailable/i);
		expect(progress.some((event) => event.type === 'source')).toBe(true);
		expect(
			progress.some(
				(event) => event.type === 'citations' && event.citations.length > 0
			)
		).toBe(true);
		expect(
			progress.some(
				(event) =>
					event.type === 'tool' &&
					event.name === 'openai_web_search' &&
					event.status === 'ok' &&
					Number((event.result as { count?: number } | undefined)?.count) > 0
			)
		).toBe(true);
	});
});

function stubRuntimeTool(name: string, category: ToolCategory, text: string): NewsroomTool {
	return {
		name,
		description: `${name} stub`,
		when_to_use: 'test only',
		category,
		input_schema: { type: 'object' },
		output_schema: { type: 'object' },
		async run() {
			const now = new Date().toISOString();
			return {
				status: 'ok',
				answer: text,
				evidence: [
					normalizeEvidence({
						source_name: `${name} fixture`,
						source_url: name === 'source_feed_fetcher' ? 'http://127.0.0.1/latest' : 'https://example.com/story',
						accessed_at: now,
						tool_used: name,
						title: `${name} result`,
						published_at: now,
						extracted_text: text,
						summary: text,
						confidence: 0.8,
						limitations: [],
						source_kind: name === 'source_feed_fetcher' ? 'primary' : 'media_report'
					})
				]
			};
		}
	};
}
