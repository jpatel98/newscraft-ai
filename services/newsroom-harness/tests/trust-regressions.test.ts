import type { CitationRecord, ConversationContext } from '@newscraft/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	NewsroomAgentRuntime,
	type RuntimeProgressEvent
} from '../src/agents/runtime.js';
import { createModelPolicyConfig } from '../src/agents/model-policy.js';

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

describe('journalist trust regressions', () => {
	it('diagnoses a clipped cited answer from conversation state without starting new research', async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);
		const context: ConversationContext = {
			version: 1,
			intent: 'diagnostic',
			currentTurn: {
				content: 'Why is the text cut off?',
				resolvedRequest: 'Why is the text cut off?',
				operation: 'send',
				researchRequired: false
			},
			activeTopic: { subject: 'Toronto community stories', location: 'Toronto' },
			lastSourceBackedAnswer: {
				messageId: 'message-clipped',
				content: 'Toronto’s Salsa on St. [1]',
				citations: [
					{
						citationNumber: 1,
						title: 'Community dance program',
						url: 'https://example.com/community-story',
						domain: 'example.com',
						publicationDate: '2026-08-07',
						sourceType: 'news_report',
						supportingExcerpt:
							'Toronto’s Salsa on St. Clair is hosting a community dance program this weekend.'
					}
				]
			}
		};

		const answer = await runtime().completeChat(
			[{ role: 'user', content: 'Why is the text cut off?' }],
			{ conversationContext: context }
		);

		expect(fetchMock).not.toHaveBeenCalled();
		expect(answer).toContain('clipped source fragment');
		expect(answer).toContain('[1]');
		expect(answer).toContain('answer-integrity failure');
	});

	it('does not emit a diagnostic canned answer when no preceding source answer is bound', async () => {
		const fetchMock = vi.fn(async () =>
			new Response(JSON.stringify({ output_text: 'Normal conversation handling.' }), {
				status: 200,
				headers: { 'content-type': 'application/json' }
			})
		);
		vi.stubGlobal('fetch', fetchMock);

		const answer = await runtime().completeChat([
			{ role: 'user', content: 'Why did the answer stop before the citation?' }
		]);

		expect(fetchMock).toHaveBeenCalled();
		expect(answer).not.toContain('answer-integrity failure');
		expect(answer).not.toContain('clipped source fragment');
	});

	it('answers a referential follow-up from explicit thread context without research or duplication', async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);

		let answer = '';
		for await (const delta of runtime().streamChat([
			{
				role: 'user',
				content:
					'A shooting occurred near downtown Toronto. Police issued a brief statement confirming one victim was transported to hospital.'
			},
			{ role: 'assistant', content: 'Understood. I have that context.' },
			{ role: 'user', content: 'What did the police statement actually say?' }
		])) {
			answer += delta;
		}

		expect(fetchMock).not.toHaveBeenCalled();
		expect(answer).toContain('one victim was transported to hospital');
		expect(answer).toContain("can't quote or verify");
		expect(answer.match(/one victim was transported to hospital/g)).toHaveLength(1);
	});

	it('writes a requested tease and keeps time abbreviations intact without adding a forbidden banner', async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);
		const context: ConversationContext = {
			version: 1,
			intent: 'transform',
			sourceMessageId: 'message-weather',
			activeTopic: {
				subject: 'Toronto heat warning status',
				entities: ['Environment Canada'],
				location: 'Toronto'
			},
			lastSourceBackedAnswer: {
				messageId: 'message-weather',
				content: [
					'Environment Canada issued a Toronto heat warning on July 17, 2026 [1].',
					'A Toronto observation at 5:45 a.m. EDT on July 28 recorded 29 C [2].'
				].join(' '),
				citations: weatherCitations()
			}
		};

		const answer = await runtime().completeChat(
			[
				{
					role: 'user',
					content:
						'Using only the previous answer, write a 10-second tease and a 25-second OC/VO. Do not add a banner.'
				}
			],
			{ conversationContext: context }
		);

		expect(fetchMock).not.toHaveBeenCalled();
		expect(answer).toMatch(/^TEASE:\n/);
		expect(answer).toContain('\n\nON CAM:\n');
		expect(answer).toContain('\n\nVO:\n');
		expect(answer).toContain('5:45 a.m. EDT on July 28');
		expect(answer).not.toContain('\n\nBANNER:\n');
		expect(answer).not.toMatch(/\nEDT on July 28/);
		expect(answer.match(/issued a Toronto heat warning on July 17/g)).toHaveLength(1);
	});

	it('keeps a requested 25-second OC/VO within a newsroom word budget', async () => {
		const citations: CitationRecord[] = Array.from({ length: 10 }, (_, index) => ({
			citationNumber: index + 1,
			title: `Official source ${index + 1}`,
			url: `https://example.gov/source-${index + 1}`,
			domain: 'example.gov',
			publicationDate: '2026-07-28',
			sourceType: 'official',
			supportingExcerpt: `Confirmed detail ${index + 1}.`
		}));
		const context: ConversationContext = {
			version: 1,
			intent: 'transform',
			activeTopic: { subject: 'city emergency response update' },
			lastSourceBackedAnswer: {
				messageId: 'message-long',
				content: citations
					.map(
						(citation) =>
							`Officials confirmed response detail ${citation.citationNumber} for the city briefing today [${citation.citationNumber}].`
					)
					.join(' '),
				citations
			}
		};

		const answer = await runtime().completeChat(
			[{ role: 'user', content: 'Write a 25-second OC/VO using only the previous answer. No banner.' }],
			{ conversationContext: context }
		);
		const spokenCopy = answer
			.replace(/^(?:ON CAM|VO):$/gm, '')
			.replace(/\[\d+\]/g, '')
			.trim();
		const wordCount = spokenCopy.match(/\b[\p{L}\p{N}][\p{L}\p{N}'’.-]*\b/gu)?.length ?? 0;

		expect(wordCount).toBeLessThanOrEqual(63);
		expect(answer).not.toContain('[10]');
	});

	it('hard-bounds a single oversized cited sentence in a 25-second OC/VO', async () => {
		const citation = weatherCitations()[0];
		const oversized = `${Array.from(
			{ length: 95 },
			(_, index) => `confirmed${index + 1}`
		).join(' ')} [1].`;
		const context: ConversationContext = {
			version: 1,
			intent: 'transform',
			activeTopic: { subject: 'Toronto weather alert update', location: 'Toronto' },
			lastSourceBackedAnswer: {
				messageId: 'message-oversized',
				content: oversized,
				citations: [citation]
			}
		};

		const answer = await runtime().completeChat(
			[{ role: 'user', content: 'Write a 25-second OC/VO using only the previous answer. No banner.' }],
			{ conversationContext: context }
		);
		const spokenCopy = answer
			.replace(/^(?:ON CAM|VO):$/gm, '')
			.replace(/\[\d+\]/g, '')
			.trim();
		const wordCount = spokenCopy.match(/\b[\p{L}\p{N}][\p{L}\p{N}'’.-]*\b/gu)?.length ?? 0;

		expect(wordCount).toBeLessThanOrEqual(63);
		expect(answer).toContain('[1]');
	});

	it('returns inherited direct links without research and re-emits their citation records', async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal('fetch', fetchMock);
		const citations: CitationRecord[] = [
			{
				citationNumber: 1,
				title: 'Policy interest rate',
				url: 'https://www.bankofcanada.ca/core-functions/monetary-policy/key-interest-rate/',
				domain: 'bankofcanada.ca',
				publicationDate: null,
				sourceType: 'official',
				supportingExcerpt: 'The page lists the target for the overnight rate.'
			},
			{
				citationNumber: 2,
				title: 'Interest rate announcement',
				url: 'https://www.bankofcanada.ca/2026/07/fad-press-release-2026-07-15/',
				domain: 'bankofcanada.ca',
				publicationDate: '2026-07-15',
				sourceType: 'official',
				supportingExcerpt: 'The announcement states the effective date.'
			}
		];
		const context: ConversationContext = {
			version: 1,
			intent: 'transform',
			activeTopic: { subject: 'Bank of Canada target for the overnight rate' },
			lastSourceBackedAnswer: {
				messageId: 'message-bank',
				content: 'The rate page lists the target [1]. The announcement gives the effective date [2].',
				citations
			}
		};
		const progress: RuntimeProgressEvent[] = [];

		let answer = '';
		for await (const delta of runtime().streamChat(
			[
				{
					role: 'user',
					content:
						'List the exact direct URLs for every citation in the previous answer. Do not re-search.'
				}
			],
			{ conversationContext: context, onProgress: (event) => progress.push(event) }
		)) {
			answer += delta;
		}

		expect(fetchMock).not.toHaveBeenCalled();
		expect(answer).toBe(`1. ${citations[0].url}\n2. ${citations[1].url}`);
		expect(progress).toEqual([{ type: 'citations', citations }]);
	});

	it('keeps explicit inherited-evidence checks in no-search mode without attaching uncited provenance', async () => {
		const fetchMock = vi.fn(async () =>
			new Response(
				JSON.stringify({
					output_text:
						'The inherited evidence does not establish that the warning was active at noon.'
				}),
				{ status: 200, headers: { 'content-type': 'application/json' } }
			)
		);
		vi.stubGlobal('fetch', fetchMock);
		const citations = weatherCitations().slice(0, 1);
		const context: ConversationContext = {
			version: 1,
			intent: 'verify',
			activeTopic: {
				subject: 'current Toronto heat warning status',
				location: 'Toronto',
				relevantDate: '2026-07-28'
			},
			lastSourceBackedAnswer: {
				messageId: 'message-weather',
				content: 'A heat warning was issued on July 17 [1].',
				citations
			}
		};
		const progress: RuntimeProgressEvent[] = [];

		const answer = await runtime().completeChat(
			[
				{
					role: 'user',
					content:
						'Using only the inherited evidence, assess whether it proves the warning was active at noon. Do not search.'
				}
			],
			{ conversationContext: context, onProgress: (event) => progress.push(event) }
		);

		expect(answer).toContain('does not establish');
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const request = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
		expect(request.tools).toBeUndefined();
		expect(request.input).toContain('Grounded conversation state');
		expect(progress).toEqual([]);
	});
});

function runtime(): NewsroomAgentRuntime {
	return new NewsroomAgentRuntime({
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
}

function weatherCitations(): CitationRecord[] {
	return [
		{
			citationNumber: 1,
			title: 'Toronto alert',
			url: 'https://weather.gc.ca/warnings/report_e.html?on61',
			domain: 'weather.gc.ca',
			publicationDate: '2026-07-17',
			sourceType: 'official',
			supportingExcerpt: 'A heat warning was issued on July 17.'
		},
		{
			citationNumber: 2,
			title: 'Toronto observation',
			url: 'https://weather.gc.ca/en/location/index.html?coords=43.7,-79.4',
			domain: 'weather.gc.ca',
			publicationDate: '2026-07-28',
			sourceType: 'official',
			supportingExcerpt: 'The 5:45 a.m. observation recorded 29 C.'
		}
	];
}
