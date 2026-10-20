import { error, json } from '@sveltejs/kit';
import { TranscriptRequestError } from './service';
import { AudioStorageUnavailableError } from './storage';

export const NO_STORE = { 'Cache-Control': 'no-store' } as const;

/** Maps service errors to responses the transcription pages can show as-is. */
export function transcriptErrorResponse(cause: unknown): Response {
	if (cause instanceof TranscriptRequestError) {
		return json({ code: cause.code, message: cause.message }, { status: cause.status, headers: NO_STORE });
	}
	if (cause instanceof AudioStorageUnavailableError) {
		return json({ code: 'storage_unavailable', message: cause.message }, { status: 503, headers: NO_STORE });
	}
	throw cause;
}

export function requireUser(locals: App.Locals): string {
	if (!locals.user) throw error(401, 'unauthorized');
	return locals.user.id;
}
