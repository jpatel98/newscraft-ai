/**
 * The story ledger as an append-only event log.
 *
 * Every change to a claim is an event; a claim's current state is the fold of
 * its events. `story_claims` keeps that folded state (the canonical record the
 * API reads), and `story_claim_variants` keeps every wording the model has used
 * for it. This module is pure so the fold and the per-turn planner can be
 * tested exhaustively; the db layer only persists what it returns.
 */
import { normalizeClaimText } from './claim-similarity';
import { LEDGER_MAX_CITATIONS, type LedgerClaim, type LedgerStatus } from './story-ledger';

export const CLAIM_EVENT_KINDS = [
	'asserted',
	'status_changed',
	'contradicted',
	'retracted',
	'check_opened',
	'check_closed'
] as const;
export type ClaimEventKind = (typeof CLAIM_EVENT_KINDS)[number];
export type ClaimEventActor = 'model' | 'person' | 'system';

export interface ClaimEvent {
	claimId: string;
	kind: ClaimEventKind;
	actor: ClaimEventActor;
	actorName: string;
	messageId: string | null;
	data: Record<string, unknown>;
	at: number;
}

/** The folded state of one canonical claim (mirrors the story_claims columns). */
export interface ClaimState {
	id: string;
	claim: string;
	status: LedgerStatus;
	attributedTo: string;
	citations: number[];
	date: string;
	needsCheck: boolean;
	/** Why the open check was opened ('model', 'contradicted', 'person', ...); null when no check is open. */
	checkReason: string | null;
	/** Claim ids this one conflicts with. */
	contradicts: string[];
	/** Every distinct normalized wording seen for this claim. */
	variants: string[];
	reviewedBy: string | null;
	reviewedAt: number | null;
	firstSeenMessageId: string | null;
	lastUpdatedMessageId: string | null;
	createdAt: number;
	updatedAt: number;
}

function stringData(data: Record<string, unknown>, key: string): string {
	const value = data[key];
	return typeof value === 'string' ? value : '';
}

function numberList(value: unknown): number[] {
	return Array.isArray(value) ? value.filter((n): n is number => Number.isSafeInteger(n) && n > 0) : [];
}

function mergeCitations(current: number[], next: number[]): number[] {
	const out = [...current];
	for (const n of next) if (!out.includes(n)) out.push(n);
	return out.slice(0, LEDGER_MAX_CITATIONS);
}

function emptyState(id: string): ClaimState {
	return {
		id,
		claim: '',
		status: 'unverified',
		attributedTo: '',
		citations: [],
		date: '',
		needsCheck: false,
		checkReason: null,
		contradicts: [],
		variants: [],
		reviewedBy: null,
		reviewedAt: null,
		firstSeenMessageId: null,
		lastUpdatedMessageId: null,
		createdAt: 0,
		updatedAt: 0
	};
}

/** Apply one event to a claim's state. Events for other claims are ignored. */
export function applyClaimEvent(state: ClaimState, event: ClaimEvent): ClaimState {
	if (event.claimId !== state.id) return state;
	const next: ClaimState = {
		...state,
		citations: [...state.citations],
		contradicts: [...state.contradicts],
		variants: [...state.variants],
		updatedAt: Math.max(state.updatedAt, event.at)
	};
	if (event.messageId) next.lastUpdatedMessageId = event.messageId;
	const data = event.data;
	switch (event.kind) {
		case 'asserted': {
			const text = stringData(data, 'text');
			if (!next.claim) {
				next.createdAt = event.at;
				next.firstSeenMessageId = event.messageId;
				const status = stringData(data, 'status');
				if (status) next.status = status as LedgerStatus;
			}
			// The latest wording is the one shown; every wording stays a variant.
			if (text) next.claim = text;
			const key = normalizeClaimText(text);
			if (key && !next.variants.includes(key)) next.variants.push(key);
			next.attributedTo = stringData(data, 'attributed_to') || next.attributedTo;
			next.citations = mergeCitations(next.citations, numberList(data.citations));
			next.date = stringData(data, 'date') || next.date;
			break;
		}
		case 'status_changed': {
			const to = stringData(data, 'to');
			if (to) next.status = to as LedgerStatus;
			if (event.actor === 'person') {
				next.reviewedBy = event.actorName || 'Someone';
				next.reviewedAt = event.at;
			}
			break;
		}
		case 'retracted':
			next.status = 'retracted';
			if (event.actor === 'person') {
				next.reviewedBy = event.actorName || 'Someone';
				next.reviewedAt = event.at;
			}
			break;
		case 'contradicted': {
			const by = stringData(data, 'by');
			if (by && !next.contradicts.includes(by)) next.contradicts.push(by);
			break;
		}
		case 'check_opened':
			next.needsCheck = true;
			next.checkReason = stringData(data, 'reason') || event.actor;
			if (event.actor === 'person') {
				next.reviewedBy = event.actorName || 'Someone';
				next.reviewedAt = event.at;
			}
			break;
		case 'check_closed':
			next.needsCheck = false;
			next.checkReason = null;
			if (event.actor === 'person') {
				next.reviewedBy = event.actorName || 'Someone';
				next.reviewedAt = event.at;
			}
			break;
	}
	return next;
}

/** Fold a claim's events (in log order) into its current state. */
export function foldClaim(id: string, events: readonly ClaimEvent[]): ClaimState {
	return events.reduce(applyClaimEvent, emptyState(id));
}

/** How the matcher resolved one incoming ledger claim. */
export type ClaimMatch =
	| { kind: 'same'; claimId: string; how: 'id' | 'text' | 'judge' | 'similar' }
	| { kind: 'contradicts'; claimId: string }
	| { kind: 'new' };

export interface TurnPlan {
	/** Canonical claims created this turn, in creation order. */
	created: ClaimState[];
	/** Every event this turn appends, in order. */
	events: ClaimEvent[];
	/** New wordings to record: claim id and the raw text. */
	variants: { claimId: string; text: string }[];
	/** The folded state of every claim this turn touched (created or existing). */
	touched: Map<string, ClaimState>;
	/** Incoming claims dropped because the per-chat cap was reached. */
	skipped: number;
	/** The canonical claim each incoming claim landed on (null when skipped). */
	resolved: (string | null)[];
}

export interface PlanTurnInput {
	active: readonly ClaimState[];
	incoming: readonly LedgerClaim[];
	/** Resolution for each incoming claim; references to `incoming:<i>` point at an earlier claim in this turn. */
	matches: readonly ClaimMatch[];
	messageId: string | null;
	at: number;
	newId: () => string;
	maxActive?: number;
}

const INCOMING_PREFIX = 'incoming:';

/**
 * Turn one answer's ledger block into events. Rules:
 * - A claim matched to an existing one adds a wording (`asserted`) to it rather
 *   than a new row, so a paraphrase never becomes a duplicate.
 * - A status the model gives that differs from the current one is a
 *   `status_changed` (or `retracted`) event; a claim a person reviewed keeps
 *   that person's status and check, whatever the model says.
 * - Checks open and close by explicit events. A model turn that no longer
 *   flags a claim records `check_closed` with actor model, so it is visible;
 *   it can only close a check the model itself opened.
 * - A contradiction creates its own claim and links both with `contradicted`.
 */
export function planTurn(input: PlanTurnInput): TurnPlan {
	const maxActive = input.maxActive ?? 400;
	const states = new Map<string, ClaimState>(input.active.map((claim) => [claim.id, claim]));
	const touched = new Map<string, ClaimState>();
	const created: ClaimState[] = [];
	const events: ClaimEvent[] = [];
	const variants: TurnPlan['variants'] = [];
	const resolvedIncoming: (string | null)[] = [];
	let activeCount = input.active.length;
	let skipped = 0;

	const emit = (claimId: string, kind: ClaimEventKind, data: Record<string, unknown>) => {
		const event: ClaimEvent = { claimId, kind, actor: 'model', actorName: '', messageId: input.messageId, data, at: input.at };
		events.push(event);
		const current = states.get(claimId);
		if (current) {
			const next = applyClaimEvent(current, event);
			states.set(claimId, next);
			touched.set(claimId, next);
		}
	};

	const resolveId = (claimId: string): string | null => {
		if (!claimId.startsWith(INCOMING_PREFIX)) return states.has(claimId) ? claimId : null;
		const index = Number(claimId.slice(INCOMING_PREFIX.length));
		return Number.isInteger(index) ? (resolvedIncoming[index] ?? null) : null;
	};

	const assertInto = (claimId: string, claim: LedgerClaim, isNew: boolean) => {
		const before = states.get(claimId)!;
		const key = normalizeClaimText(claim.claim);
		emit(claimId, 'asserted', {
			text: claim.claim,
			status: claim.status,
			attributed_to: claim.attributedTo,
			citations: claim.citations,
			date: claim.date
		});
		if (!before.variants.includes(key)) variants.push({ claimId, text: claim.claim });
		const after = states.get(claimId)!;
		const locked = after.reviewedAt != null;
		if (!isNew && !locked && claim.status !== after.status) {
			if (claim.status === 'retracted') emit(claimId, 'retracted', { from: after.status });
			else emit(claimId, 'status_changed', { from: after.status, to: claim.status });
		}
		const current = states.get(claimId)!;
		if (!locked && claim.needsCheck && !current.needsCheck) emit(claimId, 'check_opened', { reason: 'model' });
		// The model may only withdraw a flag it raised itself; a conflict or a person's flag stays open.
		if (!locked && !isNew && !claim.needsCheck && current.needsCheck && current.checkReason === 'model') {
			emit(claimId, 'check_closed', { reason: 'model' });
		}
	};

	const createClaim = (claim: LedgerClaim): string | null => {
		if (activeCount >= maxActive) {
			skipped += 1;
			return null;
		}
		const id = input.newId();
		const state: ClaimState = {
			...emptyState(id),
			createdAt: input.at,
			updatedAt: input.at
		};
		states.set(id, state);
		activeCount += 1;
		assertInto(id, claim, true);
		created.push(states.get(id)!);
		return id;
	};

	input.incoming.forEach((claim, index) => {
		const match = input.matches[index] ?? { kind: 'new' };
		let target: string | null = null;
		if (match.kind === 'same') {
			target = resolveId(match.claimId);
			if (target) assertInto(target, claim, false);
		}
		if (!target && match.kind === 'contradicts') {
			const other = resolveId(match.claimId);
			target = createClaim(claim);
			if (target && other && other !== target) {
				emit(target, 'contradicted', { by: other });
				emit(other, 'contradicted', { by: target });
				if (!states.get(target)!.needsCheck) emit(target, 'check_opened', { reason: 'contradicted' });
				const otherState = states.get(other)!;
				if (!otherState.needsCheck && otherState.reviewedAt == null) emit(other, 'check_opened', { reason: 'contradicted' });
			}
		}
		if (!target) target = createClaim(claim);
		resolvedIncoming[index] = target;
	});

	// Created claims carry their final folded state.
	for (let i = 0; i < created.length; i++) created[i] = states.get(created[i].id)!;
	for (const claim of created) touched.delete(claim.id);
	return { created, events, variants, touched, skipped, resolved: resolvedIncoming };
}

export interface ReviewInput {
	status?: LedgerStatus;
	needsCheck?: boolean;
}

/** A person's call on one claim, as events. Nothing is emitted for a no-op. */
export function planReview(state: ClaimState, review: ReviewInput, reviewer: string, at: number): ClaimEvent[] {
	const base = { claimId: state.id, actor: 'person' as const, actorName: reviewer, messageId: null, at };
	const events: ClaimEvent[] = [];
	if (review.status && review.status !== state.status) {
		events.push(
			review.status === 'retracted'
				? { ...base, kind: 'retracted', data: { from: state.status } }
				: { ...base, kind: 'status_changed', data: { from: state.status, to: review.status } }
		);
	}
	if (review.needsCheck === true && !state.needsCheck) events.push({ ...base, kind: 'check_opened', data: { reason: 'person' } });
	if (review.needsCheck === false && state.needsCheck) events.push({ ...base, kind: 'check_closed', data: { reason: 'person' } });
	// A review that changes nothing still records that a person settled the claim.
	if (!events.length) events.push({ ...base, kind: 'status_changed', data: { from: state.status, to: state.status } });
	return events;
}

export function incomingRef(index: number): string {
	return `${INCOMING_PREFIX}${index}`;
}
