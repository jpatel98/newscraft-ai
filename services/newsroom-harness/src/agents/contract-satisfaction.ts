import {
	researchRequirementsForContract,
	type DocumentContext,
	type ResearchRequirementCompletionState,
	type ResearchRequestContract
} from '@newscraft/shared';
import { classifyEvidencePageRole, isUsableEvidence, type EvidenceObject } from './evidence.js';
import { matchEvidenceToRequirement } from './research-policy.js';

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

export interface RequirementExecutionState {
	executedActions?: number;
	skippedActions?: number;
	exhausted?: boolean;
}

export interface RequirementCoverage {
	requirement_id: string;
	label: string;
	requested_count: number;
	accepted_count: number;
	gaps: string[];
	state: ResearchRequirementCompletionState;
	likely_to_improve: boolean;
	executed_actions: number;
	skipped_actions: number;
	budget_exhausted: boolean;
}

export interface ContractSatisfactionInput {
	request: string;
	contract?: ResearchRequestContract;
	evidence: EvidenceObject[];
	documents?: DocumentContext[];
	answer?: string;
	requirementExecution?: Record<string, RequirementExecutionState>;
	sharedBudgetExhausted?: boolean;
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
	requirement_coverage: RequirementCoverage[];
}

/**
 * Deterministic control-plane evaluation. A multi-requirement turn is only
 * complete when each independently requested lane is complete; one usable
 * source cannot satisfy the whole assignment.
 */
export function evaluateContractSatisfaction(input: ContractSatisfactionInput): ContractSatisfaction {
	const hardRejects: ContractHardReject[] = [];
	const accepted: EvidenceObject[] = [];
	const penalties: string[] = [];
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
	const requirements = contract ? researchRequirementsForContract(contract) : [];
	const requirementCoverage = requirements.map((requirement) => {
		const execution = input.requirementExecution?.[requirement.id] || {};
		const laneEvidence = usable.filter((item) => evidenceBelongsToRequirement(item, requirement, contract));
		const uniqueStories = new Set(laneEvidence.map((item) => item.story_cluster_id || item.canonical_url));
		const acceptedCount = uniqueStories.size;
		const gaps: string[] = [];
		if (!acceptedCount) {
			gaps.push(
				requirements.length === 1
					? 'no readable evidence currently supports the request'
					: 'no readable evidence currently supports this requirement'
			);
		}
		if (acceptedCount < requirement.requestedItemCount) {
			gaps.push(`coverage is ${acceptedCount} of ${requirement.requestedItemCount} requested items`);
		}
		const missingOutlets = requirement.namedOutlets.filter(
			(outlet) => !laneEvidence.some((item) => sourceMatchesOutlet(item, outlet))
		);
		if (missingOutlets.length) gaps.push(`missing readable direct coverage from: ${missingOutlets.join(', ')}`);
		const directRequired = requirement.outputExpectations.some((field) => /direct.*citation|article.*official/i.test(field)) ||
			contract?.requiredOutputFields.some((field) => /direct.*citation|article.*official/i.test(field));
		if (directRequired && !laneEvidence.some((item) => item.page_role === 'article' || item.page_role === 'official_live')) {
			gaps.push('a direct article or official page is still required');
		}
		const terminal = Boolean(execution.exhausted || input.sharedBudgetExhausted);
		const state = completionState({
			acceptedCount,
			requestedCount: requirement.requestedItemCount,
			gaps,
			executedActions: execution.executedActions || 0,
			skippedActions: execution.skippedActions || 0,
			terminal
		});
		return {
			requirement_id: requirement.id,
			label: requirement.label,
			requested_count: requirement.requestedItemCount,
			accepted_count: acceptedCount,
			gaps: [...new Set(gaps)],
			state,
			likely_to_improve: state === 'pending' || state === 'partial' || state === 'incomplete',
			executed_actions: execution.executedActions || 0,
			skipped_actions: execution.skippedActions || 0,
			budget_exhausted: Boolean(execution.exhausted || input.sharedBudgetExhausted)
		};
	});

	const gaps: string[] = [];
	if (!requirements.length && !usable.length) gaps.push('no readable evidence currently supports the request');
	for (const coverage of requirementCoverage) {
		for (const gap of coverage.gaps) gaps.push(requirementCoverage.length === 1 ? gap : `${coverage.label}: ${gap}`);
	}
	if (contract && (contract.temporalWindow.kind === 'current' || contract.temporalWindow.kind === 'relative') && !usable.some((item) => item.published_at || item.updated_at || item.event_at)) {
		gaps.push('current evidence still needs a source publication, update, or event timestamp');
	}

	const requestedCount = contract?.requestedItemCount;
	const totalRequested = requirementCoverage.reduce((total, coverage) => total + coverage.requested_count, 0) || requestedCount || 0;
	const totalAccepted = requirementCoverage.reduce((total, coverage) => total + coverage.accepted_count, 0) || usable.length;
	const completeness = totalRequested ? Math.min(1, totalAccepted / Math.max(1, totalRequested)) : usable.length ? 1 : 0;
	const allSatisfied = requirementCoverage.length > 0 && requirementCoverage.every((coverage) => coverage.state === 'satisfied');
	const criticalGap = gaps.some((gap) => /no readable|direct article|missing readable direct|timestamp|wrong location/i.test(gap));
	const canSynthesize = usable.length > 0 || allSatisfied || Boolean(input.sharedBudgetExhausted);
	return {
		accepted: usable,
		hard_rejects: hardRejects,
		penalties: [...new Set(penalties)],
		gaps: [...new Set(gaps)],
		...(requestedCount ? { requested_count: requestedCount } : {}),
		completeness,
		can_synthesize: canSynthesize,
		likely_to_improve: !allSatisfied && (Boolean(input.sharedBudgetExhausted) ? false : requirementCoverage.some((coverage) => coverage.likely_to_improve) || criticalGap),
		requirement_coverage: requirementCoverage
	};
}

function completionState(input: {
	acceptedCount: number;
	requestedCount: number;
	gaps: string[];
	executedActions: number;
	skippedActions: number;
	terminal: boolean;
}): ResearchRequirementCompletionState {
	if (input.acceptedCount >= input.requestedCount && !input.gaps.some((gap) => /missing readable|direct article/i.test(gap))) return 'satisfied';
	if (input.terminal) return input.acceptedCount ? 'exhausted' : input.executedActions ? 'incomplete' : 'skipped';
	if (input.acceptedCount > 0) return 'partial';
	if (input.executedActions > 0) return 'incomplete';
	if (input.skippedActions > 0) return 'skipped';
	return 'pending';
}

function evidenceBelongsToRequirement(
	item: EvidenceObject,
	requirement: ReturnType<typeof researchRequirementsForContract>[number],
	contract: ResearchRequestContract | undefined
): boolean {
	if (item.requirement_ids?.includes(requirement.id)) return true;
	if (!contract) return false;
	const role = item.page_role || classifyEvidencePageRole(item.source_url, item.title, item.source_kind);
	return matchEvidenceToRequirement(item, role, requirement, contract).accepted;
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

	if (input.contract?.requirements?.length) {
		const role = item.page_role || classifyEvidencePageRole(item.source_url, item.title, item.source_kind);
		if (!input.contract.requirements.some((requirement) => matchEvidenceToRequirement(item, role, requirement, input.contract!).accepted)) {
			return { reason: 'wrong_subject', detail: 'evidence does not match any requested requirement' };
		}
	} else {
		const contract = input.contract;
		if (contract?.location && item.location && !sameLocation(item.location, contract.location)) {
			return { reason: 'wrong_location', detail: `evidence location ${item.location} does not match ${contract.location}` };
		}
		if (contract?.subject && item.topic && !subjectOverlap(item.topic, contract.subject) && !subjectOverlap(item.title, contract.subject)) {
			return { reason: 'wrong_subject', detail: 'evidence subject does not match the authoritative request' };
		}
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
