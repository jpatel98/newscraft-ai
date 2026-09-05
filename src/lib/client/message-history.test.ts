import { describe, expect, it } from 'vitest';
import {
	deriveHistoryGaps,
	initialTailSegment,
	mergeMessageRowsAtRevision,
	mergeTailRefresh,
	mergeMessageRows,
	mergeSegments,
	reconcileMessageBatch,
	segmentsForExactMessages,
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

	it('keeps a target window separate when a refresh updates only the latest page', () => {
		const target = segmentForMessages('target', [row('m-100'), row('m-150')], true, true)!;
		const tail = initialTailSegment([row('m-951'), row('m-1000')], true)!;
		const refreshed = mergeTailRefresh([target, tail], [row('m-951'), row('m-1000')], true);
		expect(refreshed).toHaveLength(2);
		expect(deriveHistoryGaps(refreshed)).toHaveLength(1);
	});

	it('does not let an exact-id batch bridge disconnected rows', () => {
		const target = segmentForMessages('target', [row('m-100'), row('m-150')], true, true)!;
		const tail = initialTailSegment([row('m-951'), row('m-1000')], true)!;
		const ids = segmentsForExactMessages([row('m-500'), row('m-600')]);
		const merged = mergeSegments([target, tail, ...ids]);
		expect(merged).toHaveLength(4);
		expect(deriveHistoryGaps(merged)).toHaveLength(3);
	});

	it('keeps a page loaded during delayed exact-id reconciliation', () => {
		const initial = [row('m-1'), row('m-2')];
		const baseline = new Map(initial.map((message) => [message.id, 1]));
		const newerPage = [row('m-10')];
		const pageMerge = mergeMessageRowsAtRevision(initial, newerPage, new Set(), baseline, 3);
		const reconciled = reconcileMessageBatch(
			pageMerge.messages,
			[row('m-1', 1)],
			['m-1', 'm-2'],
			new Set(),
			pageMerge.revisions,
			2,
			baseline
		);
		expect(reconciled.messages.map((message) => message.id)).toEqual(['m-1', 'm-10']);
	});

	it('does not overwrite a newer row or revive a removed row', () => {
		const current = [row('m-1')];
		const revisions = new Map([['m-1', 4]]);
		const baseline = new Map([['m-1', 2]]);
		const result = reconcileMessageBatch(
			current,
			[row('m-1', 1)],
			['m-1', 'm-2'],
			new Set(['m-2']),
			revisions,
			3,
			baseline
		);
		expect(result.messages[0]).toEqual(current[0]);
		expect(result.messages.map((message) => message.id)).not.toContain('m-2');
	});
});
