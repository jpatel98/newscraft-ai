import { createHash } from 'node:crypto';
import { newId } from '$lib/utils/id';
import {
	DOCUMENT_CONTEXT_MATCH_LIMIT,
	MAX_PDF_BYTES,
	MAX_PDF_PAGES,
	SIGNED_DOWNLOAD_TTL_SECONDS
} from './constants';
import { DocumentError, documentErrorFromUnknown } from './errors';
import { hasPdfSignature } from './pdf';
import { selectDocumentContext } from './retrieval';
import type {
	ConversationDocumentContext,
	ConversationDocumentRow,
	DocumentRepository,
	DocumentStorage,
	PdfExtractor,
	PdfUploadInput
} from './types';
import { safeStorageFilename, validatePdfUploads } from './validation';

export interface OwnedConversation {
	id: string;
	accountId: string;
	orgId: string | null;
}

export interface PublicConversationDocument {
	id: string;
	filename: string;
	mimeType: 'application/pdf';
	sizeBytes: number;
	state: ConversationDocumentRow['processingState'];
	pageCount: number | null;
	error: string | null;
	createdAt: number;
	updatedAt: number;
}

export class ConversationDocumentService {
	constructor(
		private readonly repository: DocumentRepository,
		private readonly storage: DocumentStorage,
		private readonly extractor: PdfExtractor,
		private readonly now: () => number = Date.now,
		private readonly createId: () => string = newId
	) {}

	async createUploadTokens(conversation: OwnedConversation, uploads: PdfUploadInput[]) {
		if (!conversation.orgId) {
			throw new DocumentError(409, 'organization_required', 'The newsroom is not ready for PDF uploads.');
		}
		const validatedUploads = validatePdfUploads(uploads);
		const created: ConversationDocumentRow[] = [];
		try {
			const results = [];
			for (const upload of validatedUploads) {
				const id = this.createId();
				const timestamp = this.now();
				const storagePath = [
					conversation.orgId,
					conversation.id,
					id,
					safeStorageFilename(upload.filename)
				].join('/');
				const document: ConversationDocumentRow = {
					id,
					orgId: conversation.orgId,
					accountId: conversation.accountId,
					conversationId: conversation.id,
					originalFilename: upload.filename,
					storagePath,
					mimeType: 'application/pdf',
					sizeBytes: upload.sizeBytes,
					checksumSha256: upload.checksumSha256,
					processingState: 'uploading',
					pageCount: null,
					failureCode: null,
					failureMessage: null,
					processingStartedAt: null,
					processedAt: null,
					createdAt: timestamp,
					updatedAt: timestamp
				};
				await this.repository.createDocument(document);
				created.push(document);
				const signed = await this.storage.createSignedUpload(storagePath);
				if (signed.path !== storagePath) {
					throw new DocumentError(503, 'document_storage_unavailable', 'PDF storage is unavailable right now.');
				}
				results.push({
					document: publicDocument(document),
					upload: { path: signed.path, token: signed.token, signedUrl: signed.signedUrl }
				});
			}
			return results;
		} catch (error) {
			try {
				await removeInBatches(
					this.storage,
					created.map((document) => document.storagePath)
				);
				await Promise.allSettled(
					created.map((document) =>
						this.repository.deleteDocumentRecord(
							document.accountId,
							document.conversationId,
							document.id
						)
					)
				);
			} catch {
				// Keep rows when storage cleanup fails so their paths remain recoverable.
			}
			throw error;
		}
	}

	async listDocuments(accountId: string, conversationId: string): Promise<PublicConversationDocument[]> {
		const rows = await this.repository.listDocuments(accountId, conversationId);
		return rows.map(publicDocument);
	}

	async processDocument(
		accountId: string,
		conversationId: string,
		documentId: string
	): Promise<PublicConversationDocument> {
		const existing = await this.requireDocument(accountId, conversationId, documentId);
		if (existing.processingState === 'ready') return publicDocument(existing);
		if (existing.processingState === 'processing') {
			throw new DocumentError(409, 'already_processing', 'This PDF is still being processed.');
		}
		const processing = await this.repository.claimForProcessing(
			accountId,
			conversationId,
			documentId,
			this.now()
		);
		if (!processing) {
			throw new DocumentError(409, 'already_processing', 'This PDF is still being processed.');
		}

		try {
			const bytes = await this.storage.download(processing.storagePath);
			if (bytes.byteLength > MAX_PDF_BYTES) {
				throw new DocumentError(413, 'pdf_too_large', 'PDFs must be 20 MB or smaller.');
			}
			if (bytes.byteLength !== processing.sizeBytes || sha256(bytes) !== processing.checksumSha256) {
				throw new DocumentError(
					422,
					'file_mismatch',
					'The uploaded PDF did not match the selected file. Upload it again.'
				);
			}
			if (!hasPdfSignature(bytes)) {
				throw new DocumentError(415, 'pdf_only', 'Only PDF files are supported.');
			}
			const extraction = await this.extractor.extract(bytes);
			if (
				extraction.pageCount < 1 ||
				extraction.pageCount > MAX_PDF_PAGES ||
				extraction.pageCount !== extraction.pages.length
			) {
				throw new DocumentError(422, 'unreadable_pdf', 'NewsCraft could not read this PDF.');
			}
			const ready = await this.repository.replacePagesAndMarkReady(
				processing,
				extraction.pages,
				this.now()
			);
			return publicDocument(ready);
		} catch (error) {
			const failure = documentErrorFromUnknown(error);
			await this.repository.markFailed(accountId, conversationId, documentId, {
				code: failure.code,
				message: failure.message,
				now: this.now()
			});
			throw failure;
		}
	}

	async createDownloadUrl(accountId: string, conversationId: string, documentId: string) {
		const document = await this.requireDocument(accountId, conversationId, documentId);
		if (document.processingState !== 'ready') {
			throw new DocumentError(409, 'document_not_ready', 'This PDF is not ready yet.');
		}
		return this.storage.createSignedDownload(document.storagePath, SIGNED_DOWNLOAD_TTL_SECONDS);
	}

	async deleteDocument(accountId: string, conversationId: string, documentId: string): Promise<void> {
		const document = await this.requireDocument(accountId, conversationId, documentId);
		await this.storage.remove([document.storagePath]);
		await this.repository.deleteDocumentRecord(accountId, conversationId, documentId);
	}

	async cleanupConversation(accountId: string, conversationId: string): Promise<void> {
		const paths = await this.repository.listStoragePathsForConversation(accountId, conversationId);
		await removeInBatches(this.storage, paths);
		await this.repository.deleteDocumentsForConversation(accountId, conversationId);
	}

	async cleanupAccount(accountId: string): Promise<void> {
		const paths = await this.repository.listStoragePathsForAccount(accountId);
		await removeInBatches(this.storage, paths);
		await this.repository.deleteDocumentsForAccount(accountId);
	}

	async buildContext(input: {
		accountId: string;
		conversationId: string;
		documentIds?: string[];
		query: string;
	}): Promise<ConversationDocumentContext> {
		const documents = await this.repository.listReadyDocuments(
			input.accountId,
			input.conversationId,
			input.documentIds
		);
		if (documents.length === 0) {
			return { pages: [], totalCharacters: 0, usedFullDocuments: false };
		}
		const documentIds = documents.map((document) => document.id);
		const pages = await this.repository.listPages(documentIds);
		const rankedPages = await this.repository.searchPages(
			documentIds,
			input.query,
			DOCUMENT_CONTEXT_MATCH_LIMIT
		);
		return selectDocumentContext({ documents, pages, rankedPages });
	}

	async verifyCapability(): Promise<void> {
		await Promise.all([
			this.storage.verifyPrivateBucket(),
			this.extractor.verifyCapability?.() ?? Promise.resolve()
		]);
	}

	private async requireDocument(accountId: string, conversationId: string, documentId: string) {
		const document = await this.repository.getDocument(accountId, conversationId, documentId);
		if (!document) throw new DocumentError(404, 'document_not_found', 'PDF not found.');
		return document;
	}
}

function publicDocument(document: ConversationDocumentRow): PublicConversationDocument {
	return {
		id: document.id,
		filename: document.originalFilename,
		mimeType: document.mimeType,
		sizeBytes: document.sizeBytes,
		state: document.processingState,
		pageCount: document.pageCount,
		error: document.failureMessage,
		createdAt: document.createdAt,
		updatedAt: document.updatedAt
	};
}

function sha256(bytes: Uint8Array): string {
	return createHash('sha256').update(bytes).digest('hex');
}

async function removeInBatches(storage: DocumentStorage, paths: string[]): Promise<void> {
	for (let index = 0; index < paths.length; index += 100) {
		await storage.remove(paths.slice(index, index + 100));
	}
}
