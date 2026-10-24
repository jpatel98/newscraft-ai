import { error, json, type RequestHandler } from '@sveltejs/kit';
import { getConversation } from '$lib/server/db/conversations';
import { detachTranscript } from '$lib/server/db/transcripts';

/** Detaches a transcript from the conversation. The transcript itself is untouched. */
export const DELETE: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) throw error(401, 'unauthorized');
	if (!params.id) throw error(400, 'conversation id required');
	if (!params.transcriptId) throw error(400, 'transcript id required');
	const conversation = await getConversation(locals.user.id, params.id);
	if (!conversation) throw error(404, 'conversation not found');
	const removed = await detachTranscript(locals.user.id, conversation.id, params.transcriptId);
	if (!removed) throw error(404, 'transcript not attached');
	return json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } });
};
