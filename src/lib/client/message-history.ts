import type { ChatMessage } from '$lib/types';

export type HistoryCursor = { createdAt: number; id: string };
export const MESSAGE_ID_BATCH_SIZE = 100;
export type HistoryMessage = ChatMessage & { createdAt: number };

export type HistorySegment = {
	id: string;
	start: HistoryCursor;
	end: HistoryCursor;
	hasBefore: boolean;
	hasAfter: boolean;
};

export type HistoryGap = {
	id: string;
	after: HistoryCursor;
	before: HistoryCursor;
};

export type HistoryPageMeta = {
	pageSize: number;
	totalCount?: number;
	hasOlder: boolean;
	hasNewer: boolean;
	olderCursor?: HistoryCursor | null;
	newerCursor?: HistoryCursor | null;
};

export function compareCursor(a: HistoryCursor, b: HistoryCursor): number {
	if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
	return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function cursorOf(message: Pick<HistoryMessage, 'createdAt' | 'id'>): HistoryCursor {
	return { createdAt: message.createdAt, id: message.id };
}

export function mergeMessageRows(
	existing: HistoryMessage[],
	incoming: HistoryMessage[],
	tombstones: ReadonlySet<string> = new Set()
): HistoryMessage[] {
	const byId = new Map<string, HistoryMessage>();
	for (const message of existing) {
		if (!tombstones.has(message.id)) byId.set(message.id, message);
	}
	for (const message of incoming) {
		if (!tombstones.has(message.id)) byId.set(message.id, message);
	}
	return [...byId.values()].sort((a, b) => compareCursor(cursorOf(a), cursorOf(b)));
}

export function segmentForMessages(
	id: string,
	messages: HistoryMessage[],
	hasBefore = false,
	hasAfter = false
): HistorySegment | null {
	if (messages.length === 0) return null;
	return {
		id,
		start: cursorOf(messages[0]),
		end: cursorOf(messages[messages.length - 1]),
		hasBefore,
		hasAfter
	};
}

export function initialTailSegment(
	messages: HistoryMessage[],
	hasOlder: boolean,
	id = 'tail'
): HistorySegment | null {
	return segmentForMessages(id, messages, hasOlder, false);
}

export function mergeSegments(segments: HistorySegment[]): HistorySegment[] {
	const ordered = [...segments].sort((a, b) => compareCursor(a.start, b.start));
	const merged: HistorySegment[] = [];
	for (const segment of ordered) {
		const previous = merged.at(-1);
		if (!previous) {
			merged.push({ ...segment });
			continue;
		}
		const overlaps = compareCursor(segment.start, previous.end) <= 0;
		// A page response marks its near-side boundary as gap-free when it
		// reached the requested cursor. Merge such known-adjacent segments even
		// though their unique cursors are different.
		const adjacent =
			compareCursor(segment.start, previous.end) > 0 &&
			(!previous.hasAfter || !segment.hasBefore);
		if (!overlaps && !adjacent) {
			merged.push({ ...segment });
			continue;
		}
		const extendsLeft = compareCursor(segment.start, previous.start) < 0;
		const extendsRight = compareCursor(segment.end, previous.end) > 0;
		const sameStart = compareCursor(segment.start, previous.start) === 0;
		const sameEnd = compareCursor(segment.end, previous.end) === 0;
		merged[merged.length - 1] = {
			...previous,
			id: previous.id === segment.id ? previous.id : `${previous.id}+${segment.id}`,
			start: extendsLeft ? segment.start : previous.start,
			end: extendsRight ? segment.end : previous.end,
			hasBefore: extendsLeft ? segment.hasBefore : sameStart ? previous.hasBefore || segment.hasBefore : previous.hasBefore,
			hasAfter: extendsRight ? segment.hasAfter : sameEnd ? previous.hasAfter || segment.hasAfter : previous.hasAfter
		};
	}
	return merged;
}

export function deriveHistoryGaps(segments: HistorySegment[]): HistoryGap[] {
	const ordered = mergeSegments(segments);
	const gaps: HistoryGap[] = [];
	for (let index = 0; index < ordered.length - 1; index += 1) {
		const left = ordered[index];
		const right = ordered[index + 1];
		if (!left.hasAfter || !right.hasBefore || compareCursor(left.end, right.start) >= 0) continue;
		gaps.push({
			id: `gap:${left.id}:${right.id}`,
			after: left.end,
			before: right.start
		});
	}
	return gaps;
}
