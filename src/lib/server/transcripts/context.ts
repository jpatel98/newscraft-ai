// Turns an attached transcript into the bounded speaker-turn context the chat
// seeds into the worker (see transcriptCitationContext in agent/transport.ts).
// Each turn becomes one citation, so the caps here are caps on citations.
import type { TranscriptContext, TranscriptContextTurn } from '@newscraft/shared';
import type { TranscriptUtterance } from '$lib/utils/transcripts';
import { speakerLabel } from '$lib/utils/transcripts';
import { listConversationTranscripts, type AttachedTranscript } from '$lib/server/db/transcripts';

/**
 * Most speaker turns a single run will carry across all attached transcripts.
 * The worker records at most 100 citation numbers per run, documents and
 * inherited sources included, so this is a ceiling, not a target.
 */
export const TRANSCRIPT_CONTEXT_TURN_LIMIT = 100;
/** Most transcript text, in characters, a single run will carry. ~60 min of talk. */
export const TRANSCRIPT_CONTEXT_CHAR_LIMIT = 90_000;
/** Consecutive utterances by one speaker closer than this are one turn. */
const MERGE_GAP_MS = 1_500;
/** A merged turn stops growing past this length so a SOT candidate stays a clip. */
const MERGE_MAX_MS = 20_000;
const MERGE_MAX_CHARS = 400;

export interface TranscriptContextBudget {
	turnLimit?: number;
	charLimit?: number;
}

export interface TranscriptContextResult {
	transcripts: TranscriptContext[];
	/** Turns dropped to stay inside the budget, per transcript id. Empty when nothing was cut. */
	truncated: Record<string, number>;
}

function toTurn(utterance: TranscriptUtterance, names: Record<string, string>): TranscriptContextTurn | null {
	const text = utterance.text.replace(/\s+/g, ' ').trim();
	if (!text) return null;
	return {
		id: utterance.id,
		speaker: speakerLabel(utterance.speaker, names),
		startMs: Math.max(0, Math.round(utterance.start)),
		endMs: Math.max(0, Math.round(utterance.end)),
		text
	};
}

/**
 * The engine starts a new utterance on every speaker change or 2 s pause, which
 * splits one answer into many fragments. Merge a speaker's consecutive
 * fragments back into a turn: the first id, the first start, the last end.
 */
export function mergeTurns(turns: ReadonlyArray<TranscriptContextTurn>): TranscriptContextTurn[] {
	const merged: TranscriptContextTurn[] = [];
	for (const turn of turns) {
		const last = merged[merged.length - 1];
		if (
			last &&
			last.speaker === turn.speaker &&
			turn.startMs - last.endMs <= MERGE_GAP_MS &&
			turn.endMs - last.startMs <= MERGE_MAX_MS &&
			last.text.length + 1 + turn.text.length <= MERGE_MAX_CHARS
		) {
			last.endMs = Math.max(last.endMs, turn.endMs);
			last.text = `${last.text} ${turn.text}`;
			continue;
		}
		merged.push({ ...turn });
	}
	return merged;
}

/**
 * Oldest attachment first, turns in tape order. When the budget runs out the
 * tail of the last transcript is dropped and reported, never silently.
 */
export function buildTranscriptContext(
	attached: ReadonlyArray<Pick<AttachedTranscript, 'id' | 'title' | 'durationMs' | 'utterances' | 'speakerNames'>>,
	budget: TranscriptContextBudget = {}
): TranscriptContextResult {
	const turnLimit = budget.turnLimit ?? TRANSCRIPT_CONTEXT_TURN_LIMIT;
	const charLimit = budget.charLimit ?? TRANSCRIPT_CONTEXT_CHAR_LIMIT;
	let turns = 0;
	let chars = 0;
	const truncated: Record<string, number> = {};
	const transcripts: TranscriptContext[] = [];
	for (const transcript of attached) {
		const kept: TranscriptContextTurn[] = [];
		let dropped = 0;
		const candidates = mergeTurns(
			transcript.utterances.flatMap((utterance) => {
				const turn = toTurn(utterance, transcript.speakerNames);
				return turn ? [turn] : [];
			})
		);
		for (const turn of candidates) {
			if (turns >= turnLimit || chars + turn.text.length > charLimit) {
				dropped++;
				continue;
			}
			kept.push(turn);
			turns++;
			chars += turn.text.length;
		}
		if (dropped) truncated[transcript.id] = dropped;
		if (kept.length) {
			transcripts.push({ id: transcript.id, title: transcript.title, durationMs: transcript.durationMs, turns: kept });
		}
	}
	return { transcripts, truncated };
}

export async function loadTranscriptContext(accountId: string, conversationId: string): Promise<TranscriptContextResult> {
	const attached = await listConversationTranscripts(accountId, conversationId);
	return buildTranscriptContext(attached);
}
