import { error, json, type RequestHandler } from '@sveltejs/kit';
import { getConversation } from '$lib/server/db/conversations';
import { listStoryClaims } from '$lib/server/db/story-claims';
import { toStoryLedgerClaimView } from '$lib/server/story-ledger-view';

export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) throw error(401, 'unauthorized');
	const conversationId = params.id?.trim();
	if (!conversationId) throw error(400, 'conversation id required');
	const conversation = await getConversation(locals.user.id, conversationId);
	if (!conversation) throw error(404, 'not found');
	const rows = await listStoryClaims(conversationId);
	return json(
		{ claims: rows.map(toStoryLedgerClaimView) },
		{ headers: { 'cache-control': 'private, no-store' } }
	);
};
