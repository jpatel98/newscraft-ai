import { describe, expect, it, vi } from 'vitest';
import {
	ConversationDocumentError,
	deleteConversationDocument,
	documentsCapabilityEnabled,
	sha256Hex,
	uploadConversationPdf
} from './documents';

function pdfFile(contents = '%PDF-1.7\nhello', name = 'notes.pdf'): File {
	return new File([contents], name, { type: 'application/pdf' });
}

describe('conversation document client', () => {
	it('reads the capability without exposing a failed health response', async () => {
		const enabledFetch = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ app: { capabilities: { documents: true } } }), { status: 200 })
		);
		await expect(documentsCapabilityEnabled(enabledFetch)).resolves.toBe(true);
		await expect(documentsCapabilityEnabled(vi.fn().mockRejectedValue(new Error('offline')))).resolves.toBe(
			false
		);
		await expect(
			documentsCapabilityEnabled(
				vi.fn().mockResolvedValue(new Response(JSON.stringify({ app: { ok: true } }), { status: 200 }))
			)
		).resolves.toBe(false);
	});

	it('hashes, uploads directly to the signed URL, then processes the PDF', async () => {
		const file = pdfFile();
		const onCreated = vi.fn();
		const onProcessing = vi.fn();
		const fetchImpl = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						documents: [
							{
								document: {
									id: 'doc-1',
									filename: 'notes.pdf',
									state: 'uploading',
									pageCount: null,
									error: null
								},
								upload: {
									path: 'org/conversation/doc-1/notes.pdf',
									token: 'signed-token',
									signedUrl: 'https://storage.example/upload?token=signed-token'
								}
							}
						]
					})
				)
			)
			.mockResolvedValueOnce(new Response('{}', { status: 200 }))
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						document: {
							id: 'doc-1',
							filename: 'notes.pdf',
							state: 'ready',
							pageCount: 2,
							error: null
						}
					})
				)
			);

		await expect(
			uploadConversationPdf('conversation 1', file, { fetch: fetchImpl, onCreated, onProcessing })
		).resolves.toMatchObject({ id: 'doc-1', state: 'ready', pageCount: 2 });
		expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ id: 'doc-1' }));
		expect(onProcessing).toHaveBeenCalledWith(expect.objectContaining({ state: 'processing' }));
		expect(fetchImpl.mock.calls[0][0]).toBe(
			'/api/conversations/conversation%201/documents/upload-token'
		);
		const tokenRequest = fetchImpl.mock.calls[0][1] as RequestInit;
		const tokenBody = JSON.parse(String(tokenRequest.body));
		expect(tokenBody.documents[0]).toMatchObject({
			filename: 'notes.pdf',
			mimeType: 'application/pdf',
			sizeBytes: file.size,
			checksumSha256: await sha256Hex(file)
		});
		expect(fetchImpl.mock.calls[1][0]).toBe('https://storage.example/upload?token=signed-token');
		const uploadRequest = fetchImpl.mock.calls[1][1] as RequestInit;
		expect(uploadRequest).toMatchObject({ method: 'PUT', headers: { 'x-upsert': 'false' } });
		expect(uploadRequest.body).toBeInstanceOf(FormData);
		const uploadForm = uploadRequest.body as FormData;
		expect(uploadForm.get('cacheControl')).toBe('3600');
		expect(uploadForm.get('')).toBe(file);
		expect(fetchImpl.mock.calls[2][0]).toContain('/doc-1/process');
	});

	it('keeps document failures concise and user safe', async () => {
		const fetchImpl = vi.fn().mockResolvedValue(
			new Response(JSON.stringify({ message: 'Password-protected PDFs are not supported.' }), {
				status: 422
			})
		);
		await expect(uploadConversationPdf('conversation-1', pdfFile(), { fetch: fetchImpl })).rejects.toEqual(
			new ConversationDocumentError('Password-protected PDFs are not supported.')
		);
	});

	it('deletes through the authenticated conversation route', async () => {
		const fetchImpl = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
		await deleteConversationDocument('conversation/1', 'document/1', fetchImpl);
		expect(fetchImpl).toHaveBeenCalledWith(
			'/api/conversations/conversation%2F1/documents/document%2F1',
			expect.objectContaining({ method: 'DELETE' })
		);
	});
});
