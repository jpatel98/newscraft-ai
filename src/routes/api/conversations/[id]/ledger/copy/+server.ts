import { error, json, type RequestHandler } from '@sveltejs/kit';
import { getConversation } from '$lib/server/db/conversations';
import { listStoryClaims } from '$lib/server/db/story-claims';
import { workerLedgerCopy } from '$lib/server/ledger-copy';
import { toStoryLedgerClaimView } from '$lib/server/story-ledger-view';
import { checkCopy, COPY_FORMATS, copyRequest, renderCopy, type CopyFormat } from '$lib/utils/ledger-copy';

/**
 * Anchor intro, VO or reader written from the chat's ledger. Only air-ready
 * claims go to the writer; every sentence is checked for its claims'
 * attribution, and a lost attribution is put back before the copy is returned.
 */
export const POST: RequestHandler = async ({ params, locals, request }) => {
	if (!locals.user) throw error(401, 'unauthorized');
	const conversationId = params.id?.trim();
	if (!conversationId) throw error(400, 'conversation id required');
	let format: CopyFormat;
	try {
		const body = (await request.json()) as { format?: unknown };
		if (!COPY_FORMATS.includes(body?.format as CopyFormat)) throw new Error('format');
		format = body.format as CopyFormat;
	} catch {
		throw error(400, 'format must be intro, vo or reader');
	}
	const conversation = await getConversation(locals.user.id, conversationId);
	if (!conversation) throw error(404, 'not found');
	const claims = (await listStoryClaims(conversationId)).map(toStoryLedgerClaimView);
	const { request: offered, byRef, withheld } = copyRequest(claims);
	if (!offered.length) throw error(409, 'Nothing in this story is ready for air yet.');
	const lines = await workerLedgerCopy(format, conversation.title ?? '', offered);
	if (!lines) throw error(503, 'Copy writing is unavailable right now. Try again shortly.');
	const checked = checkCopy(lines, byRef, withheld);
	if (!checked.lines.length) throw error(502, 'The copy came back empty. Try again.');
	return json(
		{
			format,
			text: renderCopy(format, checked.lines),
			repaired: checked.repaired,
			dropped: checked.dropped,
			withheld: withheld.length
		},
		{ headers: { 'cache-control': 'private, no-store' } }
	);
};
