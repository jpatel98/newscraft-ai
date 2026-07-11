import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DocumentError } from '$lib/server/documents/errors';

const conversationMocks = vi.hoisted(() => ({ getConversation: vi.fn() }));
const serviceMocks = vi.hoisted(() => ({
	listDocuments: vi.fn(),
	createUploadTokens: vi.fn(),
	processDocument: vi.fn(),
	createDownloadUrl: vi.fn(),
	deleteDocument: vi.fn()
}));

vi.mock('$lib/server/db/conversations', () => conversationMocks);
vi.mock('$app/environment', () => ({ dev: false }));
vi.mock('$env/dynamic/private', () => ({ env: { SUPABASE_URL: 'https://storage.example' } }));
vi.mock('$lib/server/documents/runtime', () => ({
	getConversationDocumentService: () => serviceMocks
}));

import { GET as listDocuments } from './+server';
import { DELETE as deleteDocument } from './[documentId]/+server';
import { GET as downloadDocument } from './[documentId]/download/+server';
import { POST as processDocument } from './[documentId]/process/+server';
import { POST as createUploadToken } from './upload-token/+server';

const user = { id: 'account-1', email: 'editor@example.test', name: 'Editor', role: 'admin' as const };
const conversation = {
	id: 'conversation-1',
	accountId: user.id,
	orgId: 'org-1',
	title: 'Story',
	systemPrompt: null,
	createdAt: 1,
	updatedAt: 2,
	pinned: 0
};

function event(options: { authenticated?: boolean; body?: unknown } = {}) {
	return {
		params: { id: conversation.id, documentId: 'document-1' },
		locals: {
			user: options.authenticated === false ? null : user,
			traceId: 'trace-12345678',
			isMarketingHost: false
		},
		request: new Request('http://localhost/api/conversations/conversation-1/documents', {
			method: 'POST',
			body: options.body === undefined ? undefined : JSON.stringify(options.body)
		})
	} as any;
}

describe('conversation document routes', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		conversationMocks.getConversation.mockResolvedValue(conversation);
		serviceMocks.listDocuments.mockResolvedValue([]);
		serviceMocks.createUploadTokens.mockResolvedValue([]);
		serviceMocks.processDocument.mockResolvedValue({ id: 'document-1', state: 'ready' });
		serviceMocks.createDownloadUrl.mockResolvedValue('https://storage.example/signed-document');
	});

	it('requires authentication and conversation ownership', async () => {
		await expect(listDocuments(event({ authenticated: false }))).rejects.toMatchObject({ status: 401 });
		conversationMocks.getConversation.mockResolvedValue(undefined);
		await expect(listDocuments(event())).rejects.toMatchObject({ status: 404 });
	});

	it('validates a PDF batch before creating upload tokens', async () => {
		const response = await createUploadToken(
			event({
				body: {
					documents: [
						{
							filename: 'agenda.pdf',
							mimeType: 'application/pdf',
							sizeBytes: 100,
							checksumSha256: 'a'.repeat(64)
						}
					]
				}
			})
		);
		expect(response.status).toBe(201);
		expect(serviceMocks.createUploadTokens).toHaveBeenCalledWith(
			conversation,
			[expect.objectContaining({ filename: 'agenda.pdf', mimeType: 'application/pdf' })]
		);
	});

	it('processes and deletes only inside the owned conversation', async () => {
		const processResponse = await processDocument(event());
		expect(await processResponse.json()).toEqual({ document: { id: 'document-1', state: 'ready' } });
		expect(serviceMocks.processDocument).toHaveBeenCalledWith(
			user.id,
			conversation.id,
			'document-1'
		);

		const deleteResponse = await deleteDocument(event());
		expect(await deleteResponse.json()).toEqual({ ok: true });
		expect(serviceMocks.deleteDocument).toHaveBeenCalledWith(
			user.id,
			conversation.id,
			'document-1'
		);
	});

	it('redirects downloads to a short-lived signed URL without caching', async () => {
		const response = await downloadDocument(event());
		expect(response.status).toBe(303);
		expect(response.headers.get('location')).toBe('https://storage.example/signed-document');
		expect(response.headers.get('cache-control')).toBe('no-store');
	});

	it('rejects signed download URLs outside the configured HTTPS storage origin', async () => {
		serviceMocks.createDownloadUrl.mockResolvedValue('http://attacker.example/file?token=secret');
		await expect(downloadDocument(event())).rejects.toMatchObject({
			status: 503,
			body: { message: 'PDF storage is unavailable right now.' }
		});
	});

	it('maps server document failures to user-safe HTTP errors', async () => {
		serviceMocks.processDocument.mockRejectedValue(
			new DocumentError(422, 'encrypted_pdf', 'Password-protected PDFs are not supported.')
		);
		await expect(processDocument(event())).rejects.toMatchObject({
			status: 422,
			body: { message: 'Password-protected PDFs are not supported.' }
		});
	});
});
