import { error, json, type RequestHandler } from '@sveltejs/kit';
import { deleteTranscript, getTranscript, publicTranscript, updateTranscript } from '$lib/server/db/transcripts';
import { NO_STORE, requireUser } from '$lib/server/transcripts/http';
import { getAudioStorage } from '$lib/server/transcripts/storage';
import type { TranscriptUtterance } from '$lib/utils/transcripts';

export const GET: RequestHandler = async ({ locals, params }) => {
	const accountId = requireUser(locals);
	const transcript = await getTranscript(accountId, params.id!);
	if (!transcript) throw error(404, 'transcript not found');
	return json({ transcript: publicTranscript(transcript) }, { headers: NO_STORE });
};

/** Rename the transcript, name a speaker, or correct one turn's text. */
export const PATCH: RequestHandler = async ({ locals, params, request }) => {
	const accountId = requireUser(locals);
	let body: Record<string, unknown>;
	try {
		body = (await request.json()) as Record<string, unknown>;
	} catch {
		throw error(400, 'invalid json');
	}
	const transcript = await getTranscript(accountId, params.id!);
	if (!transcript) throw error(404, 'transcript not found');

	const patch: Parameters<typeof updateTranscript>[2] = {};
	if (body.title !== undefined) {
		const title = typeof body.title === 'string' ? body.title.trim() : '';
		if (!title || title.length > 200) throw error(400, 'title must be 1 to 200 characters');
		patch.title = title;
	}
	if (body.speaker !== undefined) {
		const speaker = body.speaker as { id?: unknown; name?: unknown };
		const id = typeof speaker?.id === 'string' ? speaker.id : '';
		const name = typeof speaker?.name === 'string' ? speaker.name.trim().slice(0, 80) : '';
		if (!transcript.utterances.some((u) => u.speaker === id)) throw error(400, 'unknown speaker');
		const names = { ...transcript.speakerNames };
		if (name) names[id] = name;
		else delete names[id];
		patch.speakerNames = names;
	}
	if (body.utterance !== undefined) {
		const edit = body.utterance as { id?: unknown; text?: unknown };
		const text = typeof edit?.text === 'string' ? edit.text.trim() : '';
		if (!text || text.length > 20_000) throw error(400, 'text must be 1 to 20000 characters');
		let found = false;
		// An edited turn keeps its start and end times; its word timings no longer
		// match the text, so they are dropped.
		const utterances: TranscriptUtterance[] = transcript.utterances.map((u) => {
			if (u.id !== edit.id) return u;
			found = true;
			return u.text === text ? u : { ...u, text, words: [] };
		});
		if (!found) throw error(400, 'unknown utterance');
		patch.utterances = utterances;
		patch.text = utterances.map((u) => u.text).join(' ');
	}
	if (Object.keys(patch).length === 0) throw error(400, 'nothing to change');

	const updated = await updateTranscript(accountId, transcript.id, patch);
	if (!updated) throw error(404, 'transcript not found');
	return json({ transcript: publicTranscript(updated) }, { headers: NO_STORE });
};

export const DELETE: RequestHandler = async ({ locals, params }) => {
	const accountId = requireUser(locals);
	const deleted = await deleteTranscript(accountId, params.id!);
	if (!deleted) throw error(404, 'transcript not found');
	if (deleted.audioKey) {
		await getAudioStorage().remove(deleted.audioKey).catch((cause) => {
			console.warn('[newscraft] transcript audio cleanup failed', cause instanceof Error ? cause.message : cause);
		});
	}
	return new Response(null, { status: 204 });
};
