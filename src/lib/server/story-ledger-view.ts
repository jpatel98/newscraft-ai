import type { StoryClaimRow } from '$lib/server/db/story-claims';
import type { StoryClaimEventRow } from '$lib/server/db/story-claims';
import type { StoryLedgerChangeView, StoryLedgerClaimView } from '$lib/utils/story-ledger-view';

export type { StoryLedgerClaimView };

export function toStoryLedgerChangeView(row: StoryClaimEventRow): StoryLedgerChangeView {
	return {
		seq: Number(row.seq),
		claim_id: row.claimId,
		kind: row.kind,
		actor: row.actor,
		actor_name: row.actorName,
		data: (row.data ?? {}) as Record<string, unknown>,
		at: new Date(Number(row.createdAt)).toISOString()
	};
}

export function toStoryLedgerClaimView(row: StoryClaimRow): StoryLedgerClaimView {
	return {
		id: row.id,
		claim: row.claim,
		status: row.status,
		attributed_to: row.attributedTo,
		citations: Array.isArray(row.citationNumbers) ? row.citationNumbers : [],
		date: row.publicationDate,
		needs_check: row.needsCheck,
		updated_at: new Date(Number(row.updatedAt)).toISOString(),
		reviewed_by: row.reviewedBy ?? null,
		reviewed_at: row.reviewedAt != null ? new Date(Number(row.reviewedAt)).toISOString() : null,
		first_seen_message_id: row.firstSeenMessageId,
		last_updated_message_id: row.lastUpdatedMessageId,
		suggested_status: (row.suggestedStatus ?? null) as StoryLedgerClaimView['suggested_status'],
		source_tier: row.sourceTier ?? null,
		corroboration: row.corroboration ?? 0,
		sources: (Array.isArray(row.evidence) ? row.evidence : []).map((s) => ({ n: s.n, url: s.url, host: s.host, tier: s.tier, date: s.date })),
		check_reason: row.needsCheck ? (row.checkReason ?? 'model') : null
	};
}
