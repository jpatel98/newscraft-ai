import { error, json, type RequestHandler } from '@sveltejs/kit';
import { publicTranscript } from '$lib/server/db/transcripts';
import { NO_STORE, requireUser, transcriptErrorResponse } from '$lib/server/transcripts/http';
import { getTranscriptService } from '$lib/server/transcripts/service';
import { checkRateLimit } from '$lib/server/rate-limit';

/** Starts (or retries) transcription and answers once it is finished or failed. */
export const POST: RequestHandler = async ({ locals, params }) => {
	const accountId = requireUser(locals);
	const rate = checkRateLimit(`transcribe-process:${accountId}`, { limit: 30, windowMs: 60 * 60 * 1000 });
	if (!rate.allowed) throw error(429, 'too many transcription attempts; try again later');
	try {
		const transcript = await getTranscriptService().process(accountId, params.id!);
		return json({ transcript: publicTranscript(transcript) }, { headers: NO_STORE });
	} catch (cause) {
		return transcriptErrorResponse(cause);
	}
};
