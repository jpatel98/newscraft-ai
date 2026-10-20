// Shared transcript shapes and the text exports, used by the API and the
// transcription pages. Times are milliseconds from the start of the audio.

export type TranscriptStatus = 'uploading' | 'queued' | 'processing' | 'complete' | 'failed';
export type TranscriptSourceKind = 'upload' | 'recording' | 'link';

export type TranscriptWord = { text: string; start: number; end: number };

export type TranscriptUtterance = {
	id: string;
	speaker: string;
	start: number;
	end: number;
	text: string;
	words: TranscriptWord[];
};

export type TranscriptSummary = {
	id: string;
	title: string;
	status: TranscriptStatus;
	sourceKind: TranscriptSourceKind;
	sourceName: string | null;
	durationMs: number | null;
	preview: string;
	createdAt: number;
	updatedAt: number;
};

export type TranscriptDetail = TranscriptSummary & {
	sourceUrl: string | null;
	hasAudio: boolean;
	languageCode: string | null;
	engine: string;
	model: string;
	keyterms: string[];
	text: string;
	utterances: TranscriptUtterance[];
	speakerNames: Record<string, string>;
	errorCode: string | null;
	errorMessage: string | null;
	completedAt: number | null;
};

/** "speaker_0" reads as "Speaker 1" until someone names them. */
export function speakerLabel(speaker: string, names: Record<string, string> = {}): string {
	const named = names[speaker]?.trim();
	if (named) return named;
	const match = /(\d+)$/.exec(speaker);
	return match ? `Speaker ${Number(match[1]) + 1}` : speaker || 'Speaker';
}

/** 0:07, 12:45, 1:02:03 */
export function formatClock(ms: number): string {
	const total = Math.max(0, Math.floor(ms / 1000));
	const h = Math.floor(total / 3600);
	const m = Math.floor((total % 3600) / 60);
	const s = total % 60;
	const ss = String(s).padStart(2, '0');
	return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

function srtTime(ms: number): string {
	const value = Math.max(0, Math.round(ms));
	const h = Math.floor(value / 3_600_000);
	const m = Math.floor((value % 3_600_000) / 60_000);
	const s = Math.floor((value % 60_000) / 1000);
	const milli = value % 1000;
	return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(milli).padStart(3, '0')}`;
}

export function buildPlainText(utterances: TranscriptUtterance[], names: Record<string, string> = {}): string {
	return utterances
		.filter((u) => u.text.trim())
		.map((u) => `[${formatClock(u.start)}] ${speakerLabel(u.speaker, names)}: ${u.text.trim()}`)
		.join('\n\n');
}

export function buildSrt(utterances: TranscriptUtterance[], names: Record<string, string> = {}): string {
	return utterances
		.filter((u) => u.text.trim())
		.map((u, index) => {
			const end = Math.max(u.end, u.start + 1);
			return `${index + 1}\n${srtTime(u.start)} --> ${srtTime(end)}\n${speakerLabel(u.speaker, names)}: ${u.text.trim()}\n`;
		})
		.join('\n');
}

/** A filesystem-safe base name for downloads. */
export function exportBaseName(title: string): string {
	const cleaned = title
		.normalize('NFKD')
		.replace(/[^\w\s.-]+/g, '')
		.trim()
		.replace(/\s+/g, '-')
		.slice(0, 80);
	return cleaned || 'transcript';
}

/**
 * The chat draft "Use in chat" writes: the transcript with speaker names and
 * times, cut at a size a chat request accepts.
 */
export const CHAT_TRANSCRIPT_CHAR_LIMIT = 60_000;
export function buildChatDraft(title: string, utterances: TranscriptUtterance[], names: Record<string, string> = {}): string {
	const body = buildPlainText(utterances, names);
	const clipped = body.length > CHAT_TRANSCRIPT_CHAR_LIMIT
		? `${body.slice(0, CHAT_TRANSCRIPT_CHAR_LIMIT)}\n\n[Transcript cut here. The full version is in Transcriptions.]`
		: body;
	return `Transcript: ${title}\n\n${clipped}\n\n`;
}
