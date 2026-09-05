import { describe, expect, it } from 'vitest';
import {
	trimNewestMessages,
	trimOldestMessages,
	trimTargetWindow,
	type MessageEnvelope
} from './conversation-history';

function message(id: string, content: string): MessageEnvelope {
	return {
		id,
		role: 'user',
		content,
		toolCalls: null,
		partial: false,
		createdAt: Number(id.replace('m-', '')),
		durableState: null,
		durableError: null
	};
}

describe('conversation history byte and row bounds', () => {
	it('keeps the newest rows and leaves an omitted older cursor reachable', () => {
		const rows = ['m-1', 'm-2', 'm-3'].map((id) => message(id, id));
		expect(trimNewestMessages(rows, 2).map((row) => row.id)).toEqual(['m-2', 'm-3']);
	});

	it('keeps the oldest rows for an exclusive range page', () => {
		const rows = ['m-1', 'm-2', 'm-3'].map((id) => message(id, id));
		expect(trimOldestMessages(rows, 2).map((row) => row.id)).toEqual(['m-1', 'm-2']);
	});

	it('preserves an oversized target and removes only outward rows', () => {
		const before = ['m-1', 'm-2'].map((id) => message(id, 'before'));
		const target = message('m-3', 'x'.repeat(100));
		const after = ['m-4', 'm-5'].map((id) => message(id, 'after'));
		const result = trimTargetWindow(before, target, after, 2, 2, 10);
		expect(result.target.id).toBe('m-3');
		expect(result.before).toHaveLength(0);
		expect(result.after).toHaveLength(0);
	});
});

