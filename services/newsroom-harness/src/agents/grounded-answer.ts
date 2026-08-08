import type { EvidenceObject } from './evidence.js';
import { isCitationUrl } from '@newscraft/shared';

export type GroundedWrapper =
	| 'strong'
	| 'emphasis'
	| 'code'
	| { kind: 'link'; url: string };

export interface GroundedStructuredLabel {
	label: string;
	value?: string;
	separator?: ':' | '=' | '—';
}

export interface GroundedPresentation {
	kind: 'paragraph' | 'bullet' | 'heading' | 'table-row';
	level?: number;
	leadingText?: string;
	leadingStrong?: boolean;
	trailingLabel?: string;
	trailingText?: string;
	wrapper?: GroundedWrapper;
	tableCells?: string[];
	/** Explicit label/value intent; validated as a structured field rather than a short-token exception. */
	structuredLabel?: GroundedStructuredLabel;
}

export interface GroundedClaim {
	claimId: string;
	visibleText: string;
	evidenceIds: readonly string[];
	presentation: GroundedPresentation;
}

export type GroundedAnswerBlock =
	| { kind: 'claim'; claim: GroundedClaim }
	| { kind: 'section'; heading: string; level?: number }
	| { kind: 'text'; text: string }
	| { kind: 'source'; title: string; url: string; detail?: string };

export interface GroundedAnswer {
	/** Ordered claim ledger. Citation numbers are deliberately absent here. */
	claims: readonly GroundedClaim[];
	blocks: readonly GroundedAnswerBlock[];
}

export interface GroundedEvidenceLedger {
	evidence: readonly EvidenceObject[];
	byId: ReadonlyMap<string, EvidenceObject>;
	citationById: ReadonlyMap<string, number>;
	identityByEvidence: ReadonlyMap<EvidenceObject, string>;
	evidenceOrder: readonly string[];
}

export interface GroundedClaimOptions {
	claimId?: string;
	visibleText?: string;
	presentation?: Partial<GroundedPresentation>;
}

const TERMINAL = /[.!?。！？](?:["'”’»)]*)$/u;
const PRESENTATION_TERMINAL = /[.!?。！？;:；：—–-](?:["'”’»)]*)$/u;
const CITATION = /\[(\d+)\](?!\()/g;
const canonicalCitationNumbers = new WeakMap<EvidenceObject, number>();

/**
 * Canonical evidence sequencing. Provider-local citation numbers are metadata,
 * never identity: occurrence order owns the provisional ledger number until
 * the final renderer assigns appearance order.
 */
export function normalizeGroundedEvidence(evidence: EvidenceObject[]): GroundedEvidenceLedger {
	const byId = new Map<string, EvidenceObject>();
	const citationById = new Map<string, number>();
	const identityByEvidence = new Map<EvidenceObject, string>();
	const evidenceOrder: string[] = [];
	const usedIds = new Set<string>();
	for (const [index, item] of evidence.entries()) {
		const base =
			item.evidence_id?.trim() ||
			item.canonical_url?.trim() ||
			item.source_url?.trim() ||
			`evidence:${index + 1}`;
		let identity = base;
		let suffix = 2;
		while (usedIds.has(identity)) identity = `${base}#${suffix++}`;
		usedIds.add(identity);
		byId.set(identity, item);
		evidenceOrder.push(identity);
		identityByEvidence.set(item, identity);
		const provisionalNumber = index + 1;
		citationById.set(identity, provisionalNumber);
		item.citation_number = provisionalNumber;
	}

	return { evidence, byId, citationById, identityByEvidence, evidenceOrder };
}

export function evidenceIdentity(item: EvidenceObject, ledger: GroundedEvidenceLedger): string | undefined {
	return ledger.identityByEvidence.get(item);
}

/**
 * Selects one complete source statement. This is evidence normalization, not
 * parsing of provider-authored answer prose. Short extracted prefixes lose to
 * a complete summary/supporting excerpt when the source ledger contains one.
 */
export function completeGroundedEvidenceStatement(item: EvidenceObject): string {
	const candidates = [item.summary, item.supporting_excerpt || '', item.extracted_text]
		.map(cleanEvidenceField)
		.filter(Boolean)
		.flatMap((value) => evidenceStatementCandidates(value, item));
	const unique = [...new Map(candidates.map((value) => [comparableText(value), value])).values()];
	const selected = unique.sort((left, right) => {
		const leftPrefix = unique.some((candidate) => strictTextPrefix(left, candidate));
		const rightPrefix = unique.some((candidate) => strictTextPrefix(right, candidate));
		if (leftPrefix !== rightPrefix) return leftPrefix ? 1 : -1;
		return right.length - left.length;
	})[0];
	return selected || '';
}

export function groundedClaimFromEvidence(
	item: EvidenceObject,
	ledger: GroundedEvidenceLedger,
	options: GroundedClaimOptions = {}
): GroundedClaim | null {
	const evidenceId = evidenceIdentity(item, ledger);
	if (!evidenceId) return null;
	const presentation: GroundedPresentation = {
		kind: 'paragraph',
		...(options.presentation || {})
	};
	const structuredText = structuredLabelText(presentation.structuredLabel);
	const visibleText = (options.visibleText || structuredText || completeGroundedEvidenceStatement(item)).trim();
	if (!visibleText) return null;
	const claim: GroundedClaim = {
		claimId: options.claimId || `claim:${evidenceId}`,
		visibleText,
		evidenceIds: [evidenceId],
		presentation
	};
	return validateGroundedClaim(claim, ledger) ? claim : null;
}

export function validateGroundedClaim(claim: GroundedClaim, ledger: GroundedEvidenceLedger): boolean {
	const structuredText = structuredLabelText(claim.presentation.structuredLabel);
	if (structuredText && comparableText(claim.visibleText) !== comparableText(structuredText)) return false;
	const text = stripPresentationMarkup(structuredText || claim.visibleText).trim();
	if (!text || hasMalformedCitationSyntax(claim.visibleText)) return false;
	if (claim.presentation.kind === 'heading' && !structuredText && supportUnits(text).length <= 1) return false;
	const ids = [...new Set(claim.evidenceIds)];
	if (!ids.length || ids.length !== claim.evidenceIds.length) return false;
	return ids.every((id) => {
		const item = ledger.byId.get(id);
		if (!item) return false;
		if (claim.presentation.structuredLabel) {
			return sourceSupportsStructuredLabel(item, claim.presentation.structuredLabel);
		}
		return sourceSupportsPhrase(item, text) && !isIncompleteClaimPrefix(text, item);
	});
}

export function groundedAnswerFromClaims(
	claims: GroundedClaim[],
	blocks: GroundedAnswerBlock[] = claims.map((claim) => ({ kind: 'claim', claim }))
): GroundedAnswer {
	return { claims: [...claims], blocks: [...blocks] };
}

export function groundedAnswerFromEvidence(
	evidence: EvidenceObject[],
	options: { limit?: number; kind?: GroundedPresentation['kind'] } = {}
): { answer: GroundedAnswer; ledger: GroundedEvidenceLedger } {
	const ledger = normalizeGroundedEvidence(evidence);
	const claims = ledger.evidence
		.slice(0, options.limit ?? ledger.evidence.length)
		.flatMap((item) => {
			const claim = groundedClaimFromEvidence(item, ledger, {
				presentation: { kind: options.kind || (ledger.evidence.length === 1 ? 'paragraph' : 'bullet') }
			});
			return claim ? [claim] : [];
		});
	return { answer: groundedAnswerFromClaims(claims), ledger };
}

function resolveGroundedAnswer(answer: GroundedAnswer, ledger: GroundedEvidenceLedger): GroundedAnswer {
	return {
		...answer,
		blocks: answer.blocks.flatMap<GroundedAnswerBlock>((block) => {
			if (block.kind !== 'claim') return [block];
			const claim = validatedOrFallbackClaim(block.claim, ledger);
			return claim ? [{ kind: 'claim' as const, claim }] : [];
		})
	};
}

/**
 * Resolve claims first, then assign numbers from the order in which their
 * evidence becomes visible. Provider-local numbers and input-array order are
 * never used as the final visible citation order.
 */
export function assignGroundedCitationOrder(
	answer: GroundedAnswer,
	ledger: GroundedEvidenceLedger
): GroundedAnswer {
	const resolved = resolveGroundedAnswer(answer, ledger);
	const orderedEvidenceIds: string[] = [];
	const seen = new Set<string>();
	for (const block of resolved.blocks) {
		if (block.kind !== 'claim') continue;
		for (const evidenceId of block.claim.evidenceIds) {
			if (ledger.byId.has(evidenceId) && !seen.has(evidenceId)) {
				seen.add(evidenceId);
				orderedEvidenceIds.push(evidenceId);
			}
		}
	}
	// Keep unreferenced evidence addressable for metadata/export, but never let
	// it displace a citation that is already visible in the answer.
	for (const evidenceId of ledger.evidenceOrder) {
		if (!seen.has(evidenceId)) orderedEvidenceIds.push(evidenceId);
	}
	const mutableCitationById = ledger.citationById as Map<string, number>;
	mutableCitationById.clear();
	for (const [index, evidenceId] of orderedEvidenceIds.entries()) {
		const number = index + 1;
		mutableCitationById.set(evidenceId, number);
		const item = ledger.byId.get(evidenceId)!;
		item.citation_number = number;
		canonicalCitationNumbers.set(item, number);
	}
	return resolved;
}

/** Return the number assigned by the last structured render for this item. */
export function canonicalGroundedCitationNumber(item: EvidenceObject): number | undefined {
	return canonicalCitationNumbers.get(item);
}

/**
 * The renderer is the only owner of visible citation placement and wrappers.
 * Invalid claims are replaced from their exact evidence set, or omitted.
 */
export function renderGroundedAnswer(answer: GroundedAnswer, ledger: GroundedEvidenceLedger): string {
	const resolvedAnswer = assignGroundedCitationOrder(answer, ledger);
	const lines: string[] = [];
	for (const block of resolvedAnswer.blocks) {
		if (block.kind === 'section') {
			if (!block.heading.trim() || hasMalformedCitationSyntax(block.heading)) continue;
			const level = Math.max(1, Math.min(6, block.level || 2));
			lines.push(`${'#'.repeat(level)} ${escapeMarkdownText(block.heading.trim())}`);
			continue;
		}
		if (block.kind === 'text') {
			if (!block.text.trim() || hasAnyCitationSyntax(block.text)) continue;
			lines.push(block.text.trim());
			continue;
		}
		if (block.kind === 'source') {
			if (!block.title.trim() || !isSafeSourceUrl(block.url)) continue;
			const detail = block.detail?.trim() ? ` - ${escapeMarkdownText(block.detail.trim())}` : '';
			lines.push(`- [${escapeMarkdownText(block.title.trim())}](${escapeUrl(block.url)})${detail}`);
			continue;
		}

		const rendered = renderClaim(block.claim, ledger);
		if (rendered) lines.push(rendered);
	}
	return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function citationNumbersInGroundedAnswer(value: string): number[] {
	return Array.from(value.matchAll(CITATION), (match) => Number(match[1])).filter(
		(number) => Number.isInteger(number) && number > 0
	);
}

export function hasMalformedCitationSyntax(value: string): boolean {
	for (const match of value.matchAll(/\[([^\]\n]*)\](?!\()/g)) {
		if (!/^\d+$/.test(match[1].trim())) return true;
	}
	return /\[[^\]\n]*$/u.test(value);
}

function hasAnyCitationSyntax(value: string): boolean {
	return citationNumbersInGroundedAnswer(value).length > 0 || hasMalformedCitationSyntax(value);
}

function validatedOrFallbackClaim(claim: GroundedClaim, ledger: GroundedEvidenceLedger): GroundedClaim | null {
	if (validateGroundedClaim(claim, ledger)) return claim;
	const visibleText = stripPresentationMarkup(claim.visibleText)
		.replace(/\s*\[[^\]\n]*(?:\]|$)/gu, ' ')
		.trim();
	for (const evidenceId of claim.evidenceIds) {
		const item = ledger.byId.get(evidenceId);
		if (!item) continue;
		// A fallback may complete a supported prefix or drop an unsupported
		// citation from a multi-source group. It may never replace an unrelated
		// visible claim with arbitrary evidence merely because the IDs exist.
		if (!sourceSupportsPhrase(item, visibleText)) continue;
		const replacement = groundedClaimFromEvidence(item, ledger, {
			claimId: claim.claimId,
			presentation: claim.presentation
		});
		if (replacement) return replacement;
	}
	return null;
}

function renderClaim(claim: GroundedClaim, ledger: GroundedEvidenceLedger): string {
	const presentation = claim.presentation;
	const citationNumbers = [...new Set(claim.evidenceIds)]
		.map((id) => ledger.citationById.get(id))
		.filter((number): number is number => Number.isInteger(number));
	const citationGroup = citationNumbers.map((number) => `[${number}]`).join(' ');
	const claimText = terminalize(
		(structuredLabelText(presentation.structuredLabel) || claim.visibleText).trim(),
		presentation
	);
	if (!claimText || hasMalformedCitationSyntax(claimText)) return '';
	const wrapped = wrapClaim(escapeMarkdownText(stripPresentationMarkup(claimText)), presentation.wrapper);
	const leading = presentation.leadingText?.trim()
		? `${presentation.leadingStrong ? `**${escapeMarkdownText(presentation.leadingText.trim())}**` : escapeMarkdownText(presentation.leadingText.trim())} `
		: '';
	const cited = citationGroup ? `${wrapped} ${citationGroup}` : wrapped;
	const trailing = presentation.trailingLabel
		? ` **${escapeMarkdownText(presentation.trailingLabel)}:**${presentation.trailingText ? ` ${escapeMarkdownText(presentation.trailingText)}` : ''}`
		: presentation.trailingText
			? ` ${escapeMarkdownText(presentation.trailingText)}`
			: '';
	const body = `${leading}${cited}${trailing}`.trim();
	if (presentation.kind === 'heading') {
		return `${'#'.repeat(Math.max(1, Math.min(6, presentation.level || 2)))} ${body}`;
	}
	if (presentation.kind === 'bullet') return `- ${body}`;
	if (presentation.kind === 'table-row') {
		const cells = (presentation.tableCells || []).map((cell) => escapeMarkdownText(cell.trim()));
		return `| ${[...cells, body].join(' | ')} |`;
	}
	return body;
}

function wrapClaim(value: string, wrapper: GroundedWrapper | undefined): string {
	if (!wrapper) return value;
	if (wrapper === 'strong') return `**${value}**`;
	if (wrapper === 'emphasis') return `*${value}*`;
	if (wrapper === 'code') return `\`${value.replace(/`/g, '\\\`')}\``;
	return isSafeSourceUrl(wrapper.url) ? `[${value}](${escapeUrl(wrapper.url)})` : value;
}

function cleanEvidenceField(value: string): string {
	return stripPresentationMarkup(value)
		.replace(/\s*\[\d+\](?!\()/g, ' ')
		.replace(/^\s*(?:#{1,6}\s+|[-*•]\s+|\d+[.)]\s+)/u, '')
		.replace(/\s+([,.;:!?])/gu, '$1')
		.replace(/\s+/gu, ' ')
		.trim();
}

function evidenceStatementCandidates(value: string, item: EvidenceObject): string[] {
	if (hasExplicitEllipsis(value)) return [];
	const sentences = splitEvidenceSentences(value);
	const complete = sentences.filter((sentence) => isCompleteEvidenceStatement(sentence, item));
	// A source field can contain several independent sentences. Preserve the
	// first complete statement instead of selecting the longest later sentence;
	// this keeps initials, versions, and URL-bearing lead sentences intact.
	if (complete.length) return [terminalize(complete[0])];
	if (isCompleteEvidenceStatement(value, item)) return [terminalize(value)];
	return [];
}

function isCompleteEvidenceStatement(value: string, item: EvidenceObject): boolean {
	const text = stripPresentationMarkup(value).replace(/\s*\[\d+\](?!\()/g, '').trim();
	if (!text || hasExplicitEllipsis(text)) return false;
	const units = supportUnits(text);
	if (!units.length) return false;
	const title = comparableText(item.title);
	const comparable = comparableText(text);
	if (title && comparable === title && !TERMINAL.test(text)) return false;
	const labeled = labeledSupportParts(text);
	if (labeled.label && labeled.body && isCompleteLabelValueBody(labeled.body)) return true;
	if (TERMINAL.test(text)) {
		return !endsInDanglingAbbreviation(text) || hasExplicitAbbreviationDefinition(text);
	}
	// A source field without terminal punctuation can still be a complete
	// version, URL, or headline-like statement. Reject open grammatical joins
	// such as "Toronto's Salsa on" instead of treating word count as proof of
	// completeness.
	const finalUnit = units.at(-1) || '';
	if (isOpenEndedEvidenceUnit(finalUnit)) return false;
	return units.length >= 3 || units.some((unit) => isStructuredEvidenceUnit(unit));
}

function splitEvidenceSentences(value: string): string[] {
	const result: string[] = [];
	let start = 0;
	for (let index = 0; index < value.length; index += 1) {
		if (!/[.!?。！？]/u.test(value[index]) || !isSentenceBoundary(value, start, index)) continue;
		const sentence = value.slice(start, index + 1).trim();
		if (sentence) result.push(sentence);
		start = index + 1;
	}
	const remainder = value.slice(start).trim();
	if (remainder) result.push(remainder);
	return result;
}

function isSentenceBoundary(value: string, sentenceStart: number, periodIndex: number): boolean {
	const next = value[periodIndex + 1];
	if (next && !/\s/u.test(next)) return false;
	if (value[periodIndex] !== '.') return true;
	if (periodIndex > 0 && periodIndex + 1 < value.length && /\d/u.test(value[periodIndex - 1]) && /\d/u.test(next || '')) return false;
	const before = value.slice(sentenceStart, periodIndex + 1);
	const token = before.match(/(?:^|\s)([A-Za-z]{1,16})\.$/)?.[1] || '';
	const after = value.slice(periodIndex + 1).match(/^\s+([\p{L}\p{N}][\p{L}\p{N}'’.-]*)/u)?.[1] || '';
	if (!after) return true;
	if (/^[A-Za-z]$/.test(token) || /^(?:st|rd|ave|blvd|dr|mr|mrs|ms|prof|jr|sr|no|fig|sec|vs|etc|approx|dept)$/i.test(token)) return false;
	if (/(?:^|\s)(?:[A-Za-z]\.){2,}$/.test(before)) return false;
	if (/(?:^|\s)[ap]\.m\.$/i.test(before)) {
		if (hasValidMeridiemClock(before) && !isTimezoneToken(after)) return true;
		return false;
	}
	return true;
}

function endsInDanglingAbbreviation(value: string): boolean {
	if (hasValidMeridiemClock(value)) return false;
	return /(?:^|\s)(?:st|rd|ave|blvd|dr|mr|mrs|ms|prof|jr|sr|no|fig|sec|vs|etc|approx|dept)\.$/i.test(value) ||
		/(?:^|\s)(?:[A-Za-z]\.){2,}$/.test(value) ||
		danglingMeridiem(value);
}

function hasValidMeridiemClock(value: string): boolean {
	return /(?:^|\s)(?:0?[1-9]|1[0-2])(?::[0-5]\d)?\s*[ap]\.m\.(?:\s+(?:UTC|GMT|[A-Z]{2,6}))?\s*[.!?]?$/iu.test(
		value
	);
}

function isTimezoneToken(value: string): boolean {
	return /^(?:UTC|GMT|[ECMP]T|[ECMP](?:ST|DT))$/iu.test(value);
}

function danglingMeridiem(value: string): boolean {
	const withoutTimezone = value.replace(/\s+(?:UTC|GMT|[ECMP]T|[ECMP](?:ST|DT))\.?$/iu, '').trim();
	return /(?:^|\s)[ap]\.m\.$/iu.test(withoutTimezone);
}

function hasExplicitAbbreviationDefinition(value: string): boolean {
	// A terminal abbreviation is accepted only when the evidence itself states
	// that it is an abbreviation/initialism (or explicitly defines its short
	// form). A generic copular/verb allow-list is not evidence of completeness:
	// "The event is at St." and a clipped proper name must fail closed.
	return /\b(?:abbreviation|abbreviated\s+(?:form|name)|initials?|short\s+(?:form|name))\b[\s\S]{0,60}\b(?:is|means|stands\s+for|refers\s+to)\b[\s\S]*\b(?:[A-Za-z]{1,16}\.|(?:[A-Za-z]\.){2,}|[ap]\.m\.)$/iu.test(
		value
	);
}

function isOpenEndedEvidenceUnit(value: string): boolean {
	return /^(?:a|an|and|as|at|but|by|for|from|if|in|into|is|nor|of|on|or|than|that|the|these|this|those|to|with|without)$/iu.test(
		value
	);
}

function isStructuredEvidenceUnit(value: string): boolean {
	return /^(?:https?:\/\/|(?:\d+\.)+\d(?:-[\p{L}\p{N}][\p{L}\p{N}._-]*)?(?:\+[\p{L}\p{N}][\p{L}\p{N}._-]*)?|(?:[\p{L}]\.){2,})/iu.test(value);
}

function hasExplicitEllipsis(value: string): boolean {
	// A URL may legitimately contain a dotted path/host placeholder. Detect
	// elision everywhere else, before sentence extraction can accept a tail.
	const withoutUrls = value.replace(/https?:\/\/[^\s\])}>]+/giu, '');
	return /…|(?:\.\s*){3,}/u.test(withoutUrls);
}

function terminalize(value: string, presentation?: GroundedPresentation): string {
	if (!value) return '';
	if (PRESENTATION_TERMINAL.test(value)) return value;
	if (
		presentation?.structuredLabel ||
		presentation?.kind === 'heading' ||
		presentation?.wrapper === 'code' ||
		/^https?:\/\/[^\s]+$/iu.test(value)
	) {
		return value;
	}
	return `${value}.`;
}

function strictTextPrefix(shorter: string, longer: string): boolean {
	const left = comparableText(shorter);
	const right = comparableText(longer);
	return Boolean(left && right && left !== right && right.startsWith(`${left} `));
}

function sourceSupportsPhrase(item: EvidenceObject, statement: string): boolean {
	const fragments = [item.extracted_text, item.summary, item.supporting_excerpt || '']
		.filter((source): source is string => Boolean(source && isCompleteEvidenceStatement(source, item)));
	return fragments.some((source) => sourceSupportsText(source, statement));
}

function structuredLabelText(structured: GroundedStructuredLabel | undefined): string {
	if (!structured?.label.trim()) return '';
	if (structured.value == null || !structured.value.trim()) return structured.label.trim();
	return `${structured.label.trim()}${structured.separator || ':'} ${structured.value.trim()}`;
}

function sourceSupportsStructuredLabel(item: EvidenceObject, structured: GroundedStructuredLabel): boolean {
	const expectedLabel = comparableText(structured.label);
	if (!expectedLabel) return false;
	const fields = [item.extracted_text, item.summary, item.supporting_excerpt || ''].filter(
		(value): value is string => Boolean(value)
	);
	return fields.some((field) => {
		const cleaned = stripPresentationMarkup(field).trim();
		const parts = labeledSupportParts(cleaned);
		if (structured.value == null || !structured.value.trim()) {
			return !parts.label && comparableText(cleaned) === expectedLabel;
		}
		if (parts.label !== expectedLabel) return false;
		return (
			comparableText(parts.body).replace(/[.!?]+$/u, '') === comparableText(structured.value).replace(/[.!?]+$/u, '') &&
			isCompleteLabelValueBody(parts.body)
		);
	});
}

function isCompleteLabelValueBody(value: string): boolean {
	const body = value.trim();
	if (!body || hasExplicitEllipsis(body) || endsInDanglingAbbreviation(body)) return false;
	const units = supportUnits(body);
	const finalUnit = units.at(-1) || '';
	return units.length > 0 && !isOpenEndedEvidenceUnit(finalUnit);
}

function isIncompleteClaimPrefix(claimText: string, item: EvidenceObject): boolean {
	const completeStatement = completeGroundedEvidenceStatement(item);
	const claimParts = labeledSupportParts(claimText);
	const evidenceParts = labeledSupportParts(completeStatement);
	if (!claimParts.body || !evidenceParts.body) return false;
	if (claimParts.label && evidenceParts.label && claimParts.label !== evidenceParts.label) return false;
	const claimUnits = supportUnits(claimParts.body);
	const evidenceUnits = supportUnits(evidenceParts.body);
	// A single exact token can intentionally be a complete answer label or
	// status ("Yes", "Status", or a short Unicode phrase). Prefix rejection is
	// for multi-unit visible claims; token-boundary support is enforced above.
	if (claimUnits.length <= 1 || claimUnits.length >= evidenceUnits.length) return false;
	for (let start = 0; start <= evidenceUnits.length - claimUnits.length; start += 1) {
		if (!claimUnits.every((unit, index) => unit === evidenceUnits[start + index])) continue;
		// A visible terminal sentence may be a complete clause inside a longer
		// source sentence. The exceptional case is an abbreviation/title ending:
		// "Toronto's Salsa on St." is still an open name, even though it has a dot.
		if (TERMINAL.test(claimText) && !endsInDanglingAbbreviation(claimText)) return false;
		return start + claimUnits.length < evidenceUnits.length;
	}
	return false;
}

function sourceSupportsText(source: string, statement: string): boolean {
	const sourceParts = labeledSupportParts(source);
	const statementParts = labeledSupportParts(statement);
	if (!sourceParts.body || !statementParts.body) return false;
	if (sourceParts.label && statementParts.label && sourceParts.label !== statementParts.label) return false;
	const claimUnits = supportUnits(statementParts.body);
	const sourceUnits = supportUnits(sourceParts.body);
	if (!claimUnits.length || !sourceUnits.length) return false;
	if (claimUnits.length === 1 && isLatinToken(claimUnits[0])) {
		return sourceUnits.some((unit) => unit === claimUnits[0]);
	}
	if (claimUnits.length === 1) return exactNonLatinPhrase(sourceParts.body, statementParts.body);
	for (let index = 0; index <= sourceUnits.length - claimUnits.length; index += 1) {
		if (claimUnits.every((unit, offset) => unit === sourceUnits[index + offset])) return true;
	}
	return false;
}

function supportText(value: string): string {
	return stripPresentationMarkup(value)
		.normalize('NFKC')
		.replace(/[“”‘’]/g, "'")
		.replace(/\s*\[\d+\](?!\()/g, ' ')
		.replace(/^\s*(?:#{1,6}\s+|[-*•]\s+|\d+[.)]\s+)/u, '')
		.replace(/\s*\|\s*/gu, ' ')
		.replace(/\s+/gu, ' ')
		.trim()
		.toLowerCase();
}

function labeledSupportParts(value: string): { label: string; body: string } {
	const normalized = supportText(value);
	const match = normalized.match(/^([^:\n]{2,80}):\s+(.+)$/u);
	if (!match || /https?$/iu.test(match[1]) || /[.!?]$/u.test(match[1])) {
		return { label: '', body: normalized };
	}
	return {
		label: comparableText(match[1]),
		body: match[2].trim()
	};
}

function supportUnits(value: string): string[] {
	return Array.from(
		value.matchAll(
		/https?:\/\/[^\s\])}>]+|(?:\d+\.)+\d+(?:-[\p{L}\p{N}][\p{L}\p{N}._-]*)?(?:\+[\p{L}\p{N}][\p{L}\p{N}._-]*)?|(?:[\p{L}]\.){2,}|[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*(?:-[\p{L}\p{N}]+)*/giu
		),
		(match) => match[0].replace(/[.,!?。！？]+$/u, '').toLowerCase()
	).filter(Boolean);
}

function isLatinToken(value: string): boolean {
	return /^[\p{Script=Latin}\p{N}]+(?:[.'’-][\p{Script=Latin}\p{N}]+)*$/u.test(value);
}

function exactNonLatinPhrase(source: string, statement: string): boolean {
	let offset = 0;
	while (offset <= source.length - statement.length) {
		const index = source.indexOf(statement, offset);
		if (index < 0) return false;
		const end = index + statement.length;
		const before = source[index - 1] || '';
		const after = source[end] || '';
		if (!/[\p{L}\p{N}]/u.test(before) && (!/[\p{L}\p{N}]/u.test(after) || /[^\p{L}\p{N}\s]$/u.test(statement))) return true;
		offset = index + 1;
	}
	return false;
}

function stripPresentationMarkup(value: string): string {
	return value
		.replace(/^\s*#{1,6}\s+/u, '')
		.replace(/^\s*(?:[-*•]|\d+[.)])\s+/u, '')
		.replace(/\*\*([^*\n]+)\*\*/g, '$1')
		.replace(/__([^_\n]+)__/g, '$1')
		.replace(/`([^`\n]+)`/g, '$1')
		.replace(/^\*([^*\n]+)\*$/u, '$1')
		.replace(/^_([^_\n]+)_$/u, '$1')
		.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1')
		.replace(/\|/g, ' ');
}

function comparableText(value: string): string {
	return stripPresentationMarkup(value)
		.normalize('NFKC')
		.toLowerCase()
		.replace(/[“”‘’]/g, "'")
		.replace(/[^\p{L}\p{N}]+/gu, ' ')
		.replace(/\s+/gu, ' ')
		.trim();
}

function escapeMarkdownText(value: string): string {
	return value.replace(/\\/g, '\\\\').replace(/([`*_{}\[\]<>#])/g, '\\$1');
}

function escapeUrl(value: string): string {
	return value.replace(/[()\\\s]/g, (character) => (character === ' ' ? '%20' : `\\${character}`));
}

function isSafeSourceUrl(value: string): boolean {
	return isCitationUrl(value);
}
