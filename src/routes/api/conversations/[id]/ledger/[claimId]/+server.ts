import { error, json, type RequestHandler } from '@sveltejs/kit';
import { getConversation } from '$lib/server/db/conversations';
import { reviewStoryClaim, type StoryClaimReview } from '$lib/server/db/story-claims';
import { toStoryLedgerClaimView } from '$lib/server/story-ledger-view';
import { LEDGER_STATUSES, type LedgerStatus } from '$lib/utils/story-ledger';

const STATUS_SET: ReadonlySet<string> = new Set(LEDGER_STATUSES);

/** A producer or reporter settles one ledger claim: { status?, needs_check? }. */
export const PATCH: RequestHandler = async ({ params, locals, request }) => {
	if (!locals.user) throw error(401, 'unauthorized');
	const conversationId = params.id?.trim();
	const claimId = params.claimId?.trim();
	if (!conversationId || !claimId) throw error(400, 'conversation and claim id required');

	let body: Record<string, unknown>;
	try {
		const parsed = await request.json();
		if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not an object');
		body = parsed as Record<string, unknown>;
	} catch {
		throw error(400, 'invalid json');
	}
	const review: StoryClaimReview = {};
	if (body.status !== undefined) {
		if (typeof body.status !== 'string' || !STATUS_SET.has(body.status)) throw error(400, 'invalid status');
		review.status = body.status as LedgerStatus;
	}
	if (body.needs_check !== undefined) {
		if (typeof body.needs_check !== 'boolean') throw error(400, 'invalid needs_check');
		review.needsCheck = body.needs_check;
	}
	if (!review.status && review.needsCheck === undefined) throw error(400, 'nothing to change');

	const conversation = await getConversation(locals.user.id, conversationId);
	if (!conversation) throw error(404, 'not found');
	const reviewer = (locals.user.name || locals.user.email || 'Someone').trim().slice(0, 120);
	const row = await reviewStoryClaim(conversationId, claimId, review, reviewer);
	if (!row) throw error(404, 'claim not found');
	return json({ claim: toStoryLedgerClaimView(row) }, { headers: { 'cache-control': 'private, no-store' } });
};
