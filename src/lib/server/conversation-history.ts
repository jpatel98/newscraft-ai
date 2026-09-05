import type { MessageContent } from '$lib/types';
import {
	parseContent,
	type MessagePageCursor,
	type MessageRow,
	type Role
} from '$lib/server/db/conversations';
import type { HermesRunMessageState } from '$lib/server/db/hermes-runs';
import type { ArtifactSummary } from '$lib/server/artifacts/contracts';

/** The UI requests at most this many persisted rows in one history page. */
export const MESSAGE_PAGE_SIZE = 50;
export const MESSAGE_PAGE_MAX_BYTES = 1024 * 1024;
export const TARGET_WINDOW_BEFORE = 25;
export const TARGET_WINDOW_AFTER = 25;
export const MESSAGE_ID_BATCH_SIZE = 100;

export type ThreadMessageView = {
	id: string;
	role: Role;
	content: MessageContent;
	toolCalls: string | null;
	partial: boolean;
	createdAt: number;
	durableState: string | null;
	durableError: string | null;
	artifacts?: ArtifactSummary[];
};

export type MessageEnvelope = Pick<
	ThreadMessageView,
	'id' | 'role' | 'content' | 'toolCalls' | 'partial' | 'createdAt' | 'durableState' | 'durableError' | 'artifacts'
>;

export function cursorOf(message: Pick<MessageRow, 'createdAt' | 'id'>): MessagePageCursor {
	return { createdAt: message.createdAt, id: message.id };
}

export function compareCursors(a: MessagePageCursor, b: MessagePageCursor): number {
	if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
	return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function toThreadMessage(
	message: MessageRow,
	run?: HermesRunMessageState | null,
	artifacts?: ArtifactSummary[]
): ThreadMessageView {
	return {
		id: message.id,
		role: message.role,
		content: parseContent(message.content),
		toolCalls: message.toolCalls,
		partial: message.partial === 1,
		createdAt: message.createdAt,
		durableState: run?.state ?? null,
		durableError: run?.errorMessage ?? null,
		...(artifacts?.length ? { artifacts } : {})
	};
}

export function messageEnvelopeBytes(message: MessageEnvelope): number {
	return Buffer.byteLength(JSON.stringify(message), 'utf8');
}

function totalBytes(messages: MessageEnvelope[]): number {
	return Buffer.byteLength(JSON.stringify(messages), 'utf8');
}

/**
 * Keep the newest rows in ascending order. The byte limit is a soft target:
 * one oversized message remains intact so content is never truncated.
 */
export function trimNewestMessages<T extends MessageEnvelope>(
	candidates: T[],
	maxRows: number,
	maxBytes = MESSAGE_PAGE_MAX_BYTES
): T[] {
	let selected = candidates.slice(Math.max(0, candidates.length - maxRows));
	while (selected.length > 1 && totalBytes(selected) > maxBytes) selected = selected.slice(1);
	return selected;
}

/** Keep the oldest rows in ascending order for an exclusive range page. */
export function trimOldestMessages<T extends MessageEnvelope>(
	candidates: T[],
	maxRows: number,
	maxBytes = MESSAGE_PAGE_MAX_BYTES
): T[] {
	let selected = candidates.slice(0, maxRows);
	while (selected.length > 1 && totalBytes(selected) > maxBytes) selected = selected.slice(0, -1);
	return selected;
}

/**
 * Keep a target and rows nearest to it. Rows are removed from the outside of
 * the window only. The target is always retained, even when it is oversized.
 */
export function trimTargetWindow<T extends MessageEnvelope>(
	beforeCandidates: T[],
	target: T,
	afterCandidates: T[],
	beforeLimit = TARGET_WINDOW_BEFORE,
	afterLimit = TARGET_WINDOW_AFTER,
	maxBytes = MESSAGE_PAGE_MAX_BYTES
): { before: T[]; target: T; after: T[] } {
	let before = beforeCandidates.slice(Math.max(0, beforeCandidates.length - beforeLimit));
	let after = afterCandidates.slice(0, afterLimit);
	while (before.length || after.length) {
		if (totalBytes([...before, target, ...after]) <= maxBytes) break;
		if (before.length) before = before.slice(1);
		else after = after.slice(0, -1);
	}
	return { before, target, after };
}

export function rowsToThreadMessages(
	rows: MessageRow[],
	runs: ReadonlyMap<string, HermesRunMessageState>
): ThreadMessageView[] {
	return rows.map((row) => toThreadMessage(row, runs.get(row.id)));
}
