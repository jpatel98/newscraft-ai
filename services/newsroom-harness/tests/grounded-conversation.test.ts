import { describe, expect, it } from 'vitest';
import type { ConversationContext } from '@newscraft/shared';
import { guardEvidenceForConversation } from '../src/agents/grounded-conversation.js';
import { normalizeEvidence } from '../src/agents/evidence.js';

describe('grounded conversation guard', () => {
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
});
