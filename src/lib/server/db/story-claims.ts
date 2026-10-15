import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { newId } from '$lib/utils/id';
import {
	planReview,
	planTurn,
	type ClaimEvent,
	type ClaimMatch,
	type ClaimState
} from '$lib/utils/claim-events';
import type { CitedPage } from '$lib/utils/claim-evidence';
import { matchIncoming, type ClaimJudge } from '$lib/utils/claim-matcher';
import { normalizeClaimText } from '$lib/utils/claim-similarity';
import type { SourceTier } from '$lib/utils/source-tiers';
import type { LedgerClaim, LedgerStatus } from '$lib/utils/story-ledger';
import { db } from './index';
import { storyClaimEvents, storyClaims, storyClaimVariants } from './schema';

export type StoryClaimRow = typeof storyClaims.$inferSelect;

/** Upper bound on live (non-superseded) claims kept per conversation. */
const MAX_ACTIVE_CLAIMS = 400;

function toState(row: StoryClaimRow, variants: string[], contradicts: string[], checkReason: string | null = null): ClaimState {
	return {
		id: row.id,
		claim: row.claim,
		status: row.status as LedgerStatus,
		suggestedStatus: (row.suggestedStatus ?? row.status) as LedgerStatus,
		attributedTo: row.attributedTo,
		citations: Array.isArray(row.citationNumbers) ? row.citationNumbers : [],
		evidence: Array.isArray(row.evidence) ? row.evidence : [],
		sourceTier: (row.sourceTier ?? null) as SourceTier | null,
		corroboration: row.corroboration ?? 0,
		date: row.publicationDate,
		needsCheck: row.needsCheck,
		checkReason: row.needsCheck ? (checkReason ?? 'model') : null,
		contradicts,
		variants: [...new Set([normalizeClaimText(row.claim), ...variants.map(normalizeClaimText)])],
		reviewedBy: row.reviewedBy ?? null,
		reviewedAt: row.reviewedAt ?? null,
		firstSeenMessageId: row.firstSeenMessageId,
		lastUpdatedMessageId: row.lastUpdatedMessageId,
		createdAt: Number(row.createdAt),
		updatedAt: Number(row.updatedAt)
	};
}

function rowPatch(state: ClaimState) {
	return {
		claim: state.claim.slice(0, 240),
		status: state.status,
		suggestedStatus: state.suggestedStatus,
		sourceTier: state.sourceTier,
		corroboration: state.corroboration,
		evidence: state.evidence,
		attributedTo: state.attributedTo,
		citationNumbers: state.citations,
		publicationDate: state.date,
		needsCheck: state.needsCheck,
		lastUpdatedMessageId: state.lastUpdatedMessageId,
		reviewedBy: state.reviewedBy,
		reviewedAt: state.reviewedAt,
		updatedAt: state.updatedAt
	};
}

/** Live claims of a conversation as matcher/planner state (with wordings and conflicts). */
async function loadActiveStates(client: any, conversationId: string): Promise<ClaimState[]> {
	const rows = (await client
		.select()
		.from(storyClaims)
		.where(and(eq(storyClaims.conversationId, conversationId), isNull(storyClaims.supersededBy)))
		.orderBy(desc(storyClaims.updatedAt))
		.limit(MAX_ACTIVE_CLAIMS + 50)) as StoryClaimRow[];
	if (!rows.length) return [];
	const ids = rows.map((row) => row.id);
	const variants = (await client
		.select({ claimId: storyClaimVariants.claimId, text: storyClaimVariants.text })
		.from(storyClaimVariants)
		.where(inArray(storyClaimVariants.claimId, ids))) as { claimId: string; text: string }[];
	const linked = (await client
		.select({ claimId: storyClaimEvents.claimId, kind: storyClaimEvents.kind, data: storyClaimEvents.data })
		.from(storyClaimEvents)
		.where(
			and(
				inArray(storyClaimEvents.claimId, ids),
				inArray(storyClaimEvents.kind, ['contradicted', 'check_opened', 'check_closed'])
			)
		)
		.orderBy(asc(storyClaimEvents.seq))) as { claimId: string; kind: string; data: Record<string, unknown> }[];
	const variantsBy = new Map<string, string[]>();
	for (const variant of variants) variantsBy.set(variant.claimId, [...(variantsBy.get(variant.claimId) ?? []), variant.text]);
	const conflictsBy = new Map<string, string[]>();
	const reasonBy = new Map<string, string | null>();
	for (const event of linked) {
		if (event.kind === 'contradicted') {
			const by = typeof event.data?.by === 'string' ? event.data.by : '';
			if (by) conflictsBy.set(event.claimId, [...(conflictsBy.get(event.claimId) ?? []), by]);
		} else {
			reasonBy.set(event.claimId, event.kind === 'check_opened' ? String(event.data?.reason || 'model') : null);
		}
	}
	return rows.map((row) =>
		toState(row, variantsBy.get(row.id) ?? [], conflictsBy.get(row.id) ?? [], reasonBy.get(row.id) ?? null)
	);
}

function eventRow(conversationId: string, event: ClaimEvent) {
	return {
		id: newId(),
		conversationId,
		claimId: event.claimId,
		kind: event.kind,
		actor: event.actor,
		actorName: event.actorName,
		messageId: event.messageId,
		data: event.data,
		createdAt: event.at
	};
}

export interface UpsertResult {
	inserted: number;
	updated: number;
	events: number;
	judged: number;
	judgeAvailable: boolean;
}

/**
 * Apply one turn's ledger claims to a conversation.
 *
 * Each incoming claim is matched against the chat's live claims (explicit id,
 * exact wording, then embedding candidates settled by `judge`). A match adds a
 * wording and events to that claim; a conflict creates a linked claim; anything
 * else is new. Every change is an appended event and story_claims is updated
 * to the folded state, so the API shape is unchanged. A claim a person
 * reviewed keeps that person's status and check.
 */
export async function upsertStoryClaims(
	conversationId: string,
	messageId: string | null,
	claims: readonly LedgerClaim[],
	now: number = Date.now(),
	judge: ClaimJudge | null = null,
	sources?: ReadonlyMap<number, CitedPage>
): Promise<UpsertResult> {
	if (!claims.length) return { inserted: 0, updated: 0, events: 0, judged: 0, judgeAvailable: false };
	// The judge is a network call: match outside the transaction, then re-plan
	// inside it against fresh rows (a vanished match target just becomes new).
	const snapshot = await loadActiveStates(db, conversationId);
	const matched = await matchIncoming(snapshot, claims, judge);
	return db.transaction(async (tx: any) => {
		await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${'story-ledger:' + conversationId}))`);
		const active = await loadActiveStates(tx, conversationId);
		const plan = planTurn({
			active,
			incoming: claims,
			matches: matched.matches as ClaimMatch[],
			messageId,
			at: now,
			newId,
			maxActive: MAX_ACTIVE_CLAIMS,
			sources
		});
		for (const state of plan.created) {
			await tx.insert(storyClaims).values({
				id: state.id,
				conversationId,
				firstSeenMessageId: state.firstSeenMessageId,
				supersededBy: null,
				createdAt: state.createdAt,
				...rowPatch(state)
			});
		}
		for (const state of plan.touched.values()) {
			await tx.update(storyClaims).set(rowPatch(state)).where(eq(storyClaims.id, state.id));
		}
		if (plan.events.length) await tx.insert(storyClaimEvents).values(plan.events.map((event) => eventRow(conversationId, event)));
		for (const variant of plan.variants) {
			await tx
				.insert(storyClaimVariants)
				.values({
					id: newId(),
					conversationId,
					claimId: variant.claimId,
					text: variant.text.slice(0, 240),
					messageId,
					createdAt: now
				})
				.onConflictDoNothing();
		}
		return {
			inserted: plan.created.length,
			updated: plan.touched.size,
			events: plan.events.length,
			judged: matched.judged.length,
			judgeAvailable: matched.judgeAvailable
		};
	});
}

export interface StoryClaimReview {
	status?: LedgerStatus;
	needsCheck?: boolean;
}

/**
 * A person settles one live claim: sets its status and/or needs-check flag and
 * records who and when, as events. Returns the updated row, or null when the
 * claim is not a live claim of this conversation.
 */
export async function reviewStoryClaim(
	conversationId: string,
	claimId: string,
	review: StoryClaimReview,
	reviewer: string,
	now: number = Date.now()
): Promise<StoryClaimRow | null> {
	return db.transaction(async (tx: any) => {
		await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${'story-ledger:' + conversationId}))`);
		const [row] = (await tx
			.select()
			.from(storyClaims)
			.where(
				and(
					eq(storyClaims.id, claimId),
					eq(storyClaims.conversationId, conversationId),
					isNull(storyClaims.supersededBy)
				)
			)
			.limit(1)) as StoryClaimRow[];
		if (!row) return null;
		const before = toState(row, [], []);
		const events = planReview(before, review, reviewer, now);
		const patch = {
			...(review.status ? { status: review.status } : {}),
			...(typeof review.needsCheck === 'boolean' ? { needsCheck: review.needsCheck } : {}),
			reviewedBy: reviewer,
			reviewedAt: now,
			updatedAt: now
		};
		await tx.update(storyClaims).set(patch).where(eq(storyClaims.id, row.id));
		await tx.insert(storyClaimEvents).values(events.map((event) => eventRow(conversationId, event)));
		return { ...row, ...patch };
	});
}

/** Live claims for a conversation, most recently updated first. */
export async function listStoryClaims(conversationId: string, limit = 200): Promise<StoryClaimRow[]> {
	return (await db
		.select()
		.from(storyClaims)
		.where(and(eq(storyClaims.conversationId, conversationId), isNull(storyClaims.supersededBy)))
		.orderBy(desc(storyClaims.updatedAt), desc(storyClaims.id))
		.limit(Math.max(1, Math.min(limit, 500)))) as StoryClaimRow[];
}

export type StoryClaimEventRow = typeof storyClaimEvents.$inferSelect;

/** A conversation's ledger events in log order (optionally after a sequence number). */
export async function listStoryClaimEvents(conversationId: string, afterSeq = 0, limit = 1000): Promise<StoryClaimEventRow[]> {
	return (await db
		.select()
		.from(storyClaimEvents)
		.where(and(eq(storyClaimEvents.conversationId, conversationId), sql`${storyClaimEvents.seq} > ${afterSeq}`))
		.orderBy(asc(storyClaimEvents.seq))
		.limit(Math.max(1, Math.min(limit, 5000)))) as StoryClaimEventRow[];
}

/** Remove a conversation's ledger. Deleting the conversation already cascades. */
export async function deleteStoryClaims(conversationId: string): Promise<void> {
	await db.delete(storyClaims).where(eq(storyClaims.conversationId, conversationId));
}
