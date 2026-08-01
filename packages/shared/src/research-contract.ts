import type {
	ResearchEvidenceStatus,
	ResearchPageType,
	ResearchPartialAnswerPolicy,
	ResearchRequestContract,
	ResearchTemporalWindow
} from './gateway.js';

const DESK_TERMS = [
	'politics',
	'government',
	'business',
	'economy',
	'health',
	'public safety',
	'crime',
	'courts',
	'transit',
	'traffic',
	'weather',
	'education',
	'housing',
	'environment',
	'community',
	'culture',
	'entertainment',
	'technology',
	'sports',
	'events',
	'international',
	'local'
];

const PAGE_TYPE_PATTERNS: Array<[ResearchPageType, RegExp]> = [
	['event_listing', /\b(?:event listings?|events? pages?|calendar listings?|what's on)\b/i],
	['traffic_aggregator', /\b(?:traffic aggregators?|traffic maps?|commute aggregators?)\b/i],
	['hub', /\b(?:hubs?|landing pages?|roundups?)\b/i],
	['homepage', /\bhomepages?\b/i],
	['category', /\b(?:category|section) pages?\b/i],
	['search', /\bsearch results?\b/i],
	['forum', /\bforums?\b/i],
	['social', /\bsocial(?: media)?\b/i]
];

const OUTLET_ALIASES: Array<[string, RegExp]> = [
	['CBC', /\bCBC(?:\s+News)?\b/i],
	['CTV News', /\bCTV(?:\s+News)?\b/i],
	['Global News', /\bGlobal(?:\s*News)?(?:\.ca)?\b/i],
	['CP24', /\bCP24(?:\.com)?\b/i],
	['CityNews', /\bCityNews\b/i],
	['Reuters', /\bReuters\b/i],
	['Associated Press', /\b(?:Associated Press|AP News)\b/i],
	['BBC', /\bBBC(?:\s+News)?\b/i],
	['Guardian', /\b(?:The\s+)?Guardian\b/i],
	['Toronto Star', /\bToronto Star\b/i],
	['The Globe and Mail', /\b(?:The\s+)?Globe and Mail\b/i]
];

const NUMBER_WORDS: Record<string, number> = {
	one: 1,
	two: 2,
	three: 3,
	four: 4,
	five: 5,
	six: 6,
	seven: 7,
	eight: 8,
	nine: 9,
	ten: 10,
	eleven: 11,
	twelve: 12
};

export interface ResearchContractOptions {
	base?: ResearchRequestContract;
	preserveBaseSubject?: boolean;
	homeMarket?: string;
	timezone?: string;
}

export function deriveResearchRequestContract(
	request: string,
	options: ResearchContractOptions = {}
): ResearchRequestContract {
	const text = request.replace(/\s+/g, ' ').trim();
	const base = options.base;
	const explicitSubject = subjectFromRequest(text);
	const preserveSubject = options.preserveBaseSubject !== false && Boolean(base?.subject);
	const location = extractLocation(text) || base?.location || options.homeMarket;
	const excludedCategories = unique([
		...(base?.excludedCategories || []),
		...extractExcludedDesks(text)
	]);
	const excludedPageTypes = uniquePageTypes([
		...(base?.excludedPageTypes || []),
		...extractExcludedPageTypes(text)
	]);
	const excludedSourceTypes = unique([
		...(base?.excludedSourceTypes || []),
		...extractExcludedSourceTypes(text)
	]);
	const includedCategories = unique([
		...(base?.includedCategories || []),
		...extractIncludedDesks(text)
	]).filter((item) => !excludedCategories.includes(item));
	const namedOutlets = unique([...(base?.namedOutlets || []), ...extractNamedOutlets(text)]);
	const namedDomains = unique([...(base?.namedDomains || []), ...extractNamedDomains(text)]);
	const referenceUrls = unique([...(base?.referenceUrls || []), ...extractUrls(text)]);
	const requestedItemCount = extractRequestedItemCount(text) ?? base?.requestedItemCount;
	const requiredOutputFields = unique([
		...(base?.requiredOutputFields || []),
		...extractRequiredOutputFields(text)
	]);
	const temporalWindow = temporalWindowFor(text, options.timezone, base?.temporalWindow);
	const allowFewerThanRequested =
		/\b(?:allow|fewer than|less than|up to|at most|partial|verified subset|if available|when available)\b/i.test(text) ||
		base?.allowFewerThanRequested === true;
	const partialAnswerPolicy: ResearchPartialAnswerPolicy = allowFewerThanRequested
		? 'verified_subset_with_leads'
		: base?.partialAnswerPolicy || 'verified_subset_with_leads';
	const includedDesks = unique([...(base?.includedDesks || []), ...extractIncludedDesks(text)]).filter(
		(item) => !excludedCategories.includes(item)
	);

	return {
		version: 1,
		subject: cleanSubject(preserveSubject ? base?.subject || explicitSubject : explicitSubject || base?.subject || text),
		...(location ? { location } : {}),
		...(options.homeMarket || base?.homeMarket ? { homeMarket: options.homeMarket || base?.homeMarket } : {}),
		temporalWindow,
		...(requestedItemCount ? { requestedItemCount } : {}),
		includedDesks,
		includedCategories,
		excludedDesks: unique([...(base?.excludedDesks || []), ...excludedCategories]),
		excludedCategories,
		excludedSourceTypes,
		excludedPageTypes,
		namedOutlets,
		namedDomains,
		requiredOutputFields,
		partialAnswerPolicy,
		allowFewerThanRequested,
		referenceUrls
	};
}

export function mergeLatestResearchContract(
	base: ResearchRequestContract,
	latestRequest: string,
	options: Omit<ResearchContractOptions, 'base'> = {}
): ResearchRequestContract {
	const latest = deriveResearchRequestContract(latestRequest, {
		...options,
		base,
		preserveBaseSubject: !looksLikeExplicitNewTopic(latestRequest) && !correctionProvidesNewSubject(latestRequest)
	});
	return latest;
}

export function researchContractWithTemporalWindow(
	contract: ResearchRequestContract,
	window: Pick<ResearchTemporalWindow, 'start' | 'end' | 'timezone' | 'label'>
): ResearchRequestContract {
	return {
		...contract,
		temporalWindow: { ...contract.temporalWindow, ...window }
	};
}

export function formatResearchRequestContract(contract: ResearchRequestContract): string {
	return JSON.stringify({
		subject: contract.subject,
		location: contract.location || null,
		homeMarket: contract.homeMarket || null,
		temporalWindow: contract.temporalWindow,
		requestedItemCount: contract.requestedItemCount || null,
		includedDesks: contract.includedDesks,
		includedCategories: contract.includedCategories,
		excludedDesks: contract.excludedDesks,
		excludedCategories: contract.excludedCategories,
		excludedSourceTypes: contract.excludedSourceTypes,
		excludedPageTypes: contract.excludedPageTypes,
		namedOutlets: contract.namedOutlets,
		namedDomains: contract.namedDomains,
		requiredOutputFields: contract.requiredOutputFields,
		partialAnswerPolicy: contract.partialAnswerPolicy,
		allowFewerThanRequested: contract.allowFewerThanRequested,
		referenceUrls: contract.referenceUrls
	});
}

export function isCorrectionOrConstraintTurn(value: string): boolean {
	return /^(?:correction|actually|i mean|please note|also|and|but|important|update|change|exclude|without|allow)\b/i.test(
		value.trim()
	);
}

function subjectFromRequest(value: string): string {
	let subject = value
		.replace(/https?:\/\/\S+/gi, ' ')
		.replace(/^\s*(?:correction|actually|i mean)\s*[:,-]?\s*/i, '')
		.replace(/^\s*i mean\s*[:,-]?\s*/i, '')
		.replace(/\b(?:published|updated|posted|issued|reported)(?:\s+(?:or|and)\s+(?:published|updated|posted|issued|reported))*\s+(?:today|tonight|yesterday|this week|in the last[^,;.]+)\b/gi, ' ')
		.replace(/\b(?:direct|specific|readable)\s+(?:(?:article)(?:\/official)?|official)\s+(?:page|citations?|sources?)\b/gi, ' ')
		.replace(/\b(?:requesting|asking for)\s+(?:\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(?:(?:verified|non[- ]sports?|same[- ]day|direct)\s+)*(?:news\s+)?(?:stories|items|briefs?|headlines?|updates?)\b/gi, ' ')
		.replace(/\b(?:exclude|excluding|without|do not include|don't include|allow fewer than|fewer than|less than|at most|up to)\b[\s\S]*$/i, ' ')
		.replace(/\b(?:give|provide|find|gather|collect|list)\s+me\s+(?:a\s+)?(?:briefing|brief|roundup|stories|headlines)\b/gi, ' ')
		.replace(/\b(?:for|as)\s+(?:the\s+)?assignment[- ]desk\b/gi, ' ')
		.replace(/\bassignment[- ]desk\b/gi, ' ')
		.replace(/(?:[,;:]?\s+)(?:with|and)\s*$/i, '')
		.replace(/\s+/g, ' ')
		.trim();
	if (!subject || /^(?:exclude|excluding|without|allow|also|and|but|please)\b/i.test(subject)) return value.trim();
	return subject.slice(0, 2000).trim();
}

function extractRequestedItemCount(value: string): number | undefined {
	const match = value.match(/\b(\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(?:(?:verified|non[- ]sports?|same[- ]day|direct)\s+)*(?:news\s+)?(?:stories|items|briefs?|headlines?|updates?)\b/i);
	if (!match) return undefined;
	const parsed = /^\d+$/.test(match[1]) ? Number(match[1]) : NUMBER_WORDS[match[1].toLowerCase()];
	return Number.isInteger(parsed) && parsed > 0 ? Math.min(25, parsed) : undefined;
}

function extractIncludedDesks(value: string): string[] {
	const normalized = value.toLowerCase();
	const included: string[] = [];
	for (const desk of DESK_TERMS) {
		const pattern = new RegExp(`\\b(?:include|focus(?:ed)? on|cover|covering|desk(?:s)?[: ]+)\\s+(?:${escapeRegExp(desk)})\\b`, 'i');
		if (pattern.test(value) || new RegExp(`\\b${escapeRegExp(desk)}\\s+desk\\b`, 'i').test(value)) included.push(desk);
	}
	if (/\bnon[- ]sports?\b|\bexclude(?:d|ing)?\s+sports?\b/i.test(value)) return included.filter((item) => item !== 'sports');
	return included.filter((item) => normalized.includes(item));
}

function extractExcludedDesks(value: string): string[] {
	const excluded: string[] = [];
	const exclusion = value.match(/\b(?:exclude|excluding|without|do not include|don't include|non[- ])\b[\s\S]{0,500}/i)?.[0] || '';
	const haystack = exclusion || value;
	for (const desk of DESK_TERMS) {
		if (new RegExp(`\\b${escapeRegExp(desk)}\\b`, 'i').test(haystack) &&
			(/\b(?:exclude|excluding|without|do not include|don't include|non[- ])\b/i.test(exclusion) || desk === 'sports' && /\bnon[- ]sports?\b/i.test(value))) {
			excluded.push(desk);
		}
	}
	return unique(excluded);
}

function extractExcludedSourceTypes(value: string): string[] {
	const types: string[] = [];
	if (/\b(?:reddit|forums?|forum threads?)\b/i.test(value)) types.push('forum');
	if (/\bsocial(?: media)?\b/i.test(value)) types.push('social');
	if (/\btraffic aggregators?\b/i.test(value)) types.push('traffic_aggregator');
	if (/\bevent listings?\b/i.test(value)) types.push('event_listing');
	if (/\b(?:aggregators?|content farms?)\b/i.test(value)) types.push('aggregator');
	if (/\b(?:evergreen|old|background)\s+(?:material|content|stories|coverage)\b/i.test(value)) types.push('evergreen');
	return unique(types);
}

function extractExcludedPageTypes(value: string): ResearchPageType[] {
	const types: ResearchPageType[] = [];
	for (const [type, pattern] of PAGE_TYPE_PATTERNS) if (pattern.test(value)) types.push(type);
	return uniquePageTypes(types);
}

function extractNamedOutlets(value: string): string[] {
	return unique(OUTLET_ALIASES.filter(([, pattern]) => pattern.test(value)).map(([name]) => name));
}

function extractNamedDomains(value: string): string[] {
	const sourceText = value.replace(/https?:\/\/[^\s)\]>]+/gi, ' ');
	return unique(
		[...sourceText.matchAll(/\b(?:https?:\/\/)?(?:www\.)?([a-z0-9-]+(?:\.[a-z0-9-]+)+)\b/gi)]
				.map((match) => match[1].toLowerCase())
				.concat(
					sourceText.match(/\b(?:cbc\.ca|ctvnews\.ca|globalnews\.ca|cp24\.com|citynews\.ca|reuters\.com|apnews\.com)\b/gi) || []
				)
	);
}

function extractUrls(value: string): string[] {
	return unique(
		[...value.matchAll(/https?:\/\/[^\s)\]>]+/gi)].map((match) => match[0].replace(/[.,;:!?]+$/, ''))
	);
}

function extractRequiredOutputFields(value: string): string[] {
	const fields: string[] = [];
	if (/\b(?:story|stories|items?|headlines?|updates?)\b/i.test(value)) fields.push('story_items');
	if (/\b(?:direct|specific|readable)\s+article|\bofficial\s+(?:page|source)|\barticle\/official\b/i.test(value)) fields.push('direct_article_or_official_citations');
	if (/\bcitations?|sources?|source-backed|provenance\b/i.test(value)) fields.push('citations');
	if (/\b(?:published|publication|updated|timestamp|date|time)\b/i.test(value)) fields.push('publication_time');
	if (/\b(?:script|oc\/?vo|on[- ]cam|voice[- ]over)\b/i.test(value)) fields.push('producer_script');
	if (/\b(?:cross[- ]check|check against|official sources?)\b/i.test(value)) fields.push('official_cross_check');
	return unique(fields);
}

function temporalWindowFor(
	value: string,
	timezone: string | undefined,
	base: ResearchTemporalWindow | undefined
): ResearchTemporalWindow {
	const phrase = value.match(/\b(?:today|tonight|yesterday|tomorrow|latest|current|breaking|this week|past 24 hours?|last 24 hours?)\b/i)?.[0];
	const explicitDate = value.match(/\b20\d{2}-\d{2}-\d{2}\b/)?.[0];
	const relative = value.match(/\b(?:past|last)\s+\d{1,2}\s+(?:hours?|days?|weeks?)\b/i)?.[0];
	if (explicitDate) return { kind: 'absolute', phrase: explicitDate, timezone: timezone || base?.timezone };
	if (relative) return { kind: 'relative', phrase: relative, timezone: timezone || base?.timezone };
	if (phrase) return { kind: 'current', phrase: phrase.toLowerCase(), timezone: timezone || base?.timezone };
	return base || { kind: 'unspecified', timezone };
}

function extractLocation(value: string): string | undefined {
	const common = value.match(
		/\b(?:Toronto|Ottawa|Montreal|Vancouver|Calgary|Edmonton|Halifax|Hamilton|Mississauga|Brampton|Winnipeg|Quebec City|Victoria|London|Kitchener|Waterloo|New York|Los Angeles|Chicago|Washington|London|Paris|Berlin|Sydney|Melbourne)\b/i
	)?.[0];
	if (common) return common.replace(/\s+/g, ' ').trim();

	const cue = value.match(/\b(?:mean|in|near|around|across|outside|for)\s+(?:the\s+)?([A-Z][\p{L}'-]*(?:\s+[A-Z][\p{L}'-]*){0,3})/u);
	if (cue?.[1]) {
		const words = cue[1].replace(/[.,!?]+$/, '').trim().split(/\s+/);
		const locationWords = [words[0], ...words.slice(1).filter((word) => /^[A-Z][\p{L}'-]*$/u.test(word))];
		const candidate = locationWords.join(' ').trim();
		if (candidate && candidate.length <= 60 && !/^(?:Correction|Actually|I|Today|Latest|Current|Assignment|Desk)$/i.test(candidate)) {
			return candidate;
		}
	}
	return undefined;
}

function cleanSubject(value: string): string {
	return value.replace(/\s+/g, ' ').replace(/^[,;:.-]+|[,;:.-]+$/g, '').trim().slice(0, 2000);
}

function looksLikeExplicitNewTopic(value: string): boolean {
	return /^(?:find|search|research|gather|collect|get)\b[\s\S]{0,120}\b(?:on|for|about)\b/i.test(value.trim()) &&
		!isCorrectionOrConstraintTurn(value);
}

function correctionProvidesNewSubject(value: string): boolean {
	if (!isCorrectionOrConstraintTurn(value)) return false;
	const subject = subjectFromRequest(value).trim();
	return subject.length >= 12 && !/^(?:reinforce|keep|maintain|allow|exclude|excluding|without|also|and|but|please)\b/i.test(subject);
}

function unique(values: string[]): string[] {
	return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function uniquePageTypes(values: ResearchPageType[]): ResearchPageType[] {
	return [...new Set(values)];
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export type { ResearchEvidenceStatus };
