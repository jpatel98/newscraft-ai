import type { ConversationContext, ConversationTopic } from '@newscraft/shared';
import type { EvidenceObject, EvidenceRanking, EvidenceSourceKind } from './evidence.js';

export interface RankedEvidenceResult {
	evidence: EvidenceObject[];
	excluded: EvidenceObject[];
	limitations: string[];
	diagnostics: EvidenceRanking[];
}

const GENERIC_TERMS = new Set([
	'about', 'active', 'article', 'check', 'compare', 'coverage', 'current', 'find',
	'latest', 'news', 'official', 'report', 'research', 'source', 'story', 'today',
	'update', 'verify', 'what', 'when', 'where', 'with'
]);

export function rankEvidenceForConversation(
	evidence: EvidenceObject[],
	context: ConversationContext | undefined
): RankedEvidenceResult {
	const topic = context?.activeTopic;
	if (!topic) {
		const ranked = evidence
			.map((item) => ({ item, ranking: baseRanking(item) }))
			.sort(compareRankedEvidence);
		const accepted = ranked.filter(({ ranking }) => ranking.eligible);
		const excluded = ranked.filter(({ ranking }) => !ranking.eligible);
		return {
			evidence: accepted.map(({ item }) => item),
			excluded: excluded.map(({ item }) => item),
			limitations: excluded.length
				? [
						`${excluded.length} source${excluded.length === 1 ? ' was' : 's were'} excluded because it was unsafe, invalid, or could not support a factual claim.`
					]
				: [],
			diagnostics: ranked.map(({ ranking }) => ranking)
		};
	}

	const accepted: Array<{ item: EvidenceObject; ranking: EvidenceRanking }> = [];
	const excluded: Array<{ item: EvidenceObject; ranking: EvidenceRanking }> = [];
	for (const item of evidence) {
		const ranking = rankEvidence(item, topic);
		if (ranking.eligible) accepted.push({ item, ranking });
		else excluded.push({ item, ranking });
	}
	accepted.sort(compareRankedEvidence);
	const limitations: string[] = [];
	if (excluded.length) {
		limitations.push(
			`${excluded.length} source${excluded.length === 1 ? ' was' : 's were'} excluded because it could not safely support the current request.`
		);
	}
	if (accepted.length && accepted.some(({ ranking }) => ranking.score < 0.62)) {
		limitations.push('Some usable evidence was incomplete or weakly matched, so the answer is necessarily partial.');
	}
	if (!accepted.length && evidence.length) {
		limitations.push('The gathered evidence was about a different subject, location, time, or could not support a factual claim.');
	}
	return {
		evidence: accepted.map(({ item }) => item),
		excluded: excluded.map(({ item }) => item),
		limitations,
		diagnostics: [...accepted, ...excluded].map(({ ranking }) => ranking)
	};
}

function rankEvidence(item: EvidenceObject, topic: ConversationTopic): EvidenceRanking {
	const notes: string[] = [];
	const text = normalize(
		`${item.topic ?? ''} ${item.title} ${item.source_name} ${item.summary} ${item.extracted_text}`
	);
	const subjectTerms = terms(topic.subject);
	const entityTerms = (topic.entities ?? []).flatMap(terms);
	const locationTerms = topic.location ? terms(topic.location) : [];
	const subjectMatches = matches(text, subjectTerms);
	const entityMatches = matches(text, entityTerms);
	const locationMatches = matches(text, locationTerms);
	const explicitEntityMismatch =
		entityTerms.length > 0 && item.entities?.length
			? !item.entities.some((entity) => entityTerms.some((term) => normalize(entity).includes(term)))
			: false;
	const explicitLocationMismatch =
		locationTerms.length > 0 && item.location
			? !locationTerms.some((term) => normalize(item.location ?? '').includes(term))
			: false;
	const directPublisherMismatch =
		topic.directSourcesRequired &&
		Boolean(topic.requestedOutlets?.length) &&
		!topic.requestedOutlets!.some((outlet) => comesFromOutlet(item, outlet));
	const unsafe = /(^|\.)(reddit\.com|wikipedia\.org)$/i.test(host(item.source_url));
	const structurallyInvalid =
		item.source_kind !== 'user_document' &&
		(!item.source_url ||
			!/^(?:https?:\/\/|document:\/\/|attachment:\/\/|newsroom:\/\/)/i.test(item.source_url));
	const unsupported =
		item.readability === 'blocked' ||
		!(item.supporting_excerpt || item.extracted_text || item.summary).trim();
	const wrongTime = incompatibleTime(item, topic);
	const noConversationFit =
		subjectTerms.length > 0 &&
		subjectMatches === 0 &&
		entityMatches === 0 &&
		locationMatches === 0;

	let hardReject: EvidenceRanking['hard_reject_reason'];
	if (unsafe) hardReject = 'unsafe';
	else if (structurallyInvalid) hardReject = 'invalid';
	else if (unsupported) hardReject = 'unsupported';
	else if (directPublisherMismatch) hardReject = 'wrong_entity';
	else if (explicitLocationMismatch) hardReject = 'wrong_location';
	else if (explicitEntityMismatch && subjectMatches === 0) hardReject = 'wrong_entity';
	else if (wrongTime) hardReject = 'wrong_time';
	else if (noConversationFit) hardReject = 'wrong_subject';

	const relevance = ratio(subjectMatches, subjectTerms.length, 0.45);
	const freshness = freshnessScore(item, topic, notes);
	const sourceQuality = item.source_authority ?? sourceQualityFor(item.source_kind);
	const directness = directnessScore(item, topic);
	const readability = item.readability === 'readable' ? 1 : item.readability === 'partial' ? 0.55 : 0;
	const conversationFit = Math.max(
		ratio(entityMatches, entityTerms.length, 0.55),
		ratio(locationMatches, locationTerms.length, 0.55),
		relevance
	);
	if (!item.published_at && !item.event_at) notes.push('missing date metadata lowered freshness');
	if (!item.entities?.length) notes.push('missing entity metadata was treated as uncertainty');
	if (!item.location) notes.push('missing location metadata was treated as uncertainty');
	if (hardReject) notes.push(`hard rejected: ${hardReject}`);

	const score = clamp(
		relevance * 0.27 +
		freshness * 0.2 +
		sourceQuality * 0.18 +
		directness * 0.12 +
		readability * 0.13 +
		conversationFit * 0.1
	);
	return {
		score,
		eligible: !hardReject,
		...(hardReject ? { hard_reject_reason: hardReject } : {}),
		factors: {
			relevance,
			freshness,
			source_quality: sourceQuality,
			directness,
			readability,
			conversation_fit: conversationFit
		},
		notes
	};
}

function baseRanking(item: EvidenceObject): EvidenceRanking {
	const sourceQuality = item.source_authority ?? sourceQualityFor(item.source_kind);
	const readability = item.readability === 'readable' ? 1 : item.readability === 'partial' ? 0.55 : 0;
	const sourceHost = host(item.source_url);
	const unsafe = /(^|\.)(reddit\.com|wikipedia\.org)$/i.test(sourceHost);
	const invalid =
		item.source_kind !== 'user_document' &&
		(!item.source_url ||
			!/^(?:https?:\/\/|document:\/\/|attachment:\/\/|newsroom:\/\/)/i.test(item.source_url));
	const unsupported =
		readability === 0 ||
		!(item.supporting_excerpt || item.extracted_text || item.summary).trim();
	const hardReject: EvidenceRanking['hard_reject_reason'] = unsafe
		? 'unsafe'
		: invalid
			? 'invalid'
			: unsupported
				? 'unsupported'
				: undefined;
	return {
		score: clamp(sourceQuality * 0.55 + readability * 0.45),
		eligible: !hardReject,
		...(hardReject ? { hard_reject_reason: hardReject } : {}),
		factors: {
			relevance: 0.5,
			freshness: item.published_at || item.event_at ? 0.8 : 0.45,
			source_quality: sourceQuality,
			directness: 0.5,
			readability,
			conversation_fit: 0.5
		},
		notes: hardReject ? [`hard rejected: ${hardReject}`] : []
	};
}

function freshnessScore(item: EvidenceObject, topic: ConversationTopic, notes: string[]): number {
	const date = Date.parse(item.event_at || item.published_at || '');
	if (!Number.isFinite(date)) return 0.4;
	if (!isCurrentTopic(topic)) return 0.8;
	const ageHours = Math.abs(Date.now() - date) / 3_600_000;
	if (ageHours <= 36) return 1;
	if (ageHours <= 72) return 0.75;
	notes.push('older evidence lowered freshness');
	return 0.3;
}

function incompatibleTime(item: EvidenceObject, topic: ConversationTopic): boolean {
	if (!isCurrentTopic(topic)) return false;
	const date = Date.parse(item.event_at || item.published_at || '');
	if (!Number.isFinite(date)) return false;
	return Math.abs(Date.now() - date) > 14 * 24 * 3_600_000;
}

function isCurrentTopic(topic: ConversationTopic): boolean {
	return /\b(?:today|yesterday|current|currently|latest|active|now|this week)\b/i.test(topic.subject) ||
		/^(?:today|yesterday|current|latest|now)$/i.test(topic.relevantDate ?? '');
}

function directnessScore(item: EvidenceObject, topic: ConversationTopic): number {
	if (topic.requestedOutlets?.some((outlet) => comesFromOutlet(item, outlet))) return 1;
	if (item.source_kind === 'official' || item.source_kind === 'primary' || item.source_kind === 'user_document') return 0.95;
	if (item.source_kind === 'news_report' || item.source_kind === 'media_report') return 0.7;
	return 0.45;
}

function comesFromOutlet(item: EvidenceObject, outlet: string): boolean {
	const allTerms = normalize(outlet).split(' ').filter(Boolean);
	const terms = allTerms.filter((term) => !['the', 'news', 'press', 'media'].includes(term));
	const label = terms.join('');
	const acronym = allTerms.filter((term) => term !== 'the').map((term) => term[0]).join('');
	const domain = publisherDomainLabel(host(item.source_url));
	return (
		(label.length >= 2 && (domain.includes(label) || label.includes(domain))) ||
		(acronym.length >= 2 && domain.startsWith(acronym))
	);
}

function publisherDomainLabel(value: string): string {
	const labels = value.toLowerCase().split('.').filter(Boolean);
	if (labels.length < 2) return labels[0]?.replace(/[^a-z0-9]/g, '') ?? '';
	const secondLevel = labels.at(-2) ?? '';
	const index =
		labels.length >= 3 && ['co', 'com', 'net', 'org'].includes(secondLevel)
			? labels.length - 3
			: labels.length - 2;
	return (labels[index] ?? '').replace(/[^a-z0-9]/g, '');
}

function sourceQualityFor(kind: EvidenceSourceKind | undefined): number {
	if (kind === 'official' || kind === 'primary' || kind === 'user_document') return 0.95;
	if (kind === 'news_report' || kind === 'media_report') return 0.8;
	if (kind === 'commercial') return 0.55;
	if (kind === 'social_post') return 0.4;
	return 0.5;
}

function compareRankedEvidence(
	left: { item: EvidenceObject; ranking: EvidenceRanking },
	right: { item: EvidenceObject; ranking: EvidenceRanking }
): number {
	const score = right.ranking.score - left.ranking.score;
	if (score !== 0) return score;
	const rightDate = Date.parse(right.item.event_at || right.item.published_at || '') || 0;
	const leftDate = Date.parse(left.item.event_at || left.item.published_at || '') || 0;
	if (rightDate !== leftDate) return rightDate - leftDate;
	return `${left.item.source_url}\n${left.item.title}`.localeCompare(
		`${right.item.source_url}\n${right.item.title}`
	);
}

function terms(value: string): string[] {
	return Array.from(new Set(normalize(value).split(' ').filter((term) => term.length >= 3 && !GENERIC_TERMS.has(term)))).slice(0, 24);
}

function matches(text: string, candidates: string[]): number {
	return candidates.filter((term) => text.includes(term)).length;
}

function ratio(found: number, total: number, missing: number): number {
	return total ? clamp(found / Math.min(total, 3)) : missing;
}

function host(value: string): string {
	try {
		return new URL(value).hostname.replace(/^www\./, '');
	} catch {
		return '';
	}
}

function normalize(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function clamp(value: number): number {
	return Math.max(0, Math.min(1, Number(value.toFixed(4))));
}
