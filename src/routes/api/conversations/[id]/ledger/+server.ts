import { error, json, type RequestHandler } from '@sveltejs/kit';
import { getConversation } from '$lib/server/db/conversations';
import { lastStoryClaimEventSeq, listStoryClaimEvents, listStoryClaims } from '$lib/server/db/story-claims';
import { toStoryLedgerChangeView, toStoryLedgerClaimView } from '$lib/server/story-ledger-view';

export const GET: RequestHandler = async ({ params, locals, url }) => {
	if (!locals.user) throw error(401, 'unauthorized');
	const conversationId = params.id?.trim();
	if (!conversationId) throw error(400, 'conversation id required');
	const conversation = await getConversation(locals.user.id, conversationId);
	if (!conversation) throw error(404, 'not found');
	const sinceParam = url.searchParams.get('since');
	const since = sinceParam !== null && /^\d{1,15}$/.test(sinceParam) ? Number(sinceParam) : null;
	const changes = since === null ? null : await listStoryClaimEvents(conversationId, since, 300);
	const lastSeq = since === null ? await lastStoryClaimEventSeq(conversationId) : Number(changes?.at(-1)?.seq ?? since);
	const rows = await listStoryClaims(conversationId);
	return json(
		{
			claims: rows.map(toStoryLedgerClaimView),
			last_seq: lastSeq,
			...(changes ? { changes: changes.map(toStoryLedgerChangeView) } : {})
		},
		{ headers: { 'cache-control': 'private, no-store' } }
	);
};
