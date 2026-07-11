import { describe, expect, it } from 'vitest';
import { selectDocumentContext } from './retrieval';
import type { ConversationDocumentPageRow, ConversationDocumentRow } from './types';

function document(id = 'document-1'): ConversationDocumentRow {
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
		pageCount: 30,
		failureCode: null,
		failureMessage: null,
		processingStartedAt: 1,
		processedAt: 2,
		createdAt: 1,
		updatedAt: 2
	};
}

function page(pageNumber: number, text = `Text for page ${pageNumber}`): ConversationDocumentPageRow {
	return {
		id: `document-1:${pageNumber}`,
		documentId: 'document-1',
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

describe('document context retrieval', () => {
	it('includes every page when the full-document limits fit', () => {
		const readyDocument = document();
		readyDocument.pageCount = 3;
		const pages = [page(1), page(2), page(3)];
		const context = selectDocumentContext({ documents: [readyDocument], pages, rankedPages: [] });
		expect(context.usedFullDocuments).toBe(true);
		expect(context.pages.map((item) => item.pageNumber)).toEqual([1, 2, 3]);
	});

	it('uses ranked matches and adjacent pages for long documents', () => {
		const pages = Array.from({ length: 30 }, (_, index) => page(index + 1));
		const context = selectDocumentContext({
			documents: [document()],
			pages,
			rankedPages: [
				{ ...pages[9], rank: 0.9 },
				{ ...pages[19], rank: 0.8 }
			]
		});
		expect(context.usedFullDocuments).toBe(false);
		expect(context.pages.map((item) => item.pageNumber)).toEqual([10, 9, 11, 20, 19, 21]);
	});

	it('never exceeds the context character cap', () => {
		const pages = Array.from({ length: 30 }, (_, index) => page(index + 1, 'x'.repeat(100)));
		const context = selectDocumentContext({
			documents: [document()],
			pages,
			rankedPages: [{ ...pages[9], rank: 1 }],
			charLimit: 150
		});
		expect(context.totalCharacters).toBe(150);
		expect(context.pages).toHaveLength(2);
		expect(context.pages[1]).toMatchObject({ pageNumber: 9, truncated: true, text: 'x'.repeat(50) });
	});

	it('caps ranked matches at six before adding adjacent pages', () => {
		const readyDocument = document();
		readyDocument.pageCount = 40;
		const pages = Array.from({ length: 40 }, (_, index) => page(index + 1));
		const rankedPages = [3, 8, 13, 18, 23, 28, 33, 38].map((pageNumber, index) => ({
			...pages[pageNumber - 1],
			rank: 1 - index / 10
		}));
		const context = selectDocumentContext({
			documents: [readyDocument],
			pages,
			rankedPages
		});

		expect(context.pages.map((item) => item.pageNumber)).toEqual([
			3, 2, 4, 8, 7, 9, 13, 12, 14, 18, 17, 19, 23, 22, 24, 28, 27, 29
		]);
		expect(context.pages.some((item) => item.pageNumber >= 32)).toBe(false);
	});
});
