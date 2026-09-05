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

import { getMessagesBatch } from './conversations';

const dialect = new PgDialect();

describe('getMessagesBatch', () => {
	beforeEach(() => vi.clearAllMocks());

	it('reads the first page in created-at and id order', async () => {
		await getMessagesBatch('conversation-1', null, 16);

		const where = dbMocks.chain.where.mock.calls[0][0];
		const order = dbMocks.chain.orderBy.mock.calls[0].map((part) => dialect.sqlToQuery(part).sql);
		expect(dialect.sqlToQuery(where)).toMatchObject({
			sql: '"messages"."conversation_id" = $1',
			params: ['conversation-1']
		});
		expect(order).toEqual(['"messages"."created_at" asc', '"messages"."id" asc']);
		expect(dbMocks.chain.limit).toHaveBeenCalledWith(16);
	});

	it('uses both cursor fields so equal timestamps are neither skipped nor repeated', async () => {
		await getMessagesBatch('conversation-1', { createdAt: 100, id: 'm-16' }, 16);

		const query = dialect.sqlToQuery(dbMocks.chain.where.mock.calls[0][0]);
		expect(query.sql).toBe(
			'("messages"."conversation_id" = $1 and ("messages"."created_at" > $2 or ("messages"."created_at" = $3 and "messages"."id" > $4)))'
		);
		expect(query.params).toEqual(['conversation-1', 100, 100, 'm-16']);
	});
});
