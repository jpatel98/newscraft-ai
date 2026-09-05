import { and, asc, eq, inArray, or, sql } from 'drizzle-orm';
import { db } from '$lib/server/db';
import { conversationDocumentPages, conversationDocuments } from '$lib/server/db/schema';
import type {
	ConversationDocumentPageRow,
	ConversationDocumentRow,
	DocumentPageKey,
	DocumentPageStats,
	DocumentRepository,
	RankedDocumentPage
} from './types';

export function createPostgresDocumentRepository(): DocumentRepository {
	return {
		async createDocument(row) {
			await db.insert(conversationDocuments).values(row);
		},

		async deleteDocumentRecord(accountId, conversationId, documentId) {
			await db
				.delete(conversationDocuments)
				.where(ownerWhere(accountId, conversationId, documentId));
		},

		async getDocument(accountId, conversationId, documentId) {
			const [row] = (await db
				.select()
				.from(conversationDocuments)
				.where(ownerWhere(accountId, conversationId, documentId))
				.limit(1)) as ConversationDocumentRow[];
			return row;
		},

		async listDocuments(accountId, conversationId) {
			return (await db
				.select()
				.from(conversationDocuments)
				.where(
					and(
						eq(conversationDocuments.accountId, accountId),
						eq(conversationDocuments.conversationId, conversationId)
					)
				)
				.orderBy(asc(conversationDocuments.createdAt))) as ConversationDocumentRow[];
		},

		async listReadyDocuments(accountId, conversationId, documentIds) {
			if (documentIds && documentIds.length === 0) return [];
			const ownership = and(
				eq(conversationDocuments.accountId, accountId),
				eq(conversationDocuments.conversationId, conversationId),
				eq(conversationDocuments.processingState, 'ready')
			);
			return (await db
				.select()
				.from(conversationDocuments)
				.where(
					documentIds
						? and(ownership, inArray(conversationDocuments.id, Array.from(new Set(documentIds))))
						: ownership
				)
				.orderBy(asc(conversationDocuments.createdAt))) as ConversationDocumentRow[];
		},

		async claimForProcessing(accountId, conversationId, documentId, now) {
			const [row] = (await db
				.update(conversationDocuments)
				.set({
					processingState: 'processing',
					processingStartedAt: now,
					processedAt: null,
					failureCode: null,
					failureMessage: null,
					updatedAt: now
				})
				.where(
					and(
						ownerWhere(accountId, conversationId, documentId),
						or(
							eq(conversationDocuments.processingState, 'uploading'),
							eq(conversationDocuments.processingState, 'failed')
						)
					)
				)
				.returning()) as ConversationDocumentRow[];
			return row;
		},

		async markFailed(accountId, conversationId, documentId, failure) {
			await db.transaction(async (tx: any) => {
				await tx
					.delete(conversationDocumentPages)
					.where(eq(conversationDocumentPages.documentId, documentId));
				await tx
					.update(conversationDocuments)
					.set({
						processingState: 'failed',
						pageCount: null,
						failureCode: failure.code,
						failureMessage: failure.message,
						processedAt: failure.now,
						updatedAt: failure.now
					})
					.where(ownerWhere(accountId, conversationId, documentId));
			});
		},

		async replacePagesAndMarkReady(document, pages, now) {
			return db.transaction(async (tx: any) => {
				await tx
					.delete(conversationDocumentPages)
					.where(eq(conversationDocumentPages.documentId, document.id));
				if (pages.length > 0) {
					await tx.insert(conversationDocumentPages).values(
						pages.map((pageText, index) => ({
							id: `${document.id}:${index + 1}`,
							documentId: document.id,
							orgId: document.orgId,
							accountId: document.accountId,
							conversationId: document.conversationId,
							pageNumber: index + 1,
							pageText,
							charCount: pageText.length,
							createdAt: now,
							updatedAt: now
						}))
					);
				}
				const [ready] = (await tx
					.update(conversationDocuments)
					.set({
						processingState: 'ready',
						pageCount: pages.length,
						failureCode: null,
						failureMessage: null,
						processedAt: now,
						updatedAt: now
					})
					.where(ownerWhere(document.accountId, document.conversationId, document.id))
					.returning()) as ConversationDocumentRow[];
				return ready;
			});
		},

		async getPageStats(documentIds) {
			const ids = uniqueDocumentIds(documentIds);
			if (ids.length === 0) return [];
			const idValues = sql.join(ids.map((id) => sql`${id}`), sql`, `);
			const result = await db.execute(sql`
				SELECT
					document_id AS "documentId",
					count(*)::int AS "pageCount",
					coalesce(sum(char_count), 0)::int AS "totalCharacters"
				FROM conversation_document_pages
				WHERE document_id IN (${idValues})
				GROUP BY document_id
				ORDER BY document_id ASC
			`);
			return Array.from(result as Iterable<DocumentPageStats>);
		},

		async listPages(documentIds) {
			const ids = uniqueDocumentIds(documentIds);
			if (ids.length === 0) return [];
			return (await db
				.select()
				.from(conversationDocumentPages)
				.where(inArray(conversationDocumentPages.documentId, ids))
				.orderBy(asc(conversationDocumentPages.documentId), asc(conversationDocumentPages.pageNumber))) as ConversationDocumentPageRow[];
		},

		async listPagesByKeys(documentIds, pageKeys) {
			const ids = uniqueDocumentIds(documentIds);
			if (ids.length === 0 || pageKeys.length === 0) return [];
			const allowedIds = new Set(ids);
			const keys = Array.from(
				new Map(
					pageKeys
						.filter(
							(key) =>
								allowedIds.has(key.documentId) &&
								Number.isInteger(key.pageNumber) &&
								key.pageNumber > 0
						)
						.map((key) => [`${key.documentId}:${key.pageNumber}`, key] as const)
				)
				.values()
			);
			if (keys.length === 0) return [];
			const keyWhere = or(
				...keys.map((key) =>
					and(
						eq(conversationDocumentPages.documentId, key.documentId),
						eq(conversationDocumentPages.pageNumber, key.pageNumber)
					)
				)
			);
			return (await db
				.select()
				.from(conversationDocumentPages)
				.where(and(inArray(conversationDocumentPages.documentId, ids), keyWhere))
				.orderBy(asc(conversationDocumentPages.documentId), asc(conversationDocumentPages.pageNumber))) as ConversationDocumentPageRow[];
		},

		async listPagesPrefix(documentIds, limit) {
			const ids = uniqueDocumentIds(documentIds);
			const boundedLimit = Math.floor(limit);
			if (ids.length === 0 || boundedLimit < 1) return [];
			return (await db
				.select()
				.from(conversationDocumentPages)
				.where(inArray(conversationDocumentPages.documentId, ids))
				.orderBy(asc(conversationDocumentPages.documentId), asc(conversationDocumentPages.pageNumber))
				.limit(boundedLimit)) as ConversationDocumentPageRow[];
		},

		async searchPages(documentIds, query, limit) {
			const ids = uniqueDocumentIds(documentIds);
			if (ids.length === 0 || limit < 1) return [];
			const normalizedQuery = query.trim();
			if (!normalizedQuery) {
				return (await this.listPagesPrefix(ids, limit)).map((page) => ({ ...page, rank: 0 }));
			}
			const idValues = sql.join(ids.map((id) => sql`${id}`), sql`, `);
			const result = await db.execute(sql`
				SELECT
					id,
					document_id AS "documentId",
					org_id AS "orgId",
					account_id AS "accountId",
					conversation_id AS "conversationId",
					page_number AS "pageNumber",
					page_text AS "pageText",
					char_count AS "charCount",
					created_at AS "createdAt",
					updated_at AS "updatedAt",
					ts_rank(search_vector, plainto_tsquery('simple', ${normalizedQuery}))::float8 AS rank
				FROM conversation_document_pages
				WHERE document_id IN (${idValues})
					AND search_vector @@ plainto_tsquery('simple', ${normalizedQuery})
				ORDER BY rank DESC, document_id ASC, page_number ASC
				LIMIT ${limit}
			`);
			return Array.from(result as Iterable<RankedDocumentPage>);
		},

		async listStoragePathsForConversation(accountId, conversationId) {
			const rows = (await db
				.select({ storagePath: conversationDocuments.storagePath })
				.from(conversationDocuments)
				.where(
					and(
						eq(conversationDocuments.accountId, accountId),
						eq(conversationDocuments.conversationId, conversationId)
					)
				)) as Array<{ storagePath: string }>;
			return rows.map((row) => row.storagePath);
		},

		async listStoragePathsForAccount(accountId) {
			const rows = (await db
				.select({ storagePath: conversationDocuments.storagePath })
				.from(conversationDocuments)
				.where(eq(conversationDocuments.accountId, accountId))) as Array<{ storagePath: string }>;
			return rows.map((row) => row.storagePath);
		},

		async deleteDocumentsForConversation(accountId, conversationId) {
			await db
				.delete(conversationDocuments)
				.where(
					and(
						eq(conversationDocuments.accountId, accountId),
						eq(conversationDocuments.conversationId, conversationId)
					)
				);
		},

		async deleteDocumentsForAccount(accountId) {
			await db.delete(conversationDocuments).where(eq(conversationDocuments.accountId, accountId));
		}
	};
}

function uniqueDocumentIds(documentIds: string[]): string[] {
	return Array.from(new Set(documentIds));
}

function ownerWhere(accountId: string, conversationId: string, documentId: string) {
	return and(
		eq(conversationDocuments.id, documentId),
		eq(conversationDocuments.accountId, accountId),
		eq(conversationDocuments.conversationId, conversationId)
	);
}
