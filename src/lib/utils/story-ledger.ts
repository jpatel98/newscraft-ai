/**
 * Pure parsing for the story-ledger block the research worker appends as the
 * LAST thing in an answer:
 *
 *   ```newscraft-ledger
 *   {"claims":[{"claim":"...","status":"confirmed", ...}]}
 *   ```
 *
 * The block is machine-readable only. It is extracted and stored server-side
 * and must never reach the user, the exported Markdown, or the artifact pane.
 * This module has no server imports so the thread UI can also use it to hide
 * a block that is still streaming in.
 */

export const LEDGER_FENCE_INFO = 'newscraft-ledger';
export const LEDGER_FENCE_OPEN = '```newscraft-ledger';
export const LEDGER_STATUSES = ['confirmed', 'alleged', 'reported', 'unverified', 'retracted'] as const;
export type LedgerStatus = (typeof LEDGER_STATUSES)[number];

export const LEDGER_MAX_CLAIMS = 12;
export const LEDGER_MAX_CLAIM_CHARS = 240;
export const LEDGER_MAX_ATTRIBUTION_CHARS = 160;
export const LEDGER_MAX_CITATIONS = 12;

export interface LedgerClaim {
	claim: string;
	status: LedgerStatus;
	attributedTo: string;
	citations: number[];
	/** YYYY-MM-DD or empty. */
	date: string;
	needsCheck: boolean;
	/** Existing claim id this claim replaces, when the worker named one. */
	supersedes?: string;
}

export interface LedgerSplit {
	/** The answer with the ledger block removed (trailing whitespace trimmed). */
	visible: string;
	/** Validated claims, or null when no block was found or its JSON was invalid. */
	claims: LedgerClaim[] | null;
	/** True when a trailing ledger block was found, valid or not. */
	found: boolean;
}

const STATUS_SET: ReadonlySet<string> = new Set(LEDGER_STATUSES);
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validDate(value: unknown): string {
	if (typeof value !== 'string') return '';
	const text = value.trim();
	const match = ISO_DATE.exec(text);
	if (!match) return '';
	const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
	const date = new Date(Date.UTC(year, month - 1, day));
	return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
		? text
		: '';
}

function citationNumbers(value: unknown): number[] {
	if (!Array.isArray(value)) return [];
	const out: number[] = [];
	for (const item of value) {
		if (typeof item === 'number' && Number.isSafeInteger(item) && item > 0 && !out.includes(item)) {
			out.push(item);
			if (out.length >= LEDGER_MAX_CITATIONS) break;
		}
	}
	return out;
}

/** Validates one raw claim; returns null when it cannot be stored safely. */
export function normalizeLedgerClaim(raw: unknown): LedgerClaim | null {
	if (!isRecord(raw)) return null;
	const claim = typeof raw.claim === 'string' ? raw.claim.replace(/\s+/g, ' ').trim() : '';
	if (!claim || claim.length > LEDGER_MAX_CLAIM_CHARS) return null;
	const status = typeof raw.status === 'string' ? raw.status.trim().toLowerCase() : '';
	if (!STATUS_SET.has(status)) return null;
	const attributedRaw = raw.attributed_to ?? raw.attributedTo;
	const attributedTo =
		typeof attributedRaw === 'string'
			? attributedRaw.replace(/\s+/g, ' ').trim().slice(0, LEDGER_MAX_ATTRIBUTION_CHARS)
			: '';
	const supersedes =
		typeof raw.supersedes === 'string' && raw.supersedes.trim() && raw.supersedes.trim().length <= 64
			? raw.supersedes.trim()
			: undefined;
	return {
		claim,
		status: status as LedgerStatus,
		attributedTo,
		citations: citationNumbers(raw.citations),
		date: validDate(raw.date),
		needsCheck: (raw.needs_check ?? raw.needsCheck) === true,
		...(supersedes ? { supersedes } : {})
	};
}

/**
 * Locate a trailing ledger block. Returns the index where the fence opens and
 * the body text, or null when the text has no block in last position.
 */
function findTrailingBlock(text: string): { start: number; body: string } | null {
	let start = text.lastIndexOf(LEDGER_FENCE_OPEN);
	while (start > 0 && text[start - 1] !== '\n') {
		// Only a fence that begins its own line counts.
		start = text.lastIndexOf(LEDGER_FENCE_OPEN, start - 1);
	}
	if (start < 0) return null;
	const afterOpen = text.slice(start + LEDGER_FENCE_OPEN.length);
	// The info string must end at the line: "```newscraft-ledger-x" is not ours.
	if (afterOpen.length && !/^[ \t]*(\r?\n|$)/.test(afterOpen)) return null;
	const close = afterOpen.indexOf('```');
	if (close >= 0) {
		const tail = afterOpen.slice(close + 3);
		if (tail.trim()) return null; // not trailing
		return { start, body: afterOpen.slice(0, close) };
	}
	return { start, body: afterOpen };
}

export function splitLedgerBlock(answerText: string): LedgerSplit {
	const text = typeof answerText === 'string' ? answerText : '';
	const block = findTrailingBlock(text);
	if (!block) return { visible: text, claims: null, found: false };
	const visible = text.slice(0, block.start).trimEnd();
	let parsed: unknown;
	try {
		parsed = JSON.parse(block.body.trim());
	} catch {
		return { visible, claims: null, found: true };
	}
	const rawClaims = isRecord(parsed) ? parsed.claims : Array.isArray(parsed) ? parsed : null;
	if (!Array.isArray(rawClaims)) return { visible, claims: null, found: true };
	const claims: LedgerClaim[] = [];
	for (const raw of rawClaims) {
		const claim = normalizeLedgerClaim(raw);
		if (claim) claims.push(claim);
		if (claims.length >= LEDGER_MAX_CLAIMS) break;
	}
	return { visible, claims, found: true };
}

/**
 * Display-time cleanup for text that may still be streaming in: removes a
 * complete trailing block and also a block (or fence prefix) that has only
 * partly arrived, so the fence never flashes in the thread.
 */
export function stripLedgerForDisplay(text: string): string {
	if (typeof text !== 'string' || !text) return text;
	const split = splitLedgerBlock(text);
	if (split.found) return split.visible;
	// Unterminated block mid-stream: an opener with non-JSON tail still counts.
	const open = text.lastIndexOf(LEDGER_FENCE_OPEN);
	if (open >= 0 && (open === 0 || text[open - 1] === '\n') && !text.slice(open + LEDGER_FENCE_OPEN.length).includes('```')) {
		return text.slice(0, open).trimEnd();
	}
	// Partial opener at the very end, for example "```newscraft-le".
	const lineStart = text.lastIndexOf('\n') + 1;
	const lastLine = text.slice(lineStart);
	if (lastLine.length >= 4 && LEDGER_FENCE_OPEN.startsWith(lastLine)) return text.slice(0, lineStart).trimEnd();
	return text;
}
