import type { ResearchPageType, ResearchRequestContract } from '@newscraft/shared';
import {
	classifyEvidencePageRole,
	classifyEvidenceSource,
	inferEvidenceCategories,
	type EvidenceObject,
	type EvidencePageRole
} from './evidence.js';

export interface ResearchContractFilterResult {
	accepted: EvidenceObject[];
	excluded: EvidenceObject[];
	limitations: string[];
}

const DIRECT_PAGE_ROLES = new Set<EvidencePageRole>(['article', 'official_live']);
const HUB_ROLES = new Set<EvidencePageRole>([
	'hub',
	'homepage',
	'category',
	'search',
	'forum',
	'social',
	'event_listing',
	'traffic_aggregator'
]);

/**
 * Apply the latest-turn contract before metadata enrichment or page fetching.
 * Rejected candidates stay in the request-owned ledger as discovery leads so
 * the editor can see why coverage was thin without treating them as facts.
 */
export function filterEvidenceForResearchContract(
	evidence: EvidenceObject[],
	contract: ResearchRequestContract | undefined
): ResearchContractFilterResult {
	if (!contract) return { accepted: evidence, excluded: [], limitations: [] };
	const accepted: EvidenceObject[] = [];
	const excluded: EvidenceObject[] = [];
	const limitations: string[] = [];
	for (const item of evidence) {
		const role = item.page_role || classifyEvidencePageRole(item.source_url, item.title, item.source_kind);
		const reason = contractRejectionReason(item, role, contract);
		if (!reason) {
			accepted.push({ ...item, page_role: role, ledger_status: 'accepted' });
			continue;
		}
		const rejected = {
			...item,
			page_role: role,
			ledger_status: 'rejected' as const,
			temporal_scope: 'discovery' as const,
			rejection_reason: reason
		};
		excluded.push(rejected);
		limitations.push(reason);
	}
	return {
		accepted,
		excluded,
		limitations: [...new Set(limitations)]
	};
}

/** Fast URL-only gate used before a metadata fetch is scheduled. */
export function isResearchUrlAllowed(url: string, contract?: ResearchRequestContract): boolean {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return false;
	}
	const host = parsed.hostname.replace(/^www\./, '').toLowerCase();
	const text = `${host} ${parsed.pathname} ${parsed.search}`.toLowerCase();
	if (/(^|\.)(?:wikipedia\.org|reddit\.com)$/.test(host)) return false;
	if (/(^|\.)(?:facebook|instagram|tiktok|threads|x|twitter|youtube)\.com$/.test(host)) return false;
	if (/(^|\.)bsky\.app$/.test(host) || /(^|\.)mastodon\.social$/.test(host)) return false;
	if (/(?:\/search(?:\/|$)|[?&](?:q|query)=)/.test(text)) return false;

	if (!contract) return true;
	const sourceKind = classifyEvidenceSource(host, url);
	const role = classifyEvidencePageRole(url, '', sourceKind);
	if (contract.excludedPageTypes.includes(role as ResearchPageType)) return false;
	if (contract.excludedSourceTypes.some((type) => sourceTypeMatches(type, role, sourceKind, text))) return false;
	if (requiresDirectPages(contract) && HUB_ROLES.has(role)) return false;
	if (matchesExcludedTerm(text, [...contract.excludedCategories, ...contract.excludedDesks])) return false;
	return true;
}

function contractRejectionReason(
	item: EvidenceObject,
	role: EvidencePageRole,
	contract: ResearchRequestContract
): string | undefined {
	const text = `${item.title} ${item.summary} ${item.source_url} ${item.topic || ''}`.toLowerCase();
	const categories = [item.desk || '', ...(item.categories || []), ...inferEvidenceCategories(text)].filter(Boolean);
	const sourceType = item.source_kind || classifyEvidenceSource(item.source_name, item.source_url);

	if (contract.excludedPageTypes.includes(role as ResearchPageType)) {
		return `excluded page role: ${role}`;
	}
	if (contract.excludedSourceTypes.some((type) => sourceTypeMatches(type, role, sourceType, text))) {
		return `excluded source type: ${contract.excludedSourceTypes.find((type) => sourceTypeMatches(type, role, sourceType, text))}`;
	}
	if (requiresDirectPages(contract) && !DIRECT_PAGE_ROLES.has(role)) {
		return `not a direct article or official page: ${role}`;
	}
	if (matchesExcludedTerm(text, [...contract.excludedCategories, ...contract.excludedDesks]) ||
		categories.some((category) => matchesExcludedTerm(category, [...contract.excludedCategories, ...contract.excludedDesks]))) {
		return 'excluded desk or category';
	}
	if (contract.location && item.location && !sameLocation(item.location, contract.location)) {
		return `wrong location: ${item.location}`;
	}
	if (item.topic && !hasSubjectOverlap(item.topic, contract.subject) && !hasSubjectOverlap(contract.subject, item.title)) {
		return 'wrong subject';
	}
	return undefined;
}

function requiresDirectPages(contract: ResearchRequestContract): boolean {
	return contract.requiredOutputFields.some((field) =>
		/direct_article_or_official_citations|direct.*citation|article.*official/i.test(field)
	);
}

function sourceTypeMatches(type: string, role: EvidencePageRole, sourceKind: string, text: string): boolean {
	const normalized = type.toLowerCase().replace(/[ -]+/g, '_');
	if (normalized === 'forum' || normalized === 'reddit') return role === 'forum' || sourceKind === 'social_post' || /reddit|forum/.test(text);
	if (normalized === 'social') return role === 'social' || sourceKind === 'social_post';
	if (normalized === 'event_listing' || normalized === 'events') return role === 'event_listing' || /event|calendar|whatson|what's_on/.test(text);
	if (normalized === 'traffic_aggregator' || normalized === 'traffic') return role === 'traffic_aggregator' || /traffic|commute|roadconditions|511/.test(text);
	if (normalized === 'aggregator') return /aggregator|content farm/.test(text);
	if (normalized === 'evergreen' || normalized === 'background') return /evergreen|background|archive|explainer/.test(text);
	return false;
}

function matchesExcludedTerm(value: string, excluded: string[]): boolean {
	const normalized = value.toLowerCase();
	return excluded.some((term) => {
		const candidate = term.toLowerCase().trim();
		if (!candidate) return false;
		return new RegExp(`(?:^|[^a-z0-9])${escapeRegExp(candidate).replace(/\s+/g, '[\\s_-]+')}(?:$|[^a-z0-9])`, 'i').test(normalized);
	});
}

function sameLocation(left: string, right: string): boolean {
	const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
	const a = normalize(left);
	const b = normalize(right);
	return a === b || a.includes(b) || b.includes(a);
}

function hasSubjectOverlap(left: string, right: string): boolean {
	const stopwords = new Set(['about', 'after', 'and', 'city', 'for', 'from', 'latest', 'news', 'the', 'today', 'with']);
	const words = (value: string) => new Set((value.toLowerCase().match(/[a-z0-9]{4,}/g) || []).filter((word) => !stopwords.has(word)));
	const leftWords = words(left);
	const rightWords = words(right);
	return [...leftWords].some((word) => rightWords.has(word));
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
