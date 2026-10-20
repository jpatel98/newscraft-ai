import { env } from '$env/dynamic/private';
import type { TranscriptUtterance, TranscriptWord } from '$lib/utils/transcripts';

export const ELEVENLABS_ENGINE = 'elevenlabs';
export const ELEVENLABS_DEFAULT_MODEL = 'scribe_v2';
const ELEVENLABS_BASE_URL = 'https://api.elevenlabs.io';

/** A new speaker turn starts on a speaker change or a pause this long. */
const TURN_PAUSE_MS = 2000;

export class TranscriptionEngineError extends Error {
	constructor(readonly code: string, message: string, readonly retryable = false) {
		super(message);
		this.name = 'TranscriptionEngineError';
	}
}

export type TranscriptionRequest = {
	/** HTTPS URL of the media: a short-lived signed storage link, or a page link (YouTube and similar). */
	sourceUrl: string;
	languageCode?: string | null;
	keyterms?: string[];
	signal?: AbortSignal;
};

export type TranscriptionResult = {
	text: string;
	languageCode: string | null;
	durationMs: number | null;
	utterances: TranscriptUtterance[];
};

export type TranscriptionEngine = {
	name: string;
	model: string;
	configured: boolean;
	transcribe(request: TranscriptionRequest): Promise<TranscriptionResult>;
};

type ElevenLabsWord = {
	text?: unknown;
	start?: unknown;
	end?: unknown;
	type?: unknown;
	speaker_id?: unknown;
};

/**
 * Groups ElevenLabs word timings into speaker turns. Spacing tokens are kept in
 * the turn text but not as words; audio events are dropped.
 */
export function utterancesFromElevenLabsWords(words: unknown): TranscriptUtterance[] {
	if (!Array.isArray(words)) return [];
	const turns: TranscriptUtterance[] = [];
	let current: TranscriptUtterance | null = null;
	let pendingSpace = false;

	for (const raw of words as ElevenLabsWord[]) {
		const type = typeof raw.type === 'string' ? raw.type : 'word';
		const text = typeof raw.text === 'string' ? raw.text : '';
		if (type === 'spacing') {
			pendingSpace = true;
			continue;
		}
		if (type !== 'word' || !text.trim()) continue;
		const start = secondsToMs(raw.start);
		const end = Math.max(start, secondsToMs(raw.end));
		const speaker = typeof raw.speaker_id === 'string' && raw.speaker_id ? raw.speaker_id : 'speaker_0';
		const word: TranscriptWord = { text: text.trim(), start, end };

		if (!current || current.speaker !== speaker || start - current.end >= TURN_PAUSE_MS) {
			current = { id: `u${turns.length + 1}`, speaker, start, end, text: word.text, words: [word] };
			turns.push(current);
		} else {
			current.text += pendingSpace ? ` ${word.text}` : word.text;
			current.end = end;
			current.words.push(word);
		}
		pendingSpace = false;
	}
	return turns;
}

function secondsToMs(value: unknown): number {
	const seconds = typeof value === 'number' ? value : Number(value);
	return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : 0;
}

export function cleanKeyterms(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const seen = new Set<string>();
	const terms: string[] = [];
	for (const item of value) {
		if (typeof item !== 'string') continue;
		const term = item.trim().replace(/\s+/g, ' ').slice(0, 50);
		const key = term.toLowerCase();
		if (!term || seen.has(key)) continue;
		seen.add(key);
		terms.push(term);
		if (terms.length >= 50) break;
	}
	return terms;
}

export function createElevenLabsEngine(options: {
	apiKey?: string;
	model?: string;
	baseUrl?: string;
	fetchImpl?: typeof fetch;
} = {}): TranscriptionEngine {
	const apiKey = (options.apiKey ?? env.ELEVENLABS_API_KEY ?? '').trim();
	const model = (options.model ?? env.ELEVENLABS_STT_MODEL ?? '').trim() || ELEVENLABS_DEFAULT_MODEL;
	// Overridable only so local end-to-end runs can point at a stand-in service.
	const baseUrl = (options.baseUrl ?? env.ELEVENLABS_BASE_URL ?? '').trim().replace(/\/+$/, '') || ELEVENLABS_BASE_URL;
	const fetchImpl = options.fetchImpl ?? fetch;

	return {
		name: ELEVENLABS_ENGINE,
		model,
		configured: Boolean(apiKey),
		async transcribe(request) {
			if (!apiKey) {
				throw new TranscriptionEngineError('engine_not_configured', "Transcription isn't switched on for this workspace yet.");
			}
			const form = new FormData();
			form.set('model_id', model);
			form.set('source_url', request.sourceUrl);
			form.set('diarize', 'true');
			form.set('timestamps_granularity', 'word');
			form.set('tag_audio_events', 'false');
			if (request.languageCode) form.set('language_code', request.languageCode);
			for (const term of request.keyterms ?? []) form.append('keyterms', term);

			let response: Response;
			try {
				response = await fetchImpl(`${baseUrl}/v1/speech-to-text`, {
					method: 'POST',
					headers: { 'xi-api-key': apiKey },
					body: form,
					signal: request.signal
				});
			} catch (cause) {
				if (cause instanceof Error && (cause.name === 'TimeoutError' || cause.name === 'AbortError')) {
					throw new TranscriptionEngineError('engine_timeout', 'Transcription took too long. Try again, or split the recording.', true);
				}
				throw new TranscriptionEngineError('engine_unreachable', "Couldn't reach the transcription service. Try again.", true);
			}

			if (!response.ok) throw await engineErrorFromResponse(response);
			const body = (await response.json().catch(() => null)) as {
				text?: unknown;
				language_code?: unknown;
				words?: unknown;
			} | null;
			if (!body) throw new TranscriptionEngineError('engine_bad_response', 'The transcription service sent back something unreadable. Try again.', true);

			const utterances = utterancesFromElevenLabsWords(body.words);
			const lastEnd = utterances.at(-1)?.end ?? null;
			return {
				text: typeof body.text === 'string' ? body.text.trim() : utterances.map((u) => u.text).join(' '),
				languageCode: typeof body.language_code === 'string' ? body.language_code : null,
				durationMs: lastEnd,
				utterances
			};
		}
	};
}

async function engineErrorFromResponse(response: Response): Promise<TranscriptionEngineError> {
	const detail = await response.text().catch(() => '');
	console.warn('[newscraft] transcription engine error', response.status, detail.slice(0, 300));
	if (response.status === 401 || response.status === 403) {
		return new TranscriptionEngineError('engine_auth_failed', 'The transcription service rejected our key. An admin needs to check it.');
	}
	if (response.status === 429) {
		return new TranscriptionEngineError('engine_busy', 'The transcription service is busy. Try again in a minute.', true);
	}
	if (response.status === 400 || response.status === 422) {
		return new TranscriptionEngineError('media_unreadable', "That audio couldn't be read. Check the file or link and try again.");
	}
	return new TranscriptionEngineError('engine_failed', 'Transcription failed on the service side. Try again.', true);
}

let engine: TranscriptionEngine | null = null;
export function getTranscriptionEngine(): TranscriptionEngine {
	engine ??= createElevenLabsEngine();
	return engine;
}
