import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

const dbMocks = vi.hoisted(() => {
	const chain = {} as Record<string, ReturnType<typeof vi.fn>>;
	chain.select = vi.fn(() => chain);
	chain.from = vi.fn(() => chain);
	chain.where = vi.fn(() => chain);
	chain.orderBy = vi.fn(() => chain);
	chain.limit = vi.fn(() => Promise.resolve([]));
	const execute = vi.fn(async (_query: SQL<unknown>): Promise<unknown[]> => []);
	return { chain, execute };
});

vi.mock('$lib/server/db', () => ({ db: { ...dbMocks.chain, execute: dbMocks.execute } }));

import { createPostgresDocumentRepository } from './repository';

const dialect = new PgDialect();

describe('document repository context reads', () => {
	beforeEach(() => vi.clearAllMocks());

	it('aggregates page counts and stored character counts without selecting page text', async () => {
		dbMocks.execute.mockResolvedValue([
			{ documentId: 'document-1', pageCount: 2, totalCharacters: 18 }
		]);

		const repository = createPostgresDocumentRepository();
		await expect(repository.getPageStats(['document-1', 'document-1', 'document-2'])).resolves.toEqual([
			{ documentId: 'document-1', pageCount: 2, totalCharacters: 18 }
		]);

		const query = dialect.sqlToQuery(dbMocks.execute.mock.calls[0][0]);
		expect(query.sql).toContain('count(*)::int AS "pageCount"');
		expect(query.sql).toContain('coalesce(sum(char_count), 0)::int AS "totalCharacters"');
		expect(query.sql).toContain('GROUP BY document_id');
		expect(query.params).toEqual(['document-1', 'document-2']);
		expect(dbMocks.chain.select).not.toHaveBeenCalled();
	});

	it('restricts keyed page reads to ready-document IDs and stable document/page order', async () => {
		const repository = createPostgresDocumentRepository();
		await repository.listPagesByKeys(
			['document-1'],
			[
				{ documentId: 'document-1', pageNumber: 2 },
				{ documentId: 'document-2', pageNumber: 1 },
				{ documentId: 'document-1', pageNumber: 2 },
				{ documentId: 'document-1', pageNumber: 0 }
			]
		);

		const where = dialect.sqlToQuery(dbMocks.chain.where.mock.calls[0][0]);
		expect(where.sql).toContain('"conversation_document_pages"."document_id" in ($1)');
		expect(where.sql).toContain('"conversation_document_pages"."page_number" = $3');
		expect(where.params).toEqual(['document-1', 'document-1', 2]);
		const order = dbMocks.chain.orderBy.mock.calls[0].map((part) => dialect.sqlToQuery(part).sql);
		expect(order).toEqual([
			'"conversation_document_pages"."document_id" asc',
			'"conversation_document_pages"."page_number" asc'
		]);
	});

	it('limits prefix reads and keeps empty-query search bounded', async () => {
		const repository = createPostgresDocumentRepository();
		await repository.listPagesPrefix(['document-2', 'document-1'], 6);
		expect(dbMocks.chain.limit).toHaveBeenCalledWith(6);
		dbMocks.chain.limit.mockClear();
		await repository.searchPages(['document-1'], '   ', 6);
		expect(dbMocks.chain.limit).toHaveBeenCalledWith(6);
	});
});
