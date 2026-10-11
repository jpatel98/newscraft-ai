import { and, desc, eq, isNull } from 'drizzle-orm';
import { newId } from '$lib/utils/id';
import type { LedgerClaim } from '$lib/utils/story-ledger';
import { db } from './index';
import { storyClaims } from './schema';

export type StoryClaimRow = typeof storyClaims.$inferSelect;

/** Upper bound on live (non-superseded) claims kept per conversation. */
const MAX_ACTIVE_CLAIMS = 400;

function comparable(text: string): string {
	return text.replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Apply one turn's ledger claims to a conversation.
 *
 * - A claim whose text matches a live claim (case-insensitively), or that names
 *   `supersedes` with identical text, updates that row in place.
 * - A claim naming `supersedes` with different text becomes a new row (or
 *   updates a text-matching row) and the old row is marked `superseded_by`.
 * - Otherwise a new row is inserted.
 * Empty attribution, date, and citations never erase what is already stored.
 */
export async function upsertStoryClaims(
	conversationId: string,
	messageId: string | null,
	claims: readonly LedgerClaim[],
	now: number = Date.now()
): Promise<{ inserted: number; updated: number }> {
	if (!claims.length) return { inserted: 0, updated: 0 };
	return db.transaction(async (tx: any) => {
		const active = (await tx
			.select()
			.from(storyClaims)
			.where(and(eq(storyClaims.conversationId, conversationId), isNull(storyClaims.supersededBy)))
			.orderBy(desc(storyClaims.updatedAt))
			.limit(MAX_ACTIVE_CLAIMS + 50)) as StoryClaimRow[];
		let inserted = 0;
		let updated = 0;

		const apply = async (row: StoryClaimRow, claim: LedgerClaim): Promise<void> => {
			const patch = {
				status: claim.status,
				attributedTo: claim.attributedTo || row.attributedTo,
				citationNumbers: claim.citations.length ? claim.citations : row.citationNumbers,
				publicationDate: claim.date || row.publicationDate,
				needsCheck: claim.needsCheck,
				lastUpdatedMessageId: messageId ?? row.lastUpdatedMessageId,
				updatedAt: now
			};
			await tx.update(storyClaims).set(patch).where(eq(storyClaims.id, row.id));
			Object.assign(row, patch);
			updated += 1;
		};

		for (const claim of claims) {
			const key = comparable(claim.claim);
			const named = claim.supersedes ? active.find((row) => row.id === claim.supersedes) : undefined;
			const textMatch = active.find((row) => comparable(row.claim) === key);

			if (named && textMatch === named) {
				await apply(named, claim);
				continue;
			}
			let target = textMatch;
			if (!target) {
				if (active.length >= MAX_ACTIVE_CLAIMS) continue;
				const row: StoryClaimRow = {
					id: newId(),
					conversationId,
					claim: claim.claim,
					status: claim.status,
					attributedTo: claim.attributedTo,
					citationNumbers: claim.citations,
					publicationDate: claim.date,
					needsCheck: claim.needsCheck,
					firstSeenMessageId: messageId,
					lastUpdatedMessageId: messageId,
					supersededBy: null,
					createdAt: now,
					updatedAt: now
				};
				await tx.insert(storyClaims).values(row);
				active.unshift(row);
				inserted += 1;
				target = row;
			} else {
				await apply(target, claim);
			}
			if (named && named !== target) {
				await tx
					.update(storyClaims)
					.set({ supersededBy: target.id, updatedAt: now })
					.where(eq(storyClaims.id, named.id));
				active.splice(active.indexOf(named), 1);
			}
		}
		return { inserted, updated };
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

/** Remove a conversation's ledger. Deleting the conversation already cascades. */
export async function deleteStoryClaims(conversationId: string): Promise<void> {
	await db.delete(storyClaims).where(eq(storyClaims.conversationId, conversationId));
}
