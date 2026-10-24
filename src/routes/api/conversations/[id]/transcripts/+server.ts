// Transcripts attached to a conversation as sources.
//   GET  → { transcripts: [{ id, title, status, durationMs, attachedAt, turnCount }] }
//   POST { transcriptId } → attaches one the account owns; idempotent.
// Attached transcripts are seeded into every later turn as one citation per
// speaker turn (see src/lib/server/transcripts/context.ts).
import { error, json, type RequestHandler } from '@sveltejs/kit';
import { getConversation } from '$lib/server/db/conversations';
import { attachTranscript, listConversationTranscripts } from '$lib/server/db/transcripts';

function summary(transcript: Awaited<ReturnType<typeof listConversationTranscripts>>[number]) {
	return {
		id: transcript.id,
		title: transcript.title,
		status: transcript.status,
		durationMs: transcript.durationMs,
		attachedAt: transcript.attachedAt,
		turnCount: transcript.utterances.length
	};
}

export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) throw error(401, 'unauthorized');
	if (!params.id) throw error(400, 'conversation id required');
	const conversation = await getConversation(locals.user.id, params.id);
	if (!conversation) throw error(404, 'conversation not found');
	const transcripts = await listConversationTranscripts(locals.user.id, conversation.id);
	return json({ transcripts: transcripts.map(summary) }, { headers: { 'Cache-Control': 'no-store' } });
};

export const POST: RequestHandler = async ({ params, locals, request }) => {
	if (!locals.user) throw error(401, 'unauthorized');
	if (!params.id) throw error(400, 'conversation id required');
	const conversation = await getConversation(locals.user.id, params.id);
	if (!conversation) throw error(404, 'conversation not found');
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		throw error(400, 'invalid json');
	}
	const transcriptId = typeof body === 'object' && body && typeof (body as { transcriptId?: unknown }).transcriptId === 'string'
		? (body as { transcriptId: string }).transcriptId.trim()
		: '';
	if (!transcriptId) throw error(400, 'transcriptId required');
	const attached = await attachTranscript(locals.user.id, conversation.id, transcriptId);
	if (!attached) throw error(404, 'transcript not found');
	if (attached.status !== 'complete') {
		// Attached, but it will not be seeded until transcription finishes.
		return json({ transcript: summary(attached), pending: true }, { status: 202, headers: { 'Cache-Control': 'no-store' } });
	}
	return json({ transcript: summary(attached) }, { headers: { 'Cache-Control': 'no-store' } });
};
