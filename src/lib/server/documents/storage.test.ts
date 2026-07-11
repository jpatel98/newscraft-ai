import { describe, expect, it, vi } from 'vitest';
import { createSupabaseDocumentStorage } from './storage';

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
