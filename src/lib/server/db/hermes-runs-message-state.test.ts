import { beforeEach, describe, expect, it, vi } from 'vitest';

const dbMocks = vi.hoisted(() => {
	const chain = {} as Record<string, ReturnType<typeof vi.fn>>;
	chain.select = vi.fn(() => chain);
	chain.from = vi.fn(() => chain);
	chain.where = vi.fn(() => chain);
	chain.orderBy = vi.fn(() => chain);
	chain.limit = vi.fn(() => Promise.resolve([]));
	chain.then = vi.fn((resolve: (value: unknown) => unknown) => resolve([]));
	return { chain };
});

vi.mock('./index', () => ({ db: dbMocks.chain }));

import { listHermesRunStatesForMessages } from './hermes-runs';

describe('exact durable message state reads', () => {
	beforeEach(() => vi.clearAllMocks());

	it('returns the newest state per requested assistant without a global 500-row cap', async () => {
		dbMocks.chain.then.mockImplementationOnce((resolve: (value: unknown) => unknown) => resolve([
			{ assistantMessageId: 'a-2', state: 'complete', errorMessage: null, createdAt: 20, id: 'run-2' },
			{ assistantMessageId: 'a-2', state: 'failed', errorMessage: 'old', createdAt: 10, id: 'run-1' },
			{ assistantMessageId: 'a-1', state: 'cancelled', errorMessage: null, createdAt: 15, id: 'run-3' }
		]));
		const result = await listHermesRunStatesForMessages('account-1', 'conversation-1', ['a-1', 'a-2', 'a-2']);
		expect(result).toEqual([
			{ assistantMessageId: 'a-2', state: 'complete', errorMessage: null },
			{ assistantMessageId: 'a-1', state: 'cancelled', errorMessage: null }
		]);
		expect(dbMocks.chain.limit).not.toHaveBeenCalled();
	});

	it('does not issue a query for an empty id set', async () => {
		await expect(listHermesRunStatesForMessages('account-1', 'conversation-1', [])).resolves.toEqual([]);
		expect(dbMocks.chain.select).not.toHaveBeenCalled();
	});
});
