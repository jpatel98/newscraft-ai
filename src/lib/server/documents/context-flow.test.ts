import { describe, expect, it, vi } from 'vitest';
import {
	DOCUMENT_CONTEXT_CHAR_LIMIT,
	DOCUMENT_CONTEXT_MATCH_LIMIT,
	FULL_DOCUMENT_PAGE_LIMIT
} from './constants';
import { ConversationDocumentService } from './service';
import { selectDocumentContext } from './retrieval';
import type {
	ConversationDocumentPageRow,
	ConversationDocumentRow,
	DocumentRepository,
	RankedDocumentPage
} from './types';

function document(
	id: string,
	overrides: Partial<ConversationDocumentRow> = {}
): ConversationDocumentRow {
	return {
		id,
		orgId: 'org-1',
		accountId: 'account-1',
		conversationId: 'conversation-1',
		originalFilename: `${id}.pdf`,
		storagePath: `org-1/conversation-1/${id}/file.pdf`,
		mimeType: 'application/pdf',
		sizeBytes: 100,
		checksumSha256: 'a'.repeat(64),
		processingState: 'ready',
		pageCount: null,
		failureCode: null,
		failureMessage: null,
		processingStartedAt: 1,
		processedAt: 2,
		createdAt: 1,
		updatedAt: 2,
		...overrides
	};
}

function page(
	documentId: string,
	pageNumber: number,
	text = `${documentId} page ${pageNumber}`
): ConversationDocumentPageRow {
	return {
		id: `${documentId}:${pageNumber}`,
		documentId,
		orgId: 'org-1',
		accountId: 'account-1',
		conversationId: 'conversation-1',
		pageNumber,
		pageText: text,
		charCount: text.length,
		createdAt: 1,
		updatedAt: 1
	};
}

function pagesFor(documentId: string, count: number, text = ''): ConversationDocumentPageRow[] {
	return Array.from({ length: count }, (_, index) => page(documentId, index + 1, text || `${documentId} page ${index + 1}`));
}

function sortPages(pages: ConversationDocumentPageRow[]): ConversationDocumentPageRow[] {
	return [...pages].sort(
		(a, b) => a.documentId.localeCompare(b.documentId) || a.pageNumber - b.pageNumber
	);
}

function statsFor(
	documentIds: string[],
	pages: ConversationDocumentPageRow[]
) {
	return documentIds
		.map((documentId) => {
			const matching = pages.filter((page) => page.documentId === documentId);
			return matching.length === 0
				? undefined
				: {
						documentId,
						pageCount: matching.length,
						totalCharacters: matching.reduce((sum, page) => sum + page.charCount, 0)
				  };
		})
		.filter((stats): stats is NonNullable<typeof stats> => Boolean(stats));
}

function rankedFor(
	pages: ConversationDocumentPageRow[],
	query: string,
	ranks: Array<[string, number]> = []
): RankedDocumentPage[] {
	if (!query.trim()) {
		return sortPages(pages)
			.slice(0, DOCUMENT_CONTEXT_MATCH_LIMIT)
			.map((item) => ({ ...item, rank: 0 }));
	}
	const byKey = new Map(pages.map((item) => [item.id, item]));
	return ranks
		.map(([id, rank]) => {
			const item = byKey.get(id);
			return item ? { ...item, rank } : undefined;
		})
		.filter((item): item is RankedDocumentPage => Boolean(item))
		.sort(
			(a, b) =>
				b.rank - a.rank ||
				a.documentId.localeCompare(b.documentId) ||
				a.pageNumber - b.pageNumber
		);
}

function legacyContext(
	documents: ConversationDocumentRow[],
	pages: ConversationDocumentPageRow[],
	query: string,
	ranks: Array<[string, number]> = []
) {
	return selectDocumentContext({
		documents,
		pages,
		rankedPages: rankedFor(pages, query, ranks)
	});
}

function makeRepository(
	documents: ConversationDocumentRow[],
	pages: ConversationDocumentPageRow[],
	query: string,
	ranks: Array<[string, number]> = []
) {
	const sorted = sortPages(pages);
	const documentIds = documents.map((item) => item.id);
	const stats = statsFor(documentIds, pages);
	const calls = {
		listReadyDocuments: [] as string[] | undefined,
		listPages: [] as string[][],
		listPagesPrefix: [] as Array<{ documentIds: string[]; limit: number }>,
		listPagesByKeys: [] as Array<{ documentIds: string[]; keys: Array<{ documentId: string; pageNumber: number }> }>,
		searchPages: [] as Array<{ documentIds: string[]; query: string; limit: number }>
	};
	const repository = {
		listReadyDocuments: vi.fn(async (_accountId: string, _conversationId: string, requestedIds?: string[]) => {
			calls.listReadyDocuments = requestedIds;
			const requested = requestedIds ? new Set(requestedIds) : undefined;
			return documents.filter((item) => !requested || requested.has(item.id));
		}),
		getPageStats: vi.fn(async (ids: string[]) => stats.filter((item) => ids.includes(item.documentId))),
		listPages: vi.fn(async (ids: string[]) => {
			calls.listPages.push(ids);
			return sorted.filter((item) => ids.includes(item.documentId));
		}),
		listPagesPrefix: vi.fn(async (ids: string[], limit: number) => {
			calls.listPagesPrefix.push({ documentIds: ids, limit });
			return sorted.filter((item) => ids.includes(item.documentId)).slice(0, limit);
		}),
		listPagesByKeys: vi.fn(async (ids: string[], keys: Array<{ documentId: string; pageNumber: number }>) => {
			calls.listPagesByKeys.push({ documentIds: ids, keys });
			const allowed = new Set(ids);
			const wanted = new Set(keys.map((key) => `${key.documentId}:${key.pageNumber}`));
			return sorted.filter((item) => allowed.has(item.documentId) && wanted.has(item.id));
		}),
		searchPages: vi.fn(async (ids: string[], searchQuery: string, limit: number) => {
			calls.searchPages.push({ documentIds: ids, query: searchQuery, limit });
			return rankedFor(sorted.filter((item) => ids.includes(item.documentId)), searchQuery, ranks).slice(0, limit);
		})
	} as unknown as DocumentRepository;
	return { repository, calls, documentIds };
}

async function runCase(
	documents: ConversationDocumentRow[],
	pages: ConversationDocumentPageRow[],
	query: string,
	ranks: Array<[string, number]> = [],
	requestedIds = documents.map((item) => item.id)
) {
	const { repository, calls, documentIds } = makeRepository(documents, pages, query, ranks);
	const service = new ConversationDocumentService(repository, {} as never, {} as never);
	const actual = await service.buildContext({
		accountId: 'account-1',
		conversationId: 'conversation-1',
		documentIds: requestedIds,
		query
	});
	return {
		actual,
		expected: legacyContext(documents, pages, query, ranks),
		calls,
		documentIds
	};
}

describe('document context query flow', () => {
	it('matches the previous selector output across document sizes and query modes', async () => {
		const cases = [
			{
				name: 'small full document',
				documents: [document('small', { pageCount: 3 })],
				pages: pagesFor('small', 3),
				query: 'needle',
				ranks: [['small:2', 1]] as Array<[string, number]>
			},
			{
				name: 'large document with ranked hits',
				documents: [document('large', { pageCount: 30 })],
				pages: pagesFor('large', 30),
				query: 'needle',
				ranks: [['large:10', 0.9], ['large:20', 0.8]] as Array<[string, number]>
			},
			{
				name: 'mixed documents',
				documents: [document('a', { pageCount: 2 }), document('b', { pageCount: 26 })],
				pages: [...pagesFor('a', 2), ...pagesFor('b', 26)],
				query: 'needle',
				ranks: [['b:26', 0.9], ['a:2', 0.8]] as Array<[string, number]>
			},
			{
				name: 'empty query fallback',
				documents: [document('empty-query', { pageCount: 30 })],
				pages: pagesFor('empty-query', 30),
				query: '   '
			},
			{
				name: 'nonempty query with no matches',
				documents: [document('no-match', { pageCount: 30 })],
				pages: pagesFor('no-match', 30),
				query: 'missing'
			},
			{
				name: 'overlapping equal-rank edge hits',
				documents: [document('edges', { pageCount: 30 })],
				pages: pagesFor('edges', 30),
				query: 'needle',
				ranks: [['edges:1', 1], ['edges:2', 1], ['edges:30', 1], ['edges:29', 1]] as Array<[
					string,
					number
				]>
			},
			{
				name: 'missing page-count metadata',
				documents: [document('missing-small'), document('missing-large')],
				pages: [...pagesFor('missing-small', 3), ...pagesFor('missing-large', 26)],
				query: 'needle',
				ranks: [['missing-large:13', 1]] as Array<[string, number]>
			},
			{
				name: 'stale low page-count metadata',
				documents: [document('stale-low', { pageCount: 1 })],
				pages: pagesFor('stale-low', 30),
				query: 'needle'
			},
			{
				name: 'stale high page-count metadata',
				documents: [document('stale-high', { pageCount: 40 })],
				pages: pagesFor('stale-high', 3),
				query: 'missing'
			},
			{
				name: 'empty pages',
				documents: [document('empty-pages', { pageCount: 2 })],
				pages: [page('empty-pages', 1, ''), page('empty-pages', 2, 'visible')],
				query: 'needle',
				ranks: [['empty-pages:2', 1]] as Array<[string, number]>
			}
		];

		for (const item of cases) {
			const result = await runCase(item.documents, item.pages, item.query, item.ranks);
			expect(result.actual, item.name).toEqual(result.expected);
		}
	});

	it('uses the exact full-document thresholds and does not search when they fit', async () => {
		const full = await runCase(
			[document('full', { pageCount: FULL_DOCUMENT_PAGE_LIMIT })],
			[page('full', 1, 'x'.repeat(DOCUMENT_CONTEXT_CHAR_LIMIT))],
			'needle'
		);
		expect(full.actual.usedFullDocuments).toBe(true);
		expect(full.calls.searchPages).toEqual([]);
		expect(full.calls.listPages).toEqual([['full']]);

		const tooManyPages = await runCase(
			[document('too-many', { pageCount: FULL_DOCUMENT_PAGE_LIMIT + 1 })],
			[page('too-many', 1, 'small')],
			'needle'
		);
		expect(tooManyPages.actual.usedFullDocuments).toBe(false);
		expect(tooManyPages.calls.listPages).toEqual([]);
		expect(tooManyPages.calls.searchPages).toHaveLength(1);

		const tooManyCharacters = await runCase(
			[document('too-long', { pageCount: FULL_DOCUMENT_PAGE_LIMIT })],
			[page('too-long', 1, 'x'.repeat(DOCUMENT_CONTEXT_CHAR_LIMIT + 1))],
			'needle'
		);
		expect(tooManyCharacters.actual.usedFullDocuments).toBe(false);
		expect(tooManyCharacters.calls.searchPages).toHaveLength(1);
	});

	it('fetches only hit pages and neighbors, including first and last page boundaries', async () => {
		const result = await runCase(
			[document('large', { pageCount: 30 })],
			pagesFor('large', 30),
			'needle',
			[
				['large:1', 1],
				['large:30', 1]
			]
		);
		expect(result.calls.listPagesByKeys).toHaveLength(1);
		expect(result.calls.listPagesByKeys[0].documentIds).toEqual(['large']);
		expect(result.calls.listPagesByKeys[0].keys).toEqual([
			{ documentId: 'large', pageNumber: 1 },
			{ documentId: 'large', pageNumber: 2 },
			{ documentId: 'large', pageNumber: 30 },
			{ documentId: 'large', pageNumber: 29 }
		]);
		expect(result.actual.pages.map((item) => item.pageNumber)).toEqual([1, 2, 30, 29]);
	});

	it('uses a six-page prefix only for the nonempty no-match fallback', async () => {
		const emptyQuery = await runCase(
			[document('empty', { pageCount: 30 })],
			pagesFor('empty', 30),
			''
		);
		expect(emptyQuery.calls.listPagesPrefix).toEqual([]);

		const noMatch = await runCase(
			[document('missing', { pageCount: 30 })],
			pagesFor('missing', 30),
			'no-match'
		);
		expect(noMatch.calls.listPagesPrefix).toEqual([
			{ documentIds: ['missing'], limit: DOCUMENT_CONTEXT_MATCH_LIMIT }
		]);
		expect(noMatch.calls.listPages).toEqual([]);
	});

	it('never reads pages for IDs omitted by the owner-scoped ready-document query', async () => {
		const result = await runCase(
			[document('owned', { pageCount: 30 })],
			pagesFor('owned', 30),
			'needle',
			[['owned:10', 1]],
			['owned', 'not-owned']
		);
		expect(result.calls.listReadyDocuments).toEqual(['owned', 'not-owned']);
		expect(result.calls.searchPages[0].documentIds).toEqual(['owned']);
		expect(result.calls.listPagesByKeys[0].documentIds).toEqual(['owned']);
		expect(result.actual.pages.every((item) => item.documentId === 'owned')).toBe(true);
	});

	it('returns before any page query when no ready documents remain', async () => {
		const { repository, calls } = makeRepository([], [], 'needle');
		const service = new ConversationDocumentService(repository, {} as never, {} as never);
		await expect(
			service.buildContext({
				accountId: 'account-1',
				conversationId: 'conversation-1',
				query: 'needle'
			})
		).resolves.toEqual({ pages: [], totalCharacters: 0, usedFullDocuments: false });
		expect(calls.listPages).toEqual([]);
		expect(calls.listPagesPrefix).toEqual([]);
		expect(calls.listPagesByKeys).toEqual([]);
		expect(calls.searchPages).toEqual([]);
	});
});
