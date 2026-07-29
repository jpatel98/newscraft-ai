import { describe, expect, it } from 'vitest';
import type { ConversationContext } from '@newscraft/shared';
import { guardEvidenceForConversation } from '../src/agents/grounded-conversation.js';
import { normalizeEvidence } from '../src/agents/evidence.js';

describe('grounded conversation guard', () => {
	it('keeps explicitly attached document pages even when the prompt uses generic document wording', () => {
		const documentPage = normalizeEvidence({
			source_name: 'municipal-audit.pdf',
			source_url: '/api/conversations/conversation-1/documents/document-1/download#page=1',
			accessed_at: '2026-07-28T12:00:00.000Z',
			tool_used: 'pdf_text_extractor',
			title: 'municipal-audit.pdf, page 1',
			published_at: null,
			extracted_text: 'Procurement documentation was incomplete in 14 of 40 contracts.',
			summary: 'Procurement documentation was incomplete in 14 of 40 contracts.',
			confidence: 0.9,
			limitations: [],
			source_kind: 'user_document',
			citation_number: 1,
			document_page: 1
		});
		const context: ConversationContext = {
			version: 1,
			intent: 'research',
			activeTopic: { subject: 'Summarize the attached audit in five bullets' }
		};

		const result = guardEvidenceForConversation([documentPage], context);

		expect(result.evidence).toEqual([documentPage]);
		expect(result.excluded).toEqual([]);
	});

	it('rejects Santo Domingo baseball evidence for a Toronto ECCC weather follow-up', () => {
		const context: ConversationContext = {
			intent: 'verify',
			activeTopic: {
				subject: 'ECCC weather alert for Toronto on July 28, 2026',
				entities: ['ECCC'],
				location: 'Toronto',
				relevantDate: '2026-07-28'
			}
		};
		const weather = normalizeEvidence({
			source_name: 'ECCC',
			source_url: 'https://weather.gc.ca/warnings/report_e.html?on61',
			accessed_at: '2026-07-28T12:00:00.000Z',
			tool_used: 'openai_web_search',
			title: 'Toronto weather alerts',
			published_at: '2026-07-28',
			extracted_text: 'ECCC lists Toronto weather alerts and warning status for July 28, 2026.',
			summary: 'ECCC lists Toronto weather alerts and warning status.',
			confidence: 0.9,
			limitations: [],
			source_kind: 'official',
			citation_number: 1
		});
		const baseball = normalizeEvidence({
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
			citation_number: 2
		});

		const result = guardEvidenceForConversation([baseball, weather], context);

		expect(result.evidence).toEqual([weather]);
		expect(result.excluded).toEqual([baseball]);
		expect(result.limitations.join(' ')).toContain('excluded');
	});

	it('requires direct publisher pages for named outlet comparisons', () => {
		const context: ConversationContext = {
			intent: 'research',
			activeTopic: {
				subject: 'same-day CBC and Global News coverage of the Toronto housing announcement',
				location: 'Toronto',
				relevantDate: '2026-07-28',
				requestedOutlets: ['CBC', 'Global News'],
				directSourcesRequired: true
			}
		};
		const cbc = normalizeEvidence({
			source_name: 'CBC News',
			source_url: 'https://www.cbc.ca/news/canada/toronto/housing-announcement',
			accessed_at: '2026-07-28T12:00:00.000Z',
			tool_used: 'openai_web_search',
			title: 'Toronto housing announcement',
			published_at: '2026-07-28',
			extracted_text: 'CBC reports on the Toronto housing announcement.',
			summary: 'CBC reports on the Toronto housing announcement.',
			confidence: 0.8,
			limitations: [],
			source_kind: 'news_report',
			citation_number: 1
		});
		const aggregator = normalizeEvidence({
			source_name: 'Wire roundup',
			source_url: 'https://example.com/roundup',
			accessed_at: '2026-07-28T12:00:00.000Z',
			tool_used: 'openai_web_search',
			title: 'CBC and Global News coverage roundup',
			published_at: '2026-07-28',
			extracted_text: 'A roundup quotes CBC and Global News on Toronto housing.',
			summary: 'A roundup quotes CBC and Global News on Toronto housing.',
			confidence: 0.8,
			limitations: [],
			source_kind: 'media_report',
			citation_number: 2
		});

		const result = guardEvidenceForConversation([cbc, aggregator], context);

		expect(result.evidence).toEqual([cbc]);
		expect(result.excluded).toEqual([aggregator]);
		expect(result.limitations.join(' ')).toContain('Global News');
	});

	it('applies the current follow-up date instead of accepting stale inherited-topic evidence', () => {
		const context: ConversationContext = {
			intent: 'verify',
			activeTopic: {
				subject:
					'ECCC weather alert for Toronto on May 1, 2026 Current follow-up: Is it still active on 2026-07-28?',
				entities: ['ECCC'],
				location: 'Toronto',
				relevantDate: '2026-07-28'
			}
		};
		const stale = normalizeEvidence({
			source_name: 'ECCC',
			source_url: 'https://weather.gc.ca/warnings/report_e.html?on61',
			accessed_at: '2026-07-28T12:00:00.000Z',
			tool_used: 'openai_web_search',
			title: 'Toronto weather alerts',
			published_at: '2026-05-01',
			extracted_text: 'ECCC listed a Toronto weather alert on May 1, 2026.',
			summary: 'ECCC listed a Toronto weather alert on May 1, 2026.',
			confidence: 0.9,
			limitations: [],
			source_kind: 'official',
			citation_number: 1
		});
		const current = normalizeEvidence({
			source_name: 'ECCC',
			source_url: 'https://weather.gc.ca/warnings/report_e.html?on61',
			accessed_at: '2026-07-28T12:00:00.000Z',
			tool_used: 'openai_web_search',
			title: 'Toronto weather alerts',
			published_at: '2026-07-28',
			extracted_text: 'ECCC lists the Toronto warning status for July 28, 2026.',
			summary: 'ECCC lists the Toronto warning status for July 28, 2026.',
			confidence: 0.9,
			limitations: [],
			source_kind: 'official',
			citation_number: 2
		});

		const result = guardEvidenceForConversation([stale, current], context);

		expect(result.evidence).toEqual([current]);
		expect(result.excluded).toEqual([stale]);
	});

	it('does not let an eleven-day-old alert establish current warning status', () => {
		const context: ConversationContext = {
			version: 1,
			intent: 'verify',
			activeTopic: {
				subject: 'Is the Toronto heat warning currently active today?',
				entities: ['Environment Canada'],
				location: 'Toronto',
				relevantDate: '2026-07-28'
			}
		};
		const oldAlert = normalizeEvidence({
			source_name: 'Environment Canada',
			source_url: 'https://weather.gc.ca/warnings/report_e.html?on61',
			accessed_at: '2026-07-28T16:00:00.000Z',
			tool_used: 'openai_web_search',
			title: 'Toronto heat warning',
			published_at: '2026-07-17',
			extracted_text: 'A heat warning was issued for Toronto on July 17, 2026.',
			summary: 'A heat warning was issued for Toronto on July 17, 2026.',
			confidence: 0.9,
			limitations: [],
			source_kind: 'official',
			citation_number: 1
		});

		const result = guardEvidenceForConversation([oldAlert], context);

		expect(result.evidence).toEqual([]);
		expect(result.excluded).toEqual([oldAlert]);
		expect(result.limitations.join(' ')).toContain('excluded');
	});

	it('does not let a two-day-old alert establish active-now status', () => {
		const context: ConversationContext = {
			version: 1,
			intent: 'verify',
			activeTopic: {
				subject: 'Is the Toronto weather alert active now?',
				location: 'Toronto',
				relevantDate: '2026-07-28'
			}
		};
		const oldAlert = normalizeEvidence({
			source_name: 'Environment Canada',
			source_url: 'https://weather.gc.ca/warnings/report_e.html?on61',
			accessed_at: '2026-07-28T16:00:00.000Z',
			tool_used: 'openai_web_search',
			title: 'Toronto weather alert',
			published_at: '2026-07-26',
			extracted_text: 'An alert was issued for Toronto on July 26, 2026.',
			summary: 'An alert was issued for Toronto on July 26, 2026.',
			confidence: 0.9,
			limitations: [],
			source_kind: 'official'
		});

		expect(guardEvidenceForConversation([oldAlert], context).evidence).toEqual([]);
	});

	it('accepts a freshly accessed undated official live-status page', () => {
		const context: ConversationContext = {
			version: 1,
			intent: 'verify',
			activeTopic: {
				subject: 'Is the Toronto weather alert active now?',
				location: 'Toronto',
				relevantDate: '2026-07-28'
			}
		};
		const currentStatus = normalizeEvidence({
			source_name: 'Environment Canada',
			source_url: 'https://weather.gc.ca/warnings/report_e.html?on61',
			accessed_at: '2026-07-28T16:00:00.000Z',
			tool_used: 'openai_web_search',
			title: 'Toronto weather alerts',
			published_at: null,
			extracted_text: 'No alerts in effect.',
			summary: 'No alerts in effect.',
			confidence: 0.9,
			limitations: [],
			source_kind: 'official'
		});

		expect(guardEvidenceForConversation([currentStatus], context).evidence).toEqual([currentStatus]);
	});

	it('rejects freshly fetched official evidence whose own text is dated two days earlier', () => {
		const context: ConversationContext = {
			version: 1,
			intent: 'verify',
			activeTopic: {
				subject: 'Is the Toronto weather alert active now?',
				location: 'Toronto',
				relevantDate: '2026-07-28'
			}
		};
		const staleStatus = normalizeEvidence({
			source_name: 'Environment Canada',
			source_url: 'https://weather.gc.ca/warnings/report_e.html?on61',
			accessed_at: '2026-07-28T17:00:00.000Z',
			tool_used: 'openai_web_search',
			title: 'Toronto weather alerts',
			published_at: null,
			extracted_text: 'The displayed status timestamp is July 26, 2026, 5:58 a.m. EDT.',
			summary: 'The displayed status timestamp is July 26, 2026, 5:58 a.m. EDT.',
			confidence: 0.9,
			limitations: [],
			source_kind: 'official'
		});

		expect(guardEvidenceForConversation([staleStatus], context).evidence).toEqual([]);
	});

	it('rejects a generic province alert table that does not identify the requested city', () => {
		const context: ConversationContext = {
			version: 1,
			intent: 'verify',
			activeTopic: {
				subject: 'current Toronto Environment Canada heat warning status today',
				entities: ['Environment Canada', 'Toronto heat warning'],
				location: 'Toronto',
				relevantDate: '2026-07-28',
				directSourcesRequired: true
			}
		};
		const genericAlertTable = normalizeEvidence({
			source_name: 'Environment Canada',
			source_url:
				'https://weather.gc.ca/index_e.html?alertTableFilterProv=ON&center=50.45%2C-104.617&layers=alert',
			accessed_at: '2026-07-28T17:00:00.000Z',
			tool_used: 'openai_web_search',
			title: 'Weather Information - Environment Canada',
			published_at: null,
			extracted_text: 'The provincial active-alert table was updated at 12:36 p.m. EDT.',
			summary: 'The provincial active-alert table was updated at 12:36 p.m. EDT.',
			confidence: 0.8,
			limitations: [],
			source_kind: 'official'
		});

		expect(guardEvidenceForConversation([genericAlertTable], context).evidence).toEqual([]);
	});
});
