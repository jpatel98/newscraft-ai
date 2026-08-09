import type { ToolBudgetSnapshot } from './budget.js';
import {
	researchRequirementsForContract,
	type CitationRecord,
	type ConversationContext,
	type ResearchRequestContract
} from '@newscraft/shared';
import {
	assessEvidenceQuality,
	isUsableEvidence,
	type EvidenceObject,
	type EvidenceSourceKind
} from './evidence.js';
import type { EvidenceStoryCluster } from './evidence.js';
import type { RequirementCoverage } from './contract-satisfaction.js';
import type { RouteDecision } from './router.js';
import { isCurrentResearchAssignment } from './time-context.js';
import {
	completeGroundedEvidenceStatement,
	groundedAnswerFromClaims,
	groundedClaimFromEvidence,
	citationNumbersInGroundedAnswer,
	hasMalformedCitationSyntax,
	normalizeGroundedEvidence,
	renderGroundedAnswer,
	validateGroundedClaim,
	evidenceIdentity,
	type GroundedAnswerBlock,
	type GroundedClaim,
	type GroundedEvidenceLedger,
	type GroundedPresentation
} from './grounded-answer.js';

export interface AnswerGenerationInput {
	prompt: string;
	decision: RouteDecision;
	evidence: EvidenceObject[];
	limitations: string[];
	budget: ToolBudgetSnapshot;
	toolAnswers?: string[];
	outputStyle?: 'report' | 'chat';
	conversationContext?: ConversationContext;
	researchStepCount?: number;
	timeZone?: string;
	researchContract?: ResearchRequestContract;
	requirementCoverage?: RequirementCoverage[];
	storyClusters?: EvidenceStoryCluster[];
}

/**
 * Conservative safety net for legacy/provider output. It never repairs
 * free-form prose. Invalid or malformed output is replaced by a deterministic
 * claim ledger render.
 */
export function enforceFinalCitationIntegrity(answer: string, evidence: EvidenceObject[]): string {
	const ledger = normalizeGroundedEvidence(evidence);
	// A free-form answer cannot prove that each visible claim is supported by
	// the exact retained evidence set. Structured callers render directly from
	// GroundedAnswer; this legacy boundary therefore rejects every citation-like
	// answer instead of accepting a provider's placement by marker number.
	if (!answer.trim() || citationNumbersInGroundedAnswer(answer).length || hasMalformedCitationSyntax(answer)) {
		return renderEvidenceFallback(ledger);
	}
	return answer.trim();
}

/** Diagnostic-only compatibility check for already persisted legacy answers. */
export function incompleteCitationNumbers(answer: string, citations: CitationRecord[]): number[] {
	const visible = answer.replace(/\[(\d+)\](?!\()/g, '').trim();
	if (!visible) return [];
	const normalizedVisible = diagnosticComparable(visible);
	return citations
		.filter((citation) => citation.supportingExcerpt)
		.filter((citation) => {
			const excerpt = diagnosticComparable(citation.supportingExcerpt);
			return Boolean(excerpt && normalizedVisible && excerpt.startsWith(`${normalizedVisible} `));
		})
		.map((citation) => citation.citationNumber)
		.sort((left, right) => left - right);
}

function renderEvidenceFallback(ledger: GroundedEvidenceLedger): string {
	const claims = ledger.evidence
		.slice(0, 6)
		.flatMap((item) => {
			const claim = groundedClaimFromEvidence(item, ledger, {
				presentation: { kind: ledger.evidence.length === 1 ? 'paragraph' : 'bullet' }
			});
			return claim ? [claim] : [];
		});
	return renderGroundedAnswer(groundedAnswerFromClaims(claims), ledger);
}

function diagnosticComparable(value: string): string {
	return value
		.replace(/\[(\d+)\](?!\()/g, '')
		.replace(/^\s*(?:#{1,6}\s+|[-*•]\s+|\d+[.)]\s+)/u, '')
		.replace(/\*\*([^*\n]+)\*\*/g, '$1')
		.replace(/\u0060([^\u0060\n]+)\u0060/g, '$1')
		.replace(/\s+/gu, ' ')
		.trim()
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, ' ')
		.replace(/\s+/gu, ' ')
		.trim();
}

export const completeEvidenceStatement = completeGroundedEvidenceStatement;

export function generateFinalAnswer(input: AnswerGenerationInput): string {
	const answerEvidence =
		input.outputStyle === 'chat' ? withImplicitCitationNumbers(input.evidence) : input.evidence;
	const sortedEvidence = answerEvidence.some((item) => item.temporal_scope)
		? answerEvidence
		: sortEvidenceForPrompt(input.prompt, answerEvidence);
	const evidence = sortedEvidence.filter(isUsableEvidence);
	const unusableEvidence = sortedEvidence.filter((item) => !isUsableEvidence(item));
	if (input.decision.selected_mode === 'clarification_needed') {
		return 'I need a specific source, story, document, or research update to check before I can answer cleanly.';
	}
	if (input.decision.selected_mode === 'answer_from_memory') {
		return answerFromMemory(input.prompt);
	}
	if (input.decision.selected_mode === 'direct_answer') {
		return directAnswerFallback(input.prompt);
	}
	const requirements = input.researchContract ? researchRequirementsForContract(input.researchContract) : [];
	if (requirements.length > 1) {
		return multiRequirementChatAnswer({
			...input,
			evidence: sortedEvidence,
			requirements,
			unusableEvidence,
			storyClusters: input.storyClusters || []
		});
	}
	if (!evidence.length && input.toolAnswers?.length) {
		const safeToolAnswers = input.toolAnswers.filter(
			(item) =>
				item.trim() &&
				citationNumbersInGroundedAnswer(item).length === 0 &&
				!hasMalformedCitationSyntax(item)
		);
		if (!safeToolAnswers.length) {
			return input.outputStyle === 'chat'
				? chatNoLead(unusableEvidence, input.limitations)
				: noPublishableLeadReport(unusableEvidence, input.limitations);
		}
		const answer = safeToolAnswers
			.join('\n\n')
			.replace(/\s*\[\d+\]/g, '');
		const caveats = publicCaveatsFor(input.prompt, evidence, unusableEvidence, input.limitations, {
			noUsableEvidence: true
		});
		const visibleCaveats = input.outputStyle === 'chat' ? chatToolAnswerCaveats(input.prompt, caveats) : caveats;
		const formattedAnswer =
			input.outputStyle === 'chat'
				? `**Unverified lead from the search**\n\n${formatChatToolAnswer(input.prompt, answer)}`
				: answer.trim();
		const guarded = appendCaveats(formattedAnswer, visibleCaveats);
		return input.outputStyle === 'chat' ? cleanVisibleChatOutput(guarded, input.prompt) : guarded;
	}
	if (!evidence.length) {
		if (input.outputStyle === 'chat') return chatNoLead(unusableEvidence, input.limitations);
		return noPublishableLeadReport(unusableEvidence, input.limitations);
	}
	if (input.outputStyle === 'chat') {
		return chatAnswer(
			input.prompt,
			evidence,
			unusableEvidence,
			input.limitations,
			input.timeZone,
			input.researchContract
		);
	}

	const briefItems = evidence.map((item) => briefItemFor(item));
	const lead = leadParagraph(input.prompt, evidence, briefItems);
	const uncertaintyNotes = uncertaintyNotesFor(input.prompt, evidence, unusableEvidence);

	const ledger = normalizeGroundedEvidence(evidence);
	const reportBlocks: GroundedAnswerBlock[] = [
		{ kind: 'section', heading: 'Summary', level: 2 },
		{ kind: 'text', text: lead },
		{ kind: 'section', heading: 'Sources', level: 2 },
		...evidence.map((item) => ({
			kind: 'source' as const,
			title: sourceDisplayTitle(item, 90),
			url: item.source_url,
			detail: `${kindLabel(item)}; ${publicationDateLabel(item)}.${sourceNoteFor(item) ? ` ${sourceNoteFor(item)}` : ''}`
		})),
		...sourceIssueNotes(unusableEvidence, input.limitations).map((text) => ({ kind: 'text' as const, text })),
		{ kind: 'section', heading: 'Uncertainty', level: 2 },
		...uncertaintyNotes.map((text) => ({ kind: 'text' as const, text }))
	];
	return renderGroundedAnswer(groundedAnswerFromClaims([], reportBlocks), ledger);
}

interface MultiRequirementAnswerInput extends AnswerGenerationInput {
	requirements: ReturnType<typeof researchRequirementsForContract>;
	unusableEvidence: EvidenceObject[];
	storyClusters: EvidenceStoryCluster[];
}

/** Render independently requested deliverables as independent newsroom sections. */
function multiRequirementChatAnswer(input: MultiRequirementAnswerInput): string {
	const coverage = new Map((input.requirementCoverage || []).map((row) => [row.requirement_id, row]));
	const ledger = normalizeGroundedEvidence(input.evidence);
	const evidenceById = new Map(input.evidence.map((item) => [item.evidence_id || item.source_url, item]));
	const clustersById = new Map(input.storyClusters.map((cluster) => [cluster.id, cluster]));
	const blocks: GroundedAnswerBlock[] = [];
	const claims: GroundedClaim[] = [];
	for (const requirement of input.requirements) {
		const row = coverage.get(requirement.id);
		const laneEvidence = input.evidence
			.filter((item) => evidenceMatchesRequirementForAnswer(item, requirement))
			.sort((left, right) => evidenceTimestamp(right) - evidenceTimestamp(left));
		const selected: EvidenceObject[] = [];
		const seenStories = new Set<string>();
		for (const item of laneEvidence) {
			const storyKey = item.story_cluster_id || item.canonical_url || item.source_url;
			if (seenStories.has(storyKey)) continue;
			seenStories.add(storyKey);
			selected.push(item);
			if (selected.length >= requirement.requestedItemCount) break;
		}
		const requested = row?.requested_count || requirement.requestedItemCount;
		const accepted = row?.accepted_count ?? selected.length;
		const state = row?.state || (accepted >= requested ? 'satisfied' : accepted ? 'partial' : 'incomplete');
		const gaps = row?.gaps || (accepted < requested ? [`coverage is ${accepted} of ${requested} requested items`] : []);
		const status = coverageStatusLabel(state, accepted, requested, gaps);
		blocks.push({ kind: 'section', heading: requirement.label, level: 3 });
		blocks.push({ kind: 'text', text: `Coverage: ${status}` });
		for (const item of selected) {
			const cluster = item.story_cluster_id ? clustersById.get(item.story_cluster_id) : undefined;
			const corroboratingItems = (cluster?.corroborating_evidence_ids || [])
				.map((id) => evidenceById.get(id))
				.filter((candidate): candidate is EvidenceObject => Boolean(candidate) && candidate !== item);
			const title = sourceDisplayTitle(item, 150);
			const what = substantiveStorySummary(item);
			if (!what) continue;
			const when = item.event_at || item.updated_at || item.published_at;
			const sourceTime = when ? producerTimestamp(when, input.timeZone) : 'not found in readable source metadata';
			const evidenceSet = [item, ...corroboratingItems];
			const evidenceIds = evidenceSet
				.map((candidate) => evidenceIdentity(candidate, ledger))
				.filter((id): id is string => Boolean(id));
			const presentation: GroundedPresentation = {
				kind: 'bullet',
				leadingText: `${title} — What happened:`,
				leadingStrong: true,
				trailingLabel: 'Why it matters',
				trailingText: `${producerWhyItMatters(item)} Source time: ${sourceTime}.`
			};
			const candidate: GroundedClaim = {
				claimId: `requirement:${requirement.id}:${evidenceIdentity(item, ledger) || title}`,
				visibleText: what,
				evidenceIds,
				presentation
			};
			const claim = validateGroundedClaim(candidate, ledger)
				? candidate
				: groundedClaimFromEvidence(item, ledger, { presentation });
			if (!claim) continue;
			claims.push(claim);
			blocks.push({ kind: 'claim', claim });
		}
		if (!selected.length) {
			blocks.push({ kind: 'text', text: 'No readable, requirement-matched story evidence was available for this section.' });
		}
	}
	if (input.unusableEvidence.length) {
		blocks.push({ kind: 'text', text: 'Some attempted sources were blocked, unavailable, or unreadable and were not used as evidence.' });
	}
	return renderGroundedAnswer(groundedAnswerFromClaims(claims, blocks), ledger);
}

function evidenceMatchesRequirementForAnswer(
	item: EvidenceObject,
	requirement: ReturnType<typeof researchRequirementsForContract>[number]
): boolean {
	if (item.requirement_ids?.length) return item.requirement_ids.includes(requirement.id);
	if (!requirement.geography) return true;
	const location = item.location?.toLowerCase().trim();
	const geography = requirement.geography.toLowerCase().trim();
	if (location) return location === geography || location.includes(geography) || geography.includes(location);
	const text = `${item.title} ${item.summary} ${item.topic} ${item.source_url}`.toLowerCase();
	return text.includes(geography);
}

function coverageStatusLabel(
	state: string,
	accepted: number,
	requested: number,
	gaps: string[]
): string {
	const label = state === 'satisfied' ? 'Complete' : state === 'exhausted' ? 'Budget exhausted' : state === 'skipped' ? 'Skipped' : state === 'partial' ? 'Partial' : 'Incomplete';
	const gapText = gaps.length ? `; ${gaps.slice(0, 2).join('; ')}` : '';
	return `${label} — ${accepted}/${requested} requested item${requested === 1 ? '' : 's'}${gapText}`;
}

function substantiveStorySummary(item: EvidenceObject): string {
	if (/^https?:\/\//i.test(item.source_url) && item.direct_verified !== true) return '';
	const statement = producerStorySummary(item) || completeEvidenceStatement(item);
	const words = statement.match(/\b[\p{L}\p{N}][\p{L}\p{N}'’-]*\b/gu)?.length || 0;
	if (words >= 9) return statement;
	const title = sourceDisplayTitle(item, 150);
	const excerpt = compactText(item.summary || item.extracted_text || '', 240);
	if (excerpt && excerpt !== title) return `The readable source excerpt says “${excerpt}” but does not provide enough context for a fuller summary.`;
	return `The readable source identifies “${title},” but its available text is too thin for a fuller summary.`;
}

function chatAnswer(
	prompt: string,
	evidence: EvidenceObject[],
	unusableEvidence: EvidenceObject[],
	limitations: string[],
	timeZone?: string,
	researchContract?: ResearchRequestContract
): string {
	const documentEvidence = evidence.filter((item) => item.source_kind === 'user_document');
	const externalEvidence = evidence.filter((item) => item.source_kind !== 'user_document');
	// Provider/tool prose is not a sourced-answer authority. The visible answer
	// is always rendered from the normalized evidence ledger when evidence exists.
	const answer = documentEvidence.length && !externalEvidence.length
		? documentChatAnswer(documentEvidence, prompt)
		: groundedEvidenceChatAnswer(
				prompt,
				externalEvidence.length ? externalEvidence : evidence,
				timeZone,
				externalEvidence.length ? documentEvidence : [],
				researchContract
			);
	const caveats = publicCaveatsFor(prompt, evidence, unusableEvidence, limitations, { noUsableEvidence: false });
	const publicationDate = publicationDateAnswer(prompt, evidence);
	return appendCaveats([answer, publicationDate].filter(Boolean).join('\n\n'), caveats);
}

function publicationDateAnswer(prompt: string, evidence: EvidenceObject[]): string {
	if (!/\b(?:when (?:was|were) .*published|publication date|published when)\b/i.test(prompt)) return '';
	const dated = evidence.find((item) => item.published_at);
	return dated ? `Publication date: ${dated.published_at}.` : 'Publication date: Date unknown.';
}

function groundedEvidenceChatAnswer(
	prompt: string,
	evidence: EvidenceObject[],
	timeZone?: string,
	documentEvidence: EvidenceObject[] = [],
	researchContract?: ResearchRequestContract
): string {
	const conflict = /\b(?:verify|fact[- ]?check|confirm|is it true|status|active|in effect)\b/i.test(prompt)
		? conflictingEvidenceStatement(evidence)
		: '';
	if (conflict) return conflict;

	const producerBriefing = isProducerRoundupPrompt(prompt, researchContract);
	const allEvidence = [...evidence, ...documentEvidence];
	const ledger = normalizeGroundedEvidence(allEvidence);
	const currentRequest =
		isCurrentResearchAssignment(prompt, researchContract) || /\b(?:recent|new)\b/i.test(prompt);
	// The final renderer is also a safety boundary for callers that bypass the
	// normal preparePublishableEvidence pass. Current answers must not promote
	// readable-but-undated or unverified external candidates, even when a legacy
	// record incorrectly labels one as primary.
	const publishableEvidence = currentRequest
		? evidence.filter((item) => {
			const timestamp = item.event_at || item.updated_at || item.published_at;
			const externallyVerified =
				!/^https?:\/\//i.test(item.source_url) || item.direct_verified === true;
			return Boolean(timestamp) &&
				externallyVerified &&
				(item.temporal_scope === 'primary' || item.temporal_scope === 'fallback');
		})
		: evidence;
	const selected = producerRoundupSelection(prompt, publishableEvidence, researchContract).slice(0, 6);
	const claims = selected.flatMap((item) => {
		const statement = producerBriefing ? producerStorySummary(item) : completeEvidenceStatement(item);
		if (!statement) return [];
		const date = item.event_at || item.updated_at || item.published_at;
		const dateLabel = date ? producerTimestamp(date, timeZone) : '';
		const fallback = item.temporal_scope === 'fallback' ? 'Earlier (last 24 hours)' : '';
		const leadingText = [fallback, dateLabel].filter(Boolean).join(' — ');
		const title = producerBriefing ? sourceDisplayTitle(item, 150) : '';
		const prefix = producerBriefing
			? [leadingText, title ? `${title} — What happened:` : 'What happened:'].filter(Boolean).join(': ')
			: '';
		const sourceTime = date ? producerTimestamp(date, timeZone) : 'not found in readable source metadata';
		const trailingText = [
			producerBriefing ? `${producerWhyItMatters(item)} Source time: ${sourceTime}.` : '',
			wantsDirectUrls(prompt) ? item.source_url : ''
		]
			.filter(Boolean)
			.join(' ');
		const presentation: GroundedPresentation = {
			kind: producerBriefing || selected.length > 1 ? 'bullet' : 'paragraph',
			...(prefix ? { leadingText: prefix, leadingStrong: producerBriefing } : {}),
			...(producerBriefing
				? { trailingLabel: 'Why it matters', trailingText }
				: {}),
			...(!producerBriefing && wantsDirectUrls(prompt) ? { trailingText: item.source_url } : {})
		};
		const claim = groundedClaimFromEvidence(item, ledger, { presentation });
		return claim ? [claim] : [];
	});
	const documentClaims = documentEvidence.flatMap((item) => {
		const claim = groundedClaimFromEvidence(item, ledger, { presentation: { kind: 'bullet' } });
		return claim ? [claim] : [];
	});
	if (!claims.length && !documentClaims.length) {
		return "I couldn't verify a complete claim from the remaining topic- and date-matched source text.";
	}
	const allClaims = [...claims, ...documentClaims];
	const blocks: GroundedAnswerBlock[] = [];
	if (producerBriefing && claims.length) {
		blocks.push({ kind: 'section', heading: producerSectionHeading(prompt), level: 2 });
		blocks.push(...claims.map((claim) => ({ kind: 'claim' as const, claim })));
		if (claims.length < 5) {
			blocks.push({
				kind: 'text',
				text: `Coverage is incomplete; I found ${claims.length} distinct same-day item${claims.length === 1 ? '' : 's'} that met the source and freshness requirements.`
			});
		}
	} else if (!producerBriefing && claims.length > 1) {
		blocks.push({ kind: 'section', heading: 'Latest producer roundup', level: 2 });
		blocks.push(...claims.map((claim) => ({ kind: 'claim' as const, claim })));
	} else if (claims.length === 1) {
		blocks.push({ kind: 'claim', claim: claims[0] });
	}
	if (documentClaims.length) {
		blocks.push({ kind: 'section', heading: 'Attached document evidence', level: 2 });
		blocks.push(...documentClaims.map((claim) => ({ kind: 'claim' as const, claim })));
	}
	return renderGroundedAnswer(groundedAnswerFromClaims(allClaims, blocks), ledger);
}

function producerRoundupSelection(
	prompt: string,
	evidence: EvidenceObject[],
	researchContract?: ResearchRequestContract
): EvidenceObject[] {
	if (!isProducerRoundupPrompt(prompt, researchContract)) {
		return evidence;
	}
	const rank = (items: EvidenceObject[]) => [...items].sort((left, right) => {
		const recency = evidenceTimestamp(right) - evidenceTimestamp(left);
		if (recency) return recency;
		return editorialConsequenceScore(right) - editorialConsequenceScore(left);
	});
	const sameDayRequired = requiresSameDayEvidence(prompt);
	const primary = evidence.filter((item) => {
		if (item.temporal_scope === 'fallback' || item.temporal_scope === 'background') return false;
		// A live or official page without a publication/update time can be useful
		// context, but it cannot satisfy an explicit same-day producer assignment.
		// The temporal guard marks verified in-window evidence as primary.
		if (sameDayRequired) return item.temporal_scope === 'primary' && evidenceTimestamp(item) > 0;
		return true;
	});
	const fallback = evidence.filter((item) => !primary.includes(item));
	const strongPrimary = rank(primary.filter((item) => editorialConsequenceScore(item) >= 0));
	const selected: EvidenceObject[] = [];
	const publisherCounts = new Map<string, number>();
	const addUnique = (item: EvidenceObject, publisherLimit?: number): boolean => {
		if (selected.some((existing) => sameProducerStory(existing, item))) return false;
		const publisher = evidencePublisherKey(item);
		if (publisherLimit && (publisherCounts.get(publisher) || 0) >= publisherLimit) return false;
		selected.push(item);
		publisherCounts.set(publisher, (publisherCounts.get(publisher) || 0) + 1);
		return true;
	};
	for (const item of strongPrimary) {
		addUnique(item, 2);
		if (selected.length >= 6) break;
	}
	if (selected.length < 6) {
		for (const item of strongPrimary) {
			addUnique(item);
			if (selected.length >= 6) break;
		}
	}
	if (selected.length < 5 && !sameDayRequired) {
		for (const item of rank(fallback).filter((candidate) => editorialConsequenceScore(candidate) >= 0)) {
			addUnique(item);
			if (selected.length >= 5) break;
		}
	}
	return selected.sort((left, right) => evidenceTimestamp(right) - evidenceTimestamp(left));
}

export function isProducerRoundupPrompt(
	prompt: string,
	contract?: Pick<ResearchRequestContract, 'outputType'>
): boolean {
	if (contract?.outputType === 'producer_roundup' || contract?.outputType === 'story_list') return true;
	const explicitProducerRequest = /\b(?:briefing|roundup|headlines|top stories|latest .*news|assignment desk|newsroom producer|story ideas?|news ideas?|pitches?|reporting angles?|assignment ideas?)\b/i.test(prompt);
	if (explicitProducerRequest) return true;
	return /\bfollow[- ]?ups?\b/i.test(prompt) && /\b(?:news|story|stories|report|reporting|reporter|headline|assignment|pitch|angle|coverage|producer|newsroom)\b/i.test(prompt);
}

function producerSectionHeading(prompt: string): string {
	return /\b(?:story ideas?|news ideas?|pitches?|reporting angles?|assignment ideas?)\b/i.test(prompt)
		? 'Story ideas'
		: 'Latest producer roundup';
}

function evidencePublisherKey(item: EvidenceObject): string {
	const publisher = item.publisher || item.source_name;
	if (publisher?.trim()) return publisher.trim().toLowerCase();
	try {
		return new URL(item.source_url).hostname.replace(/^www\./, '').toLowerCase();
	} catch {
		return item.source_url.toLowerCase();
	}
}

function sameProducerStory(left: EvidenceObject, right: EvidenceObject): boolean {
	if (
		left === right ||
		(left.canonical_url && right.canonical_url && left.canonical_url === right.canonical_url) ||
		(left.source_url && right.source_url && left.source_url === right.source_url)
	) {
		return true;
	}
	const leftTerms = producerStoryTerms(left.title);
	const rightTerms = producerStoryTerms(right.title);
	if (!leftTerms.size || !rightTerms.size) return false;
	const overlap = [...leftTerms].filter((term) => rightTerms.has(term)).length;
	return overlap >= 3 && overlap / Math.min(leftTerms.size, rightTerms.size) >= 1 / 3;
}

function producerStoryTerms(value: string): Set<string> {
	const ignored = new Set([
		'against', 'after', 'allegedly', 'following', 'from', 'into', 'latest', 'local',
		'man', 'news', 'over', 'suspected', 'the', 'three', 'toronto', 'with'
	]);
	return new Set(
		(value.toLowerCase().match(/[a-z0-9]{3,}/g) || [])
			.filter((term) => !ignored.has(term))
	);
}

function requiresSameDayEvidence(prompt: string): boolean {
	return /\b(?:same[- ]day|today|tonight)\b|\bfor\s+[A-Z][a-z]{2,8}\s+\d{1,2},\s+20\d{2}\b/i.test(prompt);
}

function producerTimestamp(value: string, timeZone?: string): string {
	const parsed = new Date(value);
	if (!Number.isFinite(parsed.getTime())) return value;
	try {
		return new Intl.DateTimeFormat('en-CA', {
			year: 'numeric',
			month: 'short',
			day: 'numeric',
			hour: 'numeric',
			minute: '2-digit',
			timeZone: timeZone || 'UTC',
			timeZoneName: 'short'
		}).format(parsed);
	} catch {
		return parsed.toISOString();
	}
}

/**
 * Producer items need readable page prose, not a provider's URL annotation,
 * section label, or search-result title. Keep the selection upstream of the
 * renderer and require direct verification for external pages.
 */
function producerStorySummary(item: EvidenceObject): string {
	if (/^https?:\/\//i.test(item.source_url) && item.direct_verified !== true) return '';
	for (const candidate of [item.summary, item.extracted_text, item.supporting_excerpt]) {
		const cleaned = compactText(candidate || '', 720);
		if (!cleaned) continue;
		const sentences = cleaned
			.split(/(?<=[.!?])\s+/)
			.map((sentence) => sentence.trim())
			.filter(Boolean)
			.slice(0, 3);
		const summary = sentences.join(' ');
		const words = summary.match(/\b[\p{L}\p{N}][\p{L}\p{N}'’-]*\b/gu)?.length || 0;
		if (words >= 9) return summary;
	}
	return '';
}

function producerWhyItMatters(item: EvidenceObject): string {
	const text = `${item.title} ${item.summary} ${item.extracted_text}`.toLowerCase();
	if (/\b(?:weather|rainfall|storm|flood|heat|snow|warning)\b/.test(text)) {
		return 'It can affect public safety, travel and near-term newsroom planning.';
	}
	if (/\b(?:transit|ttc|streetcar|subway|bus|rail|traffic|road)\b/.test(text)) {
		return 'It has immediate implications for transportation safety or service.';
	}
	if (/\b(?:health|hospital|virus|injur|doctor|patient|medical)\b/.test(text)) {
		return 'It signals a public-health or injury trend with direct local impact.';
	}
	if (/\b(?:housing|supportive homes|shelter|rent|homeless)\b/.test(text)) {
		return 'It affects housing access and the delivery of essential city services.';
	}
	if (/\b(?:charged|arrest|assault|shoot|stabb|hate|police|court|investigat)\b/.test(text)) {
		return 'It is a public-safety story with potential community and accountability follow-up.';
	}
	if (/\b(?:council|government|mayor|minister|policy|budget|infrastructure|education|school)\b/.test(text)) {
		return 'It could change public services, spending or daily life in the city.';
	}
	return 'It is a consequential local development worth assignment-desk follow-up.';
}

function editorialConsequenceScore(item: EvidenceObject): number {
	const text = `${item.title} ${item.summary} ${item.extracted_text}`.toLowerCase();
	let score = (item.source_authority || 0.5) * 2;
	if (/\b(?:emergency|warning|evacuat|outage|fire|shoot|stabb|killed|death|injur|hospital|charged|arrest|investigat|court|fraud|assault|public safety)\b/i.test(text)) score += 3;
	if (/\b(?:council|government|mayor|minister|policy|budget|election|housing|transit|health|education|business|economy|infrastructure|strike|weather statement)\b/i.test(text)) score += 2;
	if (/\b(?:puppy|pet adoption|cute as|horoscope|recipe|celebrity|lottery|contest|gift guide)\b/i.test(text)) score -= 4;
	return score;
}

function evidenceTimestamp(item: EvidenceObject): number {
	return Date.parse(item.event_at || item.updated_at || item.published_at || '') || 0;
}

function conflictingEvidenceStatement(evidence: EvidenceObject[]): string {
	if (evidence.length < 2) return '';
	const negative = evidence.find((item) =>
		/\b(?:no|not|never|denied|disputed|false|incorrect|did not|has not|have not|cannot|can't)\b/i.test(
			`${item.summary} ${item.extracted_text}`
		)
	);
	const affirmative = evidence.find(
		(item) =>
			item !== negative &&
			!/\b(?:no|not|never|denied|disputed|false|incorrect|did not|has not|have not|cannot|can't)\b/i.test(
				`${item.summary} ${item.extracted_text}`
			)
	);
	if (!negative || !affirmative) return '';
	const ledger = normalizeGroundedEvidence(evidence);
	const affirmativeClaim = groundedClaimFromEvidence(affirmative, ledger, {
		presentation: { kind: 'bullet' }
	});
	const negativeClaim = groundedClaimFromEvidence(negative, ledger, {
		presentation: { kind: 'bullet' }
	});
	if (!negativeClaim || !affirmativeClaim) return '';
	return renderGroundedAnswer(
		groundedAnswerFromClaims([affirmativeClaim, negativeClaim], [
			{ kind: 'text', text: '**The available sources conflict, so this remains uncertain.**' },
			{ kind: 'claim', claim: affirmativeClaim },
			{ kind: 'claim', claim: negativeClaim }
		]),
		ledger
	);
}

function withImplicitCitationNumbers(evidence: EvidenceObject[]): EvidenceObject[] {
	normalizeGroundedEvidence(evidence);
	return evidence;
}

function documentChatAnswer(evidence: EvidenceObject[], prompt: string): string {
	const requestedCount = requestedListCount(prompt);
	const limit = requestedCount >= 9 ? Math.min(12, requestedCount) : 6;
	const ledger = normalizeGroundedEvidence(evidence);
	const claims = ledger.evidence.slice(0, limit).flatMap((item) => {
		const claim = groundedClaimFromEvidence(item, ledger, {
			presentation: { kind: limit === 1 ? 'paragraph' : 'bullet' }
		});
		return claim ? [claim] : [];
	});
	const blocks: GroundedAnswerBlock[] = [];
	if (claims.length > 1) blocks.push({ kind: 'section', heading: 'Document summary', level: 2 });
	blocks.push(...claims.map((claim) => ({ kind: 'claim' as const, claim })));
	return renderGroundedAnswer(groundedAnswerFromClaims(claims, blocks), ledger);
}

function requestedListCount(prompt: string): number {
	const words: Record<string, number> = { nine: 9, ten: 10, eleven: 11, twelve: 12 };
	const match = prompt.match(/\b(nine|ten|eleven|twelve|1[0-2])\b/i);
	if (!match) return 0;
	return words[match[1].toLowerCase()] || Number(match[1]) || 0;
}

function formatChatToolAnswer(prompt: string, answer: string): string {
	return cleanVisibleChatOutput(answer, prompt);
}

function chatToolAnswerCaveats(prompt: string, caveats: string[]): string[] {
	if (needsExplicitVerificationCaveat(prompt)) {
		return caveats.map((item) =>
			/^I couldn't verify this from readable sources right now\.$/i.test(item)
				? 'This lead is not backed by readable source evidence yet.'
				: item
		);
	}
	return caveats.filter(
		(item) =>
			!/^I could not find reliable sources confirming this\b/i.test(item) &&
			!/^I couldn't verify this from readable sources\b/i.test(item)
	);
}

export function cleanVisibleChatOutput(answer: string, prompt = ''): string {
	const cleaned = softenUnsupportedScheduleAbsence(
		cleanChatToolAnswer(answer, { preserveUrls: wantsDirectUrls(prompt) }),
		prompt
	);
	if (wantsTable(prompt)) return compactChatText(cleaned, 8000);
	return polishedChatText(cleaned, 8000);
}

function softenUnsupportedScheduleAbsence(value: string, prompt: string): string {
	if (!/\b(?:schedule|scheduled|fixture|fixtures|games?|matches?)\b/i.test(prompt)) return value;
	return value
		.replace(
			/\bThere are no ([^.]*?\b(?:games?|matches?|fixtures?)\b[^.]*?) scheduled\b/gi,
			'I found no $1 listed as scheduled'
		)
		.replace(/\b(?:show|shows|showed) no fixtures\b/gi, 'did not show any fixtures');
}

export function draftNewsroomOcvoFromConversation(
	prompt: string,
	context: ConversationContext | undefined
): string | null {
	if (context?.intent !== 'transform' || !context.lastSourceBackedAnswer || !wantsNewsroomOcvo(prompt)) {
		return null;
	}
	const resolvableCitationNumbers = new Set(
		context.lastSourceBackedAnswer.citations.map((citation) => citation.citationNumber)
	);
	const sourceAnswer = stripUnresolvedCitationMarkers(
		sanitizeOcvoSourceText(context.lastSourceBackedAnswer.content),
		resolvableCitationNumbers
	);
	if (!sourceAnswer) return null;
	const sentences = splitScriptSentences(sourceAnswer);
	const scriptSentences = selectCitationPreservingScriptSentences(
		sentences.length ? sentences : [sourceAnswer],
		resolvableCitationNumbers
	);
	const scriptLines = dedupeVisibleCitationMarkers(scriptSentences, resolvableCitationNumbers)
		.map((sentence, index) => scriptLine(sentence, index === 0 ? 260 : 280, resolvableCitationNumbers))
		.filter(Boolean);
	const fallbackVo = nonClaimVoFallback();
	const fallbackWords = wordCount(fallbackVo);
	const scriptBudget = requestedOcvoWordBudget(prompt);
	const reserveFallback = scriptLines.length <= 1 ? fallbackWords : 0;
	const boundedScriptLines = limitScriptLinesToWordBudget(
		scriptLines.length ? scriptLines : [scriptLine(sourceAnswer, 260, resolvableCitationNumbers)],
		Math.max(1, scriptBudget - reserveFallback)
	);
	const onCam = boundedScriptLines[0] || scriptLine(sourceAnswer, 260, resolvableCitationNumbers);
	const vo = uniqueScriptLines(boundedScriptLines.slice(1), onCam);
	if (!vo.length) vo.push(fallbackVo);
	const tease = wantsTease(prompt) ? teaseTextForContext(context) : '';
	const banner = excludesBanner(prompt) ? '' : bannerTextForContext(context, sourceAnswer);
	return [
		...(tease ? ['TEASE:', tease, ''] : []),
		'ON CAM:',
		onCam,
		'',
		'VO:',
		...vo,
		...(banner ? ['', 'BANNER:', banner] : [])
	].join('\n');
}

function wantsNewsroomOcvo(prompt: string): boolean {
	return /\b(?:ocvo|oc\/vo|on[- ]?cam(?:era)?|voice[- ]?over|vo|script)\b/i.test(prompt);
}

function wantsTease(prompt: string): boolean {
	return /\btease\b/i.test(prompt);
}

function excludesBanner(prompt: string): boolean {
	return /\b(?:no|without)\s+(?:a\s+)?banner\b/i.test(prompt) ||
		/\bdo not (?:add|include|write)\s+(?:a\s+)?banner\b/i.test(prompt);
}

function teaseTextForContext(context: ConversationContext): string {
	const topic = context.activeTopic;
	const subject = compactText(topic?.subject || 'this developing story', 96)
		.replace(/\[\d+\]/g, '')
		.replace(/[.!?]$/, '');
	return ensureTerminalPunctuation(`What the latest confirmed evidence says about ${subject}`);
}

function sanitizeOcvoSourceText(value: string): string {
	const withoutSections = cleanChatToolAnswer(value)
		.replace(/\[(?:Sources?|End|END|source list|source)\]/gi, ' ')
		.replace(/(?:^|\n)\s*(?:ON\s*CAM|ONCAM|VO|V\/O|BANNER|SUPER)\s*:?\s*/gi, '\n')
		.replace(/\b(?:ON\s*CAM|ONCAM)\s*:\s*(?=\S)/gi, '\n')
		.replace(/\b(?:V\/O|VO)\s*:\s*(?=\S)/gi, '\n')
		.replace(/\bBANNER\s*:\s*(?=\S)/gi, '\n')
		.replace(
			/(?:^|\n)\s*.*\b(?:openai|perplexity|web_search|tool call|provider|http\s*\d{3}|status code|api key|model)\b.*$/gim,
			'\n'
		)
		.replace(/(?:^|\n)\s*(?:version|take)\s+\d+\s*:?\s*/gi, '\n')
		.replace(/\b(?:If you(?:'|’)d like|Would you like|Do you want)\b[\s\S]*$/i, '')
		.replace(/\s+/g, ' ')
		.trim();
	return withoutSections.replace(/\s+([,.;:!?])/g, '$1');
}

function splitScriptSentences(value: string): string[] {
	const protectedText = value
		.replace(/\[(\d+)\]/g, '{{$1}}')
		.replace(/\b([ap])\.m\./gi, (_, period: string) => `{{${period.toLowerCase()}m}}`);
	return protectedText
		.split(/(?<=[.!?])\s+/)
		.map((sentence) =>
			sentence
				.replace(/\{\{(\d+)\}\}/g, '[$1]')
				.replace(/\{\{([ap])m\}\}/g, '$1.m.')
				.trim()
		)
		.filter((sentence) => sentence.length >= 8);
}

export function directCitationLinksFromConversation(
	prompt: string,
	context: ConversationContext | undefined
): string | null {
	if (!context?.lastSourceBackedAnswer || !wantsDirectUrls(prompt)) return null;
	const citations = context.lastSourceBackedAnswer.citations;
	if (!citations.length) return 'No resolved citation links are available in the selected answer.';
	return citations.map((citation) => `${citation.citationNumber}. ${citation.url}`).join('\n');
}

function selectCitationPreservingScriptSentences(sentences: string[], citationNumbers: Set<number>): string[] {
	const targetNumbers = new Set(
		sentences.flatMap((sentence) => citationMarkersInText(sentence).filter((number) => citationNumbers.has(number)))
	);
	if (!targetNumbers.size) return uniqueScriptLines(sentences, '').slice(0, 4);

	const selected: string[] = [];
	const covered = new Set<number>();
	for (const sentence of sentences) {
		const markers = citationMarkersInText(sentence).filter((number) => targetNumbers.has(number));
		if (!markers.some((number) => !covered.has(number))) continue;
		selected.push(sentence);
		for (const marker of markers) covered.add(marker);
		if (covered.size === targetNumbers.size) break;
	}
	return selected.length ? selected : uniqueScriptLines(sentences, '').slice(0, 4);
}

function dedupeVisibleCitationMarkers(sentences: string[], citationNumbers: Set<number>): string[] {
	const seen = new Set<number>();
	return sentences
		.map((sentence) =>
			sentence
				.replace(/\[(\d+)\]/g, (marker, rawNumber: string) => {
					const number = Number(rawNumber);
					if (!citationNumbers.has(number) || seen.has(number)) return '';
					seen.add(number);
					return marker;
				})
				.replace(/\s+([,.;:!?])/g, '$1')
				.replace(/\s{2,}/g, ' ')
				.trim()
		)
		.filter(Boolean);
}

function stripUnresolvedCitationMarkers(value: string, citationNumbers: Set<number>): string {
	return value
		.replace(/\[(\d+)\]/g, (marker, rawNumber: string) =>
			citationNumbers.has(Number(rawNumber)) ? marker : ''
		)
		.replace(/\s+([,.;:!?])/g, '$1')
		.replace(/\s{2,}/g, ' ')
		.trim();
}

function nonClaimVoFallback(): string {
	return 'No additional sourced VO detail is confirmed in the selected answer.';
}

function requestedOcvoWordBudget(prompt: string): number {
	const match = prompt.match(
		/\b(\d{1,3})\s*(?:-|\s)?\s*seconds?\s+(?:oc\s*\/?\s*vo|voice[- ]?over|script)\b/i
	);
	const seconds = match ? Number(match[1]) : 30;
	return Math.max(20, Math.min(180, Math.floor(seconds * 2.5)));
}

function limitScriptLinesToWordBudget(lines: string[], budget: number): string[] {
	const selected: string[] = [];
	let used = 0;
	for (const line of lines) {
		const words = wordCount(line);
		if (selected.length && used + words > budget) continue;
		const fitted = words > budget - used ? fitScriptLineToWordBudget(line, budget - used) : line;
		if (!fitted) continue;
		selected.push(fitted);
		used += wordCount(fitted);
		if (used >= budget) break;
	}
	return selected;
}

function fitScriptLineToWordBudget(line: string, budget: number): string {
	if (budget <= 0) return '';
	const markers = Array.from(line.matchAll(/\[(\d+)\]/g), (match) => match[0]);
	const prose = line.replace(/\s*\[\d+\]/g, '').trim();
	const words = prose.split(/\s+/).filter(Boolean);
	const proseBudget = Math.max(1, budget - markers.length);
	const shortened = words.length > proseBudget ? `${words.slice(0, proseBudget).join(' ')}…` : prose;
	return ensureTerminalPunctuation(`${shortened}${markers.length ? ` ${markers.join(' ')}` : ''}`);
}

function wordCount(value: string): number {
	return value.match(/\b[\p{L}\p{N}][\p{L}\p{N}'’.-]*\b/gu)?.length ?? 0;
}

export function citationMarkersInText(value: string): number[] {
	return Array.from(value.matchAll(/\[(\d+)\](?!\()/g), (match) => Number(match[1])).filter(
		(number) => Number.isInteger(number) && number > 0
	);
}

function uniqueScriptLines(sentences: string[], existing: string): string[] {
	const seen = new Set([normalizeComparable(existing)]);
	const result: string[] = [];
	for (const sentence of sentences) {
		const key = normalizeComparable(sentence);
		if (!key || seen.has(key)) continue;
		seen.add(key);
		result.push(sentence);
	}
	return result;
}

function scriptLine(value: string, maxLength: number, citationNumbers?: Set<number>): string {
	const uncitedFallback = () => ensureTerminalPunctuation(compactText(value, maxLength).replace(/^[-*]\s*/, '').trim());
	const cleaned = compactText(value, Number.MAX_SAFE_INTEGER).replace(/^[-*]\s*/, '').trim();
	const markers = citationNumbers ? uniqueResolvableCitationMarkers(cleaned, citationNumbers) : [];
	if (!markers.length) return uncitedFallback();
	return ensureTerminalPunctuation(shortenCitationBearingScriptLine(cleaned, maxLength, markers));
}

function shortenCitationBearingScriptLine(value: string, maxLength: number, markers: number[]): string {
	const cleaned = collapseScriptWhitespace(value);
	const markerLabels = markers.map((number) => `[${number}]`);
	const markerSuffix = ` ${markerLabels.join(' ')}`;
	if (cleaned.length <= maxLength && markerLabels.every((marker) => cleaned.includes(marker))) {
		return cleaned;
	}
	const suffix = `${markerSuffix}.`;
	const proseBudget = Math.max(0, maxLength - suffix.length);
	const markerlessProse = collapseScriptWhitespace(cleaned.replace(/\s*\[\d+\]/g, ''));
	const shortenedProse = compactCitationProse(markerlessProse, proseBudget).replace(/[.!?]$/, '');
	return `${shortenedProse}${suffix}`.trim();
}

function uniqueResolvableCitationMarkers(value: string, citationNumbers: Set<number>): number[] {
	const seen = new Set<number>();
	const markers: number[] = [];
	for (const number of citationMarkersInText(value)) {
		if (!citationNumbers.has(number) || seen.has(number)) continue;
		seen.add(number);
		markers.push(number);
	}
	return markers;
}

function compactCitationProse(value: string, maxLength: number): string {
	const cleaned = collapseScriptWhitespace(value);
	if (maxLength <= 0) return '';
	if (cleaned.length <= maxLength) return cleaned;
	if (maxLength === 1) return '…';
	return `${cleaned.slice(0, maxLength - 1).trim()}…`;
}

function collapseScriptWhitespace(value: string): string {
	return value
		.replace(/\s+([,.;:!?])/g, '$1')
		.replace(/\s{2,}/g, ' ')
		.trim();
}

function ensureTerminalPunctuation(value: string): string {
	if (!value) return value;
	return /[.!?。！？]\s*(?:\[\d+\])?$/.test(value) ? value : `${value}.`;
}

function bannerTextForContext(context: ConversationContext, sourceAnswer: string): string {
	const candidates = [
		context.activeTopic?.location && context.activeTopic.subject
			? `${context.activeTopic.location}: ${context.activeTopic.subject}`
			: '',
		context.activeTopic?.subject || '',
		sourceAnswer
	];
	const candidate = candidates.find((item) => item.trim()) || '';
	return compactText(candidate.replace(/\[\d+\]/g, ''), 64).replace(/[.!?]$/, '');
}

function wantsTable(prompt: string): boolean {
	return /\b(table|tabular|rows?|columns?)\b/i.test(prompt);
}

function wantsDirectUrls(prompt: string): boolean {
	return /\b(?:exact|direct|raw)(?:\s+direct)?\s+(?:links?|urls?)\b/i.test(prompt) ||
		/\bdirect\s+(?:article(?:\s+or\s+official)?|official)\s+(?:links?|urls?)\b/i.test(prompt) ||
		/\b(?:give|show|list|include)\b[\s\S]{0,40}\b(?:links?|urls?)\b/i.test(prompt);
}

function chatNoLead(unusableEvidence: EvidenceObject[], limitations: string[] = []): string {
	const notes = sourceIssueNotes(unusableEvidence).slice(0, 3);
	const caveats = publicCaveatsFor('', [], unusableEvidence, limitations, { noUsableEvidence: true });
	return [
		...(caveats.length ? caveats : ["I couldn't verify this from readable sources right now."]),
		...notes
	]
		.filter(Boolean)
		.join('\n');
}

function answerFromMemory(prompt: string): string {
	const normalized = prompt.toLowerCase().replace(/^(?:user|assistant|system):\s*/, '').trim();
	if (/^(hi|hello|hey|yo|sup|good morning|good afternoon|good evening|howdy|hiya)[!.? ]*$/.test(normalized)) {
		return 'Hi. What should NewsCraft work on?';
	}
	if (/\bnut graf\b/.test(normalized)) {
		return 'A nut graf is the early paragraph that tells the audience what the story is really about and why it matters. It should clarify the stakes, context, and reason to keep reading without overstating facts.';
	}
	if (/\bproducer brief|newsroom brief\b/.test(normalized)) {
		return 'A producer-ready brief should state what happened, what is new, why it matters, what is confirmed, what still needs checking, and which sources support each point.';
	}
	return 'This appears to be stable newsroom guidance rather than a live-source request. I would answer from established practice, and I would not claim to have checked current sources unless a tool run is routed.';
}

function directAnswerFallback(prompt: string): string {
	const normalized = prompt.toLowerCase().replace(/\s+/g, ' ').trim();
	if (/\b(headline|hed)\b/.test(normalized)) {
		return [
			'Here are a few newsroom-safe headline directions:',
			'- Lead with the clearest confirmed action or decision.',
			'- Keep attribution visible if the claim is not independently verified.',
			'- Avoid implying certainty beyond the material provided.'
		].join('\n');
	}
	if (/\b(plan|outline|brainstorm|pitch)\b/.test(normalized)) {
		return [
			'Here is a compact way to structure it:',
			'1. Define the audience and the decision they need to make.',
			'2. Separate confirmed facts, open questions, and assumptions.',
			'3. Pick the strongest angle, then list the reporting or production steps needed to support it.'
		].join('\n');
	}
	if (/\b(rewrite|edit|polish|tighten|make this clearer)\b/.test(normalized)) {
		return 'I can help rewrite it. Send the text and the target tone, length, and audience.';
	}
	return [
		'I can help with that directly.',
		'For anything factual, current, or source-backed, ask me to check sources and I will route it through research.'
	].join('\n\n');
}

interface BriefItem {
	evidence: EvidenceObject;
	title: string;
	source: string;
	detail: string;
}

function leadParagraph(prompt: string, evidence: EvidenceObject[], briefItems: BriefItem[]): string {
	const official = evidence.filter((item) => item.source_kind === 'official' || item.source_kind === 'primary');
	const media = evidence.filter(
		(item) => item.source_kind === 'media_report' || item.source_kind === 'news_report'
	);
	const newest = evidence[0];
	const itemCount = briefItems.length;
	const base =
		itemCount > 1
			? `This research update found ${itemCount} usable source${itemCount === 1 ? '' : 's'}. The strongest source material is listed below with attribution.`
			: `This research update found one usable source: ${briefItems[0]?.title || sourceDisplayTitle(newest, 120)}.`;
	const latestFraming = latestAvailableFraming(prompt, newest);
	const sourceFraming =
		official.length && media.length
			? `The gathered evidence includes ${official.length} official or primary source${official.length === 1 ? '' : 's'} and ${media.length} media report${media.length === 1 ? '' : 's'}.`
			: official.length
				? `The gathered evidence is led by official or primary source material.`
				: media.length
					? `The gathered evidence is based on media reports and should be checked against primary-source material before you rely on it.`
					: `The gathered evidence should be treated as preliminary.`;
	const changed = /\b(latest|new|changed|update|today|recent)\b/i.test(prompt)
		? ` Latest source material is listed below.`
		: '';
	return `${base}\n\n${[latestFraming, sourceFraming].filter(Boolean).join(' ')}${changed}`;
}

function uncertaintyNotesFor(prompt: string, evidence: EvidenceObject[], unusableEvidence: EvidenceObject[]): string[] {
	const notes: string[] = [];
	const officialCount = evidence.filter((item) => item.source_kind === 'official' || item.source_kind === 'primary').length;
	const mediaCount = evidence.filter(
		(item) => item.source_kind === 'media_report' || item.source_kind === 'news_report'
	).length;
	if (officialCount) notes.push(`- Official or primary source material is available: ${officialCount}.`);
	if (mediaCount) notes.push(`- Secondary or media source material is available: ${mediaCount}; attribute outlet reporting separately from official statements.`);
	if (detectPoliceLegalTask(prompt)) {
		notes.push(
			'- Police/legal caution: distinguish allegations, arrests, charges, and convictions. Do not imply guilt unless a conviction is documented.'
		);
	}
	const conflicts = detectConflicts(evidence);
	notes.push(
		conflicts.length
			? `- Potential conflicts to resolve: ${conflicts.join('; ')}.`
			: '- No conflicting claims were apparent in the usable source notes.'
	);
	if (unusableEvidence.length) notes.push('- Some configured sources could not be read and were not used as evidence.');
	return notes.length ? notes : ['- No additional uncertainty notes were generated.'];
}

function detectPoliceLegalTask(prompt: string): boolean {
	return /\b(police|court|arrest|charged|charges|convicted|conviction|alleged|suspect|victim|public safety)\b/i.test(
		prompt
	);
}

function detectConflicts(evidence: EvidenceObject[]): string[] {
	const combined = evidence.map((item) => `${item.title} ${item.summary}`).join(' ').toLowerCase();
	const conflicts: string[] = [];
	if (combined.includes('denied') && combined.includes('confirmed')) conflicts.push('confirmed and denied claims both appear');
	if (combined.includes('no injuries') && combined.includes('injuries')) conflicts.push('injury details may differ');
	return conflicts;
}

function sortEvidenceForPrompt(prompt: string, evidence: EvidenceObject[]): EvidenceObject[] {
	const currentRequest = /\b(latest|today|new|recent|breaking|current|update|updates)\b/i.test(prompt);
	return [...evidence].sort((left, right) =>
		currentRequest ? compareEvidenceRecency(left, right) : compareEvidencePriority(left, right)
	);
}

function compareEvidenceRecency(left: EvidenceObject, right: EvidenceObject): number {
	const leftTime = evidenceTimeMs(left);
	const rightTime = evidenceTimeMs(right);
	if (leftTime !== rightTime) return rightTime - leftTime;
	return sourcePriority(left) - sourcePriority(right);
}

function compareEvidencePriority(left: EvidenceObject, right: EvidenceObject): number {
	const leftPriority = sourcePriority(left);
	const rightPriority = sourcePriority(right);
	if (leftPriority !== rightPriority) return leftPriority - rightPriority;
	return evidenceTimeMs(right) - evidenceTimeMs(left);
}

function sourcePriority(item: EvidenceObject): number {
	const priority: Record<EvidenceSourceKind, number> = {
		official: 0,
		primary: 1,
		user_document: 2,
		internal: 3,
		news_report: 4,
		media_report: 4,
		commercial: 5,
		social_post: 6,
		unknown: 7
	};
	return priority[item.source_kind || 'unknown'];
}

function evidenceTimeMs(item: EvidenceObject): number {
	const parsed = Date.parse(item.published_at || '');
	return Number.isFinite(parsed) ? parsed : 0;
}

function kindLabel(item: EvidenceObject): string {
	if (item.source_kind === 'official') return 'official source';
	if (item.source_kind === 'primary') return 'primary source';
	if (item.source_kind === 'media_report' || item.source_kind === 'news_report') return 'news report';
	if (item.source_kind === 'user_document') return 'user document';
	if (item.source_kind === 'social_post') return 'social post';
	if (item.source_kind === 'commercial') return 'commercial source';
	if (item.source_kind === 'internal') return 'internal NewsCraft source';
	return 'source';
}

function formatSourceLink(item: EvidenceObject): string {
	const label = sourceDisplayTitle(item, 90).replace(/\]/g, ')');
	if (item.source_url.startsWith('newsroom://') || item.source_url === 'about:blank') {
		return `${label} (${item.source_url})`;
	}
	return `[${label}](${item.source_url})`;
}

function briefItemFor(item: EvidenceObject): BriefItem {
	const title = sourceDisplayTitle(item, 110);
	const source = formatSourceLink(item);
	const detail = cleanBriefDetail(item, title);
	return { evidence: item, title, source, detail };
}

function sourceNoteFor(item: EvidenceObject): string {
	const title = sourceDisplayTitle(item, 110);
	return cleanBriefDetail(item, title, 220);
}

function cleanBriefDetail(item: EvidenceObject, title: string, maxLength = 180): string {
	const raw = item.summary || firstUsefulSentence(item.extracted_text) || '';
	const cleaned = compactText(raw, maxLength);
	if (!cleaned) return '';
	if (sameNormalized(cleaned, title)) return '';
	if (looksLikeHeadlineBlob(cleaned)) return '';
	return cleaned;
}

function firstUsefulSentence(value: string): string {
	return value
		.split(/(?<=[.!?])\s+/)
		.map((sentence) => sentence.trim())
		.find((sentence) => sentence.length >= 40 && !looksLikeHeadlineBlob(sentence)) || '';
}

function looksLikeHeadlineBlob(value: string): boolean {
	const cleaned = value.toLowerCase();
	const urlish = (cleaned.match(/\b(?:https?:\/\/|www\.|[a-z0-9-]+\.(?:ca|com|org|net)\/)/g) || []).length;
	const dateReadMarkers = (cleaned.match(/\b(?:mins?|hours?|min read|updated|breaking|subscribe|skip to|sign in)\b/g) || [])
		.length;
	const sentenceMarks = (value.match(/[.!?]/g) || []).length;
	return urlish >= 1 || dateReadMarkers >= 2 || (value.length > 180 && sentenceMarks <= 1);
}

function sameNormalized(left: string, right: string): boolean {
	const normalizedLeft = normalizeComparable(left);
	const normalizedRight = normalizeComparable(right);
	return Boolean(normalizedLeft && normalizedRight && (normalizedLeft === normalizedRight || normalizedLeft.includes(normalizedRight)));
}

function normalizeComparable(value: string): string {
	return value
		.toLowerCase()
		.replace(/https?:\/\/\S+/g, '')
		.replace(/[^a-z0-9]+/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

function summaryFor(item: EvidenceObject, maxLength = 260): string {
	return compactText(item.summary || item.extracted_text || item.title, maxLength);
}

function sourceDisplayTitle(item: EvidenceObject, maxLength: number): string {
	const title = item.title.trim();
	if (looksUrlLike(title) || title === item.source_url) return compactUrlLabel(item.source_url, maxLength);
	return compactText(title, maxLength);
}

function compactUrlLabel(value: string, maxLength: number): string {
	try {
		const url = new URL(value);
		const path = url.pathname.replace(/\/$/, '');
		const label = `${url.hostname.replace(/^www\./, '')}${path && path !== '/' ? path : ''}`;
		if (label.length <= maxLength) return label;
		return `${label.slice(0, Math.max(0, maxLength - 1)).trim()}…`;
	} catch {
		return compactText(value, maxLength);
	}
}

function looksUrlLike(value: string): boolean {
	return /^https?:\/\//i.test(value) || /^[a-z0-9.-]+\.[a-z]{2,}(?:\/|$)/i.test(value);
}

function latestAvailableFraming(prompt: string, item: EvidenceObject): string {
	if (!/\b(latest|today|new|recent|breaking|current|update|updates)\b/i.test(prompt)) return '';
	if (!item.published_at) {
		return 'No usable source in this run included a publication date; treat the date as unknown and verify recency before use.';
	}
	return `The freshest usable source found in this run was published ${item.published_at}; treat this as the latest available result, not proof that nothing newer exists.`;
}

function publicationDateLabel(item: EvidenceObject): string {
	return item.published_at ? `published ${item.published_at}` : 'publication date not found';
}

function compactText(value: string, maxLength: number): string {
	const cleaned = value
		.replace(/```[\s\S]*?```/g, ' ')
		.replace(/^#{1,6}\s+/gm, '')
		.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
		.replace(/[*_~>`#]+/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
	if (cleaned.length <= maxLength) return cleaned;
	return `${cleaned.slice(0, Math.max(0, maxLength - 1)).trim()}…`;
}

function compactChatText(value: string, maxLength: number): string {
	const cleaned = value
		.replace(/```(?:markdown|md|text)?\n?/gi, '')
		.replace(/```/g, '')
		.replace(/^#{1,6}\s+/gm, '')
		.replace(/\*\*([^*]+)\*\*/g, '$1')
		.replace(/__([^_]+)__/g, '$1')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
	if (cleaned.length <= maxLength) return cleaned;
	return `${cleaned.slice(0, Math.max(0, maxLength - 1)).trim()}…`;
}

function cleanChatToolAnswer(value: string, options: { preserveUrls?: boolean } = {}): string {
	return normalizeChatAnswerWhitespace(repairInlineStoryLines(stripCitationChatter(stripSourceSections(value), options)));
}

function stripSourceSections(value: string): string {
	return value
		.replace(
			/(?:^|\n)\s*(?:#{1,6}\s*)?(?:sources?|references?|citations?)\b\s*:?\s*[\s\S]*$/i,
			''
		)
		.replace(/(?:^|\n)\s*(?:[-*]\s*)?\[[^\]]+\]\(https?:\/\/[^)]+\)[^\n]*/gi, '');
}

function stripCitationChatter(value: string, options: { preserveUrls?: boolean } = {}): string {
	const cleaned = value
		.replace(
			/(?:^|\n)\s*If you(?:'|’)d like,\s*(?:the )?next step can be[\s\S]*?(?=\n{2,}|$)/gi,
			''
		)
		.replace(
			/(?:^|\n)\s*(?:Would you like|Do you want) (?:me )?to[\s\S]*?(?=\n{2,}|$)/gi,
			''
		)
		.replace(
			/(?:^|\n)\s*If you want,?\s+(?:I|we|NewsCraft)\s+(?:can|could|will)\b[\s\S]*$/gi,
			''
		)
		.replace(
			/(?:^|\n)\s*If you want one clear next step\b[\s\S]*?(?=\n{2,}\*\*Attached document evidence\*\*|$)/gi,
			''
		)
		.replace(
			/(?:^|\n)\s*If you prefer immediate verification\b[\s\S]*?(?=\n{2,}\*\*Attached document evidence\*\*|$)/gi,
			''
		)
		.replace(
			/(?:^|\n)\s*(?:[-*]\s*)?If you meant\b[^\n]*(?:\bsay which\b|\btell me\b|\bI(?:'|’)ll\b|\bI will\b)[^\n]*(?=\n|$)/gi,
			''
		)
		.replace(
			/(?:^|\n)\s*(?:#{1,6}\s*)?What I can do next\b[\s\S]*?(?=\n{2,}(?:Quick factual anchor|Attached document evidence)\b|$)/gi,
			''
		)
		.replace(/(?:^|\n)\s*(?:Which|What) next step do you want\??\s*$/gi, '')
		.replace(
			/(?:^|\n)\s*(?:[-*]\s*)?If you need\b[^\n]*(?:\bI|we|NewsCraft)\s+(?:can|could|will)\b[^\n]*(?=\n|$)/gi,
			''
		)
		.replace(
			/(?:^|\n)\s*I could not find reliable\s*$/gi,
			''
		)
		.replace(
			/(?:^|\n)\s*Link extraction was incomplete for this web search result; verify before relying on it\.\s*/gi,
			'\n'
		)
		.replace(/\bPosted times?:\s*[\s\S]*?(?=\s+(?:Additional confirmations?|AP write[- ]?up|Canadian Press version|Sources?:)\b|$)/gi, '')
		.replace(/\bAdditional confirmations?:\s*[\s\S]*$/i, '')
		.replace(/\bAP write[- ]?up carried by\s*[\s\S]*$/i, '')
		.replace(/\bCanadian Press version carried by\s*[\s\S]*$/i, '')
		.replace(/\bIt is based on media\/search results and should be checked against a primary source before publication\.?/gi, '');
	if (options.preserveUrls) return cleaned;
	return cleaned
		.replace(/\[([^\]]+)\]\(https?:\/\/[^)]+\)/gi, '$1')
		.replace(/https?:\/\/\S+/gi, '')
		.replace(/\s+\((?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^)]*)?\)/gi, '');
}

function normalizeChatAnswerWhitespace(value: string): string {
	return value
		.replace(/\.:\s+(?=[A-Z])/g, '.\n- ')
		.replace(/[ \t]+\n/g, '\n')
		.replace(/\n{3,}/g, '\n\n')
		.replace(/[ \t]{2,}/g, ' ')
		.replace(/\s+([,.;:!?])/g, '$1')
		.trim();
}

function repairInlineStoryLines(value: string): string {
	return value
		.replace(/\s*,?\s*ordered by freshness:?\s*/gi, ':\n')
		.replace(/:\s+-\s+/g, ':\n- ')
		.replace(
			/\s+-\s+(?=(?:Today|Yesterday|Latest|This morning|This afternoon|This evening|[A-Z][A-Za-z0-9'’$,.&/ ]{2,80})\s+[—–-]\s+)/g,
			'\n- '
		)
		.replace(/^- (Today|Yesterday|Latest|This morning|This afternoon|This evening)\s+[—–-]\s+/gim, '$1: ')
		.replace(/^- Bold:\s*([^—–:\n]{2,100})\s+[—–-]\s+/gim, '$1: ')
		.replace(/^- ([A-Z][^:\n]{2,80})[ \t]+[—–-][ \t]+/gm, '$1: ');
}

function polishedChatText(value: string, maxLength: number): string {
	const cleaned = value
		.replace(/```(?:markdown|md|text)?\n?/gi, '')
		.replace(/```/g, '')
		.replace(/^#{1,6}\s+/gm, '')
		.replace(/\*\*([^*]+)\*\*/g, '$1')
		.replace(/__([^_]+)__/g, '$1')
		.replace(/`([^`]+)`/g, '$1')
		.replace(/^Bold:\s*/gim, '')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
	const bounded = cleaned.length <= maxLength ? cleaned : truncateTextAtBoundary(cleaned, maxLength);
	return trimIncompleteTrailingParagraph(bounded);
}

function truncateTextAtBoundary(value: string, maxLength: number): string {
	const slice = value.slice(0, maxLength);
	const paragraph = slice.lastIndexOf('\n\n');
	const sentence = Math.max(slice.lastIndexOf('. '), slice.lastIndexOf('! '), slice.lastIndexOf('? '));
	const boundary = Math.max(paragraph, sentence >= 0 ? sentence + 1 : -1);
	return slice.slice(0, boundary > maxLength * 0.55 ? boundary : maxLength).trim();
}

function trimIncompleteTrailingParagraph(value: string): string {
	if (/[.!?]["')\]]*(?:\s*\[\d+\])?$/.test(value) || /\[\d+\]$/.test(value)) return value;
	const paragraph = value.lastIndexOf('\n\n');
	if (paragraph > 0) return value.slice(0, paragraph).trim();
	const sentence = Math.max(value.lastIndexOf('. '), value.lastIndexOf('! '), value.lastIndexOf('? '));
	return sentence > value.length * 0.55 ? value.slice(0, sentence + 1).trim() : value;
}

function noPublishableLeadReport(unusableEvidence: EvidenceObject[], limitations: string[] = []): string {
	const sourceNotes = sourceIssueNotes(unusableEvidence, limitations);
	return [
		'## Summary',
		[
			'No research update was saved from this run because no usable source material was available.',
			publicCaveatsFor('', [], unusableEvidence, limitations, { noUsableEvidence: true })[0]
		]
			.filter(Boolean)
			.join(' '),
		'',
		'## Sources',
		sourceNotes.length ? sourceNotes.join('\n') : '- No readable source material was available from this run.',
		'',
		'## Uncertainty',
		'- Re-run after the source is readable, attach a source feed, or check the story against a readable primary or reliable secondary source.'
	].join('\n');
}

function sourceIssueNotes(evidence: EvidenceObject[], limitations: string[] = []): string[] {
	const seen = new Set<string>();
	const notes: string[] = [];
	for (const item of evidence) {
		const quality = assessEvidenceQuality(item);
		if (quality.usable) continue;
		const label = publicIssueLabel(item);
		const note = quality.publicNote || 'Source did not return usable story text during this run.';
		const key = `${label}\n${note}`;
		if (seen.has(key)) continue;
		seen.add(key);
		notes.push(`- ${label}: ${note} It was not used as evidence.`);
	}
	for (const limitation of limitations) {
		const note = publicLimitationNote(limitation);
		if (!note || seen.has(note)) continue;
		seen.add(note);
		notes.push(`- ${note}`);
	}
	return notes;
}

function publicCaveatsFor(
	prompt: string,
	evidence: EvidenceObject[],
	unusableEvidence: EvidenceObject[],
	limitations: string[],
	options: { noUsableEvidence: boolean }
): string[] {
	const caveats: string[] = [];
	const combinedLimitations = [...limitations, ...unusableEvidence.flatMap((item) => item.limitations)];
	const providerConfigurationLimitation = combinedLimitations
		.map(providerUnavailableLimitation)
		.find((item): item is string => Boolean(item));
	const missingOutletCoverage = combinedLimitations
		.map(missingOutletCoverageLimitation)
		.find((item): item is string => Boolean(item));
	const blocked = combinedLimitations.some((item) => /paywall|subscription|login|captcha|blocked|unavailable|access denied|access was restricted|requires access|forbidden|could not be read/i.test(item));
	if (options.noUsableEvidence) {
		if (providerConfigurationLimitation) caveats.push(providerConfigurationLimitation);
		else {
			caveats.push(
				blocked
					? "I couldn't verify this because the available sources were blocked, paywalled, unavailable, or unreadable."
					: "I couldn't verify this from readable sources right now."
			);
		}
		if (missingOutletCoverage) caveats.push(missingOutletCoverage);
		return caveats;
	}
	if (missingOutletCoverage) caveats.push(missingOutletCoverage);

	if (needsPrimaryConfirmation(prompt, evidence)) {
		caveats.push('I could not confirm this from a readable official or primary source in the gathered material; verify before relying on it.');
	}
	if (evidence.length && evidence.every((item) => item.confidence < 0.55)) {
		caveats.push('The available source material is weak; treat this as unconfirmed until stronger sources are available.');
	}
	return caveats;
}

function needsPrimaryConfirmation(prompt: string, evidence: EvidenceObject[]): boolean {
	if (
		/\b(?:briefing|roundup|headlines|top stories|latest .*news|assignment desk|newsroom producer)\b/i.test(prompt) &&
		!/\b(?:verify|confirm|fact[- ]?check|what .* officially said|is (?:this|that|it) true)\b/i.test(prompt)
	) {
		return false;
	}
	if (!needsExplicitVerificationCaveat(prompt)) return false;
	return !evidence.some((item) => item.source_kind === 'official' || item.source_kind === 'primary');
}

function needsExplicitVerificationCaveat(prompt: string): boolean {
	return /\b(verify|verification|confirm|official|primary|source of truth|what .* officially said|government|parliament|minister|ministry|department|agency|police|sheriff|court|legal|lawsuit|charges?|arrest|elections?|ballot|vote count|schedule|fixtures?|kick[- ]?off|tip[- ]?off)\b/i.test(
		prompt
	);
}

function appendCaveats(answer: string, caveats: string[]): string {
	const cleaned = answer.trim();
	const unique = caveats.filter((item, index) => item && caveats.indexOf(item) === index);
	if (!unique.length) return cleaned;
	const lower = cleaned.toLowerCase();
	const missing = unique.filter((item) => !lower.includes(item.toLowerCase()));
	return [cleaned, ...missing].filter(Boolean).join('\n\n');
}

function publicLimitationNote(value: string): string {
	const providerUnavailable = providerUnavailableLimitation(value);
	if (providerUnavailable) return providerUnavailable;
	const missingOutletCoverage = missingOutletCoverageLimitation(value);
	if (missingOutletCoverage) return missingOutletCoverage;
	if (/paywall|subscription|login|captcha|blocked|access denied|forbidden|could not be read|unavailable/i.test(value)) {
		return 'A candidate source was blocked, paywalled, unavailable, or could not be read. It was not used as evidence.';
	}
	if (/no usable|no cited sources|no readable|no .*source/i.test(value)) {
		return 'No usable source material was available from one attempted source.';
	}
	return '';
}

function missingOutletCoverageLimitation(value: string): string | null {
	const match = value.match(/^No readable article-level evidence was found from (.+)\.$/i);
	if (!match) return null;
	return `I did not find readable article-level coverage from ${match[1]} in this research pass.`;
}

function providerUnavailableLimitation(value: string): string | null {
	const match = value.match(
		/^\s*(openai|perplexity)\s+web_search is not configured because\s+([A-Z_]+)\s+is missing\.?$/i
	);
	if (!match) return null;
	const apiKeyName = match[2].toUpperCase();
	if (!/OPENAI_API_KEY|PERPLEXITY_API_KEY/.test(apiKeyName)) return null;
	return 'Live research is temporarily unavailable.';
}

function publicIssueLabel(item: EvidenceObject): string {
	if (item.source_name && item.source_name !== item.title) return item.source_name;
	if (item.source_url && item.source_url !== 'about:blank') {
		try {
			return new URL(item.source_url).hostname.replace(/^www\./, '');
		} catch {
			return item.source_url;
		}
	}
	return 'Configured source';
}
