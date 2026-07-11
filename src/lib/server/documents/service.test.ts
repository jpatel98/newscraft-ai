import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { ConversationDocumentService } from './service';
import type {
	ConversationDocumentRow,
	DocumentRepository,
	DocumentStorage,
	PdfExtractor
} from './types';

function row(overrides: Partial<ConversationDocumentRow> = {}): ConversationDocumentRow {
	return {
		id: 'document-1',
		orgId: 'org-1',
		accountId: 'account-1',
		conversationId: 'conversation-1',
		originalFilename: 'agenda.pdf',
		storagePath: 'org-1/conversation-1/document-1/agenda.pdf',
		mimeType: 'application/pdf',
		sizeBytes: 8,
		checksumSha256: 'a'.repeat(64),
		processingState: 'uploading',
		pageCount: null,
		failureCode: null,
		failureMessage: null,
		processingStartedAt: null,
		processedAt: null,
		createdAt: 1,
		updatedAt: 1,
		...overrides
	};
}

function dependencies() {
	const repository = {
		createDocument: vi.fn(),
		deleteDocumentRecord: vi.fn(),
		getDocument: vi.fn(),
		listDocuments: vi.fn().mockResolvedValue([]),
		listReadyDocuments: vi.fn().mockResolvedValue([]),
		claimForProcessing: vi.fn(),
		markFailed: vi.fn(),
		replacePagesAndMarkReady: vi.fn(),
		listPages: vi.fn().mockResolvedValue([]),
		searchPages: vi.fn().mockResolvedValue([]),
		listStoragePathsForConversation: vi.fn().mockResolvedValue([]),
		listStoragePathsForAccount: vi.fn().mockResolvedValue([]),
		deleteDocumentsForConversation: vi.fn(),
		deleteDocumentsForAccount: vi.fn()
	} as unknown as DocumentRepository;
	const storage = {
		createSignedUpload: vi.fn(),
		download: vi.fn(),
		createSignedDownload: vi.fn(),
		remove: vi.fn(),
		verifyPrivateBucket: vi.fn()
	} as unknown as DocumentStorage;
	const extractor = { extract: vi.fn(), verifyCapability: vi.fn() } as unknown as PdfExtractor;
	return { repository, storage, extractor };
}

describe('conversation document service', () => {
	it('creates an ownership-scoped row before issuing an upload token', async () => {
		const deps = dependencies();
		vi.mocked(deps.storage.createSignedUpload).mockImplementation(async (path) => ({
			path,
			token: 'signed-token',
			signedUrl: 'https://storage.example/upload'
		}));
		const service = new ConversationDocumentService(
			deps.repository,
			deps.storage,
			deps.extractor,
			() => 10,
			() => 'document-1'
		);
		const result = await service.createUploadTokens(
			{ id: 'conversation-1', accountId: 'account-1', orgId: 'org-1' },
			[
				{
					filename: 'agenda.pdf',
					mimeType: 'application/pdf',
					sizeBytes: 100,
					checksumSha256: 'a'.repeat(64)
				}
			]
		);
		expect(deps.repository.createDocument).toHaveBeenCalledWith(
			expect.objectContaining({
				id: 'document-1',
				orgId: 'org-1',
				accountId: 'account-1',
				conversationId: 'conversation-1',
				processingState: 'uploading'
			})
		);
		expect(result[0]).toMatchObject({
			document: { id: 'document-1', filename: 'agenda.pdf', state: 'uploading' },
			upload: { token: 'signed-token' }
		});
		expect(JSON.stringify(result)).not.toContain('checksumSha256');
	});

	it('removes issued upload paths before rolling back a failed token batch', async () => {
		const deps = dependencies();
		vi.mocked(deps.storage.createSignedUpload)
			.mockImplementationOnce(async (path) => ({
				path,
				token: 'first-token',
				signedUrl: 'https://storage.example/upload/first'
			}))
			.mockRejectedValueOnce(new Error('second token failed'));
		const ids = ['document-1', 'document-2'];
		const service = new ConversationDocumentService(
			deps.repository,
			deps.storage,
			deps.extractor,
			() => 10,
			() => ids.shift() as string
		);

		await expect(
			service.createUploadTokens(
				{ id: 'conversation-1', accountId: 'account-1', orgId: 'org-1' },
				[
					{
						filename: 'one.pdf',
						mimeType: 'application/pdf',
						sizeBytes: 100,
						checksumSha256: 'a'.repeat(64)
					},
					{
						filename: 'two.pdf',
						mimeType: 'application/pdf',
						sizeBytes: 100,
						checksumSha256: 'b'.repeat(64)
					}
				]
			)
		).rejects.toThrow('second token failed');

		expect(deps.storage.remove).toHaveBeenCalledWith([
			'org-1/conversation-1/document-1/one.pdf',
			'org-1/conversation-1/document-2/two.pdf'
		]);
		expect(deps.repository.deleteDocumentRecord).toHaveBeenCalledTimes(2);
	});

	it('verifies checksum and stores page-separated text', async () => {
		const deps = dependencies();
		const bytes = new TextEncoder().encode('%PDF-ok');
		const processing = row({
			sizeBytes: bytes.byteLength,
			checksumSha256: createHash('sha256').update(bytes).digest('hex'),
			processingState: 'processing'
		});
		vi.mocked(deps.repository.getDocument).mockResolvedValue(row());
		vi.mocked(deps.repository.claimForProcessing).mockResolvedValue(processing);
		vi.mocked(deps.storage.download).mockResolvedValue(bytes);
		vi.mocked(deps.extractor.extract).mockResolvedValue({ pageCount: 2, pages: ['one', 'two'] });
		vi.mocked(deps.repository.replacePagesAndMarkReady).mockResolvedValue(
			row({ processingState: 'ready', pageCount: 2 })
		);
		const service = new ConversationDocumentService(
			deps.repository,
			deps.storage,
			deps.extractor,
			() => 20
		);
		const result = await service.processDocument('account-1', 'conversation-1', 'document-1');
		expect(deps.repository.replacePagesAndMarkReady).toHaveBeenCalledWith(
			processing,
			['one', 'two'],
			20
		);
		expect(result).toMatchObject({ state: 'ready', pageCount: 2 });
	});

	it('persists only a safe processing failure', async () => {
		const deps = dependencies();
		const bytes = new TextEncoder().encode('%PDF-ok');
		vi.mocked(deps.repository.getDocument).mockResolvedValue(row());
		vi.mocked(deps.repository.claimForProcessing).mockResolvedValue(
			row({
				processingState: 'processing',
				sizeBytes: bytes.byteLength,
				checksumSha256: '0'.repeat(64)
			})
		);
		vi.mocked(deps.storage.download).mockResolvedValue(bytes);
		const service = new ConversationDocumentService(
			deps.repository,
			deps.storage,
			deps.extractor,
			() => 30
		);
		await expect(service.processDocument('account-1', 'conversation-1', 'document-1')).rejects.toMatchObject({
			code: 'file_mismatch'
		});
		expect(deps.repository.markFailed).toHaveBeenCalledWith(
			'account-1',
			'conversation-1',
			'document-1',
			expect.objectContaining({
				code: 'file_mismatch',
				message: 'The uploaded PDF did not match the selected file. Upload it again.'
			})
		);
	});

	it('removes private objects before deleting conversation records', async () => {
		const deps = dependencies();
		const calls: string[] = [];
		vi.mocked(deps.repository.listStoragePathsForConversation).mockResolvedValue(['one.pdf', 'two.pdf']);
		vi.mocked(deps.storage.remove).mockImplementation(async () => {
			calls.push('storage');
		});
		vi.mocked(deps.repository.deleteDocumentsForConversation).mockImplementation(async () => {
			calls.push('database');
		});
		const service = new ConversationDocumentService(deps.repository, deps.storage, deps.extractor);
		await service.cleanupConversation('account-1', 'conversation-1');
		expect(calls).toEqual(['storage', 'database']);
		expect(deps.storage.remove).toHaveBeenCalledWith(['one.pdf', 'two.pdf']);
	});

	it('does not delete database records when storage cleanup fails', async () => {
		const deps = dependencies();
		vi.mocked(deps.repository.listStoragePathsForConversation).mockResolvedValue(['one.pdf']);
		vi.mocked(deps.storage.remove).mockRejectedValue(new Error('storage failed'));
		const service = new ConversationDocumentService(deps.repository, deps.storage, deps.extractor);

		await expect(service.cleanupConversation('account-1', 'conversation-1')).rejects.toThrow(
			'storage failed'
		);
		expect(deps.repository.deleteDocumentsForConversation).not.toHaveBeenCalled();
	});

	it('requires both private storage and the PDF parser for capability readiness', async () => {
		const deps = dependencies();
		const service = new ConversationDocumentService(deps.repository, deps.storage, deps.extractor);
		await service.verifyCapability();
		expect(deps.storage.verifyPrivateBucket).toHaveBeenCalledOnce();
		expect(deps.extractor.verifyCapability).toHaveBeenCalledOnce();
	});
});
