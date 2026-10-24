import { ensureDefaultOrganizationForAccount } from '$lib/server/db';
import {
	claimForProcessing,
	completeTranscript,
	createTranscript,
	failTranscript,
	getTranscript,
	type StoredTranscript
} from '$lib/server/db/transcripts';
import { cleanKeyterms, getTranscriptionEngine, TranscriptionEngineError, type TranscriptionEngine } from './engine';
import { AudioStorageUnavailableError, getAudioStorage, type AudioStorage } from './storage';
import { MAX_AUDIO_BYTES, mediaTypeFor, titleFromFileName } from '$lib/utils/transcript-media';
import type { TranscriptSourceKind } from '$lib/utils/transcripts';

/** Leaves headroom under the 300-second function limit to record the outcome. */
const ENGINE_TIMEOUT_MS = 270_000;
/** ElevenLabs fetches the audio as soon as the request arrives. */
const ENGINE_FETCH_URL_TTL_SECONDS = 900;

export class TranscriptRequestError extends Error {
	constructor(readonly status: number, readonly code: string, message: string) {
		super(message);
		this.name = 'TranscriptRequestError';
	}
}

export type NewTranscriptInput =
	| { kind: 'upload' | 'recording'; fileName: string; contentType?: string | null; bytes: number; title?: string; keyterms?: unknown }
	| { kind: 'link'; url: string; title?: string; keyterms?: unknown };

export function parseNewTranscript(body: unknown): NewTranscriptInput {
	if (!body || typeof body !== 'object') throw new TranscriptRequestError(400, 'invalid_request', 'Send a recording or a link.');
	const value = body as Record<string, unknown>;
	const title = typeof value.title === 'string' ? value.title.trim().slice(0, 200) : undefined;
	if (value.kind === 'link') {
		const url = typeof value.url === 'string' ? value.url.trim() : '';
		let parsed: URL | null = null;
		try {
			parsed = url.length <= 2000 ? new URL(url) : null;
		} catch {
			parsed = null;
		}
		if (!parsed || parsed.protocol !== 'https:') {
			throw new TranscriptRequestError(400, 'invalid_link', 'Paste a full https:// link to the audio or video.');
		}
		return { kind: 'link', url: parsed.toString(), title, keyterms: value.keyterms };
	}
	if (value.kind === 'upload' || value.kind === 'recording') {
		const fileName = typeof value.fileName === 'string' ? value.fileName.trim().slice(0, 255) : '';
		const bytes = Number(value.bytes);
		if (!fileName) throw new TranscriptRequestError(400, 'invalid_request', 'The file needs a name.');
		if (!Number.isSafeInteger(bytes) || bytes < 1) throw new TranscriptRequestError(400, 'invalid_request', 'That file is empty.');
		if (bytes > MAX_AUDIO_BYTES) throw new TranscriptRequestError(413, 'upload_too_large', 'Recordings can be up to 1 GB.');
		return {
			kind: value.kind,
			fileName,
			bytes,
			contentType: typeof value.contentType === 'string' ? value.contentType : null,
			title,
			keyterms: value.keyterms
		};
	}
	throw new TranscriptRequestError(400, 'invalid_request', 'Send a recording or a link.');
}

export function createTranscriptService(deps: {
	engine?: TranscriptionEngine;
	storage?: AudioStorage;
} = {}) {
	const engine = () => deps.engine ?? getTranscriptionEngine();
	const storage = () => deps.storage ?? getAudioStorage();

	return {
		/** Creates the record, and for a file, a signed upload URL the browser PUTs to. */
		async create(accountId: string, input: NewTranscriptInput): Promise<{ transcript: StoredTranscript; upload: { url: string; contentType: string } | null }> {
			const keyterms = cleanKeyterms(input.keyterms);
			const current = engine();
			const orgId = await ensureDefaultOrganizationForAccount(accountId);
			if (input.kind === 'link') {
				const host = new URL(input.url).hostname.replace(/^www\./, '');
				const transcript = await createTranscript({
					accountId,
					orgId,
					title: input.title || `Link from ${host}`,
					sourceKind: 'link',
					sourceUrl: input.url,
					keyterms,
					engine: current.name,
					model: current.model
				});
				return { transcript, upload: null };
			}
			const contentType = mediaTypeFor(input.fileName, input.contentType);
			if (!contentType) {
				throw new TranscriptRequestError(415, 'unsupported_media', 'That file type isn’t supported. Use MP3, M4A, WAV, MP4, MOV or similar.');
			}
			const sourceKind: TranscriptSourceKind = input.kind;
			const transcript = await createTranscript({
				accountId,
				orgId,
				title: input.title || titleFromFileName(input.fileName),
				sourceKind,
				sourceName: input.fileName,
				contentType,
				audioBytes: input.bytes,
				keyterms,
				engine: current.name,
				model: current.model
			});
			try {
				const url = await storage().signUpload(transcript.audioKey!, contentType, input.bytes);
				return { transcript, upload: { url, contentType } };
			} catch (cause) {
				await failTranscript(accountId, transcript.id, 'storage_unavailable', 'Audio storage is unavailable right now.');
				throw cause;
			}
		},

		/**
		 * Runs the transcription. Returns the stored transcript afterwards, which is
		 * already complete or failed unless another request holds the run.
		 */
		async process(accountId: string, id: string): Promise<StoredTranscript> {
			const existing = await getTranscript(accountId, id);
			if (!existing) throw new TranscriptRequestError(404, 'not_found', 'Transcript not found.');
			if (existing.status === 'complete') return existing;

			let upload: { bytes: number; contentType: string } | undefined;
			if (existing.sourceKind !== 'link') {
				if (!existing.audioKey) throw new TranscriptRequestError(409, 'no_audio', 'This transcript has no audio.');
				const meta = await storage().stat(existing.audioKey).catch((cause) => {
					if (cause instanceof AudioStorageUnavailableError) return 'unavailable' as const;
					throw cause;
				});
				if (meta === 'unavailable') {
					return (await failTranscript(accountId, id, 'storage_unavailable', 'Audio storage is unavailable right now. Try again.')) ?? existing;
				}
				if (!meta) throw new TranscriptRequestError(409, 'upload_not_ready', 'The upload hasn’t finished yet.');
				upload = meta;
			}

			const claimed = await claimForProcessing(accountId, id, upload);
			if (!claimed) return (await getTranscript(accountId, id)) ?? existing;

			try {
				const sourceUrl = claimed.sourceKind === 'link'
					? claimed.sourceUrl!
					: await storage().signDownload(claimed.audioKey!, ENGINE_FETCH_URL_TTL_SECONDS);
				const result = await engine().transcribe({
					sourceUrl,
					keyterms: claimed.keyterms,
					signal: AbortSignal.timeout(ENGINE_TIMEOUT_MS)
				});
				if (result.utterances.length === 0) {
					return (await failTranscript(accountId, id, 'no_speech', 'No speech was found in this recording.')) ?? claimed;
				}
				return (await completeTranscript(accountId, id, result)) ?? claimed;
			} catch (cause) {
				const failure = cause instanceof TranscriptionEngineError
					? { code: cause.code, message: cause.message }
					: cause instanceof AudioStorageUnavailableError
						? { code: 'storage_unavailable', message: 'Audio storage is unavailable right now. Try again.' }
						: { code: 'transcription_failed', message: 'Transcription failed. Try again.' };
				if (!(cause instanceof TranscriptionEngineError)) console.error('[newscraft] transcription failed', cause);
				return (await failTranscript(accountId, id, failure.code, failure.message)) ?? claimed;
			}
		}
	};
}

let service: ReturnType<typeof createTranscriptService> | null = null;
export function getTranscriptService() {
	service ??= createTranscriptService();
	return service;
}
