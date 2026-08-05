import type { DocumentContext, ResearchRequestContract } from '@newscraft/shared';
import { isUsableEvidence, type EvidenceObject } from './evidence.js';

export type ContractHardRejectReason =
	| 'unsafe'
	| 'invalid'
	| 'private_document_leakage'
	| 'wrong_subject'
	| 'wrong_location'
	| 'wrong_time'
	| 'unsupported_citation';

export interface ContractHardReject {
	evidence_id?: string;
	url: string;
	reason: ContractHardRejectReason;
	detail: string;
}

export interface ContractSatisfactionInput {
	request: string;
	contract?: ResearchRequestContract;
	evidence: EvidenceObject[];
	documents?: DocumentContext[];
	answer?: string;
}

export interface ContractSatisfaction {
	accepted: EvidenceObject[];
	hard_rejects: ContractHardReject[];
	penalties: string[];
	gaps: string[];
	requested_count?: number;
	completeness: number;
	can_synthesize: boolean;
	likely_to_improve: boolean;
}

/**
 * Deterministic control-plane evaluation. Quality concerns such as weak
 * authority, missing metadata, thin diversity, and incomplete count coverage
 * are penalties or visible gaps; only safety, validity, private leakage,
 * clear request mismatches, and unsupported citation claims are hard rejects.
 */
export function evaluateContractSatisfaction(input: ContractSatisfactionInput): ContractSatisfaction {
	const hardRejects: ContractHardReject[] = [];
	const accepted: EvidenceObject[] = [];
	const penalties: string[] = [];
	const gaps: string[] = [];
	const contract = input.contract;

	for (const item of input.evidence) {
		if (item.ledger_status === 'rejected') {
			penalties.push(`contract-filtered discovery retained as context: ${item.title}`);
			continue;
		}
		const reason = hardRejectReason(item, input);
		if (reason) {
			hardRejects.push({
				evidence_id: item.evidence_id,
				url: item.source_url,
				reason: reason.reason,
				detail: reason.detail
			});
			continue;
		}
		accepted.push(item);
		if (!item.published_at && !item.updated_at && !item.event_at) penalties.push(`missing timestamp: ${item.title}`);
		if ((item.source_authority ?? 0.5) < 0.6) penalties.push(`weak source authority: ${item.title}`);
		if (item.readability === 'partial') penalties.push(`partial readability: ${item.title}`);
	}

	const usable = accepted.filter(isUsableEvidence);
	const requestedCount = contract?.requestedItemCount;
	if (!usable.length) gaps.push('no readable evidence currently supports the request');

	if (contract?.temporalWindow.kind === 'current' || contract?.temporalWindow.kind === 'relative') {
		if (!usable.some((item) => item.published_at || item.updated_at || item.event_at)) {
			gaps.push('current evidence still needs a source publication, update, or event timestamp');
		}
	}

	if (requestedCount && usable.length < requestedCount) {
		gaps.push(`coverage is ${usable.length} of ${requestedCount} requested items`);
	}

	if (contract?.namedOutlets?.length) {
		const missing = contract.namedOutlets.filter((outlet) => !usable.some((item) => sourceMatchesOutlet(item, outlet)));
		if (missing.length) gaps.push(`missing readable direct coverage from: ${missing.join(', ')}`);
	}

	if (contract?.requiredOutputFields.some((field) => /direct.*citation|article.*official/i.test(field))) {
		const directPages = usable.filter((item) => item.page_role === 'article' || item.page_role === 'official_live');
		if (!directPages.length) gaps.push('a direct article or official page is still required');
	}

	const completeness = requestedCount
		? Math.min(1, usable.length / Math.max(1, requestedCount))
		: usable.length
			? 1
			: 0;
	const criticalGap = gaps.some((gap) => /no readable|direct article|missing readable direct|timestamp/i.test(gap));
	const canSynthesize = usable.length > 0;
	return {
		accepted: usable,
		hard_rejects: hardRejects,
		penalties: [...new Set(penalties)],
		gaps: [...new Set(gaps)],
		...(requestedCount ? { requested_count: requestedCount } : {}),
		completeness,
		can_synthesize: canSynthesize,
		likely_to_improve: !canSynthesize || criticalGap || (requestedCount ? usable.length < requestedCount : false)
	};
}

function hardRejectReason(
	item: EvidenceObject,
	input: ContractSatisfactionInput
): { reason: ContractHardRejectReason; detail: string } | undefined {
	const url = item.source_url || '';
	if (isUnsafeUrl(url)) return { reason: 'unsafe', detail: 'source URL is not safe for newsroom evidence' };
	if (!isValidEvidenceUrl(item)) return { reason: 'invalid', detail: 'source URL is not a valid evidence URL' };
	if (item.source_kind === 'user_document' && !belongsToAttachedDocument(item, input.documents)) {
		return { reason: 'private_document_leakage', detail: 'private document evidence is not attached to this request' };
	}

	const explicit = (item.rejection_reason || '').toLowerCase();
	if (/wrong subject|wrong entity/.test(explicit)) return { reason: 'wrong_subject', detail: item.rejection_reason || 'wrong subject' };
	if (/wrong location/.test(explicit)) return { reason: 'wrong_location', detail: item.rejection_reason || 'wrong location' };
	if (/wrong time|out of window/.test(explicit)) return { reason: 'wrong_time', detail: item.rejection_reason || 'wrong time' };
	if (/(unsupported|no usable|unreadable|blocked)/.test(explicit) && !isUsableEvidence(item)) {
		return { reason: 'unsupported_citation', detail: item.rejection_reason || 'evidence cannot support a factual citation' };
	}

	const contract = input.contract;
	if (contract?.location && item.location && !sameLocation(item.location, contract.location)) {
		return { reason: 'wrong_location', detail: `evidence location ${item.location} does not match ${contract.location}` };
	}
	if (contract?.subject && item.topic && !subjectOverlap(item.topic, contract.subject) && !subjectOverlap(item.title, contract.subject)) {
		return { reason: 'wrong_subject', detail: 'evidence subject does not match the authoritative request' };
	}
	if (input.answer && hasUnsupportedCitation(input.answer, input.evidence)) {
		return { reason: 'unsupported_citation', detail: 'answer contains a citation marker with no ledger entry' };
	}
	return undefined;
}

function isUnsafeUrl(value: string): boolean {
	try {
		const parsed = new URL(value);
		return /(^|\.)(?:reddit\.com|wikipedia\.org)$/i.test(parsed.hostname) || /^(?:javascript|data|file):$/i.test(parsed.protocol);
	} catch {
		return false;
	}
}

function isValidEvidenceUrl(item: EvidenceObject): boolean {
	if (item.source_kind === 'user_document') return true;
	return /^(?:https?:\/\/|document:\/\/|attachment:\/\/|newsroom:\/\/)/i.test(item.source_url);
}

function belongsToAttachedDocument(item: EvidenceObject, documents: DocumentContext[] | undefined): boolean {
	if (!documents?.length) return false;
	return documents.some((document) => {
		const id = encodeURIComponent(document.id);
		return item.source_url.includes(document.id) || item.source_url.includes(id) || Boolean(document.downloadUrl && item.source_url.startsWith(document.downloadUrl));
	});
}

function hasUnsupportedCitation(answer: string, evidence: EvidenceObject[]): boolean {
	const accepted = new Set(evidence.map((item) => item.citation_number).filter((value): value is number => Number.isInteger(value)));
	return [...answer.matchAll(/\[(\d+)\]/g)].some((match) => !accepted.has(Number(match[1])));
}

function sourceMatchesOutlet(item: EvidenceObject, outlet: string): boolean {
	const terms = normalize(outlet).split(' ').filter((term) => term.length > 1 && !['the', 'news'].includes(term));
	const host = (() => {
		try {
			return new URL(item.source_url).hostname.replace(/^www\./, '').toLowerCase();
		} catch {
			return '';
		}
	})();
	return terms.length > 0 && terms.some((term) => host.includes(term) || normalize(item.source_name).includes(term));
}

function sameLocation(left: string, right: string): boolean {
	const a = normalize(left);
	const b = normalize(right);
	return a === b || a.includes(b) || b.includes(a);
}

function subjectOverlap(left: string, right: string): boolean {
	const ignored = new Set(['about', 'after', 'and', 'city', 'for', 'from', 'latest', 'news', 'the', 'today', 'with']);
	const a = new Set(normalize(left).split(' ').filter((term) => term.length >= 4 && !ignored.has(term)));
	const b = new Set(normalize(right).split(' ').filter((term) => term.length >= 4 && !ignored.has(term)));
	return [...a].some((term) => b.has(term));
}

function normalize(value: string): string {
	return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}
