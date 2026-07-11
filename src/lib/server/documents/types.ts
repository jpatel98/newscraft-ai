export type DocumentProcessingState = 'uploading' | 'processing' | 'ready' | 'failed';

export interface NewsroomProfileRow {
	orgId: string;
	timezone: string;
	homeMarket: string;
	preferredDomains: string[];
	createdAt: number;
	updatedAt: number;
}

export interface ConversationDocumentRow {
	id: string;
	orgId: string;
	accountId: string;
	conversationId: string;
	originalFilename: string;
	storagePath: string;
	mimeType: 'application/pdf';
	sizeBytes: number;
	checksumSha256: string;
	processingState: DocumentProcessingState;
	pageCount: number | null;
	failureCode: string | null;
	failureMessage: string | null;
	processingStartedAt: number | null;
	processedAt: number | null;
	createdAt: number;
	updatedAt: number;
}

export interface ConversationDocumentPageRow {
	id: string;
	documentId: string;
	orgId: string;
	accountId: string;
	conversationId: string;
	pageNumber: number;
	pageText: string;
	charCount: number;
	createdAt: number;
	updatedAt: number;
}

export interface RankedDocumentPage extends ConversationDocumentPageRow {
	rank: number;
}

export interface PdfUploadInput {
	filename: string;
	mimeType: string;
	sizeBytes: number;
	checksumSha256: string;
}

export interface PdfExtractionResult {
	pageCount: number;
	pages: string[];
}

export interface PdfExtractor {
	extract(bytes: Uint8Array): Promise<PdfExtractionResult>;
	verifyCapability?(): Promise<void>;
}

export interface SignedUpload {
	path: string;
	token: string;
	signedUrl: string;
}

export interface DocumentStorage {
	createSignedUpload(path: string): Promise<SignedUpload>;
	download(path: string): Promise<Uint8Array>;
	createSignedDownload(path: string, expiresInSeconds: number): Promise<string>;
	remove(paths: string[]): Promise<void>;
	verifyPrivateBucket(): Promise<void>;
}

export interface DocumentRepository {
	createDocument(row: ConversationDocumentRow): Promise<void>;
	deleteDocumentRecord(accountId: string, conversationId: string, documentId: string): Promise<void>;
	getDocument(
		accountId: string,
		conversationId: string,
		documentId: string
	): Promise<ConversationDocumentRow | undefined>;
	listDocuments(accountId: string, conversationId: string): Promise<ConversationDocumentRow[]>;
	listReadyDocuments(
		accountId: string,
		conversationId: string,
		documentIds?: string[]
	): Promise<ConversationDocumentRow[]>;
	claimForProcessing(
		accountId: string,
		conversationId: string,
		documentId: string,
		now: number
	): Promise<ConversationDocumentRow | undefined>;
	markFailed(
		accountId: string,
		conversationId: string,
		documentId: string,
		failure: { code: string; message: string; now: number }
	): Promise<void>;
	replacePagesAndMarkReady(
		document: ConversationDocumentRow,
		pages: string[],
		now: number
	): Promise<ConversationDocumentRow>;
	listPages(documentIds: string[]): Promise<ConversationDocumentPageRow[]>;
	searchPages(documentIds: string[], query: string, limit: number): Promise<RankedDocumentPage[]>;
	listStoragePathsForConversation(accountId: string, conversationId: string): Promise<string[]>;
	listStoragePathsForAccount(accountId: string): Promise<string[]>;
	deleteDocumentsForConversation(accountId: string, conversationId: string): Promise<void>;
	deleteDocumentsForAccount(accountId: string): Promise<void>;
}

export interface DocumentContextPage {
	documentId: string;
	filename: string;
	pageNumber: number;
	text: string;
	truncated: boolean;
}

export interface ConversationDocumentContext {
	pages: DocumentContextPage[];
	totalCharacters: number;
	usedFullDocuments: boolean;
}
