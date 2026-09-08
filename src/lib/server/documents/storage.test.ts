import { describe, expect, it, vi } from 'vitest';
import { createSupabaseDocumentStorage, createVpsDocumentStorage } from './storage';

function jsonResponse(value: unknown, status = 200): Response {
	return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

function supabaseModule(
	options: { isPublic?: boolean; misconfigured?: boolean; signedUrl?: string } = {}
) {
	const bucket = {
		createSignedUploadUrl: vi.fn().mockResolvedValue({
			data: {
				path: 'org/conversation/document/file.pdf',
				token: 'upload-token',
				signedUrl: options.signedUrl ?? 'https://project.supabase.co/storage/v1/object/upload/sign/file'
			},
			error: null
		}),
		download: vi.fn(),
		createSignedUrl: vi.fn(),
		remove: vi.fn()
	};
	const createClient = vi.fn().mockReturnValue({
		storage: {
			from: vi.fn().mockReturnValue(bucket),
				getBucket: vi.fn().mockResolvedValue({
					data: {
						public: options.isPublic ?? false,
						file_size_limit: options.misconfigured ? undefined : 20 * 1024 * 1024,
						allowed_mime_types: options.misconfigured ? undefined : ['application/pdf']
					},
				error: null
			})
		}
	});
	return { module: { createClient }, createClient, bucket };
}

describe('Supabase document storage adapter', () => {
	it('uses a server-only client and creates non-upserting signed uploads', async () => {
		const fake = supabaseModule();
		const storage = createSupabaseDocumentStorage({
			url: 'https://project.supabase.co',
			serviceRoleKey: 'server-secret',
			loadModule: async () => fake.module
		});
		const result = await storage.createSignedUpload('org/conversation/document/file.pdf');
		expect(fake.createClient).toHaveBeenCalledWith(
			'https://project.supabase.co',
			'server-secret',
			{
				auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
			}
		);
		expect(fake.bucket.createSignedUploadUrl).toHaveBeenCalledWith(
			'org/conversation/document/file.pdf',
			{ upsert: false }
		);
		expect(result).toEqual({
			path: 'org/conversation/document/file.pdf',
			token: 'upload-token',
			signedUrl: 'https://project.supabase.co/storage/v1/object/upload/sign/file'
		});
	});

	it('rejects signed URLs outside the configured storage origin', async () => {
		const fake = supabaseModule({ signedUrl: 'https://attacker.example/upload?token=secret' });
		const storage = createSupabaseDocumentStorage({
			url: 'https://project.supabase.co',
			serviceRoleKey: 'server-secret',
			loadModule: async () => fake.module
		});
		await expect(
			storage.createSignedUpload('org/conversation/document/file.pdf')
		).rejects.toMatchObject({ code: 'document_storage_unavailable' });
	});

	it('rejects missing credentials and public buckets without exposing configuration', async () => {
		const missing = createSupabaseDocumentStorage({ url: '', serviceRoleKey: '' });
		await expect(missing.verifyPrivateBucket()).rejects.toMatchObject({
			status: 503,
			code: 'document_storage_unavailable',
			message: 'PDF storage is unavailable right now.'
		});

		const fake = supabaseModule({ isPublic: true });
		const publicBucket = createSupabaseDocumentStorage({
			url: 'https://project.supabase.co',
			serviceRoleKey: 'server-secret',
			loadModule: async () => fake.module
		});
		await expect(publicBucket.verifyPrivateBucket()).rejects.toMatchObject({
			code: 'document_storage_unavailable'
		});

		const permissive = supabaseModule({ misconfigured: true });
		const permissiveBucket = createSupabaseDocumentStorage({
			url: 'https://project.supabase.co',
			serviceRoleKey: 'server-secret',
			loadModule: async () => permissive.module
		});
		await expect(permissiveBucket.verifyPrivateBucket()).rejects.toMatchObject({
			code: 'document_storage_unavailable'
		});
	});
});

describe('VPS document storage adapter', () => {
	it('uses the gateway control plane and maps missing PDFs to upload_not_ready', async () => {
		const baseUrl = 'https://files.example.test:10000';
		const fetchImpl = vi.fn<typeof fetch>()
			.mockResolvedValueOnce(jsonResponse({ path: 'org/conversation/document/file.pdf', token: 'upload-token', signedUrl: `${baseUrl}/v1/upload/upload-token` }))
			.mockResolvedValueOnce(jsonResponse({ signedUrl: `${baseUrl}/v1/download/download-token` }))
			.mockResolvedValueOnce(jsonResponse({}, 404));
		const storage = createVpsDocumentStorage({ baseUrl, apiKey: 'server-secret', fetchImpl });
		await expect(storage.createSignedUpload('org/conversation/document/file.pdf')).resolves.toMatchObject({ token: 'upload-token' });
		await expect(storage.createSignedDownload('org/conversation/document/file.pdf', 60)).resolves.toBe(`${baseUrl}/v1/download/download-token`);
		await expect(storage.download('org/conversation/document/file.pdf')).rejects.toMatchObject({ status: 409, code: 'upload_not_ready' });
		expect(fetchImpl.mock.calls[0]?.[1]?.headers).toMatchObject({ 'x-storage-key': 'server-secret' });
	});

	it('fails closed when VPS credentials are missing', async () => {
		const storage = createVpsDocumentStorage({ baseUrl: '', apiKey: '' });
		await expect(storage.verifyPrivateBucket()).rejects.toMatchObject({ status: 503, code: 'document_storage_unavailable' });
	});
});
