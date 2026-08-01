import { describe, expect, it } from 'vitest';
import { deriveResearchRequestContract, type ConversationContext } from '@newscraft/shared';
import { normalizeEvidence } from '../src/agents/evidence.js';
import { rankEvidenceForConversation } from '../src/agents/evidence-ranking.js';
import { guardEvidenceForConversation } from '../src/agents/grounded-conversation.js';

describe('general-purpose evidence ranking', () => {
	it('normalizes every source into the universal evidence contract', () => {
		const evidence = normalizeEvidence({
			source_name: 'City clerk',
			source_url: 'https://example.gov/meeting',
			tool_used: 'url_fetch_read',
			title: 'Council meeting result',
			published_at: '2026-07-30T13:00:00Z',
			event_at: '2026-07-30T12:00:00Z',
			location: 'Hamilton',
			entities: ['Hamilton City Council'],
			extracted_text: 'Hamilton City Council approved the transit pilot after a recorded vote.',
			summary: 'Hamilton City Council approved the transit pilot.',
			source_kind: 'official'
		});

		expect(evidence).toMatchObject({
			topic: null,
			entities: ['Hamilton City Council'],
			location: 'Hamilton',
			event_at: '2026-07-30T12:00:00Z',
			source_authority: 0.95,
			readability: 'partial',
			supporting_excerpt: expect.stringContaining('Hamilton City Council'),
			provenance: {
				url: 'https://example.gov/meeting',
				tool: 'url_fetch_read',
				source_kind: 'official'
			},
			uncertainty: []
		});
	});

	it('ranks ordinary official and news sources while downgrading missing metadata', () => {
		const context = researchContext('Latest Hamilton transit pilot vote', 'Hamilton');
		const official = source({
			title: 'Hamilton transit pilot vote',
			url: 'https://hamilton.ca/transit-pilot',
			text: 'Hamilton council approved the transit pilot in a recorded vote.',
			kind: 'official',
			location: 'Hamilton',
			publishedAt: new Date().toISOString()
		});
		const report = source({
			title: 'Council approves Hamilton transit pilot',
			url: 'https://localnews.example/hamilton-transit',
			text: 'A local report says Hamilton council approved the transit pilot.',
			kind: 'news_report'
		});

		const result = rankEvidenceForConversation([report, official], context);

		expect(result.evidence).toEqual([official, report]);
		expect(result.excluded).toEqual([]);
		expect(result.diagnostics[0].score).toBeGreaterThan(result.diagnostics[1].score);
		expect(result.diagnostics[1].notes.join(' ')).toContain('missing location metadata');
	});

	it('keeps supported partial findings instead of reducing usable evidence to zero', () => {
		const context = researchContext('Latest semiconductor plant announcement in Windsor', 'Windsor');
		const partial = source({
			title: 'Company confirms Windsor site',
			url: 'https://company.example/news/windsor-site',
			text: 'The company confirmed Windsor as the site but did not disclose the construction schedule.',
			kind: 'primary'
		});

		const result = rankEvidenceForConversation([partial], context);

		expect(result.evidence).toEqual([partial]);
		expect(result.excluded).toEqual([]);
		expect(result.diagnostics[0]).toMatchObject({ eligible: true });
		expect(result.diagnostics[0].notes.join(' ')).toContain('missing date metadata');
	});

	it('hard-rejects a clearly unrelated or wrong-location source', () => {
		const context = researchContext('Latest housing vote in Ottawa', 'Ottawa');
		const wrong = source({
			title: 'Calgary arena financing vote',
			url: 'https://example.com/calgary-arena',
			text: 'Calgary council approved new financing for the downtown arena.',
			kind: 'news_report',
			location: 'Calgary'
		});

		const result = rankEvidenceForConversation([wrong], context);

		expect(result.evidence).toEqual([]);
		expect(result.excluded).toEqual([wrong]);
		expect(result.diagnostics[0]).toMatchObject({
			eligible: false,
			hard_reject_reason: 'wrong_location'
		});
	});

	it('uses the structured latest-turn contract instead of a stale prose topic', () => {
		const request = 'Latest port reopening update in Halifax';
		const context = researchContext('Latest port reopening update in Vancouver', 'Vancouver');
		context.currentTurn = {
			...context.currentTurn!,
			content: request,
			resolvedRequest: request,
			researchContract: deriveResearchRequestContract(request, {
				homeMarket: 'Halifax',
				timezone: 'America/Toronto'
			})
		};
		const halifax = source({
			title: 'Halifax port reopens',
			url: 'https://example.com/halifax-port',
			text: 'The Halifax port reopened after the safety inspection.',
			kind: 'news_report',
			location: 'Halifax'
		});
		const vancouver = source({
			title: 'Vancouver port strike continues',
			url: 'https://example.com/vancouver-port',
			text: 'The Vancouver port strike continues.',
			kind: 'news_report',
			location: 'Vancouver'
		});

		const result = rankEvidenceForConversation([vancouver, halifax], context);

		expect(result.evidence).toEqual([halifax]);
		expect(result.excluded).toEqual([vancouver]);
		expect(result.diagnostics.find((item) => item.hard_reject_reason === 'wrong_location')).toBeDefined();
	});

	it('preserves conversation-scoped private document evidence', () => {
		const document = normalizeEvidence({
			source_name: 'audit.pdf',
			source_url: '/api/conversations/c1/documents/d1/download#page=2',
			tool_used: 'pdf_text_extractor',
			title: 'audit.pdf, page 2',
			extracted_text: 'The audit found incomplete procurement records in 14 contracts.',
			summary: 'The audit found incomplete procurement records in 14 contracts.',
			source_kind: 'user_document',
			document_page: 2
		});
		const context = researchContext('Summarize the attached audit findings');

		expect(guardEvidenceForConversation([document], context).evidence).toEqual([document]);
	});

	it('requires direct publisher evidence only when the user explicitly requests it', () => {
		const context: ConversationContext = {
			...researchContext('Compare CBC and Reuters coverage of the housing announcement'),
			activeTopic: {
				subject: 'Compare CBC and Reuters coverage of the housing announcement',
				requestedOutlets: ['CBC', 'Reuters'],
				directSourcesRequired: true
			}
		};
		const cbc = source({
			title: 'Housing announcement',
			url: 'https://cbc.ca/news/housing-announcement',
			text: 'CBC reports the government announced a housing program.',
			kind: 'news_report'
		});
		const aggregator = source({
			title: 'Reuters housing summary',
			url: 'https://aggregator.example/reuters-housing',
			text: 'An aggregator summarizes the Reuters report on the housing program.',
			kind: 'news_report'
		});

		const result = rankEvidenceForConversation([aggregator, cbc], context);

		expect(result.evidence).toEqual([cbc]);
		expect(result.excluded).toEqual([aggregator]);
		expect(result.diagnostics[1].hard_reject_reason).toBe('wrong_entity');
	});
});

function researchContext(subject: string, location?: string): ConversationContext {
	return {
		version: 1,
		intent: 'research',
		currentTurn: {
			content: subject,
			resolvedRequest: subject,
			operation: 'send',
			researchRequired: true,
			freshness: 'current'
		},
		activeTopic: {
			subject,
			...(location ? { location } : {}),
			relevantDate: 'current'
		}
	};
}

function source(input: {
	title: string;
	url: string;
	text: string;
	kind: 'official' | 'primary' | 'news_report';
	location?: string;
	publishedAt?: string;
}) {
	return normalizeEvidence({
		source_name: new URL(input.url).hostname,
		source_url: input.url,
		tool_used: 'openai_web_search',
		title: input.title,
		published_at: input.publishedAt ?? null,
		extracted_text: input.text,
		summary: input.text,
		source_kind: input.kind,
		location: input.location ?? null
	});
}
