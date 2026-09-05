import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';

const dbMocks = vi.hoisted(() => {
	const chain = {} as Record<string, ReturnType<typeof vi.fn>>;
	chain.select = vi.fn(() => chain);
	chain.from = vi.fn(() => chain);
	chain.where = vi.fn(() => chain);
	chain.orderBy = vi.fn(() => chain);
	chain.limit = vi.fn(() => Promise.resolve([]));
	return { chain };
});

vi.mock('./index', () => ({
	db: dbMocks.chain,
	ensureDefaultOrganizationForAccount: vi.fn()
}));

import {
	getLatestMessagesPage,
	getMessageCount,
	getMessageWindow,
	getMessagesBefore,
	getMessagesBetween,
	getMessagesByIds
} from './conversations';

const dialect = new PgDialect();

describe('bounded conversation history reads', () => {
	beforeEach(() => vi.clearAllMocks());

	it('orders the latest page by both keyset fields and asks for one extra row', async () => {
		await getLatestMessagesPage('conversation-1', 50);
		const order = dbMocks.chain.orderBy.mock.calls[0].map((part) => dialect.sqlToQuery(part).sql);
		expect(order).toEqual(['"messages"."created_at" desc', '"messages"."id" desc']);
		expect(dbMocks.chain.limit).toHaveBeenCalledWith(51);
	});

	it('uses an exclusive before cursor with an id tie-breaker', async () => {
		await getMessagesBefore('conversation-1', { createdAt: 100, id: 'm-10' }, 50);
		const query = dialect.sqlToQuery(dbMocks.chain.where.mock.calls[0][0]);
		expect(query.sql).toContain('"messages"."created_at" < $2');
		expect(query.sql).toContain('"messages"."id" < $4');
		expect(query.params).toEqual(['conversation-1', 100, 100, 'm-10']);
	});

	it('keeps both exclusive range boundaries in the predicate', async () => {
		await getMessagesBetween(
			'conversation-1',
			{ createdAt: 100, id: 'm-10' },
			{ createdAt: 200, id: 'm-20' },
			50
		);
		const query = dialect.sqlToQuery(dbMocks.chain.where.mock.calls[0][0]);
		expect(query.sql).toContain('"messages"."created_at" > $2');
		expect(query.sql).toContain('"messages"."created_at" < $5');
		expect(dbMocks.chain.limit).toHaveBeenCalledWith(51);
	});

	it('bounds target windows on both sides and does not use a full-history read', async () => {
		await getMessageWindow('conversation-1', { createdAt: 100, id: 'm-10' }, 25, 25);
		expect(dbMocks.chain.limit).toHaveBeenNthCalledWith(1, 26);
		expect(dbMocks.chain.limit).toHaveBeenNthCalledWith(2, 26);
		expect(dbMocks.chain.orderBy.mock.calls).toHaveLength(2);
	});

	it('scopes exact-id reconciliation and skips an empty id list', async () => {
		await getMessagesByIds('conversation-1', ['m-1', 'm-1', 'm-2']);
		const query = dialect.sqlToQuery(dbMocks.chain.where.mock.calls[0][0]);
		expect(query.sql).toContain('"messages"."conversation_id" = $1');
		expect(query.sql).toContain('"messages"."id" in');
		expect(dbMocks.chain.limit).not.toHaveBeenCalled();
		vi.clearAllMocks();
		await getMessagesByIds('conversation-1', []);
		expect(dbMocks.chain.select).not.toHaveBeenCalled();
	});

	it('returns a numeric count query', async () => {
		dbMocks.chain.limit.mockResolvedValueOnce([{ count: 123 }]);
		expect(await getMessageCount('conversation-1')).toBe(123);
	});
});
