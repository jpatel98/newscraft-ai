import { error, json, type RequestHandler } from '@sveltejs/kit';
import { generateConversationTitle } from '$lib/server/conversation-title';
import { getConversation } from '$lib/server/db/conversations';

export const POST: RequestHandler = async ({ locals, params }) => {
	if (!locals.user) throw error(401, 'unauthorized');
	const id = params.id?.trim();
	if (!id) throw error(400, 'id required');
	try {
		const existing = await getConversation(locals.user.id, id);
		if (!existing) throw error(404, 'not found');
		if (!canRetryTitle(existing.title, existing.updatedAt)) {
			throw error(400, 'title retry is not available');
		}
		const result = await generateConversationTitle(locals.user.id, id, { force: true });
		if (!result) throw error(404, 'not found');
		if (!result.generated && !result.title) throw error(400, 'not enough conversation text to title');
		return json({
			id: result.row.id,
			title: result.title,
			updatedAt: result.row.updatedAt
		});
	} catch (err) {
		if (typeof err === 'object' && err && 'status' in err) throw err;
		console.warn('NewsCraft title retry failed', err);
		throw error(502, err instanceof Error ? err.message : String(err));
	}
};

function canRetryTitle(titleValue: string | null | undefined, updatedAt: number): boolean {
	const title = (titleValue ?? '').trim().toLowerCase();
	return (
		(!title || title === '(untitled)' || title === 'new chat') &&
		Date.now() - updatedAt > 60_000
	);
}
