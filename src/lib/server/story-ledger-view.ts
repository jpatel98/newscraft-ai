import type { StoryClaimRow } from '$lib/server/db/story-claims';
import type { StoryLedgerClaimView } from '$lib/utils/story-ledger-view';

export type { StoryLedgerClaimView };

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
		first_seen_message_id: row.firstSeenMessageId,
		last_updated_message_id: row.lastUpdatedMessageId
	};
}
