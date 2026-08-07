import {
	researchRequirementsForContract,
	type NewsroomContext,
	type ResearchRequestContract,
	type ResearchRequirement
} from '@newscraft/shared';

export interface CoverageLane {
	id: string;
	label: string;
	purpose: string;
	targetDesks: string[];
	sourcePurpose: 'major_publishers' | 'official_public_impact' | 'desk_focus' | 'named_sources' | 'corroboration';
	domainHints: string[];
	query: string;
	/** The independently requested deliverable this lane serves. */
	requirementId?: string;
	/** Discovery must precede official/corroboration repetition. */
	phase?: 'discovery' | 'official' | 'corroboration';
	/** Provider-neutral capability identity used for semantic deduplication. */
	capability?: 'web_search' | 'source_monitor' | 'direct_read' | 'corroboration';
	/** Stable intent key; wording changes must not create a new lane. */
	intentKey?: string;
}

export interface CoveragePlanOptions {
	maxLanes?: number;
	namedOnly?: boolean;
}

export interface RequirementCoveragePlanOptions {
	/** Maximum number of search lanes after every requirement has a discovery lane. */
	maxLanes?: number;
	includeOfficial?: boolean;
	includeCorroboration?: boolean;
}

const DEFAULT_PRIORITY_DESKS = [
	'public safety',
	'government',
	'housing',
	'transit',
	'health',
	'education',
	'business',
	'community'
];

/**
 * Build distinct producer coverage lanes from the structured request. The
 * lane vocabulary is generic: a named incident, city, sport, or desk is data
 * in the request, never a branch in this planner.
 */
export function buildProducerCoverageLanes(
	contract: ResearchRequestContract,
	newsroomContext?: NewsroomContext,
	options: CoveragePlanOptions = {}
): CoverageLane[] {
	const maxLanes = Math.max(1, Math.min(6, options.maxLanes ?? 4));
	const profile = newsroomContext?.sourceProfile;
	const market = contract.location || contract.homeMarket || newsroomContext?.homeMarket || '';
	const domainHints = unique([
		...(profile?.majorPublisherDomains || []),
		...(newsroomContext?.preferredDomains || [])
	]);
	const officialHints = unique(profile?.officialSourceDomains || []);
	const includedDesks = unique([
		...contract.includedDesks,
		...contract.includedCategories,
		...(profile?.relevantDesks || [])
	]).filter((desk) => !isExcluded(desk, contract));
	const lanes: CoverageLane[] = [];

	const add = (
		id: string,
		label: string,
		purpose: string,
		sourcePurpose: CoverageLane['sourcePurpose'],
		targetDesks: string[],
		hints: string[]
	) => {
		if (lanes.length >= maxLanes) return;
		lanes.push({
			id,
			label,
			purpose,
			sourcePurpose,
			targetDesks,
			domainHints: hints,
			query: laneQuery(contract, market, purpose, targetDesks, hints)
		});
	};

	if (contract.namedOutlets.length || contract.namedDomains.length) {
		const namedSources = unique([
			...contract.namedOutlets,
			...contract.namedDomains.filter(
				(domain) => !contract.namedOutlets.some((outlet) => sameSourceLabel(outlet, domain))
			)
		]);
		for (const source of namedSources) {
			if (lanes.length >= maxLanes) break;
			const domain = contract.namedDomains.find((candidate) => candidate.toLowerCase() === source.toLowerCase());
			add(
				`named_${source.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`,
				`Checking ${source}`,
				`Check ${source} for directly relevant article-level coverage in the request window.`,
				'named_sources',
				[source],
				domain ? [domain] : []
			);
		}
		if (options.namedOnly) return lanes;
	}

	if (lanes.length < maxLanes) {
		add(
			'major_publishers',
			'Scanning major publisher coverage',
			'Find the newest consequential local articles across at least five distinct established news publishers serving the market. Use publisher homepages or sections only to discover and open direct article pages.',
			'major_publishers',
			[],
			domainHints
		);
	}

	if (lanes.length < maxLanes) {
		const priorityDesks = includedDesks.length
			? includedDesks
			: DEFAULT_PRIORITY_DESKS.filter((desk) => !isExcluded(desk, contract));
		add(
			'desk_focus',
			priorityDesks.length
				? `Checking ${priorityDesks.slice(0, 2).join(' and ')} desks`
				: 'Checking relevant assignment desks',
			priorityDesks.length
				? `Search established local publishers across the ${priorityDesks.slice(0, 8).join(', ')} desks for distinct consequential articles.`
				: 'Search established local publishers across relevant assignment desks for distinct consequential articles.',
			'desk_focus',
			priorityDesks,
			domainHints
		);
	}

	if (lanes.length < maxLanes) {
		add(
			'official_public_impact',
			'Checking official public-impact sources',
			'Check official or first-party releases and live updates that confirm or materially extend consequential stories in the assignment; do not treat generic notices, job pages, documents, or event listings as stories.',
			'official_public_impact',
			['public impact'],
			officialHints
		);
	}

	if (lanes.length < maxLanes) {
		add(
			'corroboration',
			'Cross-checking independent coverage',
			'Cross-check the strongest candidate stories against independent direct article or official pages and fill only uncovered gaps.',
			'corroboration',
			[],
			unique([...domainHints, ...officialHints])
		);
	}

	return lanes;
}

/**
 * Build the breadth-first plan for a normalized multi-requirement contract.
 * The first pass is deliberately one independent discovery opportunity per
 * requirement. Additional source-purpose passes are appended only after that
 * invariant is satisfied, so a broad assignment cannot spend its budget
 * repeatedly scanning the first market it happened to mention.
 */
export function buildRequirementCoverageLanes(
	contract: ResearchRequestContract,
	newsroomContext?: NewsroomContext,
	options: RequirementCoveragePlanOptions = {}
): CoverageLane[] {
	const requirements = researchRequirementsForContract(contract);
	if (!requirements.length) return [];
	const maxLanes = Math.max(requirements.length, Math.min(8, options.maxLanes ?? requirements.length + 2));
	const lanes = requirements.map((requirement) => requirementDiscoveryLane(requirement, contract, newsroomContext));
	const extras: CoverageLane[] = [];
	const includeOfficial = options.includeOfficial !== false;
	const includeCorroboration = options.includeCorroboration !== false;
	if (includeOfficial) {
		for (const requirement of requirements) {
			extras.push(requirementOfficialLane(requirement, contract, newsroomContext));
		}
	}
	if (includeCorroboration) {
		for (const requirement of requirements) {
			extras.push(requirementCorroborationLane(requirement, contract, newsroomContext));
		}
	}
	for (const requirement of requirements) {
		extras.push(requirementIndependentLane(requirement, contract, newsroomContext));
	}
	return [...lanes, ...extras.slice(0, Math.max(0, maxLanes - lanes.length))];
}

function requirementDiscoveryLane(
	requirement: ResearchRequirement,
	contract: ResearchRequestContract,
	newsroomContext?: NewsroomContext
): CoverageLane {
	const domains = unique([
		...(requirement.namedDomains || []),
		...(newsroomContext?.sourceProfile?.majorPublisherDomains || []),
		...(newsroomContext?.preferredDomains || [])
	]);
	return {
		id: `requirement_${requirement.id}_discovery`,
		label: `Discovering ${requirement.label}`,
		purpose: `Find distinct, current direct article coverage for the ${requirement.label} deliverable.`,
		targetDesks: requirement.includedCategories,
		sourcePurpose: requirement.namedOutlets.length || requirement.namedDomains.length ? 'named_sources' : 'major_publishers',
		domainHints: domains,
		query: requirementQuery(requirement, contract, 'discovery', domains),
		requirementId: requirement.id,
		phase: 'discovery',
		capability: 'web_search',
		intentKey: `${requirement.id}:discovery:web_search`
	};
}

function requirementOfficialLane(
	requirement: ResearchRequirement,
	contract: ResearchRequestContract,
	newsroomContext?: NewsroomContext
): CoverageLane {
	const domains = unique([
		...(requirement.namedDomains || []),
		...(newsroomContext?.sourceProfile?.officialSourceDomains || [])
	]);
	return {
		id: `requirement_${requirement.id}_official`,
		label: `Checking official ${requirement.label} sources`,
		purpose: `Check first-party releases or live updates that confirm or materially extend this deliverable.`,
		targetDesks: requirement.includedCategories,
		sourcePurpose: 'official_public_impact',
		domainHints: domains,
		query: requirementQuery(requirement, contract, 'official', domains),
		requirementId: requirement.id,
		phase: 'official',
		capability: 'web_search',
		intentKey: `${requirement.id}:official:web_search`
	};
}

function requirementCorroborationLane(
	requirement: ResearchRequirement,
	contract: ResearchRequestContract,
	newsroomContext?: NewsroomContext
): CoverageLane {
	const domains = unique([
		...(requirement.namedDomains || []),
		...(newsroomContext?.sourceProfile?.majorPublisherDomains || []),
		...(newsroomContext?.sourceProfile?.officialSourceDomains || [])
	]);
	return {
		id: `requirement_${requirement.id}_corroboration`,
		label: `Cross-checking ${requirement.label}`,
		purpose: `Cross-check the strongest candidate stories against independent direct or official pages and fill uncovered item gaps.`,
		targetDesks: requirement.includedCategories,
		sourcePurpose: 'corroboration',
		domainHints: domains,
		query: requirementQuery(requirement, contract, 'corroboration', domains),
		requirementId: requirement.id,
		phase: 'corroboration',
		capability: 'corroboration',
		intentKey: `${requirement.id}:corroboration:web_search`
	};
}

function requirementIndependentLane(
	requirement: ResearchRequirement,
	contract: ResearchRequestContract,
	newsroomContext?: NewsroomContext
): CoverageLane {
	const domains = unique([
		...(requirement.namedDomains || []),
		...(newsroomContext?.sourceProfile?.majorPublisherDomains || [])
	]);
	return {
		id: `requirement_${requirement.id}_independent`,
		label: `Checking an independent ${requirement.label} lane`,
		purpose: `Use a separate publisher or desk search to fill only remaining gaps in this deliverable.`,
		targetDesks: requirement.includedCategories,
		sourcePurpose: 'desk_focus',
		domainHints: domains,
		query: requirementQuery(requirement, contract, 'independent', domains),
		requirementId: requirement.id,
		phase: 'corroboration',
		capability: 'web_search',
		intentKey: `${requirement.id}:independent:web_search`
	};
}

function requirementQuery(
	requirement: ResearchRequirement,
	contract: ResearchRequestContract,
	phase: CoverageLane['phase'] | 'independent',
	domains: string[]
): string {
	const scope = [requirement.geography, requirement.level].filter(Boolean).join(' ');
	const temporal = requirement.temporalWindow.phrase || requirement.temporalWindow.label || contract.temporalWindow.phrase;
	const phaseInstruction = phase === 'discovery'
		? 'Search established local publishers across relevant assignment desks for distinct consequential articles.'
		: phase === 'official'
			? 'Check official or first-party releases and live updates that confirm or materially extend consequential stories.'
			: phase === 'independent'
				? 'Search a second independent publisher lane for uncovered consequential articles.'
				: 'Cross-check the strongest candidate stories against independent direct article or official pages.';
	const constraints = [
		requirement.excludedCategories.length ? `Exclude ${requirement.excludedCategories.join(', ')}` : '',
		requirement.excludedSourceTypes.length ? `Exclude source types ${requirement.excludedSourceTypes.join(', ')}` : '',
		requirement.namedOutlets.length ? `Prefer ${requirement.namedOutlets.join(', ')}` : '',
		domains.length ? `Useful domains: ${domains.slice(0, 6).join(', ')}` : ''
	].filter(Boolean);
	return [
		`Requirement ${requirement.id}: ${requirement.subject}`,
		scope ? `Scope: ${scope}.` : 'Scope: the explicitly requested subject without adding a location.',
		`Find ${requirement.requestedItemCount} distinct item${requirement.requestedItemCount === 1 ? '' : 's'} for this requirement.`,
		temporal ? `Freshness window: ${temporal}.` : '',
		`Pass: ${phase}.`,
		phaseInstruction,
		...constraints,
		'Open direct article or official pages; do not return search-result pages, hubs, or isolated snippets as the story.',
		'Keep this lane separate from every other requirement in the request.'
	].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}

export function coverageOverlap(
	candidates: Array<{ source_url: string; canonical_url?: string }>,
	previous: Array<{ source_url: string; canonical_url?: string }>
): { ratio: number; novelCount: number; candidateCount: number } {
	const priorUrls = new Set(previous.map((item) => canonicalUrl(item.canonical_url || item.source_url)));
	const uniqueCandidates = unique(candidates.map((item) => canonicalUrl(item.canonical_url || item.source_url)));
	const novelCount = uniqueCandidates.filter((url) => !priorUrls.has(url)).length;
	return {
		ratio: uniqueCandidates.length ? 1 - novelCount / uniqueCandidates.length : 1,
		novelCount,
		candidateCount: uniqueCandidates.length
	};
}

export function reformulateCoverageQuery(
	lane: CoverageLane,
	contract: ResearchRequestContract,
	missingPurpose = 'Focus on sources and desks not represented in the accepted evidence.'
): string {
	return [
		lane.query,
		`Reformulate this pass around a missing coverage angle: ${missingPurpose}`,
		'Exclude URLs and stories already returned by earlier lanes.',
		`The structured request contract remains authoritative: ${contract.subject}.`
	].join(' ');
}

function laneQuery(
	contract: ResearchRequestContract,
	market: string,
	purpose: string,
	targetDesks: string[],
	domainHints: string[]
): string {
	const location = market ? ` in ${market}` : '';
	const deskHint = targetDesks.length ? ` Target desks: ${targetDesks.join(', ')}.` : '';
	const sourceHint = domainHints.length
		? ` Check these relevant source domains as part of the sweep: ${domainHints.slice(0, 12).join(', ')}.`
		: '';
	const temporalHint = contract.temporalWindow.start && contract.temporalWindow.end
		? ` Freshness window: ${contract.temporalWindow.start} through ${contract.temporalWindow.end}${contract.temporalWindow.label ? ` (${contract.temporalWindow.label})` : ''}.`
		: contract.temporalWindow.phrase
			? ` Freshness window: ${contract.temporalWindow.phrase}.`
			: '';
	const referenceHint = contract.referenceUrls.length
		? ` Resolve matching reference leads directly when relevant: ${contract.referenceUrls.slice(0, 4).join(', ')}.`
		: '';
	return [
		contract.subject || 'the requested assignment',
		location,
		purpose,
		deskHint,
		sourceHint,
		temporalHint,
		referenceHint,
		'Search the request window. Return direct article or official pages with publication/update times and supporting excerpts.',
		'Apply the structured request contract for exclusions and the partial-answer policy.'
	]
		.join(' ')
		.replace(/\s+/g, ' ')
		.trim();
}

function isExcluded(value: string, contract: ResearchRequestContract): boolean {
	const normalized = value.toLowerCase();
	return [...contract.excludedCategories, ...contract.excludedDesks].some((item) => {
		const candidate = item.toLowerCase();
		return normalized === candidate || normalized.includes(candidate) || candidate.includes(normalized);
	});
}

function unique(values: string[]): string[] {
	return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function canonicalUrl(value: string): string {
	try {
		const url = new URL(value);
		url.hash = '';
		for (const key of [...url.searchParams.keys()]) if (/^(?:utm_|fbclid|gclid)/i.test(key)) url.searchParams.delete(key);
		return url.toString().replace(/\/$/, '').toLowerCase();
	} catch {
		return value.trim().replace(/#.*$/, '').replace(/\/$/, '').toLowerCase();
	}
}

function sameSourceLabel(left: string, right: string): boolean {
	const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, '');
	const normalizedLeft = normalize(left).replace(/news$/, '');
	const normalizedRight = normalize(right).replace(/com$|ca$|org$|net$/, '');
	return normalizedLeft.length > 2 && (normalizedLeft === normalizedRight || normalizedRight.includes(normalizedLeft));
}
