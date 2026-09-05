import { describe, expect, it } from 'vitest';
import {
	deriveHistoryGaps,
	initialTailSegment,
	mergeMessageRows,
	mergeSegments,
	segmentForMessages,
	type HistoryMessage
} from './message-history';

function row(id: string, createdAt = Number(id.replace('m-', ''))): HistoryMessage {
	return { id, role: 'user', content: id, partial: false, createdAt };
}

describe('message history client state', () => {
	it('upserts by id, removes tombstones, and sorts equal timestamps by id', () => {
		const existing = [row('m-b', 10), row('m-a', 10)];
		const merged = mergeMessageRows(existing, [{ ...row('m-b', 10), content: 'updated' }, row('m-c', 11)], new Set(['m-a']));
		expect(merged.map((message) => message.id)).toEqual(['m-b', 'm-c']);
		expect(merged[0].content).toBe('updated');
	});

	it('derives only explicitly unknown gaps between bounded segments', () => {
		const leftRows = [row('m-1'), row('m-2')];
		const rightRows = [row('m-5'), row('m-6')];
		const left = segmentForMessages('left', leftRows, false, true);
		const right = segmentForMessages('right', rightRows, true, false);
		expect(left && right).toBeTruthy();
		expect(deriveHistoryGaps([left!, right!])).toEqual([
			{ id: 'gap:left:right', after: { createdAt: 2, id: 'm-2' }, before: { createdAt: 5, id: 'm-5' } }
		]);
	});

	it('does not render a hidden gap as contiguous after a complete prepend', () => {
		const tail = initialTailSegment([row('m-4'), row('m-5')], true)!;
		const older = segmentForMessages('older', [row('m-1'), row('m-2'), row('m-3')], false, false)!;
		const merged = mergeSegments([tail, older]);
		expect(merged).toHaveLength(1);
		expect(deriveHistoryGaps(merged)).toEqual([]);
	});
});
