import { error, json, type RequestHandler } from '@sveltejs/kit';
import { listTranscripts, publicTranscript } from '$lib/server/db/transcripts';
import { checkRateLimit } from '$lib/server/rate-limit';
import { NO_STORE, requireUser, transcriptErrorResponse } from '$lib/server/transcripts/http';
import { getTranscriptService, parseNewTranscript } from '$lib/server/transcripts/service';

export const GET: RequestHandler = async ({ locals, url }) => {
	const accountId = requireUser(locals);
	const transcripts = await listTranscripts(accountId, url.searchParams.get('q') ?? '');
	return json({ transcripts }, { headers: NO_STORE });
};

export const POST: RequestHandler = async ({ locals, request }) => {
	const accountId = requireUser(locals);
	const rate = checkRateLimit(`transcribe:${accountId}`, { limit: 30, windowMs: 60 * 60 * 1000 });
	if (!rate.allowed) throw error(429, `too many transcriptions; try again in ${Math.ceil(rate.retryAfterMs / 60_000)} min`);
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		throw error(400, 'invalid json');
	}
	try {
		const { transcript, upload } = await getTranscriptService().create(accountId, parseNewTranscript(body));
		return json({ transcript: publicTranscript(transcript), upload }, { status: 201, headers: NO_STORE });
	} catch (cause) {
		return transcriptErrorResponse(cause);
	}
};
