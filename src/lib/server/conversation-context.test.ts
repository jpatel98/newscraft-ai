import { describe, expect, it } from 'vitest';
import type { CitationRecord } from '@newscraft/shared';
import type { MessageRow } from './db/conversations';
import {
	buildConversationContext,
	conversationContextProvenanceMessageIds,
	conversationContextCompatibilityMessage
} from './conversation-context';
import { serializeToolMetadata } from '$lib/utils/tool-metadata';
import { guardEvidenceForConversation } from '../../../services/newsroom-harness/src/agents/grounded-conversation';
import { normalizeEvidence } from '../../../services/newsroom-harness/src/agents/evidence';

const citation = (
	number: number,
	overrides: Partial<CitationRecord> = {}
): CitationRecord => ({
	citationNumber: number,
	title: `Official source ${number}`,
	url: `https://example.gov/source-${number}`,
	domain: 'example.gov',
	publicationDate: '2026-07-24',
	sourceType: 'official',
	supportingExcerpt: `Confirmed evidence ${number}.`,
	...overrides
});

function message(
	id: string,
	role: MessageRow['role'],
	content: string,
	citations: CitationRecord[] = []
): MessageRow {
	return {
		id,
		conversationId: 'conversation-1',
		role,
		content,
		toolCalls: serializeToolMetadata([], [], citations),
		partial: 0,
		resumeClaimedAt: null,
		createdAt: Number(id.replace(/\D/g, '')) || 1
	};
}

describe('conversation context builder', () => {
	it('starts current-events research from the initial user request', () => {
		const context = buildConversationContext({
			messages: [message('m1', 'user', "What's the latest on earthquakes in Japan?")],
			currentRequest: "What's the latest on earthquakes in Japan?",
			currentMessageId: 'm1'
		});

		expect(context.currentTurn).toEqual({
			messageId: 'm1',
			content: "What's the latest on earthquakes in Japan?",
			resolvedRequest: "What's the latest on earthquakes in Japan?",
			operation: 'send',
			researchRequired: true,
			freshness: 'current'
		});
		expect(context.recentTurns).toBeUndefined();
		expect(context.activeTopic?.subject).toContain('earthquakes in Japan');
	});

	it('keeps fresh official earthquake events after building the production conversation context', () => {
		const prompt = "what's the latest on earthquakes in Japan";
		const context = buildConversationContext({
			messages: [message('m1', 'user', prompt)],
			currentRequest: prompt,
			currentMessageId: 'm1'
		});
		const event = normalizeEvidence({
			source_name: 'U.S. Geological Survey',
			source_url: 'https://earthquake.usgs.gov/earthquakes/eventpage/us6000tgt4',
			accessed_at: new Date().toISOString(),
			tool_used: 'openai_web_search',
			title: 'M 4.8 - 7 km W of Honmachi, Japan',
			published_at: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
			extracted_text:
				'USGS lists a reviewed magnitude 4.8 earthquake 7 km W of Honmachi, Japan at Jul 30, 2026, 09:01 GMT+9.',
			summary:
				'USGS lists a reviewed magnitude 4.8 earthquake 7 km W of Honmachi, Japan at Jul 30, 2026, 09:01 GMT+9.',
			confidence: 0.95,
			limitations: ['Earthquake catalog values can be revised as agencies review new data.'],
			source_kind: 'official',
			citation_number: 1
		});

		const guarded = guardEvidenceForConversation([event], context);

		expect(context.activeTopic).toMatchObject({
			subject: prompt,
			entities: ['Japan'],
			location: 'Japan',
			relevantDate: 'latest'
		});
		expect(guarded.evidence).toEqual([event]);
		expect(guarded.excluded).toEqual([]);
	});

	it('treats an ordinary weather question as current structured research', () => {
		const context = buildConversationContext({
			messages: [message('m1', 'user', "what's toronto weather")],
			currentRequest: "what's toronto weather",
			currentMessageId: 'm1'
		});

		expect(context.currentTurn).toMatchObject({
			resolvedRequest: "what's toronto weather",
			researchRequired: true,
			freshness: 'current'
		});
	});

	it('keeps a conversational acknowledgement as the authoritative current turn', () => {
		const context = buildConversationContext({
			messages: [
				message('m1', 'user', 'Find the latest Toronto news today.'),
				message('m2', 'assistant', 'Here are the confirmed Toronto updates with source links.'),
				message('m3', 'user', 'Okay.')
			],
			currentRequest: 'Okay.',
			currentMessageId: 'm3'
		});

		expect(context.currentTurn?.resolvedRequest).toBe('Okay.');
		expect(context.currentTurn?.researchRequired).toBe(false);
	});

	it('does not force research for an ordinary writing request', () => {
		const context = buildConversationContext({
			messages: [],
			currentRequest: 'Write a sharper headline for this copy.'
		});

		expect(context.currentTurn).toMatchObject({
			resolvedRequest: 'Write a sharper headline for this copy.',
			researchRequired: false,
			operation: 'send'
		});
	});

	it('does not mistake a conceptual weather explanation for live conditions', () => {
		const context = buildConversationContext({
			messages: [],
			currentRequest: 'How do weather forecasts work?'
		});

		expect(context.currentTurn).toMatchObject({
			researchRequired: false
		});
		expect(context.currentTurn?.freshness).toBeUndefined();
	});

	it('does not confuse editorial update wording with a request for live updates', () => {
		const context = buildConversationContext({
			messages: [],
			currentRequest: 'Update this headline and find a stronger verb.'
		});

		expect(context.currentTurn?.researchRequired).toBe(false);
	});

	it('does not mistake a reference to the last answer for a freshness request', () => {
		const context = buildConversationContext({
			messages: [
				message('m1', 'user', 'Explain the housing proposal.'),
				message('m2', 'assistant', 'The proposal has three main parts.')
			],
			currentRequest: 'Shorten the last answer without new research.'
		});

		expect(context.currentTurn?.researchRequired).toBe(false);
	});

	it('retains topic, corrections, publication dates, and citations within a bounded packet', () => {
		const messages: MessageRow[] = [
			message('m1', 'user', 'Check the ECCC weather alert for Toronto on July 24, 2026.'),
			message('m2', 'assistant', 'ECCC lists an active Toronto alert [1].', [
				citation(1, {
					title: 'Toronto weather alerts',
					url: 'https://weather.gc.ca/warnings/report_e.html?on61',
					domain: 'weather.gc.ca'
				})
			]),
			message('m3', 'user', 'That active-alert verdict is unsupported. Correct it.'),
			message('m4', 'assistant', "Correction: I couldn't verify an active alert, so the earlier claim is retracted [1].", [
				citation(1, {
					title: 'Toronto weather alerts',
					url: 'https://weather.gc.ca/warnings/report_e.html?on61',
					domain: 'weather.gc.ca'
				})
			]),
			message('m5', 'user', 'Does the official page give an expiry time?'),
			message('m6', 'assistant', 'No expiry time was available in the cited page [1].', [citation(1)])
		];

		const context = buildConversationContext({
			messages,
			currentRequest: 'Is it still the same status?'
		});

		expect(context.activeTopic).toMatchObject({
			location: 'Toronto',
			relevantDate: 'July 24, 2026'
		});
		expect(context.lastSourceBackedAnswer?.citations).toHaveLength(1);
		expect(context.lastSourceBackedAnswer?.publicationDates).toEqual(['2026-07-24']);
		expect(context.claimStates?.some((claim) => claim.status === 'retracted')).toBe(true);
		expect(new TextEncoder().encode(JSON.stringify(context)).byteLength).toBeLessThan(24 * 1024);
	});

	it('uses a new explicit request as the active topic instead of the previous cited answer', () => {
		const messages = [
			message('m1', 'user', 'Check the ECCC weather alert for Toronto.'),
			message('m2', 'assistant', 'Correction: no active Toronto alert was verified [1].', [
				citation(1)
			])
		];

		const context = buildConversationContext({
			messages,
			currentRequest: 'What baseball games are in Santo Domingo today?'
		});

		expect(context.activeTopic?.subject).toBe('What baseball games are in Santo Domingo today?');
		expect(context.activeTopic?.location).toBe('Santo Domingo');
		expect(context.activeTopic?.subject).not.toContain('ECCC');
		expect(context.lastSourceBackedAnswer).toBeUndefined();
		expect(context.claimStates).toBeUndefined();
	});

	it('does not inherit prior citations for an explicit new source request', () => {
		const messages = [
			message('m1', 'user', 'Check the ECCC weather alert for Toronto.'),
			message('m2', 'assistant', 'No active Toronto alert was verified [1].', [citation(1)])
		];

		const context = buildConversationContext({
			messages,
			currentRequest: 'Find sources on Santo Domingo baseball today.'
		});

		expect(context.activeTopic?.subject).toBe('Find sources on Santo Domingo baseball today.');
		expect(context.activeTopic?.location).toBe('Santo Domingo');
		expect(context.activeTopic?.relevantDate).toBe('today');
		expect(context.lastSourceBackedAnswer).toBeUndefined();
		expect(context.claimStates).toBeUndefined();
	});

	it('treats source requests with pronouns plus concrete topics as new requests', () => {
		const messages = [
			message('m1', 'user', 'Check the ECCC weather alert for Toronto.'),
			message('m2', 'assistant', 'No active Toronto alert was verified [1].', [citation(1)])
		];

		const context = buildConversationContext({
			messages,
			currentRequest: 'Find sources on this Toronto transit plan.'
		});

		expect(context.activeTopic?.subject).toBe('Find sources on this Toronto transit plan.');
		expect(context.activeTopic?.location).toBe('Toronto');
		expect(context.lastSourceBackedAnswer).toBeUndefined();
	});

	it('keeps current freshness qualifiers authoritative on inherited-topic follow-ups', () => {
		const messages = [
			message('m1', 'user', 'Check the ECCC weather alert for Toronto on July 24, 2026.'),
			message('m2', 'assistant', 'ECCC listed a Toronto alert on July 24 [1].', [
				citation(1, { publicationDate: '2026-07-24' })
			])
		];

		const todayContext = buildConversationContext({
			messages,
			currentRequest: 'Is it still active today?'
		});
		const datedContext = buildConversationContext({
			messages,
			currentRequest: 'Is it still active on 2026-07-28?'
		});

		expect(todayContext.activeTopic).toMatchObject({
			location: 'Toronto',
			relevantDate: 'today'
		});
		expect(todayContext.activeTopic?.subject).toContain('Is it still active today?');
		expect(todayContext.activeTopic?.relevantDate).not.toBe('July 24, 2026');
		expect(datedContext.activeTopic?.relevantDate).toBe('2026-07-28');
	});

	it('inherits the cited answer and topic for a contextual source follow-up', () => {
		const messages = [
			message('m1', 'user', 'Check the ECCC weather alert for Toronto.'),
			message('m2', 'assistant', 'No active Toronto alert was verified [1].', [citation(1)])
		];

		const context = buildConversationContext({
			messages,
			currentRequest: 'Give me the direct citation links.'
		});

		expect(context.activeTopic?.subject).toBe('Check the ECCC weather alert for Toronto.');
		expect(context.lastSourceBackedAnswer?.messageId).toBe('m2');
	});

	it('inherits cited evidence for a long skeptical no-search follow-up', () => {
		const messages = [
			message('m1', 'user', 'Check the ECCC weather alert for Toronto.'),
			message('m2', 'assistant', 'The official page says there are no active alerts [1].', [
				citation(1, {
					title: 'Latest Alert For: Toronto Alert',
					url: 'https://ecalertme.weather.gc.ca/warning-latest_en.php?ualert_id=3738',
					domain: 'ecalertme.weather.gc.ca',
					publicationDate: null
				})
			])
		];
		const currentRequest =
			'Using only the cited evidence already in this thread, be skeptical: does citation [1] prove that no alert is active at the current newsroom time even though the page has no publication timestamp? Do not search. State exactly what is confirmed and what remains uncertain.';

		const context = buildConversationContext({ messages, currentRequest });

		expect(currentRequest.length).toBeGreaterThan(240);
		expect(context.intent).toBe('verify');
		expect(context.activeTopic?.subject).toContain('ECCC weather alert for Toronto');
		expect(context.lastSourceBackedAnswer?.messageId).toBe('m2');
		expect(context.lastSourceBackedAnswer?.citations.map((item) => item.citationNumber)).toEqual([1]);
	});

	it.each([
		'Using only the inherited evidence, assess the claim. Do not search.',
		'Use the sources from your last answer and do not search.',
		'Be skeptical of the last answer without new research.'
	])('reconstructs inherited context for common no-search wording: %s', (currentRequest) => {
		const messages = [
			message('m1', 'user', 'Check the ECCC weather alert for Toronto.'),
			message('m2', 'assistant', 'The official page says there are no active alerts [1].', [citation(1)])
		];

		const context = buildConversationContext({ messages, currentRequest });

		expect(context.lastSourceBackedAnswer?.messageId).toBe('m2');
		expect(context.activeTopic?.subject).toContain('ECCC weather alert for Toronto');
	});

	it('keeps the concrete story topic when transforming a skeptical follow-up answer', () => {
		const messages = [
			message(
				'm1',
				'user',
				[
					'QA — Verified Local Trust Run — July 28, 2026',
					'As of now in Toronto time, use the official Environment Canada alert page to determine whether any weather alert is active for the City of Toronto. Distinguish current alert status from observations and forecasts. Give me a concise producer brief with direct supporting citations and real source dates; do not treat page access time as publication time.'
				].join('\n')
			),
			message('m2', 'assistant', 'The official page states there are no active alerts [1].', [citation(1)]),
			message(
				'm3',
				'user',
				'Using only the cited evidence already in this thread, be skeptical: does citation [1] prove the status at the current newsroom time? Do not search.'
			),
			message(
				'm4',
				'assistant',
				'The page states there are no active alerts, but it has no visible publication timestamp [1].',
				[citation(1)]
			)
		];

		const context = buildConversationContext({
			messages,
			currentRequest:
				'Using only verified facts already in this thread, write a 10-second tease and a 25-second OC/VO. Do not search.'
		});

		expect(context.intent).toBe('transform');
		expect(context.activeTopic?.subject).toContain('weather alert is active for the City of Toronto');
		expect(context.activeTopic?.subject).not.toContain('be skeptical');
		expect(context.lastSourceBackedAnswer?.messageId).toBe('m4');
	});

	it('bounds provenance lookup to the selected answer plus recent assistant messages', () => {
		const messages: MessageRow[] = [];
		for (let index = 1; index <= 30; index += 1) {
			messages.push(message(`u${index}`, 'user', `Question ${index}`));
			messages.push(message(`a${index}`, 'assistant', `Answer ${index} [1].`, [citation(1)]));
		}

		const ids = conversationContextProvenanceMessageIds({
			messages,
			sourceMessageId: 'a3'
		});

		expect(ids).toContain('a3');
		expect(ids).toContain('a30');
		expect(ids).toContain('a19');
		expect(ids).not.toContain('a18');
		expect(ids).not.toContain('u30');
		expect(ids).toHaveLength(13);
	});

	it('uses the exact selected source answer and its resolved citations for output actions', () => {
		const source = [
			'**Supported update**',
			'',
			'The TTC lists Toronto transit service changes for tonight [2].'
		].join('\n');
		const messages = [
			message('m1', 'user', 'Check the Toronto transit update.'),
			message('m2', 'assistant', source, [
				citation(1, {
					title: 'Unused source',
					url: 'https://example.gov/unused',
					domain: 'example.gov'
				}),
				citation(2, {
					title: 'TTC service update',
					url: 'https://www.ttc.ca/service-advisories',
					domain: 'ttc.ca',
					sourceType: 'official',
					supportingExcerpt: 'Service changes are listed for tonight.'
				})
			]),
			message('m3', 'assistant', 'A later unrelated heat warning answer [1].', [
				citation(1, {
					title: 'Heat warning',
					url: 'https://weather.gc.ca/warnings/heat',
					domain: 'weather.gc.ca',
					supportingExcerpt: 'Heat warning details.'
				})
			])
		];

		const context = buildConversationContext({
			messages,
			currentRequest: 'Write a 30-second OC/VO from this answer.',
			outputAction: true,
			sourceMessageId: 'm2'
		});

		expect(context.intent).toBe('transform');
		expect(context.sourceMessageId).toBe('m2');
		expect(context.lastSourceBackedAnswer?.content).toBe(source);
		expect(context.lastSourceBackedAnswer?.citations.map((item) => item.citationNumber)).toEqual([2]);
		const fallback = conversationContextCompatibilityMessage(context);
		expect(fallback).toContain(source);
		expect(fallback).toContain('https://www.ttc.ca/service-advisories');
		expect(fallback).not.toContain('heat warning');
		expect(fallback).not.toContain('"messageId"');
	});

		it('resolves duplicate same-source citation numbers in selected output-action context', () => {
		const source = 'The TTC lists Toronto transit service changes for tonight [1].';
		const duplicateSameSource = [
			citation(1, {
				title: 'TTC service update',
				url: 'https://www.ttc.ca/service-advisories?id=1',
				domain: 'ttc.ca',
				sourceType: 'official',
				supportingExcerpt: 'Service changes are listed for tonight.'
			}),
			citation(1, {
				title: 'Duplicate TTC service update',
				url: 'https://www.ttc.ca/service-advisories?id=1',
				domain: 'ttc.ca',
				sourceType: 'official',
				supportingExcerpt: 'Duplicate annotation for the same source.'
			})
		];
		const messages = [
			message('m1', 'user', 'Check the Toronto transit update.'),
			message('m2', 'assistant', source, duplicateSameSource)
		];

		const context = buildConversationContext({
			messages,
			currentRequest: 'Write a 30-second OC/VO from this answer.',
			outputAction: true,
			sourceMessageId: 'm2'
		});

			expect(context.lastSourceBackedAnswer?.citations).toEqual([duplicateSameSource[0]]);
		});

		it('keeps every resolved citation beyond the former follow-up cap', () => {
			const citations = Array.from({ length: 14 }, (_, index) => citation(index + 1));
			const source = citations
				.map((item) => `Confirmed fact ${item.citationNumber} [${item.citationNumber}].`)
				.join(' ');
			const messages = [
				message('m1', 'user', 'Build a source-backed rundown.'),
				message('m2', 'assistant', source, citations)
			];

			const context = buildConversationContext({
				messages,
				currentRequest: 'List the exact direct URLs for every citation in the previous answer.',
				sourceMessageId: 'm2'
			});

			expect(context.lastSourceBackedAnswer?.citations).toHaveLength(14);
			expect(context.lastSourceBackedAnswer?.citations.map((item) => item.citationNumber)).toEqual(
				Array.from({ length: 14 }, (_, index) => index + 1)
			);
		});

		it('compacts long citation metadata before dropping resolved links', () => {
			const citations = Array.from({ length: 40 }, (_, index) =>
				citation(index + 1, {
					title: `Official source ${index + 1} ${'title '.repeat(30)}`,
					supportingExcerpt: `Confirmed evidence ${index + 1}. ${'Supporting context. '.repeat(80)}`
				})
			);
			const source = citations
				.map((item) => `Confirmed fact ${item.citationNumber} [${item.citationNumber}].`)
				.join(' ');

			const context = buildConversationContext({
				messages: [
					message('m1', 'user', 'Build a source-backed rundown.'),
					message('m2', 'assistant', source, citations)
				],
				currentRequest: 'List the exact direct URLs for every citation in the previous answer.',
				sourceMessageId: 'm2'
			});

			expect(context.lastSourceBackedAnswer?.citations).toHaveLength(40);
			expect(context.lastSourceBackedAnswer?.citations.at(-1)?.citationNumber).toBe(40);
		});

		it('excludes conflicting duplicate citation numbers from selected output-action context', () => {
		const source = 'The TTC lists Toronto transit service changes for tonight [1].';
		const duplicateConflictingSource = [
			citation(1, {
				title: 'TTC service update',
				url: 'https://www.ttc.ca/service-advisories?id=1',
				domain: 'ttc.ca',
				sourceType: 'official',
				supportingExcerpt: 'Service changes are listed for tonight.'
			}),
			citation(1, {
				title: 'Conflicting service update',
				url: 'https://weather.gc.ca/warnings/report_e.html?on61',
				domain: 'weather.gc.ca',
				sourceType: 'official',
				supportingExcerpt: 'A different source was incorrectly assigned the same citation number.'
			})
		];
		const messages = [
			message('m1', 'user', 'Check the Toronto transit update.'),
			message('m2', 'assistant', source, duplicateConflictingSource)
		];

		const context = buildConversationContext({
			messages,
			currentRequest: 'Write a 30-second OC/VO from this answer.',
			outputAction: true,
			sourceMessageId: 'm2'
		});
		const fallback = conversationContextCompatibilityMessage(context);

		expect(context.lastSourceBackedAnswer?.citations).toEqual([]);
		expect(fallback).not.toContain('https://www.ttc.ca/service-advisories');
		expect(fallback).not.toContain('https://weather.gc.ca/warnings');
	});

	it('requires direct publisher evidence for named cross-outlet comparisons', () => {
		const context = buildConversationContext({
			messages: [],
			currentRequest: 'Compare same-day CBC and Global News coverage of the Toronto housing announcement.'
		});

		expect(context.activeTopic).toMatchObject({
			requestedOutlets: ['CBC', 'Global News'],
			directSourcesRequired: true,
			location: 'Toronto'
		});
	});
});
