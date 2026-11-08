import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';

const mocks = vi.hoisted(() => ({ select: vi.fn(), from: vi.fn(), where: vi.fn(), orderBy: vi.fn(), limit: vi.fn() }));
vi.mock('./index', () => ({ db: mocks, ensureDefaultOrganizationForAccount: vi.fn() }));
import { listRecentConversationSubjects } from './conversations';

beforeEach(() => {
	vi.resetAllMocks();
	for (const method of [mocks.select, mocks.from, mocks.where, mocks.orderBy]) method.mockReturnValue(mocks);
	mocks.limit.mockResolvedValue([{ title: 'Owned thread', updatedAt: 10 }]);
});

describe('recent thread context ownership', () => {
	it('constrains the read to the account even when an organization is shared', async () => {
		expect(await listRecentConversationSubjects('owner-a', 'org_default', 5, 'current-thread')).toEqual([{ title: 'Owned thread', updatedAt: 10 }]);
		const query = new PgDialect().sqlToQuery(mocks.where.mock.calls[0][0]);
		expect(query.sql).toContain('"conversations"."account_id" = $1');
		expect(query.sql).toContain('"conversations"."org_id" = $2');
		expect(query.params).toEqual(['owner-a', 'org_default', 5, 'current-thread']);
		expect(mocks.limit).toHaveBeenCalledWith(30);
	});
});
