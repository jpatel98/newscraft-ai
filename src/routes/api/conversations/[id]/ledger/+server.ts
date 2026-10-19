import { error, json, type RequestHandler } from '@sveltejs/kit';
import { getConversation } from '$lib/server/db/conversations';
import { lastStoryClaimEventSeq, listStoryClaimEvents, listStoryClaims } from '$lib/server/db/story-claims';
import { toStoryLedgerChangeView, toStoryLedgerClaimView } from '$lib/server/story-ledger-view';

/**
 * The chat's live claims, plus `last_seq` (the newest ledger event). With
 * `?since=<seq>` it also returns `changes`: every event after that point, so
 * the pane can show what changed since the person last looked.
 */
export const GET: RequestHandler = async ({ params, locals, url }) => {
	if (!locals.user) throw error(401, 'unauthorized');
	const conversationId = params.id?.trim();
	if (!conversationId) throw error(400, 'conversation id required');
	const conversation = await getConversation(locals.user.id, conversationId);
	if (!conversation) throw error(404, 'not found');
	const sinceParam = url.searchParams.get('since');
	const since = sinceParam !== null && /^\d{1,15}$/.test(sinceParam) ? Number(sinceParam) : null;
	const [rows, lastSeq, changes] = await Promise.all([
		listStoryClaims(conversationId),
		lastStoryClaimEventSeq(conversationId),
		since === null ? Promise.resolve(null) : listStoryClaimEvents(conversationId, since, 300)
	]);
	return json(
		{
			claims: rows.map(toStoryLedgerClaimView),
			last_seq: lastSeq,
			...(changes ? { changes: changes.map(toStoryLedgerChangeView) } : {})
		},
		{ headers: { 'cache-control': 'private, no-store' } }
	);
};
