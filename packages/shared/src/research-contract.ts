import type {
	ResearchEvidenceStatus,
	ResearchOutputType,
	ResearchPageType,
	ResearchPartialAnswerPolicy,
	ResearchRequirement,
	ResearchRequirementLevel,
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

/** Producer defaults apply only when the user did not provide a count. */
export const DEFAULT_PLURAL_REQUIREMENT_COUNT = 3;
export const DEFAULT_SINGULAR_REQUIREMENT_COUNT = 1;

const PROVINCES = new Set([
	'alberta',
	'british columbia',
	'manitoba',
	'new brunswick',
	'newfoundland and labrador',
	'newfoundland',
	'nova scotia',
	'ontario',
	'prince edward island',
	'quebec',
	'saskatchewan'
]);

const COUNTRIES = new Set([
	'australia',
	'brazil',
	'canada',
	'china',
	'france',
	'germany',
	'india',
	'ireland',
	'italy',
	'japan',
	'mexico',
	'new zealand',
	'nigeria',
	'south africa',
	'south korea',
	'spain',
	'uk',
	'united kingdom',
	'united states',
	'us'
]);

export interface ResearchContractOptions {
	base?: ResearchRequestContract;
	preserveBaseSubject?: boolean;
	homeMarket?: string;
	timezone?: string;
}

interface RequirementBuildOptions {
	commonSubject: string;
	outputType: ResearchOutputType;
	timezone?: string;
	baseTemporalWindow?: ResearchTemporalWindow;
	includedCategories: string[];
	excludedCategories: string[];
	excludedSourceTypes: string[];
	excludedPageTypes: ResearchPageType[];
	namedOutlets: string[];
	namedDomains: string[];
	referenceUrls: string[];
	requiredOutputFields: string[];
	allowFewerThanRequested: boolean;
}

/** Normalize legacy v1 contracts into one requirement for new consumers. */
export function researchRequirementsForContract(contract: ResearchRequestContract): ResearchRequirement[] {
	if (contract.requirements?.length) return contract.requirements;
	return [legacyRequirementFromContract(contract)];
}

/**
 * Deterministically decompose the complete latest turn. Model-assisted
 * decomposition can be layered above this function, but this fallback keeps
 * every explicit scope, count, outlet, exclusion, and output instruction.
 */
export function decomposeResearchRequirements(
	request: string,
	options: Pick<ResearchContractOptions, 'timezone' | 'homeMarket'> = {}
): ResearchRequirement[] {
	return deriveResearchRequestContract(request, {
		...options,
		preserveBaseSubject: false
	}).requirements || [];
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
	const excludedCategories = unique([...(base?.excludedCategories || []), ...extractExcludedDesks(text)]);
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
		/\b(?:allow|fewer than|less than|up to|at most|partial|verified subset|if available|when available|coverage is incomplete|coverage is thin|say what (?:you|was) found)\b/i.test(text) ||
		base?.allowFewerThanRequested === true;
	const partialAnswerPolicy: ResearchPartialAnswerPolicy = allowFewerThanRequested
		? 'verified_subset_with_leads'
		: base?.partialAnswerPolicy || 'verified_subset_with_leads';
	const includedDesks = unique([...(base?.includedDesks || []), ...extractIncludedDesks(text)]).filter(
		(item) => !excludedCategories.includes(item)
	);
	const clauses = splitRequirementClauses(text);
	const commonSubject = requirementSubjectFromClause(clauses[0] || text, explicitSubject);
	const outputType = inferOutputType(text);
	const buildOptions: RequirementBuildOptions = {
		commonSubject,
		outputType,
		timezone: options.timezone,
		baseTemporalWindow: temporalWindow,
		includedCategories,
		excludedCategories,
		excludedSourceTypes,
		excludedPageTypes,
		namedOutlets,
		namedDomains,
		referenceUrls,
		requiredOutputFields,
		allowFewerThanRequested
	};
	const requirements = (clauses.length ? clauses : [text]).map((clause, index) =>
		buildRequirement(clause, index, buildOptions)
	);
	const totalRequestedCount = requirements.reduce((total, requirement) => total + requirement.requestedItemCount, 0);
	const legacyRequestedCount = requirements.length > 1
		? totalRequestedCount
		: requirements[0].countExplicit
			? requirements[0].requestedItemCount
			: requestedItemCount;
	const topLevelSubjectValue = preserveSubject && base?.subject
		? base.subject
		: explicitSubject || requirements[0].subject || text;
	const topLevelSubject = cleanSubject(topLevelSubjectValue, /[!?]\s*$/.test(topLevelSubjectValue));

	return {
		version: 2,
		subject: topLevelSubject,
		...(location ? { location } : {}),
		...(options.homeMarket || base?.homeMarket ? { homeMarket: options.homeMarket || base?.homeMarket } : {}),
		temporalWindow,
		...(legacyRequestedCount ? { requestedItemCount: legacyRequestedCount } : {}),
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
		referenceUrls,
		requirements,
		outputType
	};
}

export function mergeLatestResearchContract(
	base: ResearchRequestContract,
	latestRequest: string,
	options: Omit<ResearchContractOptions, 'base'> = {}
): ResearchRequestContract {
	const text = latestRequest.replace(/\s+/g, ' ').trim();
	const baseRequirements = researchRequirementsForContract(base);
	if (!isCorrectionOrConstraintTurn(text) || looksLikeExplicitNewTopic(text)) {
		return deriveResearchRequestContract(latestRequest, { ...options, preserveBaseSubject: false });
	}

	let requirements = baseRequirements.map((requirement) => ({ ...requirement }));
	const replacement = replacementDirective(text);
	if (replacement) {
		requirements = requirements.map((requirement) => {
			if (!requirementMatchesTerm(requirement, replacement.from)) return requirement;
			const replacementScope = parseGeographyScope(`for ${replacement.to}`);
			if (!replacementScope.geography && !replacementScope.level) return requirement;
			const geography = replacementScope.geography;
			const level = replacementScope.level || inferRequirementLevel(geography, `for ${replacement.to}`);
			return {
				...requirement,
				id: stableRequirementId(requirement.subject, geography, level, 0),
				label: requirementLabel(geography, level, requirement.subject),
				...(geography ? { geography } : {}),
				...(level ? { level } : {}),
				completionState: 'pending' as const,
				completion: undefined
			};
		});
	}

	const removals = removalTerms(text);
	if (removals.length) {
		requirements = requirements.filter((requirement) => !removals.some((term) => requirementMatchesTerm(requirement, term)));
	}

	const addedClauses = splitRequirementClauses(text).filter((clause) =>
		/^\s*(?:also\s+)?(?:add|include|give|provide|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b/i.test(clause)
	);
	if (addedClauses.length) {
		const delta = deriveResearchRequestContract(addedClauses.join('. '), { ...options, preserveBaseSubject: false });
		requirements.push(...researchRequirementsForContract(delta));
	}

	const excludedCategories = unique([...base.excludedCategories, ...extractExcludedDesks(text)]);
	const excludedPageTypes = uniquePageTypes([...base.excludedPageTypes, ...extractExcludedPageTypes(text)]);
	const excludedSourceTypes = unique([...base.excludedSourceTypes, ...extractExcludedSourceTypes(text)]);
	const namedOutlets = unique([...base.namedOutlets, ...extractNamedOutlets(text)]);
	const namedDomains = unique([...base.namedDomains, ...extractNamedDomains(text)]);
	const referenceUrls = unique([...base.referenceUrls, ...extractUrls(text)]);
	const requiredOutputFields = unique([...base.requiredOutputFields, ...extractRequiredOutputFields(text)]);
	const allowFewerThanRequested = base.allowFewerThanRequested || /\b(?:allow|fewer than|less than|up to|at most|partial|verified subset)\b/i.test(text);
	const temporalDelta = temporalWindowFor(text, options.timezone, undefined);
	const hasTemporalDelta = temporalDelta.kind !== 'unspecified';
	const inferredOutputType = inferOutputType(text);
	const outputType = inferredOutputType === 'answer' ? base.outputType : inferredOutputType;
	requirements = requirements.map((requirement) => ({
		...requirement,
		includedCategories: unique([...requirement.includedCategories, ...extractIncludedDesks(text)]).filter(
			(item) => !excludedCategories.includes(item)
		),
		excludedCategories: unique([...requirement.excludedCategories, ...excludedCategories]),
		excludedSourceTypes: unique([...requirement.excludedSourceTypes, ...excludedSourceTypes]),
		excludedPageTypes: uniquePageTypes([...requirement.excludedPageTypes, ...excludedPageTypes]),
		namedOutlets: unique([...requirement.namedOutlets, ...namedOutlets]),
		namedDomains: unique([...requirement.namedDomains, ...namedDomains]),
		referenceUrls: unique([...requirement.referenceUrls, ...referenceUrls]),
		outputExpectations: unique([...requirement.outputExpectations, ...outputExpectationsFor(text, outputType || 'answer', requiredOutputFields)]),
		temporalWindow: hasTemporalDelta ? { ...requirement.temporalWindow, ...temporalDelta } : requirement.temporalWindow,
		completionState: 'pending' as const,
		completion: undefined
	}));

	return contractFromRequirements(base, requirements, {
		...options,
		latestRequest: text,
		excludedCategories,
		excludedPageTypes,
		excludedSourceTypes,
		namedOutlets,
		namedDomains,
		referenceUrls,
		requiredOutputFields,
		allowFewerThanRequested,
		outputType
	});
}

export function researchContractWithTemporalWindow(
	contract: ResearchRequestContract,
	window: Pick<ResearchTemporalWindow, 'start' | 'end' | 'timezone' | 'label'>
): ResearchRequestContract {
	return {
		...contract,
		temporalWindow: { ...contract.temporalWindow, ...window },
		requirements: researchRequirementsForContract(contract).map((requirement) => ({
			...requirement,
			temporalWindow: { ...requirement.temporalWindow, ...window }
		}))
	};
}

export function formatResearchRequestContract(contract: ResearchRequestContract): string {
	const requirements = researchRequirementsForContract(contract);
	return JSON.stringify({
		version: contract.version,
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
		referenceUrls: contract.referenceUrls,
		outputType: contract.outputType || 'answer',
		requirements: requirements.map((requirement) => ({
			id: requirement.id,
			label: requirement.label,
			subject: requirement.subject,
			geography: requirement.geography || null,
			level: requirement.level || null,
			requestedItemCount: requirement.requestedItemCount,
			countExplicit: requirement.countExplicit,
			temporalWindow: requirement.temporalWindow,
			outputExpectations: requirement.outputExpectations,
			includedCategories: requirement.includedCategories,
			excludedCategories: requirement.excludedCategories,
			excludedSourceTypes: requirement.excludedSourceTypes,
			excludedPageTypes: requirement.excludedPageTypes,
			namedOutlets: requirement.namedOutlets,
			namedDomains: requirement.namedDomains,
			completionState: requirement.completionState,
			completion: requirement.completion || null
		}))
	});
}

export function isCorrectionOrConstraintTurn(value: string): boolean {
	return /^(?:correction|actually|i mean|please note|also|and|but|important|update|change|replace|swap|remove|drop|omit|exclude|without|allow)\b/i.test(
		value.trim()
	) || /^(?:(?:can|could|would)\s+(?:you|u)\s+)?(?:please\s+)?(?:check|look\s+at|use|search)\s+(?:https?:\/\/|[a-z0-9][a-z0-9.-]*\.(?:com|ca|org|net)\b|[A-Z][\w]+(?:\s+[A-Z][\w]+)*)/i.test(
		value.trim()
	);
}

function buildRequirement(clause: string, index: number, options: RequirementBuildOptions): ResearchRequirement {
	const scope = parseGeographyScope(clause);
	const candidateSubject = requirementSubjectFromClause(clause, options.commonSubject);
	const commonSubject = cleanSubject(options.commonSubject);
	const subject = /^(?:for|in|across|within|around|near|one\s+for|and\s+then\s+one\s+for)\b/i.test(candidateSubject)
		? (/^(?:for|in|across|within|around|near|one\s+for|and\s+then\s+one\s+for)\b/i.test(commonSubject) ? 'latest news' : commonSubject)
		: candidateSubject;
	const count = extractRequestedItemCount(clause);
	const plural = /\b(?:stories|items|headlines|updates|developments|roundups|briefings)\b/i.test(clause);
	const requestedItemCount = count ?? (plural ? DEFAULT_PLURAL_REQUIREMENT_COUNT : DEFAULT_SINGULAR_REQUIREMENT_COUNT);
	const temporalWindow = temporalWindowFor(clause, options.timezone, options.baseTemporalWindow);
	const localOutlets = extractNamedOutlets(clause);
	const localDomains = extractNamedDomains(clause);
	const localUrls = extractUrls(clause);
	const outputExpectations = outputExpectationsFor(clause, options.outputType, options.requiredOutputFields);
	const label = requirementLabel(scope.geography, scope.level, subject);
	return {
		id: stableRequirementId(subject, scope.geography, scope.level, index),
		label,
		subject,
		...(scope.geography ? { geography: scope.geography } : {}),
		...(scope.level ? { level: scope.level } : {}),
		requestedItemCount,
		countExplicit: count !== undefined,
		temporalWindow,
		outputExpectations,
		includedCategories: unique([...options.includedCategories, ...extractIncludedDesks(clause)]).filter(
			(item) => !options.excludedCategories.includes(item)
		),
		excludedCategories: unique([...options.excludedCategories, ...extractExcludedDesks(clause)]),
		excludedSourceTypes: unique([...options.excludedSourceTypes, ...extractExcludedSourceTypes(clause)]),
		excludedPageTypes: uniquePageTypes([...options.excludedPageTypes, ...extractExcludedPageTypes(clause)]),
		namedOutlets: localOutlets.length ? localOutlets : options.namedOutlets,
		namedDomains: localDomains.length ? localDomains : options.namedDomains,
		referenceUrls: localUrls.length ? localUrls : options.referenceUrls,
		completionState: 'pending'
	};
}

function legacyRequirementFromContract(contract: ResearchRequestContract): ResearchRequirement {
	const outputType = contract.outputType || 'answer';
	const subject = contract.subject || 'the requested assignment';
	return {
		id: stableRequirementId(subject, contract.location, inferRequirementLevel(contract.location, subject), 0),
		label: requirementLabel(contract.location, inferRequirementLevel(contract.location, subject), subject),
		subject,
		...(contract.location ? { geography: contract.location } : {}),
		...(inferRequirementLevel(contract.location, subject) ? { level: inferRequirementLevel(contract.location, subject) } : {}),
		requestedItemCount: contract.requestedItemCount || DEFAULT_SINGULAR_REQUIREMENT_COUNT,
		countExplicit: Boolean(contract.requestedItemCount),
		temporalWindow: contract.temporalWindow,
		outputExpectations: outputExpectationsFor(subject, outputType, contract.requiredOutputFields),
		includedCategories: contract.includedCategories,
		excludedCategories: contract.excludedCategories,
		excludedSourceTypes: contract.excludedSourceTypes,
		excludedPageTypes: contract.excludedPageTypes,
		namedOutlets: contract.namedOutlets,
		namedDomains: contract.namedDomains,
		referenceUrls: contract.referenceUrls,
		completionState: 'pending'
	};
}

function contractFromRequirements(
	base: ResearchRequestContract,
	requirements: ResearchRequirement[],
	input: {
		homeMarket?: string;
		timezone?: string;
		latestRequest: string;
		excludedCategories: string[];
		excludedPageTypes: ResearchPageType[];
		excludedSourceTypes: string[];
		namedOutlets: string[];
		namedDomains: string[];
		referenceUrls: string[];
		requiredOutputFields: string[];
		allowFewerThanRequested: boolean;
		outputType?: ResearchOutputType;
	}
): ResearchRequestContract {
	const first = requirements[0];
	const requestedItemCount = requirements.reduce((total, requirement) => total + requirement.requestedItemCount, 0);
	const temporalWindow = requirements.every((requirement) => requirement.temporalWindow.kind === requirements[0]?.temporalWindow.kind)
		? { ...base.temporalWindow, ...requirements[0]?.temporalWindow }
		: base.temporalWindow;
	return {
		...base,
		version: 2,
		subject: base.subject || first?.subject || input.latestRequest,
		...(first?.geography ? { location: first.geography } : { location: undefined }),
		...(input.homeMarket || base.homeMarket ? { homeMarket: input.homeMarket || base.homeMarket } : {}),
		temporalWindow,
		requestedItemCount,
		includedDesks: unique([...base.includedDesks, ...requirements.flatMap((requirement) => requirement.includedCategories)]),
		includedCategories: unique([...base.includedCategories, ...requirements.flatMap((requirement) => requirement.includedCategories)]),
		excludedDesks: unique([...base.excludedDesks, ...input.excludedCategories]),
		excludedCategories: input.excludedCategories,
		excludedSourceTypes: input.excludedSourceTypes,
		excludedPageTypes: input.excludedPageTypes,
		namedOutlets: input.namedOutlets,
		namedDomains: input.namedDomains,
		requiredOutputFields: input.requiredOutputFields,
		partialAnswerPolicy: input.allowFewerThanRequested ? 'verified_subset_with_leads' : base.partialAnswerPolicy,
		allowFewerThanRequested: input.allowFewerThanRequested,
		referenceUrls: input.referenceUrls,
		requirements,
		outputType: input.outputType || base.outputType || 'answer'
	};
}

function splitRequirementClauses(value: string): string[] {
	const withoutRole = value.replace(/^\s*act as\b[^.!?]{0,240}[.!?]\s*/i, '').trim();
	const sentences = withoutRole
		.split(/(?<=[.!?])\s+/)
		.map((sentence) => sentence.trim())
		.filter(Boolean);
	const chunks = sentences.flatMap((sentence) =>
		sentence
			.split(/(?:,\s*|\s+)(?=(?:and\s+then|then\s+one|and\s+(?:give|provide|show|list)|and\s+(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve))\b)/i)
			.map((chunk) => chunk.trim())
	);
	const candidates = chunks.filter((chunk) => {
		const normalized = chunk.replace(/^[,;:]?\s*(?:and\s+)?(?:then\s+)?/i, '').trim();
		if (!normalized || /^(?:search|scan|check|return|format|rank|sort|include|exclude|excluding|without|do not|don't|cite|use|if\b|when\b)\b/i.test(normalized)) return false;
		const hasDeliverable = /\b(?:stories?|items?|headlines?|updates?|developments?|news|briefs?|roundups?)\b/i.test(normalized);
		const hasCount = /\b(?:\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b/i.test(normalized);
		const hasScope = Boolean(parseGeographyScope(normalized).geography) ||
			/\b(?:local|regional|provincial|national|international|global)\b/i.test(normalized);
		const startsAssignment = /^(?:what|give|provide|prepare|create|write|send|show|find|list|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b/i.test(normalized);
		return (hasDeliverable || hasCount) && (hasScope || startsAssignment);
	});
	return candidates.length ? candidates.map((chunk) => chunk.replace(/^[,;:]?\s*(?:and\s+)?(?:then\s+)?/i, '').trim()) : [value.trim()];
}

function parseGeographyScope(value: string): { geography?: string; level?: ResearchRequirementLevel } {
	const explicitLevel = value.match(/\b(local|regional|provincial|national|international|global)\b/i)?.[1]?.toLowerCase() as ResearchRequirementLevel | undefined;
	const cue = value.match(/\b(?:in|for|across|within|around|near)\s+(?:the\s+)?([A-Z][\p{L}'-]*(?:\s+[A-Z][\p{L}'-]*){0,3}?)(?=\s+(?:local|regional|provincial|national|international|global)\b|[,.!?]|$)/u);
	let geography = cue?.[1]?.replace(/[.,!?]+$/, '').replace(/\s+/g, ' ').trim();
	if (geography && /^(?:international|global|national|local|regional|provincial)$/i.test(geography)) geography = undefined;
	if (!geography) geography = extractLocation(value);
	const level = explicitLevel || inferRequirementLevel(geography, value);
	return { ...(geography ? { geography } : {}), ...(level ? { level } : {}) };
}

function requirementSubjectFromClause(value: string, fallback: string): string {
	let subject = value
		.replace(/^[,;:]?\s*(?:and\s+)?(?:then\s+)?/i, '')
		.replace(/^\s*(?:what(?:'s| is| are)|give|provide|prepare|create|write|send|show|find|list)\s+(?:me|us)?\s*/i, '')
		.replace(/^\s*(?:an?\s+)?(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|\d{1,2})\s+/i, '')
		.replace(/\b(?:\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s*(?:-|–|to)\s*(?:\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(?:stories?|items?|headlines?|updates?|briefs?)\b/gi, ' ')
		.replace(/\b(?:\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(?:stories?|items?|headlines?|updates?|briefs?)\b/gi, ' ')
		.replace(/\b(?:in|for|across|within|around|near)\s+(?:the\s+)?[A-Z][\p{L}'-]*(?:\s+[A-Z][\p{L}'-]*){0,3}?(?:\s+(?:local|regional|provincial|national|international|global))?(?=$|[,.!?])/u, ' ')
		.replace(/\b(?:local|regional|provincial|national|international|global)\b/gi, ' ')
		.replace(/\b(?:the|a|an)\b/gi, ' ')
		.replace(/\s+/g, ' ')
		.trim();
	if (!subject || /^(?:for|in|across|within|around|near|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)$/i.test(subject)) {
		const cleanedFallback = cleanSubject(fallback);
		return /^(?:for|in|across|within|around|near|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)$/i.test(cleanedFallback)
			? 'latest news'
			: cleanedFallback;
	}
	if (/^(?:what|give|provide|prepare|create|write|send|show|find|list|and\s+then|one\s+for)\b/i.test(subject)) {
		const cleanedFallback = cleanSubject(fallback).replace(/^(?:what(?:'s| is| are)|give|provide|prepare|create|write|send|show|find|list)\s+(?:me|us)?\s*/i, '').trim();
		return cleanedFallback || 'requested research';
	}
	return cleanSubject(subject, true);
}

function outputExpectationsFor(value: string, outputType: ResearchOutputType, requiredFields: string[]): string[] {
	const expectations = [...requiredFields];
	if (outputType === 'producer_roundup' || outputType === 'story_list' || /\b(?:stories?|headlines?|developments?)\b/i.test(value)) {
		expectations.push('headline', 'what_happened', 'why_it_matters', 'source_time', 'citations');
	}
	if (/\b(?:why it matters|significance|impact)\b/i.test(value)) expectations.push('why_it_matters');
	if (/\b(?:headline|headlines)\b/i.test(value)) expectations.push('headline');
	if (/\b(?:summary|what happened|what happened)\b/i.test(value)) expectations.push('what_happened');
	if (/\b(?:source time|published|updated|timestamp|date|time)\b/i.test(value)) expectations.push('source_time');
	return unique(expectations);
}

function inferOutputType(value: string): ResearchOutputType {
	if (/\b(?:pdf|document|attached)\b/i.test(value)) return 'document_summary';
	if (/\b(?:compare|comparison|contrast)\b/i.test(value)) return 'comparison';
	if (/\b(?:briefing|roundup|assignment[- ]desk|developing stories|latest .*\b(?:news|stories|headlines)|top stories)\b/i.test(value)) return 'producer_roundup';
	if (/\b(?:stories|headlines|updates|items)\b/i.test(value)) return 'story_list';
	if (/\b(?:brief|digest|script)\b/i.test(value)) return 'brief';
	return 'answer';
}

function requirementLabel(geography: string | undefined, level: ResearchRequirementLevel | undefined, subject: string): string {
	if (geography && level) return `${geography} ${level}`;
	if (geography) return geography;
	if (level) return level[0].toUpperCase() + level.slice(1);
	return subject || 'Requested research';
}

function stableRequirementId(subject: string, geography: string | undefined, level: ResearchRequirementLevel | undefined, index: number): string {
	const seed = `${subject}|${geography || ''}|${level || ''}|${index}`.toLowerCase();
	let hash = 2166136261;
	for (const character of seed) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
	const slug = `${geography || level || subject}`.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 34) || 'request';
	return `req_${slug}_${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function replacementDirective(value: string): { from: string; to: string } | undefined {
	const match = value.match(/\b(?:replace|swap|change)\s+(?:the\s+)?(.+?)\s+(?:section\s+|requirement\s+)?(?:with|for|to)\s+(.+?)(?:[.!?]|$)/i);
	if (!match) return undefined;
	return {
		from: match[1].replace(/\b(?:section|requirement)\b/gi, '').trim(),
		to: match[2].replace(/\s+and\s+(?:remove|drop|omit|delete|no longer include)\b[\s\S]*$/i, '').trim()
	};
}

function removalTerms(value: string): string[] {
	const match = value.match(/\b(?:remove|drop|omit|delete|no longer include)\s+(.+?)(?:[.!?]|$)/i);
	if (!match) return [];
	return match[1]
		.split(/\s+and\s+|,|;/i)
		.map((term) => term.replace(/\b(?:the|section|requirement|one)\b/gi, '').trim())
		.filter(Boolean);
}

function requirementMatchesTerm(requirement: ResearchRequirement, term: string): boolean {
	const normalizedTerm = normalizeComparable(term);
	if (!normalizedTerm) return false;
	return [requirement.geography, requirement.level, requirement.label, requirement.subject]
		.filter(Boolean)
		.some((value) => {
			const normalizedValue = normalizeComparable(value || '');
			if (!normalizedValue) return false;
			if (normalizedValue === normalizedTerm) return true;
			const valueTokens = normalizedValue.split(' ');
			const termTokens = normalizedTerm.split(' ');
			return valueTokens.some((token) => termTokens.includes(token));
		});
}

function inferRequirementLevel(geography: string | undefined, value: string): ResearchRequirementLevel | undefined {
	const explicit = value.match(/\b(local|regional|provincial|national|international|global)\b/i)?.[1]?.toLowerCase() as ResearchRequirementLevel | undefined;
	if (explicit) return explicit;
	const normalized = geography?.toLowerCase().trim() || '';
	if (!normalized && /\binternational\b/i.test(value)) return 'international';
	if (PROVINCES.has(normalized)) return 'provincial';
	if (COUNTRIES.has(normalized)) return 'national';
	if (geography && /\b(?:in|near|around|within)\b/i.test(value)) return 'local';
	if (geography && /\bfor\b/i.test(value)) return 'national';
	return undefined;
}

function normalizeComparable(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function subjectFromRequest(value: string): string {
	const assignment = primaryAssignmentSentence(value);
	let subject = assignment
		.replace(/https?:\/\/\S+/gi, ' ')
		.replace(/^\s*(?:correction|actually|i mean)\s*[:,-]?\s*/i, '')
		.replace(/^\s*i mean\s*[:,-]?\s*/i, '')
		.replace(
			/^\s*(?:give|provide|prepare|create|write|send|show)\s+(?:me|us)\s+(?:an?\s+)?(?:(?:same[- ]day|daily|morning|evening|current|latest)\s+)?(?:(?:newsroom|news|producer|assignment[- ]desk)\s+)?(?:briefing|brief|roundup|digest|update)\s+(?:(?:for|as of|dated)\s+.{1,160}?\s+)?(?:of|about|on)\s+(?:the\s+)?/i,
			''
		)
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

function primaryAssignmentSentence(value: string): string {
	const withoutRole = value.replace(/^\s*act as\b[^.!?]{0,240}[.!?]\s*/i, '').trim();
	const sentences = withoutRole.split(/(?<=[.!?])\s+/).map((sentence) => sentence.trim()).filter(Boolean);
	const assignment = sentences.find(
		(sentence) => !/^(?:search|scan|check|look up|return|format|rank|sort|include|exclude|excluding|without|do not|don't|cite|use|if\b|when\b)\b/i.test(sentence)
	);
	return assignment || withoutRole || value.trim();
}

function extractRequestedItemCount(value: string): number | undefined {
	const qualifier = '(?:(?:verified|non[- ]sports?|same[- ]day|direct|latest|current|developing|major|top|consequential|local|regional|provincial|national|international|global|foreign)\\s+)*';
	const countPrefix = '(?:(?:up to|at most|no more than)\\s+)?';
	const range = value.match(new RegExp(`\\b${countPrefix}(\\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\\s*(?:-|–|to)\\s*(\\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\\s+${qualifier}(?:news\\s+)?(?:stories|items|briefs?|headlines?|updates?)\\b`, 'i'));
	if (range) return Math.min(25, Math.max(parseCountToken(range[1]), parseCountToken(range[2])));
	const match = value.match(new RegExp(`\\b${countPrefix}(\\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\\s+${qualifier}(?:news\\s+)?(?:stories|items|briefs?|headlines?|updates?)\\b`, 'i'));
	if (match) return Math.min(25, parseCountToken(match[1]));
	const singularStory = value.match(new RegExp(`\\b(?:a|an|one)\\s+${qualifier}(?:news\\s+)?(?:stories|items|briefs?|headlines?|updates?)\\b`, 'i'));
	const singular = singularStory || value.match(/^\s*(?:and\s+then\s+)?(?:a|an|one)\s+for\b/i);
	return singular ? 1 : undefined;
}

function parseCountToken(value: string): number {
	return /^\d+$/.test(value) ? Number(value) : NUMBER_WORDS[value.toLowerCase()] || 1;
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
			.concat(sourceText.match(/\b(?:cbc\.ca|ctvnews\.ca|globalnews\.ca|cp24\.com|citynews\.ca|reuters\.com|apnews\.com)\b/gi) || [])
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

function temporalWindowFor(value: string, timezone: string | undefined, base: ResearchTemporalWindow | undefined): ResearchTemporalWindow {
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
		/\b(?:Toronto|Ottawa|Montreal|Vancouver|Calgary|Edmonton|Halifax|Hamilton|Mississauga|Brampton|Winnipeg|Quebec City|Victoria|London|Kitchener|Waterloo|New York|Los Angeles|Chicago|Washington|Paris|Berlin|Sydney|Melbourne)\b/i
	)?.[0];
	if (common) return common.replace(/\s+/g, ' ').trim();

	const cue = value.match(/\b(?:mean|in|near|around|across|outside|for)\s+(?:the\s+)?([A-Z][\p{L}'-]*(?:\s+[A-Z][\p{L}'-]*){0,3})/u);
	if (cue?.[1]) {
		const words = cue[1].replace(/[.,!?]+$/, '').trim().split(/\s+/);
		const locationWords = [words[0], ...words.slice(1).filter((word) => /^[A-Z][\p{L}'-]*$/u.test(word))];
		const candidate = locationWords.join(' ').trim();
		if (candidate && candidate.length <= 60 && !/^(?:Correction|Actually|I|Today|Latest|Current|Assignment|Desk)$/i.test(candidate)) return candidate;
	}
	return undefined;
}

function cleanSubject(value: string, preserveTerminalPunctuation = false): string {
	const normalized = value.replace(/\s+/g, ' ').replace(/^[,;:!?.-]+/, '').trim();
	return (preserveTerminalPunctuation ? normalized : normalized.replace(/[,;:!?.-]+$/, '')).slice(0, 2000);
}

function looksLikeExplicitNewTopic(value: string): boolean {
	return /^(?:find|search|research|gather|collect|get)\b[\s\S]{0,120}\b(?:on|for|about)\b/i.test(value.trim()) &&
		!isCorrectionOrConstraintTurn(value);
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
