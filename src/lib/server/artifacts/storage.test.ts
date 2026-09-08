import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { ArtifactValidationError, ARTIFACT_MAX_ASSET_BYTES } from './contracts';
import {
	ARTIFACT_STORAGE_BUCKET,
	ARTIFACT_STORAGE_MIME_TYPES,
	createSupabaseArtifactStorage,
	createVpsArtifactStorage,
	verifyArtifactObject,
	type ArtifactObjectStorage,
	type StoredArtifactObject
} from './storage';

function response(value: unknown, status = 200): Response {
	return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

function fakeStorage(bytes: Uint8Array, contentType = 'image/png', checksum = createHash('sha256').update(bytes).digest('hex')): ArtifactObjectStorage {
	const meta: StoredArtifactObject = { key: 'artifacts/a', version: 'version-1234567890123456', bytes: bytes.byteLength, checksumSha256: checksum, contentType, path: '/private/tmp/fake' };
	return { async putStaged() { return meta; }, async get() { return bytes; }, async stat() { return meta; }, async remove() {} };
}

describe('artifact object verification', () => {
	it('checks actual bytes, checksum, MIME magic and PNG dimensions', async () => {
		const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 2, 0, 0, 0, 3]);
		const result = await verifyArtifactObject(fakeStorage(bytes), { key: 'artifacts/a', version: 'version-1234567890123456', allowedMime: 'image/png', maxBytes: 1024, exactBytes: bytes.byteLength });
		expect(result.dimensions).toEqual({ width: 2, height: 3 });
	});

	it('rejects a wrong checksum even when metadata claims the object exists', async () => {
		const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
		await expect(verifyArtifactObject(fakeStorage(bytes, 'image/png', '0'.repeat(64)), { key: 'artifacts/a', version: 'version-1234567890123456', allowedMime: 'image/png', maxBytes: 1024 })).rejects.toBeInstanceOf(ArtifactValidationError);
	});
});

describe('Supabase artifact storage adapter', () => {
	it('uses a server-only client, private bucket policy, and non-upserting signed uploads', async () => {
		const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 2, 0, 0, 0, 3]);
		const checksum = createHash('sha256').update(bytes).digest('hex');
		const bucket = {
			createSignedUploadUrl: vi.fn().mockResolvedValue({ data: { path: 'staging/a', token: 'signed-token', signedUrl: 'https://project.supabase.co/storage/v1/object/upload/sign/staging/a?token=signed-token' }, error: null }),
			upload: vi.fn().mockResolvedValue({ data: { path: 'staging/a' }, error: null }),
			info: vi.fn().mockResolvedValue({ data: { version: 'version-1234567890123456', size: bytes.byteLength, content_type: 'image/png', metadata: { sha256: checksum } }, error: null }),
			download: vi.fn().mockResolvedValue({ data: new Blob([bytes]), error: null }),
			remove: vi.fn().mockResolvedValue({ data: [], error: null })
		};
		const createClient = vi.fn().mockReturnValue({
			storage: {
				from: vi.fn().mockReturnValue(bucket),
				getBucket: vi.fn().mockResolvedValue({ data: { public: false, file_size_limit: ARTIFACT_MAX_ASSET_BYTES, allowed_mime_types: [...ARTIFACT_STORAGE_MIME_TYPES] }, error: null })
			}
		});
		const storage = createSupabaseArtifactStorage({
			url: 'https://project.supabase.co',
			serviceRoleKey: 'server-secret',
			bucket: ARTIFACT_STORAGE_BUCKET,
			loadModule: async () => ({ createClient })
		});
		await storage.verifyPrivateBucket?.();
		const target = await storage.createSignedUpload?.('staging/a');
		expect(target?.token).toBe('signed-token');
		expect(bucket.createSignedUploadUrl).toHaveBeenCalledWith('staging/a', { upsert: false });
		const stored = await storage.putStaged('staging/a', bytes, 'image/png');
		expect(stored).toMatchObject({ key: 'staging/a', version: 'version-1234567890123456', bytes: bytes.byteLength, checksumSha256: checksum });
		expect(bucket.upload).toHaveBeenCalledWith('staging/a', bytes, expect.objectContaining({ contentType: 'image/png', upsert: false }));
		expect(await storage.stat('staging/a', 'wrong-version-123456')).toBeNull();
		expect(await storage.get('staging/a', 'version-1234567890123456')).toEqual(bytes);
	});

	it('rejects public or misconfigured buckets and foreign signed URLs', async () => {
		const bucket = {
			createSignedUploadUrl: vi.fn().mockResolvedValue({ data: { path: 'staging/a', token: 'token', signedUrl: 'https://attacker.example/upload?token=secret' }, error: null }),
			upload: vi.fn(), info: vi.fn(), download: vi.fn(), remove: vi.fn()
		};
		const createClient = vi.fn().mockReturnValue({
			storage: {
				from: vi.fn().mockReturnValue(bucket),
				getBucket: vi.fn().mockResolvedValue({ data: { public: true, file_size_limit: ARTIFACT_MAX_ASSET_BYTES, allowed_mime_types: [...ARTIFACT_STORAGE_MIME_TYPES] }, error: null })
			}
		});
		const storage = createSupabaseArtifactStorage({ url: 'https://project.supabase.co', serviceRoleKey: 'server-secret', bucket: ARTIFACT_STORAGE_BUCKET, loadModule: async () => ({ createClient }) });
		await expect(storage.verifyPrivateBucket?.()).rejects.toThrow('persistent artifact storage is unavailable');
		await expect(storage.createSignedUpload?.('staging/a')).rejects.toThrow('persistent artifact storage is unavailable');
	});
});

describe('VPS artifact storage adapter', () => {
	it('treats a missing immutable generation as absent', async () => {
		const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response({}, 404));
		const storage = createVpsArtifactStorage({
			baseUrl: 'https://files.example.test:10000',
			apiKey: 'server-secret',
			fetchImpl
		});
		await expect(storage.stat('staging/a', 'a'.repeat(32))).resolves.toBeNull();
		await expect(storage.statLatest?.('staging/a')).resolves.toBeNull();
	});
});
