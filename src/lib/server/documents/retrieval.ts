import {
	DOCUMENT_CONTEXT_CHAR_LIMIT,
	DOCUMENT_CONTEXT_MATCH_LIMIT,
	FULL_DOCUMENT_PAGE_LIMIT
} from './constants';
import type {
	ConversationDocumentContext,
	ConversationDocumentPageRow,
	ConversationDocumentRow,
	DocumentContextPage,
	RankedDocumentPage
} from './types';

export function selectDocumentContext(input: {
	documents: ConversationDocumentRow[];
	pages: ConversationDocumentPageRow[];
	rankedPages: RankedDocumentPage[];
	charLimit?: number;
	fullDocumentPageLimit?: number;
}): ConversationDocumentContext {
	const charLimit = input.charLimit ?? DOCUMENT_CONTEXT_CHAR_LIMIT;
	const fullDocumentPageLimit = input.fullDocumentPageLimit ?? FULL_DOCUMENT_PAGE_LIMIT;
	const documents = new Map(input.documents.map((document) => [document.id, document]));
	const pages = [...input.pages]
		.filter((page) => documents.has(page.documentId))
		.sort(pageOrder);
	const allTextLength = pages.reduce((sum, page) => sum + page.pageText.length, 0);
	const storedPageCounts = new Map<string, number>();
	for (const page of pages) {
		storedPageCounts.set(page.documentId, (storedPageCounts.get(page.documentId) ?? 0) + 1);
	}
	const everyDocumentFits = input.documents.every(
		(document) =>
			(document.pageCount ?? storedPageCounts.get(document.id) ?? 0) <= fullDocumentPageLimit
	);

	if (everyDocumentFits && allTextLength <= charLimit) {
		return buildContext(pages, documents, charLimit, true);
	}

	const byKey = new Map(pages.map((page) => [pageKey(page.documentId, page.pageNumber), page]));
	const ranked = input.rankedPages.length > 0
		? [...input.rankedPages]
				.sort((a, b) => b.rank - a.rank || pageOrder(a, b))
				.slice(0, DOCUMENT_CONTEXT_MATCH_LIMIT)
		: pages.slice(0, 6).map((page) => ({ ...page, rank: 0 }));
	const selected: ConversationDocumentPageRow[] = [];
	const seen = new Set<string>();

	for (const hit of ranked) {
		for (const pageNumber of [hit.pageNumber, hit.pageNumber - 1, hit.pageNumber + 1]) {
			const key = pageKey(hit.documentId, pageNumber);
			const page = byKey.get(key);
			if (!page || seen.has(key)) continue;
			seen.add(key);
			selected.push(page);
		}
	}

	return buildContext(selected, documents, charLimit, false);
}

function buildContext(
	pages: ConversationDocumentPageRow[],
	documents: Map<string, ConversationDocumentRow>,
	charLimit: number,
	usedFullDocuments: boolean
): ConversationDocumentContext {
	const output: DocumentContextPage[] = [];
	let remaining = Math.max(0, charLimit);
	for (const page of pages) {
		if (remaining === 0) break;
		const document = documents.get(page.documentId);
		if (!document) continue;
		const text = page.pageText.slice(0, remaining);
		if (!text) continue;
		output.push({
			documentId: page.documentId,
			filename: document.originalFilename,
			pageNumber: page.pageNumber,
			text,
			truncated: text.length < page.pageText.length
		});
		remaining -= text.length;
	}
	return {
		pages: output,
		totalCharacters: charLimit - remaining,
		usedFullDocuments
	};
}

function pageKey(documentId: string, pageNumber: number): string {
	return `${documentId}:${pageNumber}`;
}

function pageOrder(a: ConversationDocumentPageRow, b: ConversationDocumentPageRow): number {
	return a.documentId.localeCompare(b.documentId) || a.pageNumber - b.pageNumber;
}
