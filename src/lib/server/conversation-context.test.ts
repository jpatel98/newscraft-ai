import { describe, expect, it } from 'vitest';
import type { CitationRecord } from '@newscraft/shared';
import type { MessageRow } from './db/conversations';
import {
	buildConversationContext,
	conversationContextProvenanceMessageIds,
	conversationContextCompatibilityMessage
} from './conversation-context';
import { serializeToolMetadata } from '$lib/utils/tool-metadata';

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
