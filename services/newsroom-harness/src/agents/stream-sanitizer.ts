/**
 * Incremental sanitization for streamed chat answers.
 *
 * The visible-output rules live in one place: the batch cleaner
 * (`cleanVisibleChatOutput`). Instead of re-implementing those rules
 * incrementally (and letting the two drift), the sanitizer re-runs the batch
 * cleaner over the growing raw prefix at safe flush boundaries and emits only
 * the newly appended cleaned text. Strip-to-end rules (e.g. a trailing Sources
 * section) simply delay emission; they never require retracting emitted text.
 */

export interface StreamingAnswerSanitizerOptions {
	clean: (raw: string) => string;
	/** Flush mid-line at a sentence boundary once the pending line exceeds this. */
	minSentenceFlushChars?: number;
}

const DEFAULT_MIN_SENTENCE_FLUSH_CHARS = 160;

export class StreamingAnswerSanitizer {
	private raw = '';
	private flushedRawLength = 0;
	private cleanedEmitted = '';
	private blockedUntilEnd = false;
	private readonly minSentenceFlushChars: number;

	constructor(private readonly options: StreamingAnswerSanitizerOptions) {
		this.minSentenceFlushChars = options.minSentenceFlushChars ?? DEFAULT_MIN_SENTENCE_FLUSH_CHARS;
	}

	/** Cleaned text emitted so far. */
	get emitted(): string {
		return this.cleanedEmitted;
	}

	/** Feed a raw delta; returns newly emittable cleaned text ('' if none). */
	push(delta: string): string {
		this.raw += delta;
		if (this.blockedUntilEnd) return '';
		const boundary = this.safeBoundary();
		if (boundary <= this.flushedRawLength) return '';
		this.flushedRawLength = boundary;
		return this.emitCleanedPrefix(this.raw.slice(0, boundary));
	}

	private emitCleanedPrefix(rawPrefix: string): string {
		const cleaned = this.options.clean(rawPrefix);
		if (!cleaned.startsWith(this.cleanedEmitted)) {
			// The cleaner rewrote text that was already emitted (rare, e.g. a
			// multi-line repair that crossed a flush boundary). Stop streaming and
			// let the caller reconcile against the final answer.
			this.blockedUntilEnd = true;
			return '';
		}
		const addition = cleaned.slice(this.cleanedEmitted.length);
		this.cleanedEmitted = cleaned;
		return addition;
	}

	/**
	 * Last raw offset that is safe to clean-and-emit. Newlines are always safe
	 * (the cleaner's inline rules never span lines). For long single-line text,
	 * fall back to a sentence boundary as long as the prefix does not end inside
	 * a markdown link, URL, or emphasis marker that the cleaner would rewrite.
	 */
	private safeBoundary(): number {
		const newlineBoundary = this.raw.lastIndexOf('\n') + 1;
		const pending = this.raw.slice(Math.max(newlineBoundary, this.flushedRawLength));
		if (pending.length <= this.minSentenceFlushChars) return newlineBoundary;
		const sentenceEnd = lastSentenceBoundary(pending);
		if (sentenceEnd <= 0) return newlineBoundary;
		const candidate = Math.max(newlineBoundary, this.flushedRawLength) + sentenceEnd;
		if (endsInsideInlineConstruct(this.raw.slice(0, candidate))) return newlineBoundary;
		return Math.max(candidate, newlineBoundary);
	}
}

function lastSentenceBoundary(text: string): number {
	for (let index = text.length - 1; index > 0; index -= 1) {
		if (!/[.!?]/.test(text[index - 1])) continue;
		if (!/\s/.test(text[index])) continue;
		return index + 1;
	}
	return -1;
}

function endsInsideInlineConstruct(prefix: string): boolean {
	const tail = prefix.slice(-400);
	if (/\[[^\]\n]*$/.test(tail)) return true; // unclosed [link text
	if (/\]\([^)\n]*$/.test(tail)) return true; // unclosed ](url
	if (/https?:\/\/\S*$/.test(tail)) return true; // URL still being written
	const emphasisMarks = (tail.match(/\*\*/g) || []).length;
	if (emphasisMarks % 2 === 1) return true; // unclosed **bold
	return false;
}

/**
 * Reconcile streamed cleaned text with the authoritative final answer.
 * Returns the suffix of `finalAnswer` still to emit, or null when the final
 * answer does not extend what was streamed (interrupted run or a rewrite).
 * Whitespace differences are tolerated; visible characters must match.
 */
export function streamTailForFinalAnswer(emitted: string, finalAnswer: string): string | null {
	if (finalAnswer.startsWith(emitted)) return meaningfulTail(finalAnswer.slice(emitted.length));
	let finalIndex = 0;
	let emittedIndex = 0;
	while (emittedIndex < emitted.length) {
		while (emittedIndex < emitted.length && /\s/.test(emitted[emittedIndex])) emittedIndex += 1;
		if (emittedIndex >= emitted.length) break;
		while (finalIndex < finalAnswer.length && /\s/.test(finalAnswer[finalIndex])) finalIndex += 1;
		if (finalIndex >= finalAnswer.length) return null;
		if (finalAnswer[finalIndex] !== emitted[emittedIndex]) return null;
		finalIndex += 1;
		emittedIndex += 1;
	}
	return meaningfulTail(finalAnswer.slice(finalIndex));
}

function meaningfulTail(tail: string): string {
	return tail.trim() ? tail : '';
}
