import {
	isCitationUrl,
	type CitationRecord,
	type CitationSourceType,
	type RetrievalProvenance
} from '@newscraft/shared';

export interface StreamToolCall {
	id: string;
	name: string;
	status?: 'running' | 'ok' | 'failed' | 'unknown' | string;
	startedAt?: number;
	endedAt?: number;
	durationMs?: number;
	arguments?: unknown;
	result?: unknown;
	transcript?: string;
	detail?: string;
	url?: string;
	title?: string;
}

export interface StreamToolUpdate extends StreamToolCall {
	done?: boolean;
}

export interface StreamSourceUpdate {
	id: string;
	url: string;
	title: string;
	status: string;
	domain?: string;
	detail?: string;
	/** The plan step id that produced this source, if any. Omitted for sources outside a step. */
	stepId?: string;
	/** Only explicit evidence events from the verifier may set this flag. */
	verified?: boolean;
	/** True only when publication/update time was verified for a current request. */
	currentVerified?: boolean;
	temporalScope?: string | null;
	publishedAt?: string | null;
	updatedAt?: string | null;
	eventAt?: string | null;
	retrieval?: RetrievalProvenance;
}

export interface PersistedSource extends StreamSourceUpdate {
	domain: string;
	firstSeenAt: number;
	lastSeenAt: number;
	used: boolean;
}

export type PlanStepStatus = 'pending' | 'running' | 'ok' | 'failed' | 'skipped';

export interface PlanStep {
	id: string;
	label: string;
	status: PlanStepStatus;
	detail?: string;
	requirementId?: string;
	phase?: 'discovery' | 'official' | 'corroboration';
}

export interface PlanRequirementCoverage {
	requirement_id: string;
	label: string;
	requested_count: number;
	accepted_count: number;
	state: string;
	gaps: string[];
	likely_to_improve: boolean;
	executed_actions: number;
	skipped_actions: number;
	budget_exhausted: boolean;
}

export interface StreamPlanUpdate {
	source: 'model' | 'router';
	steps: PlanStep[];
	requirementCoverage?: PlanRequirementCoverage[];
	assignmentStatus?: string;
}

export interface StreamEventUpdate {
	delta?: string;
	replace?: string;
	done?: boolean;
	partial?: boolean;
	failed?: string;
	title?: string;
	tool?: StreamToolUpdate;
	source?: PersistedSource;
	plan?: StreamPlanUpdate;
	citations?: CitationRecord[];
}

type JsonObject = Record<string, unknown>;

function objectValue(value: unknown): JsonObject | null {
	return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : null;
}

function arrayValue(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string | null {
	if (typeof value === 'string' && value.trim()) return value.trim();
	if (typeof value === 'number' || typeof value === 'boolean') return String(value);
	return null;
}

function firstString(...values: unknown[]): string | null {
	for (const value of values) {
		const text = stringValue(value);
		if (text) return text;
	}
	return null;
}

function rawString(value: unknown): string | null {
	return typeof value === 'string' ? value : stringValue(value);
}

function numberValue(value: unknown): number | undefined {
	if (typeof value === 'number' && Number.isFinite(value)) return value;
	if (typeof value === 'string' && value.trim()) {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return undefined;
}

const CITATION_SOURCE_TYPES = new Set<CitationSourceType>([
	'official',
	'primary',
	'news_report',
	'social_post',
	'user_document',
	'commercial',
	'unknown'
]);

function citationUrl(value: unknown): string | null {
	const url = stringValue(value);
	if (!url) return null;
	if (isCitationUrl(url)) return url;
	return null;
}

function isEscaped(value: string, index: number): boolean {
	let slashes = 0;
	for (let cursor = index - 1; cursor >= 0 && value[cursor] === '\\'; cursor -= 1) slashes += 1;
	return slashes % 2 === 1;
}

function findSquareClose(value: string, open: number): number | null {
	let depth = 0;
	for (let index = open; index < value.length; index += 1) {
		if (value[index] === '[' && !isEscaped(value, index)) depth += 1;
		else if (value[index] === ']' && !isEscaped(value, index)) {
			depth -= 1;
			if (depth === 0) return index;
		}
	}
	return null;
}

function findDestinationClose(value: string, open: number): number | null {
	let depth = 0;
	for (let index = open; index < value.length; index += 1) {
		if (value[index] === '(' && !isEscaped(value, index)) depth += 1;
		else if (value[index] === ')' && !isEscaped(value, index)) {
			depth -= 1;
			if (depth === 0) return index;
		}
	}
	return null;
}

function safeMarkdownDestination(raw: string, image: boolean): boolean {
	const destination = raw.trim();
	if (!destination) return false;
	if (/[\u0000-\u001f\u007f\u2028\u2029]/u.test(raw)) return false;
	const title = '(?:"[^"\\r\\n]*"|\'[^\'\\r\\n]*\'|\\([^()\\r\\n]*\\))';
	const angleMatch = destination.match(new RegExp(`^<([^<>\\r\\n]+)>(?:\\s+${title})?$`, 'u'));
	const bareMatch = destination.match(new RegExp(`^(\\S+)(?:\\s+${title})?$`, 'u'));
	const target = angleMatch ? angleMatch[1] : bareMatch?.[1];
	if (!target) return false;
	let decodedTarget = target;
	try {
		for (let pass = 0; pass < 3; pass += 1) {
			const decoded = decodeURIComponent(decodedTarget);
			if (decoded === decodedTarget) break;
			decodedTarget = decoded;
		}
	} catch {
		return false;
	}
	if (/[\u0000-\u001f\u007f\u2028\u2029]/u.test(decodedTarget)) return false;
	const decodedScheme = decodedTarget.match(/^([a-z][a-z0-9+.-]*):/iu)?.[1]?.toLowerCase();
	const allowedInternal = !image && (isCitationUrl(target) || isCitationUrl(decodedTarget));
	if (allowedInternal) return true;
	if (decodedScheme && !new Set(['http', 'https', 'mailto', 'tel']).has(decodedScheme)) return false;
	try {
		const url = new URL(target, 'https://newscraft.local');
		const allowed = image ? new Set(['http:', 'https:']) : new Set(['http:', 'https:', 'mailto:', 'tel:']);
		return allowed.has(url.protocol);
	} catch {
		return false;
	}
}

function isNumericArrayInterior(value: string): boolean {
	return /^\d+(?:\s*,\s*\d+)+(?:\s*,\s*)?$/u.test(value);
}

function isNumericArrayPrefix(value: string): boolean {
	return /^\[\d+(?:\s*,\s*\d+)*(?:\s*,\s*)?$/u.test(value) && /,/u.test(value);
}

function containsUnresolvedNumericPrefix(value: string): boolean {
	for (let index = 0; index < value.length; index += 1) {
		if (value[index] !== '[' || isEscaped(value, index)) continue;
		const suffix = value.slice(index);
		if (/^\[\d/u.test(suffix) && !isNumericArrayPrefix(suffix)) return true;
	}
	return false;
}

function canonicalizeCitationText(value: string): string {
	return value
		.replace(/[ \t]+([,.;:!?])/gu, '$1')
		.replace(/[ \t]{2,}/gu, ' ');
}

function codeDelimiter(value: string, start: number): string | null {
	if (value[start] !== '`' || isEscaped(value, start)) return null;
	let end = start + 1;
	while (value[end] === '`') end += 1;
	return '`'.repeat(end - start);
}

function findCodeClose(value: string, start: number, delimiter: string): number | null {
	for (let index = start; index <= value.length - delimiter.length; index += 1) {
		if (value.startsWith(delimiter, index)) return index;
	}
	return null;
}

function degradedMarkdownLabel(interior: string, known: ReadonlySet<number>, depth: number): string {
	if (/^\d+$/u.test(interior)) {
		const citationNumber = Number(interior);
		return known.has(citationNumber) ? `[${citationNumber}]` : '';
	}
	if (/^\d/u.test(interior) && !isNumericArrayInterior(interior)) return '';
	return renderMarkdown(interior, known, true, true, depth + 1);
}

type PendingMarkdownKind = 'bracket' | 'destination';

interface PendingMarkdownConstruct {
	kind: PendingMarkdownKind;
	start: number;
	open: number;
}

interface MarkdownRenderState {
	pending?: PendingMarkdownConstruct;
}

const MAX_PENDING_MARKDOWN_LENGTH = 64 * 1024;
const MAX_REJECTED_LABEL_LENGTH = 4096;
const TOKENIZER_FEED_CHUNK_LENGTH = 4096;

interface RejectedMarkdownConstruct {
	kind: PendingMarkdownKind;
	replacement: string;
	citationNumber?: number;
	depth: number;
	escaped: boolean;
	invalid: boolean;
	squareClosed: boolean;
}

function boundedDegradedMarkdownLabel(
	interior: string,
	known: ReadonlySet<number>,
	depth: number
): { replacement: string; citationNumber?: number } {
	const numeric = interior.match(/^(\d+)$/u);
	if (numeric) {
		const citationNumber = Number(numeric[1]);
		return { replacement: known.has(citationNumber) ? `[${citationNumber}]` : '', citationNumber };
	}
	if (interior.length > MAX_REJECTED_LABEL_LENGTH || /^\d/u.test(interior)) return { replacement: '' };
	const replacement = degradedMarkdownLabel(interior, known, depth);
	return replacement.length <= MAX_REJECTED_LABEL_LENGTH ? { replacement } : { replacement: '' };
}

function scanDestinationFragment(
	value: string,
	open: number
): Pick<RejectedMarkdownConstruct, 'depth' | 'escaped' | 'invalid'> {
	let depth = 0;
	let escaped = false;
	let invalid = false;
	for (let index = open; index < value.length; index += 1) {
		const character = value[index];
		if (escaped) {
			escaped = false;
			continue;
		}
		if (character === '\\') {
			escaped = true;
			continue;
		}
		if (/^[\u0000-\u001f\u007f\u2028\u2029]$/u.test(character)) invalid = true;
		if (character === '(') depth += 1;
		else if (character === ')') depth = Math.max(0, depth - 1);
	}
	return { depth, escaped, invalid };
}

/**
 * The single Markdown/citation tokenizer used by both complete and streaming
 * sanitation. It only classifies a bracket construct after its matching
 * bracket/destination is known; the streaming mode additionally keeps a
 * one-character bracket lookahead and a safe link prefix visible.
 */
function renderMarkdown(
	value: string,
	known: ReadonlySet<number>,
	final: boolean,
	nested = false,
	depth = 0,
	state: MarkdownRenderState = {}
): string {
	if (depth > 32) return '';
	let output = '';
	let cursor = 0;
	while (cursor < value.length) {
		const delimiter = codeDelimiter(value, cursor);
		if (delimiter) {
			const close = findCodeClose(value, cursor + delimiter.length, delimiter);
			if (close === null) return `${output}${value.slice(cursor)}`;
			const end = close + delimiter.length;
			output += value.slice(cursor, end);
			cursor = end;
			continue;
		}
		if (value[cursor] === '!' && value[cursor + 1] === '[' && !isEscaped(value, cursor)) {
			// Let the bracket tokenizer own the image opener so `![alt](` is
			// buffered as one construct rather than exposing `!` first.
			cursor += 1;
			continue;
		}
		if (value[cursor] === '!' && value[cursor + 1] === undefined && !final) {
			state.pending = { kind: 'bracket', start: cursor, open: cursor };
			return output;
		}

		if (value[cursor] !== '[' || isEscaped(value, cursor)) {
			output += value[cursor];
			cursor += 1;
			continue;
		}

		const close = findSquareClose(value, cursor);
		if (close === null) {
			const suffix = value.slice(cursor);
			if (suffix === '[' || containsUnresolvedNumericPrefix(suffix)) {
				if (!final) {
					const image = cursor > 0 && value[cursor - 1] === '!' && !isEscaped(value, cursor - 1);
					state.pending = { kind: 'bracket', start: image ? cursor - 1 : cursor, open: cursor };
					return output;
				}
				const punctuation = suffix.match(/^\[(\d+)([\s\S]*)$/u)?.[2] ?? '';
				return /^[\s.!?:;…—–-]*$/u.test(punctuation) ? `${output}${punctuation}` : output;
			}
			if (final || nested) return output + suffix;
			const image = cursor > 0 && value[cursor - 1] === '!' && !isEscaped(value, cursor - 1);
			state.pending = { kind: 'bracket', start: image ? cursor - 1 : cursor, open: cursor };
			return output;
		}

		const interior = value.slice(cursor + 1, close);
		const next = value[close + 1];
		const image = cursor > 0 && value[cursor - 1] === '!' && !isEscaped(value, cursor - 1);
		const constructStart = image ? cursor - 1 : cursor;
		if (next === '(') {
			const destinationClose = findDestinationClose(value, close + 1);
			if (destinationClose === null) {
				if (final) {
					output += degradedMarkdownLabel(interior, known, depth);
					return output;
				}
				state.pending = { kind: 'destination', start: constructStart, open: close + 1 };
				return output;
			}

			const destination = value.slice(close + 2, destinationClose);
			if (safeMarkdownDestination(destination, image)) {
				output += value.slice(constructStart, destinationClose + 1);
			} else {
				output += degradedMarkdownLabel(interior, known, depth);
			}
			cursor = destinationClose + 1;
			continue;
		}

		if (/^\d/u.test(interior)) {
			if (/^\d+$/u.test(interior)) {
				// A marker at the event boundary needs one lookahead so `[1](`
				// cannot expose an unauthorized citation before its destination.
				if (!final && !nested && next === undefined) {
					state.pending = { kind: 'bracket', start: constructStart, open: cursor };
					return output;
				}
				if (known.has(Number(interior))) output += `[${Number(interior)}]`;
			} else if (isNumericArrayInterior(interior)) {
				const array = `${image ? '!' : ''}${value.slice(cursor, close + 1)}`;
				if (!final && !nested && next === undefined) {
					state.pending = { kind: 'bracket', start: constructStart, open: cursor };
					return output;
				}
				output += array;
			}
			cursor = close + 1;
			continue;
		}

		const sanitizedInterior = renderMarkdown(interior, known, final, true, depth + 1);
		const bracketed = sanitizedInterior || !interior.trim() ? `[${sanitizedInterior}]` : '';
		if (!final && !nested && next === undefined) {
			state.pending = { kind: 'bracket', start: constructStart, open: cursor };
			return output;
		}
		output += `${image ? '!' : ''}${bracketed}`;
		cursor = close + 1;
	}
	return output;
}

class IncrementalMarkdownTokenizer {
	private citations: CitationRecord[];
	private source = '';
	private emittedText = '';
	private canonicalText = '';
	private hasEmitted = false;
	private finished = false;
	private rejected?: RejectedMarkdownConstruct;
	private pendingCharacters = 0;

	constructor(citations: ReadonlyArray<CitationRecord> = []) {
		this.citations = [...citations];
	}

	setCitations(citations: ReadonlyArray<CitationRecord>): string {
		this.citations = [...citations];
		return this.reconcile(false);
	}

	replace(value: string): string {
		this.source = '';
		this.emittedText = '';
		this.canonicalText = '';
		this.hasEmitted = false;
		this.finished = false;
		this.rejected = undefined;
		this.pendingCharacters = 0;
		return this.push(value);
	}

	push(value: string): string {
		if (this.finished || !value) return '';
		let output = '';
		for (let offset = 0; offset < value.length; offset += TOKENIZER_FEED_CHUNK_LENGTH) {
			const chunk = value.slice(offset, offset + TOKENIZER_FEED_CHUNK_LENGTH);
			if (this.rejected) output += this.consumeRejectedChunk(chunk);
			else {
				this.source += chunk;
				output += this.reconcile(false);
			}
		}
		return output;
	}

	flush(): string {
		if (this.finished) return '';
		const known = new Set(this.citations.map((citation) => citation.citationNumber));
		if (this.rejected) {
			this.appendRejectedReplacement(known, this.rejected.squareClosed || this.rejected.kind === 'destination');
		}
		this.finished = true;
		return this.reconcile(true);
	}

	abort(): string {
		return this.flush();
	}

	get emitted(): string {
		return this.emittedText;
	}

	/** Bytes retained for an unresolved/rejected construct, excluding safe answer text. */
	get bufferedCharacters(): number {
		return this.rejected ? 0 : this.pendingCharacters;
	}

	private reconcile(final: boolean): string {
		if (this.rejected) {
			this.canonicalText = this.emittedText;
			return '';
		}
		const known = new Set(this.citations.map((citation) => citation.citationNumber));
		const state: MarkdownRenderState = {};
		const rendered = final
			? canonicalizeCitationText(renderMarkdown(this.source, known, true))
			: renderMarkdown(this.source, known, false, false, 0, state);
		this.canonicalText = rendered;
		if (!final && state.pending) {
			this.pendingCharacters = this.source.length - state.pending.start;
			if (this.pendingCharacters > MAX_PENDING_MARKDOWN_LENGTH) {
				// Bound only the unresolved construct. Confirmed text before it has
				// already been emitted; the rejected state consumes later bytes
				// without retaining them until its balanced close.
				this.activateRejected(state.pending, known);
			}
		} else {
			this.pendingCharacters = 0;
		}
		if (!rendered.startsWith(this.emittedText)) return '';
		let delta = rendered.slice(this.emittedText.length);
		if (!this.hasEmitted) delta = delta.replace(/^\s+/u, '');
		if (delta) {
			this.hasEmitted = true;
			this.emittedText += delta;
		}
		return delta;
	}

	get canonical(): string {
		return this.canonicalText;
	}

	private activateRejected(pending: PendingMarkdownConstruct, known: ReadonlySet<number>): void {
		const source = this.source;
		if (pending.kind === 'destination') {
			const squareClose = pending.open - 1;
			const interiorStart = source[pending.start] === '!' ? pending.start + 2 : pending.start + 1;
			const interior = source.slice(interiorStart, squareClose);
			const label = boundedDegradedMarkdownLabel(interior, known, 0);
			const scan = scanDestinationFragment(source, pending.open);
			this.rejected = {
				kind: 'destination',
				replacement: label.replacement,
				...(label.citationNumber !== undefined ? { citationNumber: label.citationNumber } : {}),
				...scan,
				squareClosed: true
			};
		} else {
			const scan = this.scanRejectedBracket(source, pending.open);
			this.rejected = {
				kind: 'bracket',
				replacement: scan.replacement,
				...(scan.citationNumber !== undefined ? { citationNumber: scan.citationNumber } : {}),
				depth: scan.depth,
				escaped: scan.escaped,
				invalid: scan.invalid,
				squareClosed: scan.squareClosed
			};
		}
		this.source = source.slice(0, pending.start);
		this.pendingCharacters = 0;
	}

	private scanRejectedBracket(
		value: string,
		open: number
	): Pick<RejectedMarkdownConstruct, 'depth' | 'escaped' | 'invalid' | 'squareClosed' | 'replacement' | 'citationNumber'> {
		let depth = 0;
		let escaped = false;
		let invalid = false;
		let squareClosed = false;
		let close = -1;
		for (let index = open; index < value.length; index += 1) {
			const character = value[index];
			if (escaped) {
				escaped = false;
				continue;
			}
			if (character === '\\') {
				escaped = true;
				continue;
			}
			if (/^[\u0000-\u001f\u007f\u2028\u2029]$/u.test(character)) invalid = true;
			if (character === '[') depth += 1;
			else if (character === ']') {
				depth = Math.max(0, depth - 1);
				if (depth === 0) {
					squareClosed = true;
					close = index;
					break;
				}
			}
		}
		const interiorStart = open + 1;
		const interior = close >= 0 ? value.slice(interiorStart, close) : '';
		const label = close >= 0 ? boundedDegradedMarkdownLabel(interior, this.knownCitations(), 0) : { replacement: '' };
		return {
			depth,
			escaped,
			invalid,
			squareClosed,
			replacement: label.replacement,
			...(label.citationNumber !== undefined ? { citationNumber: label.citationNumber } : {})
		};
	}

	private consumeRejectedChunk(value: string): string {
		let offset = 0;
		while (this.rejected && offset < value.length) {
			const rejected = this.rejected;
			if (rejected.kind === 'destination') {
				while (offset < value.length) {
					const character = value[offset++];
					if (rejected.escaped) {
						rejected.escaped = false;
						continue;
					}
					if (character === '\\') {
						rejected.escaped = true;
						continue;
					}
					if (/^[\u0000-\u001f\u007f\u2028\u2029]$/u.test(character)) rejected.invalid = true;
					if (character === '(') rejected.depth += 1;
					else if (character === ')') {
						rejected.depth -= 1;
						if (rejected.depth === 0) {
							this.rejected = undefined;
							this.source += this.replacementForRejected(rejected);
							break;
						}
					}
				}
				if (this.rejected) return '';
				break;
			}

			while (offset < value.length && this.rejected) {
				const character = value[offset++];
				if (rejected.squareClosed) {
					if (character === '(') {
						this.rejected = {
							...rejected,
							kind: 'destination',
							depth: 1,
							escaped: false,
							squareClosed: true
						};
						break;
					}
					this.source += this.replacementForRejected(rejected);
					this.rejected = undefined;
					offset -= 1;
					break;
				}
				if (rejected.escaped) {
					rejected.escaped = false;
					continue;
				}
				if (character === '\\') {
					rejected.escaped = true;
					continue;
				}
				if (/^[\u0000-\u001f\u007f\u2028\u2029]$/u.test(character)) rejected.invalid = true;
				if (character === '[') rejected.depth += 1;
				else if (character === ']') {
					rejected.depth = Math.max(0, rejected.depth - 1);
					if (rejected.depth === 0) rejected.squareClosed = true;
				}
			}
		}
		if (offset < value.length) this.source += value.slice(offset);
		return this.reconcile(false);
	}

	private appendRejectedReplacement(known: ReadonlySet<number>, emit: boolean): void {
		const rejected = this.rejected;
		if (!rejected) return;
		if (emit) this.source += this.replacementForRejected(rejected, known);
		this.rejected = undefined;
		this.pendingCharacters = 0;
	}

	private replacementForRejected(
		rejected: RejectedMarkdownConstruct,
		known = this.knownCitations()
	): string {
		if (rejected.citationNumber !== undefined) {
			return known.has(rejected.citationNumber) ? `[${rejected.citationNumber}]` : '';
		}
		return rejected.replacement;
	}

	private knownCitations(): ReadonlySet<number> {
		return new Set(this.citations.map((citation) => citation.citationNumber));
	}
}

/** Streaming façade over the shared incremental tokenizer. */
export class StreamingCitationSanitizer extends IncrementalMarkdownTokenizer {}

/**
 * Remove provider-authored citation syntax unless the stream has already
 * supplied the exact inspectable record for that number. This is a transport
 * safety net; structured research answers should arrive with canonical
 * citation records before their authoritative replacement is emitted.
 */
export function sanitizeUnresolvedCitationMarkers(
	value: string,
	citations: ReadonlyArray<CitationRecord>
): string {
	const tokenizer = new IncrementalMarkdownTokenizer(citations);
	tokenizer.push(value);
	tokenizer.flush();
	return tokenizer.canonical.trim();
}

/** Rewrites only text-bearing SSE fields after the same stateful marker check. */
export function sanitizeCitationEventData(
	event: string,
	data: string,
	citations: ReadonlyArray<CitationRecord>,
	stream?: StreamingCitationSanitizer
): string {
	const payload = parseJsonObject(data);
	if (!payload) {
		if (event === 'agent.answer.replace' || event === 'agent.answer_replace') {
			return stream ? stream.replace(data) : sanitizeUnresolvedCitationMarkers(data, citations);
		}
		if (event === 'message' || event === 'response.output_text.delta') {
			return stream ? stream.push(data) : sanitizeUnresolvedCitationMarkers(data, citations);
		}
		return data;
	}
	const sanitize = (value: unknown, replacement = false): unknown => {
		if (typeof value !== 'string') return value;
		if (stream) return replacement ? stream.replace(value) : stream.push(value);
		return sanitizeUnresolvedCitationMarkers(value, citations);
	};

	if (event === 'agent.answer.replace' || event === 'agent.answer_replace') {
		if (typeof payload.content !== 'string') return data;
		return JSON.stringify({ ...payload, content: sanitize(payload.content, true) });
	}
	if (event === 'message') {
		const choices = arrayValue(payload.choices).map((rawChoice) => {
			const choice = objectValue(rawChoice);
			if (!choice) return rawChoice;
			const delta = objectValue(choice.delta);
			const message = objectValue(choice.message);
			return {
				...choice,
				...(delta && typeof delta.content === 'string'
					? { delta: { ...delta, content: sanitize(delta.content) } }
					: {}),
				...(message && typeof message.content === 'string'
					? { message: { ...message, content: sanitize(message.content) } }
					: {})
			};
		});
		return JSON.stringify({ ...payload, choices });
	}
	if (event === 'response.output_text.delta' && typeof payload.delta === 'string') {
		return JSON.stringify({ ...payload, delta: sanitize(payload.delta) });
	}
	if (event === 'response.output_item.added' || event === 'response.output_item.done' || event === 'response.completed') {
		const rewriteOutputItem = (rawItem: unknown): unknown => {
			const item = objectValue(rawItem);
			if (!item) return rawItem;
			const content = arrayValue(item.content).map((rawPart) => {
				const part = objectValue(rawPart);
				if (!part || typeof part.text !== 'string') return rawPart;
				return { ...part, text: sanitize(part.text) };
			});
			return {
				...item,
				...(content.length ? { content } : {}),
				...(typeof item.text === 'string' ? { text: sanitize(item.text) } : {})
			};
		};
		const response = objectValue(payload.response);
		if (response && Array.isArray(response.output)) {
			return JSON.stringify({ ...payload, response: { ...response, output: response.output.map(rewriteOutputItem) } });
		}
		if (Array.isArray(payload.output)) return JSON.stringify({ ...payload, output: payload.output.map(rewriteOutputItem) });
		if (payload.item) return JSON.stringify({ ...payload, item: rewriteOutputItem(payload.item) });
	}
	return data;
}

function citationFromValue(value: unknown): CitationRecord | null {
	const record = objectValue(value);
	if (!record) return null;
	const citationNumber = numberValue(record.citationNumber ?? record.citation_number ?? record.number);
	const url = citationUrl(record.url);
	if (!citationNumber || citationNumber < 1 || !Number.isInteger(citationNumber) || !url) return null;
	const sourceTypeValue = stringValue(record.sourceType ?? record.source_type) as CitationSourceType | null;
	const sourceType = sourceTypeValue && CITATION_SOURCE_TYPES.has(sourceTypeValue) ? sourceTypeValue : 'unknown';
	const documentPage = numberValue(record.documentPage ?? record.document_page ?? record.page);
	const rawRetrieval = objectValue(record.retrieval);
	const retrieval =
		rawRetrieval && stringValue(rawRetrieval.originalUrl)
			? (rawRetrieval as unknown as RetrievalProvenance)
			: undefined;
	return {
		citationNumber,
		title: stringValue(record.title) || url,
		url,
		domain: stringValue(record.domain) || domainOf(url) || 'Attached document',
		publicationDate: stringValue(record.publicationDate ?? record.publication_date) || null,
		sourceType,
		supportingExcerpt: stringValue(record.supportingExcerpt ?? record.supporting_excerpt ?? record.excerpt) || '',
		...(documentPage && documentPage > 0 ? { documentPage: Math.floor(documentPage) } : {}),
		...(retrieval ? { retrieval } : {})
	};
}

function parseJsonObject(data: string): JsonObject | null {
	try {
		return objectValue(JSON.parse(data));
	} catch {
		return null;
	}
}

function parseMaybeJson(value: unknown): unknown {
	if (typeof value !== 'string') return value;
	const trimmed = value.trim();
	if (!trimmed) return value;
	if (!/^[{[]/.test(trimmed)) return value;
	try {
		return JSON.parse(trimmed) as unknown;
	} catch {
		return value;
	}
}

function statusValue(value: unknown, fallback = 'running'): StreamToolCall['status'] {
	const raw = stringValue(value)?.toLowerCase() ?? fallback;
	if (['done', 'end', 'complete', 'completed', 'success', 'ok'].includes(raw)) return 'ok';
	if (['failed', 'failure', 'error', 'errored'].includes(raw)) return 'failed';
	if (['start', 'started', 'running', 'active', 'in_progress', 'progress', 'queued', 'pending'].includes(raw)) {
		return 'running';
	}
	return raw;
}

function isTerminalStatus(value: unknown): boolean {
	const raw = stringValue(value)?.toLowerCase();
	if (!raw) return false;
	return [
		'done',
		'end',
		'complete',
		'completed',
		'success',
		'ok',
		'failed',
		'failure',
		'error',
		'errored'
	].includes(raw);
}

function isStartLikeStatus(value: unknown): boolean {
	const raw = stringValue(value)?.toLowerCase();
	if (!raw) return true;
	return ['start', 'started', 'queued', 'pending', 'open', 'fetch', 'reading'].includes(raw);
}

function domainOf(url: string): string | undefined {
	try {
		return new URL(url).hostname.replace(/^www\./, '');
	} catch {
		return undefined;
	}
}

function sourceFromPayload(payload: JsonObject): StreamSourceUpdate | null {
	const nested = objectValue(payload.source) ?? objectValue(payload.url) ?? null;
	const source = nested ?? payload;
	const url = stringValue(source.url ?? source.href ?? source.link ?? source.uri);
	if (!url || !/^https?:\/\//i.test(url)) return null;
	const title =
		stringValue(source.title ?? source.name ?? source.label) ||
		stringValue(payload.title ?? payload.name) ||
		url;
	const stepId = stringValue(payload.stepId ?? source.stepId) ?? undefined;
	const rawRetrieval = objectValue(source.retrieval ?? payload.retrieval);
	const retrieval =
		rawRetrieval && stringValue(rawRetrieval.originalUrl)
			? (rawRetrieval as unknown as RetrievalProvenance)
			: undefined;
	return {
		id: stringValue(source.id ?? payload.id) || url,
		url,
		title,
		status: stringValue(source.status ?? payload.status ?? payload.phase) || 'reading',
		domain: stringValue(source.domain ?? payload.domain) ?? domainOf(url),
		detail:
			stringValue(source.detail ?? source.summary ?? source.snippet ?? payload.detail ?? payload.message) ??
			undefined,
		...(stepId ? { stepId } : {}),
		verified: source.verified === true || payload.verified === true,
		currentVerified: source.currentVerified === true || payload.currentVerified === true,
		temporalScope:
			stringValue(source.temporalScope ?? source.temporal_scope ?? payload.temporalScope ?? payload.temporal_scope) ??
			null,
		publishedAt:
			stringValue(source.publishedAt ?? source.published_at ?? payload.publishedAt ?? payload.published_at) ??
			null,
		updatedAt:
			stringValue(source.updatedAt ?? source.updated_at ?? payload.updatedAt ?? payload.updated_at) ?? null,
		eventAt: stringValue(source.eventAt ?? source.event_at ?? payload.eventAt ?? payload.event_at) ?? null,
		...(retrieval ? { retrieval } : {})
	};
}

function sourceEventIsVerified(source: StreamSourceUpdate): boolean {
	if (source.verified !== true) return false;
	if (source.currentVerified !== true) return true;
	if (!['primary', 'fallback'].includes(source.temporalScope || '')) return false;
	return Number.isFinite(Date.parse(source.eventAt || source.updatedAt || source.publishedAt || ''));
}

function sourceStatusIsUsed(status: string | undefined, startIsUsed = false): boolean {
	const value = (status || '').toLowerCase();
	if (['queued', 'pending', 'discovered', 'result', 'search_result', 'skipped', 'error'].includes(value)) {
		return false;
	}
	if (['start', 'started'].includes(value)) return startIsUsed;
	return [
		'open',
		'opened',
		'fetch',
		'fetched',
		'reading',
		'read',
		'used',
		'done',
		'ok',
		'complete',
		'completed',
		'success'
	].includes(value);
}

function sourcePayloadLooksUsed(
	payload: JsonObject,
	source: StreamSourceUpdate,
	startIsUsed = false
): boolean {
	if (sourceStatusIsUsed(source.status, startIsUsed)) return true;
	const nestedTool = objectValue(payload.tool);
	const name =
		firstString(
			payload.name,
			payload.tool,
			payload.tool_name,
			nestedTool?.name,
			nestedTool?.tool_name,
			nestedTool?.type,
			payload.type
		) || '';
	return /browse|browser|fetch|read|open|http|url|page|navigate/i.test(name);
}

function chatDelta(payload: JsonObject): string {
	const choices = arrayValue(payload.choices);
	const first = objectValue(choices[0]);
	const delta = objectValue(first?.delta);
	const message = objectValue(first?.message);
	return rawString(delta?.content ?? message?.content) ?? '';
}

function chatFinished(payload: JsonObject): boolean {
	const choices = arrayValue(payload.choices);
	return choices.some((choice) => objectValue(choice)?.finish_reason != null);
}

function outputTextFromContentPart(part: unknown): string {
	const obj = objectValue(part);
	if (!obj) return '';
	const type = stringValue(obj.type);
	if (type === 'output_text' || type === 'text') return rawString(obj.text) ?? '';
	return '';
}

function outputTextFromItem(item: unknown): string {
	const obj = objectValue(item);
	if (!obj) return '';
	const type = stringValue(obj.type);
	if (type === 'message') return arrayValue(obj.content).map(outputTextFromContentPart).join('');
	if (type === 'output_text') return rawString(obj.text) ?? '';
	return '';
}

function outputTextFromResponse(response: JsonObject): string {
	return arrayValue(response.output).map(outputTextFromItem).join('');
}

export function sseFrame(event: string, data: string): string {
	let out = event && event !== 'message' ? `event: ${event}\n` : '';
	for (const line of data.split(/\r?\n/)) out += `data: ${line}\n`;
	return `${out}\n`;
}

export class StreamEventState {
	private calls = new Map<string, StreamToolCall>();
	private sources = new Map<string, PersistedSource>();
	private citations = new Map<string, CitationRecord>();
	private itemToCall = new Map<string, string>();
	private argumentText = new Map<string, string>();
	private anonymousActive = new Map<string, string>();
	private anonymousKeys = new Map<string, string>();
	private textDeltaSeen = false;
	private seq = 0;

	apply(event: string, data: string, now = Date.now()): StreamEventUpdate[] {
		if (data === '[DONE]') return [{ done: true }];

		const payload = parseJsonObject(data);
		if (event === 'agent.title' && payload) {
			const title = stringValue(payload.title);
			return title ? [{ title }] : [];
		}
		if (!payload) return [];

		if (event === 'agent.answer.replace' || event === 'agent.answer_replace') {
			const content = rawString(payload.content);
			if (content === null) return [];
			this.textDeltaSeen = true;
			return [{ replace: content }];
		}
		if (event === 'agent.answer.partial') return [{ partial: true }];
		if (event === 'agent.persistence_error') {
			return [{ failed: stringValue(payload.message) || 'answer persistence failed; retry to save the answer' }];
		}

		if (event === 'message') {
			const delta = chatDelta(payload);
			const updates: StreamEventUpdate[] = [];
			if (delta) {
				this.textDeltaSeen = true;
				updates.push({ delta });
			}
			if (chatFinished(payload)) updates.push({ done: true });
			return updates;
		}

		if (event === 'agent.plan') return this.applyAgentPlan(payload);

		if (event === 'agent.citations') {
			const raw = Array.isArray(payload.citations) ? payload.citations : [];
			for (const item of raw) {
				const citation = citationFromValue(item);
				if (citation) {
					const key = `${citation.citationNumber}\u0000${citation.url}\u0000${citation.documentPage ?? ''}`;
					this.citations.set(key, citation);
				}
			}
			return this.citations.size ? [{ citations: this.citationList() }] : [];
		}

		if (event === 'agent.tool.progress') return this.applyAgentTool(payload, now);

		if (event.startsWith('agent.source') || event.startsWith('agent.progress')) {
			const source = sourceFromPayload(payload);
			if (source && sourceEventIsVerified(source)) {
				const persisted = this.upsertSource(source, now, sourcePayloadLooksUsed(payload, source, false));
				return [{ source: persisted }];
			}
			return this.upsertTool(payload, now).map((tool) => ({ tool }));
		}

		if (event.startsWith('response.')) return this.applyResponseEvent(event, payload, now);

		return [];
	}

	toolCalls(): StreamToolCall[] {
		return Array.from(this.calls.values())
			.map((call) => ({ ...call }))
			.sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
	}

	sourceList(): PersistedSource[] {
		return Array.from(this.sources.values())
			.map((source) => ({ ...source }))
			.sort((a, b) => a.firstSeenAt - b.firstSeenAt);
	}

	citationList(): CitationRecord[] {
		return Array.from(this.citations.values())
			.map((citation) => ({ ...citation }))
			.sort((a, b) => a.citationNumber - b.citationNumber);
	}

	private applyAgentPlan(payload: JsonObject): StreamEventUpdate[] {
		const source = (stringValue(payload.source) as StreamPlanUpdate['source']) || 'router';
		const rawSteps = arrayValue(payload.steps);
		const steps: PlanStep[] = rawSteps.flatMap((raw) => {
			const obj = objectValue(raw);
			if (!obj) return [];
			const id = stringValue(obj.id) || `step_${Math.random().toString(36).slice(2)}`;
			const label = stringValue(obj.label) || 'Researching';
			const rawStatus = stringValue(obj.status) || 'pending';
			const status: PlanStepStatus = ['pending', 'running', 'ok', 'failed', 'skipped'].includes(rawStatus)
				? (rawStatus as PlanStepStatus)
				: 'pending';
			const detail = stringValue(obj.detail) ?? undefined;
			const requirementId = stringValue(obj.requirementId ?? obj.requirement_id) ?? undefined;
			const phaseValue = stringValue(obj.phase);
			const phase = phaseValue === 'discovery' || phaseValue === 'official' || phaseValue === 'corroboration' ? phaseValue : undefined;
			return [{ id, label, status, ...(detail ? { detail } : {}), ...(requirementId ? { requirementId } : {}), ...(phase ? { phase } : {}) }];
		});
		if (!steps.length) return [];
		const rawCoverage = arrayValue(payload.requirementCoverage ?? payload.requirement_coverage);
		const requirementCoverage = rawCoverage.flatMap((raw) => {
			const obj = objectValue(raw);
			if (!obj) return [];
			const id = stringValue(obj.requirement_id ?? obj.requirementId);
			const label = stringValue(obj.label);
			if (!id || !label) return [];
			return [{
				requirement_id: id,
				label,
				requested_count: numberValue(obj.requested_count ?? obj.requestedCount) || 0,
				accepted_count: numberValue(obj.accepted_count ?? obj.acceptedCount) || 0,
				state: stringValue(obj.state) || 'pending',
				gaps: arrayValue(obj.gaps).map((gap) => stringValue(gap)).filter((gap): gap is string => Boolean(gap)),
				likely_to_improve: obj.likely_to_improve === true || obj.likelyToImprove === true,
				executed_actions: numberValue(obj.executed_actions ?? obj.executedActions) || 0,
				skipped_actions: numberValue(obj.skipped_actions ?? obj.skippedActions) || 0,
				budget_exhausted: obj.budget_exhausted === true || obj.budgetExhausted === true
			}];
		});
		const assignmentStatus = stringValue(payload.assignmentStatus ?? payload.assignment_status) ?? undefined;
		return [{ plan: { source, steps, ...(requirementCoverage.length ? { requirementCoverage } : {}), ...(assignmentStatus ? { assignmentStatus } : {}) } }];
	}

	private applyAgentTool(payload: JsonObject, now: number): StreamEventUpdate[] {
		const updates: StreamEventUpdate[] = [];
		const source = sourceFromPayload(payload);
		if (source && sourceEventIsVerified(source)) {
			const persisted = this.upsertSource(source, now, sourcePayloadLooksUsed(payload, source, true));
			updates.push({ source: persisted });
		}

		const terminal = isTerminalStatus(payload.status ?? payload.phase);
		for (const tool of this.upsertTool(payload, now)) {
			if (terminal) {
				tool.done = true;
				tool.endedAt ??= now;
			}
			updates.push({ tool });
		}
		return updates;
	}

	private applyResponseEvent(event: string, payload: JsonObject, now: number): StreamEventUpdate[] {
		if (event === 'response.output_text.delta') {
			const delta = rawString(payload.delta) ?? '';
			if (!delta) return [];
			this.textDeltaSeen = true;
			return [{ delta }];
		}

		if (event === 'response.output_item.added' || event === 'response.output_item.done') {
			const item = objectValue(payload.item);
			return item ? this.applyResponseItem(item, event, now) : [];
		}

		if (event === 'response.function_call_arguments.delta') {
			return this.applyArgumentsDelta(payload, now);
		}

		if (event === 'response.function_call_arguments.done') {
			return this.applyArgumentsDone(payload, now);
		}

		if (event === 'response.completed') {
			const response = objectValue(payload.response) ?? payload;
			const updates = arrayValue(response.output).flatMap((item) =>
				this.applyResponseItem(objectValue(item) ?? {}, event, now)
			);
			if (!this.textDeltaSeen) {
				const text = outputTextFromResponse(response);
				if (text) {
					this.textDeltaSeen = true;
					updates.push({ delta: text });
				}
			}
			updates.push({ done: true });
			return updates;
		}

		if (event === 'response.failed' || event === 'response.incomplete') {
			const error = objectValue(payload.error ?? objectValue(payload.response)?.error);
			const detail =
				stringValue(error?.message) ||
				stringValue(payload.message ?? objectValue(payload.response)?.status) ||
				event;
			return [{ failed: detail, done: true }];
		}

		return [];
	}

	private applyResponseItem(item: JsonObject, event: string, now: number): StreamEventUpdate[] {
		const type = stringValue(item.type);
		if (type === 'function_call') {
			const id = this.toolIdFromItem(item);
			const itemId = stringValue(item.id);
			if (itemId) this.itemToCall.set(itemId, id);
			const call = this.ensureTool(id, stringValue(item.name) || 'function_call', now);
			call.name = stringValue(item.name) || call.name;
			call.status = statusValue(item.status, 'running');
			this.applyArgumentsValue(call, item.arguments ?? item.arguments_json);
			if (statusValue(item.status) === 'failed') {
				call.endedAt ??= now;
				return [{ tool: { ...call, done: true } }];
			}
			return [{ tool: { ...call, done: false } }];
		}

		if (type === 'function_call_output') {
			const id = this.toolIdFromItem(item);
			const call = this.ensureTool(id, stringValue(item.name) || 'function_call', now);
			const output = item.output ?? item.result ?? item.content;
			if (output !== undefined) call.result = parseMaybeJson(output);
			call.status = statusValue(item.status, stringValue(item.error) ? 'failed' : 'ok');
			call.detail = stringValue(item.error ?? item.detail ?? item.summary) ?? call.detail;
			call.endedAt ??= now;
			call.durationMs = numberValue(item.duration_ms ?? item.durationMs) ?? call.durationMs;
			return [{ tool: { ...call, done: true } }];
		}

		return [];
	}

	private applyArgumentsDelta(payload: JsonObject, now: number): StreamEventUpdate[] {
		const id = this.toolIdFromPayload(payload);
		if (!id) return [];
		const call = this.ensureTool(id, stringValue(payload.name) || 'function_call', now);
		const delta = rawString(payload.delta) ?? '';
		if (delta) {
			const next = `${this.argumentText.get(id) ?? ''}${delta}`;
			this.argumentText.set(id, next);
			call.arguments = parseMaybeJson(next);
		}
		return [{ tool: { ...call, done: false } }];
	}

	private applyArgumentsDone(payload: JsonObject, now: number): StreamEventUpdate[] {
		const id = this.toolIdFromPayload(payload);
		if (!id) return [];
		const call = this.ensureTool(id, stringValue(payload.name) || 'function_call', now);
		const args = payload.arguments ?? this.argumentText.get(id);
		this.applyArgumentsValue(call, args);
		return [{ tool: { ...call, done: false } }];
	}

	private upsertTool(payload: JsonObject, now: number): StreamToolUpdate[] {
		const nestedTool = objectValue(payload.tool);
		const name =
			firstString(
				payload.name,
				payload.tool,
				payload.tool_name,
				nestedTool?.name,
				nestedTool?.tool_name,
				nestedTool?.type,
				payload.type
			) || 'tool';
		const explicitId = firstString(
			payload.id,
			payload.call_id,
			payload.callId,
			payload.tool_call_id,
			nestedTool?.id,
			nestedTool?.call_id,
			nestedTool?.callId,
			nestedTool?.tool_call_id
		);
		const status = payload.status ?? payload.phase ?? nestedTool?.status ?? nestedTool?.phase;
		const terminal = isTerminalStatus(status);
		const semanticKey = this.semanticToolKey(name, payload, nestedTool);
		const completed: StreamToolUpdate[] = [];
		const id =
			explicitId ?? this.anonymousToolId(name, semanticKey, status, terminal, now, completed);
		const call = this.ensureTool(id, name, now);
		call.name = name;
		call.status = statusValue(status, call.status ?? 'running');
		call.detail =
			firstString(
				payload.detail,
				nestedTool?.detail,
				payload.message,
				nestedTool?.message,
				payload.summary,
				nestedTool?.summary,
				payload.label,
				nestedTool?.label,
				payload.preview,
				nestedTool?.preview,
				payload.error,
				nestedTool?.error
			) ?? call.detail;
		call.url =
			firstString(
				payload.url,
				payload.href,
				payload.link,
				payload.uri,
				nestedTool?.url,
				nestedTool?.href,
				nestedTool?.link,
				nestedTool?.uri
			) ?? call.url;
		call.title = firstString(payload.title, nestedTool?.title, payload.label, nestedTool?.label) ?? call.title;
		call.transcript =
			firstString(payload.transcript, nestedTool?.transcript, payload.preview, nestedTool?.preview) ??
			call.transcript;
		this.applyArgumentsValue(
			call,
			payload.arguments ?? payload.args ?? payload.input ?? nestedTool?.arguments ?? nestedTool?.args ?? nestedTool?.input
		);
		const result =
			payload.result ?? payload.output ?? payload.response ?? nestedTool?.result ?? nestedTool?.output ?? nestedTool?.response;
		if (result !== undefined) call.result = parseMaybeJson(result);
		if (terminal) {
			call.endedAt ??= now;
			if (!explicitId && this.anonymousActive.get(name) === id) {
				this.anonymousActive.delete(name);
			}
		} else if (!explicitId) {
			this.anonymousActive.set(name, id);
			if (semanticKey) this.anonymousKeys.set(id, semanticKey);
		}
		return [...completed, { ...call, done: Boolean(call.endedAt) }];
	}

	private upsertSource(source: StreamSourceUpdate, now: number, used: boolean): PersistedSource {
		const existing = this.sources.get(source.url);
		const next: PersistedSource = {
			...existing,
			...source,
			id: existing?.id ?? source.id,
			domain: source.domain ?? existing?.domain ?? domainOf(source.url) ?? source.url,
			firstSeenAt: existing?.firstSeenAt ?? now,
			lastSeenAt: now,
			used: Boolean(existing?.used || used),
			// Prefer the stepId from the authoritative source event; keep existing if
			// the new update doesn't carry one (e.g. a tool-progress side-effect upsert).
			...(source.stepId ? { stepId: source.stepId } : existing?.stepId ? { stepId: existing.stepId } : {})
		};
		this.sources.set(source.url, next);
		return next;
	}

	private anonymousToolId(
		name: string,
		semanticKey: string,
		status: unknown,
		terminal: boolean,
		now: number,
		completed: StreamToolUpdate[]
	): string {
		const activeId = this.anonymousActive.get(name);
		const active = activeId ? this.calls.get(activeId) : undefined;
		const activeKey = activeId ? (this.anonymousKeys.get(activeId) ?? '') : '';

		if (terminal && active && !active.endedAt) return active.id;

		if (active && !active.endedAt) {
			const sameStep = !semanticKey || !activeKey || semanticKey === activeKey;
			if (sameStep || !isStartLikeStatus(status)) return active.id;

			const finished = this.finishTool(active.id, now);
			if (finished) completed.push(finished);
		}

		const id = `${name}-${++this.seq}`;
		if (semanticKey) this.anonymousKeys.set(id, semanticKey);
		this.anonymousActive.set(name, id);
		return id;
	}

	private semanticToolKey(name: string, payload: JsonObject, nestedTool: JsonObject | null): string {
		const parts = [
			name,
			firstString(payload.url, payload.href, payload.link, payload.uri, nestedTool?.url, nestedTool?.href, nestedTool?.link, nestedTool?.uri),
			firstString(payload.title, nestedTool?.title),
			firstString(payload.detail, nestedTool?.detail),
			firstString(payload.message, nestedTool?.message),
			firstString(payload.summary, nestedTool?.summary),
			firstString(payload.label, nestedTool?.label),
			firstString(payload.preview, nestedTool?.preview),
			this.argumentsKey(payload.arguments ?? payload.args ?? payload.input ?? nestedTool?.arguments ?? nestedTool?.args ?? nestedTool?.input)
		].filter(Boolean);
		return parts.join('\n');
	}

	private argumentsKey(value: unknown): string {
		if (value === undefined || value === null) return '';
		const parsed = parseMaybeJson(value);
		if (typeof parsed === 'string') return parsed.trim();
		try {
			return JSON.stringify(parsed);
		} catch {
			return '';
		}
	}

	private finishTool(id: string, now: number): StreamToolUpdate | null {
		const call = this.calls.get(id);
		if (!call || call.endedAt) return null;
		call.status = statusValue('ok');
		call.endedAt = now;
		return { ...call, done: true };
	}

	private ensureTool(id: string, name: string, now: number): StreamToolCall {
		const existing = this.calls.get(id);
		if (existing) return existing;
		const call: StreamToolCall = { id, name, status: 'running', startedAt: now };
		this.calls.set(id, call);
		return call;
	}

	private toolIdFromItem(item: JsonObject): string {
		return (
			stringValue(item.call_id ?? item.callId ?? item.tool_call_id) ||
			(stringValue(item.id) ? this.itemToCall.get(stringValue(item.id) as string) : null) ||
			stringValue(item.id) ||
			`tool-${++this.seq}`
		);
	}

	private toolIdFromPayload(payload: JsonObject): string | null {
		const callId = stringValue(payload.call_id ?? payload.callId ?? payload.tool_call_id);
		if (callId) return callId;
		const itemId = stringValue(payload.item_id ?? payload.itemId ?? payload.id);
		if (!itemId) return null;
		return this.itemToCall.get(itemId) ?? itemId;
	}

	private applyArgumentsValue(call: StreamToolCall, value: unknown): void {
		if (value === undefined || value === null) return;
		call.arguments = parseMaybeJson(value);
		if (typeof value === 'string') this.argumentText.set(call.id, value);
	}
}
