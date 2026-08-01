import type { NewsroomContext, ResearchRequestContract } from '@newscraft/shared';

export interface CoverageLane {
	id: string;
	label: string;
	purpose: string;
	targetDesks: string[];
	sourcePurpose: 'major_publishers' | 'official_public_impact' | 'desk_focus' | 'named_sources' | 'corroboration';
	domainHints: string[];
	query: string;
}

export interface CoveragePlanOptions {
	maxLanes?: number;
	namedOnly?: boolean;
}

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
			'Find the strongest directly relevant reporting across major publishers in the home market and wider desk.',
			'major_publishers',
			[],
			domainHints
		);
	}

	if (lanes.length < maxLanes) {
		add(
			'official_public_impact',
			'Checking official public-impact sources',
			'Check official or first-party releases, public notices, and other sources with direct impact on the assignment.',
			'official_public_impact',
			['public impact'],
			officialHints
		);
	}

	if (lanes.length < maxLanes) {
		add(
			'desk_focus',
			includedDesks.length
				? `Checking ${includedDesks.slice(0, 2).join(' and ')} desks`
				: 'Checking relevant assignment desks',
			includedDesks.length
				? `Search the relevant ${includedDesks.slice(0, 4).join(', ')} desks for distinct stories not already covered.`
				: 'Search the relevant assignment desks for distinct stories not already covered by major publishers or official sources.',
			'desk_focus',
			includedDesks,
			domainHints
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
