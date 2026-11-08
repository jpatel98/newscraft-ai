import { describe, expect, it, vi } from 'vitest';
import { VpsStorageClient } from './vps-client';

const baseUrl = 'https://files.example.test:10000';

function response(value: unknown, status = 200): Response {
	return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

describe('VpsStorageClient', () => {
	it('requires a revocation acknowledgement even when an older gateway returns 204', async () => {
		const fetchImpl = vi.fn<typeof fetch>()
			.mockResolvedValueOnce(new Response(null, { status: 204 }))
			.mockResolvedValueOnce(new Response(null, { status: 204, headers: { 'X-NewsCraft-Upload-Revoked': '1' } }));
		const client = new VpsStorageClient({ baseUrl, apiKey: 'synthetic-key', fetchImpl });
		const request = { bucket: 'newsroom-artifacts', key: 'evidence/account/project/document', revokeUploads: true as const };
		await expect(client.remove(request)).rejects.toThrow('revocation was not acknowledged');
		await expect(client.remove(request)).resolves.toBeUndefined();
		const target = new URL(String(fetchImpl.mock.calls[0][0]));
		expect(target.searchParams.get('revokeUploads')).toBe('true');
		expect(target.searchParams.get('key')).toBe(request.key);
		expect(target.searchParams.get('bucket')).toBe(request.bucket);
	});

	it('does not require acknowledgement for ordinary deletion, but rejects failed revocation', async () => {
		const fetchImpl = vi.fn<typeof fetch>()
			.mockResolvedValueOnce(new Response(null, { status: 404 }))
			.mockResolvedValueOnce(new Response(null, { status: 404, headers: { 'X-NewsCraft-Upload-Revoked': '1' } }));
		const client = new VpsStorageClient({ baseUrl, apiKey: 'synthetic-key', fetchImpl });
		await expect(client.remove({ bucket: 'b', key: 'k' })).resolves.toBeUndefined();
		expect(new URL(String(fetchImpl.mock.calls[0][0])).searchParams.has('revokeUploads')).toBe(false);
		await expect(client.remove({ bucket: 'b', key: 'k', revokeUploads: true })).rejects.toThrow('revocation was not acknowledged');
	});

	it.each(['0', 'true', '1, 1'])('rejects malformed revocation acknowledgement %s', async (acknowledgement) => {
		const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204, headers: { 'X-NewsCraft-Upload-Revoked': acknowledgement } }));
		const client = new VpsStorageClient({ baseUrl, apiKey: 'synthetic-key', fetchImpl });
		await expect(client.remove({ bucket: 'newsroom-artifacts', key: 'evidence/account/project/document', revokeUploads: true })).rejects.toThrow('revocation was not acknowledged');
	});

	it('keeps the API key on control-plane requests and validates signed URL origin', async () => {
		const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
			response({
				path: 'org/conversation/document/file.pdf',
				token: 'upload-token',
				signedUrl: `${baseUrl}/v1/upload/upload-token`
			})
		);
		const client = new VpsStorageClient({ baseUrl, apiKey: 'server-key', fetchImpl });
		await expect(client.signUpload({
			bucket: 'newsroom-documents', key: 'org/conversation/document/file.pdf', maxBytes: 1024, contentType: 'application/pdf'
		})).resolves.toMatchObject({ path: 'org/conversation/document/file.pdf', token: 'upload-token' });
		const request = fetchImpl.mock.calls[0]?.[1];
		expect(request?.headers).toMatchObject({ 'x-storage-key': 'server-key', 'content-type': 'application/json' });

		fetchImpl.mockResolvedValueOnce(response({ signedUrl: 'https://attacker.example/v1/upload/token' }));
		await expect(client.signDownload({ bucket: 'newsroom-documents', key: 'file.pdf', expiresInSeconds: 60 })).rejects.toThrow('invalid download URL');
	});

	it('parses immutable metadata and returns null only for a missing object', async () => {
		const fetchImpl = vi.fn<typeof fetch>()
			.mockResolvedValueOnce(response({ key: 'staging/a', version: 'a'.repeat(32), bytes: 4, checksumSha256: 'b'.repeat(64), contentType: 'image/png', path: 'staging/a' }))
			.mockResolvedValueOnce(response({}, 404));
		const client = new VpsStorageClient({ baseUrl, apiKey: 'server-key', fetchImpl });
		await expect(client.stat({ bucket: 'newsroom-artifacts', key: 'staging/a', version: 'a'.repeat(32) })).resolves.toMatchObject({ bytes: 4, contentType: 'image/png' });
		await expect(client.statLatest({ bucket: 'newsroom-artifacts', key: 'staging/missing' })).resolves.toBeNull();
	});

	it('requires a private policy response', async () => {
		const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response({ private: false, maxBytes: 20, mimeTypes: [] }));
		const client = new VpsStorageClient({ baseUrl, apiKey: 'server-key', fetchImpl });
		await expect(client.verifyPolicy('newsroom-artifacts')).rejects.toThrow('policy is invalid');
	});

	it.each([undefined, false, true, 'true', 1])('surfaces strict revocation support without rejecting legacy policy %s', async (capability) => {
		const policy = { private: true, maxBytes: 20, mimeTypes: ['application/pdf'], ...(capability === undefined ? {} : { supportsUploadRevocation: capability }) };
		const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response(policy));
		const client = new VpsStorageClient({ baseUrl, apiKey: 'synthetic-key', fetchImpl });
		await expect(client.verifyPolicy('newsroom-documents')).resolves.toEqual({
			private: true, maxBytes: 20, mimeTypes: ['application/pdf'], supportsUploadRevocation: capability === true
		});
	});

	it('preserves a gateway base path on control and signed data URLs', async () => {
		const prefixedBaseUrl = 'https://files.example.test/newscraft-storage';
		const fetchImpl = vi.fn<typeof fetch>()
			.mockResolvedValueOnce(response({ signedUrl: `${prefixedBaseUrl}/v1/download/download-token` }))
			.mockResolvedValueOnce(response({ ok: true }));
		const client = new VpsStorageClient({ baseUrl: prefixedBaseUrl, apiKey: 'server-key', fetchImpl });
		await expect(client.signDownload({ bucket: 'newsroom-documents', key: 'file.pdf', expiresInSeconds: 60 })).resolves.toContain('/newscraft-storage/v1/download/');
		await client.getObject({ bucket: 'newsroom-documents', key: 'file.pdf' });
		const requestedUrl = String(fetchImpl.mock.calls[1]?.[0]);
		 expect(requestedUrl).toContain('https://files.example.test/newscraft-storage/v1/object?');

		fetchImpl.mockResolvedValueOnce(response({ signedUrl: 'https://files.example.test/v1/download/wrong-prefix' }));
		await expect(client.signDownload({ bucket: 'newsroom-documents', key: 'file.pdf', expiresInSeconds: 60 })).rejects.toThrow('invalid download URL');
	});
});
