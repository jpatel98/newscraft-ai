import {
	researchRequirementsForContract,
	type ResearchPageType,
	type ResearchRequirement,
	type ResearchRequestContract
} from '@newscraft/shared';
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

export interface ResearchRequirementMatch {
	requirement: ResearchRequirement;
	accepted: boolean;
	reason?: string;
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
	const requirements = researchRequirementsForContract(contract);
	const accepted: EvidenceObject[] = [];
	const excluded: EvidenceObject[] = [];
	const limitations: string[] = [];
	for (const item of evidence) {
		const role = item.page_role || classifyEvidencePageRole(item.source_url, item.title, item.source_kind);
		const matches = requirements
			.map((requirement) => matchEvidenceToRequirement(item, role, requirement, contract))
			.filter((match) => match.accepted);
		const reason = matches.length ? undefined : contractRejectionReason(item, role, contract);
		if (!reason) {
			accepted.push({
				...item,
				page_role: role,
				ledger_status: 'accepted',
				requirement_ids: [...new Set(matches.map((match) => match.requirement.id))]
			});
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

/** Match one source to one independently requested deliverable. */
export function matchEvidenceToRequirement(
	item: EvidenceObject,
	role: EvidencePageRole,
	requirement: ResearchRequirement,
	contract: ResearchRequestContract
): ResearchRequirementMatch {
	const text = `${item.title} ${item.summary} ${item.source_url} ${item.topic || ''}`.toLowerCase();
	const categories = [item.desk || '', ...(item.categories || []), ...inferEvidenceCategories(text)].filter(Boolean);
	const sourceType = item.source_kind || classifyEvidenceSource(item.source_name, item.source_url);
	if (requirement.excludedPageTypes.includes(role as ResearchPageType)) {
		return { requirement, accepted: false, reason: `excluded page role: ${role}` };
	}
	if (requirement.excludedSourceTypes.some((type) => sourceTypeMatches(type, role, sourceType, text))) {
		return { requirement, accepted: false, reason: 'excluded source type' };
	}
	if (requiresDirectPages(contract, requirement) && !DIRECT_PAGE_ROLES.has(role)) {
		return { requirement, accepted: false, reason: `not a direct article or official page: ${role}` };
	}
	if (
		matchesExcludedTerm(text, [...requirement.excludedCategories, ...contract.excludedCategories, ...contract.excludedDesks]) ||
		categories.some((category) => matchesExcludedTerm(category, [...requirement.excludedCategories, ...contract.excludedCategories, ...contract.excludedDesks]))
	) {
		return { requirement, accepted: false, reason: 'excluded desk or category' };
	}
	if (requirement.geography && item.location && !sameRequirementGeography(item.location, requirement.geography, requirement.level)) {
		return { requirement, accepted: false, reason: `wrong location: ${item.location}` };
	}
	if (
		requirement.geography &&
		!item.location &&
		(contract.requirements?.length || 0) > 1 &&
		!hasGeographyMention(text, requirement.geography) &&
		(genericRequirementSubject(requirement.subject) || !hasSubjectOverlap(requirement.subject, `${item.title} ${item.topic || ''}`))
	) {
		return { requirement, accepted: false, reason: 'location or subject was not established' };
	}
	const scopeText = `${item.location || ''} ${item.title} ${item.summary} ${item.topic || ''}`;
	if ((requirement.level === 'international' || requirement.level === 'global') &&
		!/(?:\binternational\b|\bglobal\b|\bworld\b|\bworldwide\b)/i.test(scopeText)) {
		const overlapsAnotherRequestedGeography = (contract.requirements || []).some((other) => {
			if (other.id === requirement.id || !other.geography) return false;
			if (item.location && sameRequirementGeography(item.location, other.geography, other.level)) return true;
			return hasGeographyMention(scopeText, other.geography);
		});
		if (overlapsAnotherRequestedGeography) {
			return { requirement, accepted: false, reason: 'international scope was not established' };
		}
	}
	if (
		item.topic &&
		!hasSubjectOverlap(item.topic, requirement.subject) &&
		!hasSubjectOverlap(requirement.subject, item.title) &&
		!genericRequirementSubject(requirement.subject)
	) {
		return { requirement, accepted: false, reason: 'wrong subject' };
	}
	return { requirement, accepted: true };
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
	const requirements = researchRequirementsForContract(contract);
	if (!requirements.some((requirement) => matchEvidenceToRequirement(item, role, requirement, contract).accepted)) {
		const locationRequirement = requirements.find((requirement) => requirement.geography);
		if (locationRequirement && item.location && !sameRequirementGeography(item.location, locationRequirement.geography || '', locationRequirement.level)) {
			return `wrong location: ${item.location}`;
		}
		return 'wrong subject or requirement scope';
	}
	return undefined;
}

function requiresDirectPages(contract: ResearchRequestContract, requirement?: ResearchRequirement): boolean {
	return [...contract.requiredOutputFields, ...(requirement?.outputExpectations || [])].some((field) =>
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

function sameRequirementGeography(left: string, right: string, level?: ResearchRequirement['level']): boolean {
	if (!sameLocation(left, right)) return false;
	if ((level === 'international' || level === 'global') && /^(?:international|global|worldwide?)$/i.test(right.trim())) {
		return /international|global|world/i.test(left) || /international|global|world/i.test(right);
	}
	return true;
}

function genericRequirementSubject(value: string): boolean {
	return /^(?:latest|current|breaking|developing|top|major|local|national|international|world|news|stories|headlines|updates|developments|the requested assignment)(?:\s+(?:latest|current|developing|top|major|news|stories|headlines|updates|developments))*$/i.test(
		value.replace(/\s+/g, ' ').trim()
	);
}

function hasSubjectOverlap(left: string, right: string): boolean {
	const stopwords = new Set(['about', 'after', 'and', 'city', 'for', 'from', 'latest', 'news', 'the', 'today', 'with']);
	const words = (value: string) => new Set((value.toLowerCase().match(/[a-z0-9]{4,}/g) || []).filter((word) => !stopwords.has(word)));
	const leftWords = words(left);
	const rightWords = words(right);
	return [...leftWords].some((word) => rightWords.has(word));
}

function hasGeographyMention(text: string, geography: string): boolean {
	const normalizedText = text.toLowerCase();
	const normalizedGeography = geography.toLowerCase().trim();
	return Boolean(normalizedGeography && normalizedText.includes(normalizedGeography));
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
