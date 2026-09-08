import { describe, expect, it, vi } from 'vitest';
import { VpsStorageClient } from './vps-client';

const baseUrl = 'https://files.example.test:10000';

function response(value: unknown, status = 200): Response {
	return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

describe('VpsStorageClient', () => {
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
