import { sql } from './index';
import { newId } from '$lib/utils/id';
import type {
	TranscriptDetail,
	TranscriptSourceKind,
	TranscriptStatus,
	TranscriptSummary,
	TranscriptUtterance
} from '$lib/utils/transcripts';

/** A run that has said "processing" this long without finishing is treated as lost. */
export const STALE_PROCESSING_MS = 10 * 60 * 1000;
const PREVIEW_CHARS = 180;

type Row = Record<string, unknown>;

const num = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));

function toSummary(row: Row): TranscriptSummary {
	return {
		id: String(row.id),
		title: String(row.title),
		status: row.status as TranscriptStatus,
		sourceKind: row.source_kind as TranscriptSourceKind,
		sourceName: (row.source_name as string | null) ?? null,
		durationMs: num(row.duration_ms),
		preview: String(row.preview ?? ''),
		createdAt: Number(row.created_at),
		updatedAt: Number(row.updated_at)
	};
}

function toDetail(row: Row): TranscriptDetail & { audioKey: string | null } {
	return {
		...toSummary({ ...row, preview: String(row.text ?? '').slice(0, PREVIEW_CHARS) }),
		sourceUrl: (row.source_url as string | null) ?? null,
		hasAudio: Boolean(row.audio_key) && row.status !== 'uploading',
		audioKey: (row.audio_key as string | null) ?? null,
		languageCode: (row.language_code as string | null) ?? null,
		engine: String(row.engine),
		model: String(row.model),
		keyterms: Array.isArray(row.keyterms) ? (row.keyterms as string[]) : [],
		text: String(row.text ?? ''),
		utterances: Array.isArray(row.utterances) ? (row.utterances as TranscriptUtterance[]) : [],
		speakerNames: row.speaker_names && typeof row.speaker_names === 'object' ? (row.speaker_names as Record<string, string>) : {},
		errorCode: (row.error_code as string | null) ?? null,
		errorMessage: (row.error_message as string | null) ?? null,
		completedAt: num(row.completed_at)
	};
}

export type StoredTranscript = ReturnType<typeof toDetail>;

/** Strips the storage key before a transcript goes to the browser. */
export function publicTranscript(transcript: StoredTranscript): TranscriptDetail {
	const { audioKey: _audioKey, ...rest } = transcript;
	return rest;
}

export function audioKeyFor(accountId: string, transcriptId: string): string {
	return `${accountId}/${transcriptId}/audio`;
}

export async function createTranscript(input: {
	accountId: string;
	title: string;
	sourceKind: TranscriptSourceKind;
	sourceName?: string | null;
	sourceUrl?: string | null;
	contentType?: string | null;
	audioBytes?: number | null;
	keyterms: string[];
	engine: string;
	model: string;
}): Promise<StoredTranscript> {
	const id = newId();
	const now = Date.now();
	const hasUpload = input.sourceKind !== 'link';
	const [row] = await sql`
		INSERT INTO transcripts (
			id, account_id, title, status, source_kind, source_name, source_url, audio_key, audio_bytes,
			content_type, engine, model, keyterms, created_at, updated_at
		) VALUES (
			${id}, ${input.accountId}, ${input.title}, ${hasUpload ? 'uploading' : 'queued'}, ${input.sourceKind},
			${input.sourceName ?? null}, ${input.sourceUrl ?? null}, ${hasUpload ? audioKeyFor(input.accountId, id) : null},
			${input.audioBytes ?? null}, ${input.contentType ?? null}, ${input.engine}, ${input.model},
			${JSON.stringify(input.keyterms)}::jsonb, ${now}, ${now}
		) RETURNING *`;
	return toDetail(row);
}

export async function listTranscripts(accountId: string, query = ''): Promise<TranscriptSummary[]> {
	const q = query.trim().slice(0, 200);
	const pattern = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
	const rows = q
		? await sql`
			SELECT id, title, status, source_kind, source_name, duration_ms, created_at, updated_at,
				left(text, ${PREVIEW_CHARS}) AS preview
			FROM transcripts
			WHERE account_id = ${accountId} AND (title ILIKE ${pattern} OR text ILIKE ${pattern})
			ORDER BY created_at DESC, id DESC LIMIT 200`
		: await sql`
			SELECT id, title, status, source_kind, source_name, duration_ms, created_at, updated_at,
				left(text, ${PREVIEW_CHARS}) AS preview
			FROM transcripts WHERE account_id = ${accountId}
			ORDER BY created_at DESC, id DESC LIMIT 200`;
	return rows.map(toSummary);
}

export async function getTranscript(accountId: string, id: string): Promise<StoredTranscript | null> {
	const [row] = await sql`SELECT * FROM transcripts WHERE id = ${id} AND account_id = ${accountId}`;
	return row ? toDetail(row) : null;
}

/**
 * Claims a transcript for one transcription run. Only one caller wins; a run
 * stuck in processing past STALE_PROCESSING_MS can be claimed again.
 */
export async function claimForProcessing(
	accountId: string,
	id: string,
	upload?: { bytes: number; contentType: string }
): Promise<StoredTranscript | null> {
	const now = Date.now();
	const [row] = await sql`
		UPDATE transcripts SET
			status = 'processing',
			processing_started_at = ${now},
			error_code = NULL,
			error_message = NULL,
			audio_bytes = COALESCE(${upload?.bytes ?? null}, audio_bytes),
			content_type = COALESCE(${upload?.contentType ?? null}, content_type),
			updated_at = ${now}
		WHERE id = ${id} AND account_id = ${accountId} AND (
			status IN ('uploading', 'queued', 'failed')
			OR (status = 'processing' AND processing_started_at < ${now - STALE_PROCESSING_MS})
		)
		RETURNING *`;
	return row ? toDetail(row) : null;
}

export async function completeTranscript(
	accountId: string,
	id: string,
	result: { text: string; languageCode: string | null; durationMs: number | null; utterances: TranscriptUtterance[] }
): Promise<StoredTranscript | null> {
	const now = Date.now();
	const [row] = await sql`
		UPDATE transcripts SET
			status = 'complete', text = ${result.text}, language_code = ${result.languageCode},
			duration_ms = ${result.durationMs}, utterances = ${JSON.stringify(result.utterances)}::jsonb,
			completed_at = ${now}, updated_at = ${now}
		WHERE id = ${id} AND account_id = ${accountId} AND status = 'processing'
		RETURNING *`;
	return row ? toDetail(row) : null;
}

export async function failTranscript(accountId: string, id: string, code: string, message: string): Promise<StoredTranscript | null> {
	const [row] = await sql`
		UPDATE transcripts SET status = 'failed', error_code = ${code}, error_message = ${message}, updated_at = ${Date.now()}
		WHERE id = ${id} AND account_id = ${accountId}
		RETURNING *`;
	return row ? toDetail(row) : null;
}

export async function updateTranscript(
	accountId: string,
	id: string,
	patch: { title?: string; speakerNames?: Record<string, string>; utterances?: TranscriptUtterance[]; text?: string }
): Promise<StoredTranscript | null> {
	const now = Date.now();
	const [row] = await sql`
		UPDATE transcripts SET
			title = COALESCE(${patch.title ?? null}, title),
			speaker_names = COALESCE(${patch.speakerNames ? JSON.stringify(patch.speakerNames) : null}::jsonb, speaker_names),
			utterances = COALESCE(${patch.utterances ? JSON.stringify(patch.utterances) : null}::jsonb, utterances),
			text = COALESCE(${patch.text ?? null}, text),
			updated_at = ${now}
		WHERE id = ${id} AND account_id = ${accountId}
		RETURNING *`;
	return row ? toDetail(row) : null;
}

export async function deleteTranscript(accountId: string, id: string): Promise<StoredTranscript | null> {
	const [row] = await sql`DELETE FROM transcripts WHERE id = ${id} AND account_id = ${accountId} RETURNING *`;
	return row ? toDetail(row) : null;
}

/** Audio keys for an account, for cleanup when the account goes away. */
export async function listAccountAudioKeys(accountId: string): Promise<string[]> {
	const rows = await sql`SELECT audio_key FROM transcripts WHERE account_id = ${accountId} AND audio_key IS NOT NULL`;
	return rows.map((row) => String(row.audio_key));
}
