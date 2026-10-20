import { error, type RequestHandler } from '@sveltejs/kit';
import { getTranscript } from '$lib/server/db/transcripts';
import { requireUser } from '$lib/server/transcripts/http';
import { getAudioStorage } from '$lib/server/transcripts/storage';

/**
 * The player's audio source. Each request is redirected to a fresh short-lived
 * storage link, so seeking keeps working however long the page stays open.
 */
export const GET: RequestHandler = async ({ locals, params }) => {
	const accountId = requireUser(locals);
	const transcript = await getTranscript(accountId, params.id!);
	if (!transcript?.audioKey || transcript.status === 'uploading') throw error(404, 'audio not found');
	let url: string;
	try {
		url = await getAudioStorage().signDownload(transcript.audioKey, 300);
	} catch {
		throw error(503, 'audio storage unavailable');
	}
	return new Response(null, { status: 302, headers: { location: url, 'cache-control': 'no-store' } });
};
