import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { env } from '$env/dynamic/private';
import { dev } from '$app/environment';
import { createClient } from '@supabase/supabase-js';
import {
	ARTIFACT_MAX_ASSET_BYTES,
	ARTIFACT_MAX_PREVIEW_BYTES,
	ArtifactValidationError,
	type ArtifactAssetRole
} from './contracts';
import { isAllowedSignedStorageUrl } from '$lib/server/documents/signed-url';

/** The artifact bucket is deliberately separate from the PDF bucket. */
export const ARTIFACT_STORAGE_BUCKET = 'newsroom-artifacts';
export const ARTIFACT_STORAGE_MIME_TYPES = [
	'image/png',
	'image/jpeg',
	'text/csv',
	'text/markdown',
	'application/json'
] as const;

export interface StoredArtifactObject {
	key: string;
	version: string;
	bytes: number;
	checksumSha256: string;
	contentType: string;
	path: string;
}

export interface ArtifactObjectStorage {
	putStaged(key: string, bytes: Uint8Array, contentType: string): Promise<StoredArtifactObject>;
	get(key: string, version: string): Promise<Uint8Array>;
	stat(key: string, version: string): Promise<StoredArtifactObject | null>;
	remove(key: string, version?: string): Promise<void>;
	/** A signed upload is only exposed by the persistent adapter. */
	createSignedUpload?(key: string): Promise<{ path: string; token: string; signedUrl: string }>;
	/** Verify the server-owned bucket policy before issuing a grant. */
	verifyPrivateBucket?(): Promise<void>;
	/** Look up the current immutable generation after a direct upload. */
	statLatest?(key: string): Promise<StoredArtifactObject | null>;
}

const LOCAL_ROOT = resolve(env.NEWSCRAFT_ARTIFACT_STORAGE_DIR || '/private/tmp/newscraft-artifacts');

function safeKey(key: string): string {
	const value = key.trim();
	if (!value || value.length > 512 || isAbsolute(value) || value.includes('..') || /[\u0000-\u001f]/u.test(value)) {
		throw new ArtifactValidationError('invalid_object_key', 'object key is invalid');
	}
	const target = resolve(LOCAL_ROOT, value);
	const rel = relative(LOCAL_ROOT, target);
	if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new ArtifactValidationError('invalid_object_key', 'object key is invalid');
	return rel;
}

function objectPath(key: string, version: string): string {
	const safe = safeKey(key);
	const safeVersion = version.trim();
	if (!/^[a-zA-Z0-9_-]{16,80}$/.test(safeVersion)) throw new ArtifactValidationError('invalid_object_version', 'object version is invalid');
	return join(LOCAL_ROOT, safe, `${safeVersion}.bin`);
}

function metadataPath(key: string, version: string): string {
	return `${objectPath(key, version)}.json`;
}

export function localArtifactStorageEnabled(): boolean {
	return dev || env.NEWSCRAFT_ARTIFACT_LOCAL_STORAGE === '1';
}

export function createLocalArtifactStorage(): ArtifactObjectStorage {
	return {
		async putStaged(key, bytes, contentType) {
			if (!localArtifactStorageEnabled()) throw new Error('local artifact storage is disabled');
			const safe = safeKey(key);
			if (bytes.byteLength > ARTIFACT_MAX_ASSET_BYTES) throw new ArtifactValidationError('asset_too_large', 'asset is too large');
			const version = randomUUID().replaceAll('-', '');
			const path = objectPath(safe, version);
			await mkdir(dirname(path), { recursive: true, mode: 0o700 });
			await writeFile(path, bytes, { mode: 0o600, flag: 'wx' });
			const checksumSha256 = createHash('sha256').update(bytes).digest('hex');
			await writeFile(metadataPath(safe, version), JSON.stringify({ contentType, bytes: bytes.byteLength, checksumSha256 }), { mode: 0o600, flag: 'wx' });
			return { key: safe, version, bytes: bytes.byteLength, checksumSha256, contentType, path };
		},
		async get(key, version) {
			return new Uint8Array(await readFile(objectPath(key, version)));
		},
		async stat(key, version) {
			try {
				const [file, metadata] = await Promise.all([stat(objectPath(key, version)), readFile(metadataPath(key, version), 'utf8')]);
				const parsed = JSON.parse(metadata) as { contentType?: string; checksumSha256?: string; bytes?: number };
				if (!file.isFile() || typeof parsed.contentType !== 'string' || typeof parsed.checksumSha256 !== 'string') return null;
				return { key: safeKey(key), version, bytes: file.size, checksumSha256: parsed.checksumSha256, contentType: parsed.contentType, path: objectPath(key, version) };
			} catch {
				return null;
			}
		},
		async remove(key, version) {
			if (version) {
				await Promise.allSettled([rm(objectPath(key, version), { force: true }), rm(metadataPath(key, version), { force: true })]);
				return;
			}
			await rm(join(LOCAL_ROOT, safeKey(key)), { recursive: true, force: true });
		}
	};
}

interface SupabaseResult<T> {
	data: T | null;
	error: unknown | null;
}

interface SupabaseBucket {
	createSignedUploadUrl(path: string, options: { upsert: false }): Promise<SupabaseResult<{
		path: string;
		token: string;
		signedUrl: string;
	}>>;
	upload(path: string, body: Uint8Array, options: Record<string, unknown>): Promise<SupabaseResult<unknown>>;
	info(path: string): Promise<SupabaseResult<Record<string, unknown>>>;
	download(path: string): Promise<SupabaseResult<Blob>>;
	remove(paths: string[]): Promise<SupabaseResult<unknown>>;
}

interface SupabaseClient {
	storage: {
		from(bucket: string): SupabaseBucket;
		getBucket(bucket: string): Promise<SupabaseResult<{
			public: boolean;
			file_size_limit?: number;
			allowed_mime_types?: string[];
		}>>;
	};
}

interface SupabaseModule {
	createClient(
		url: string,
		key: string,
		options: { auth: { persistSession: false; autoRefreshToken: false; detectSessionInUrl: false } }
	): SupabaseClient;
}

type SupabaseLoader = () => Promise<SupabaseModule>;

async function loadSupabase(): Promise<SupabaseModule> {
	return { createClient } as unknown as SupabaseModule;
}

function unavailable(): Error {
	return new Error('persistent artifact storage is unavailable');
}

function supabaseObjectMetadata(
	key: string,
	data: Record<string, unknown>
): StoredArtifactObject | null {
	const version = typeof data.version === 'string' ? data.version.trim() : '';
	const bytes = typeof data.size === 'number' ? data.size : Number(data.size);
	const contentType = typeof data.contentType === 'string'
		? data.contentType
		: typeof data.content_type === 'string' ? data.content_type : '';
	if (!version || !Number.isSafeInteger(bytes) || bytes < 0 || !contentType) return null;
	const custom = data.metadata && typeof data.metadata === 'object' ? data.metadata as Record<string, unknown> : {};
	const checksum = typeof custom.sha256 === 'string' && /^[a-fA-F0-9]{64}$/u.test(custom.sha256)
		? custom.sha256.toLowerCase()
		: '';
	return {
		key,
		version,
		bytes,
		// Supabase does not guarantee a checksum in the info response. The
		// verifier computes it from the downloaded bytes; a custom sha256
		// metadata value, when present, is an additional check.
		checksumSha256: checksum,
		contentType,
		path: key
	};
}

/**
 * Persistent private storage backed by Supabase Storage. The service-role
 * client is created lazily and never reaches browser code. Object versions
 * are checked with `info()` before every download; Supabase's download API is
 * path-based, so immutable, non-upserting keys plus this check prevent a
 * replaced object from being served for an older database generation.
 */
export function createSupabaseArtifactStorage(options: {
	url?: string;
	serviceRoleKey?: string;
	bucket?: string;
	loadModule?: SupabaseLoader;
	allowLoopbackHttp?: boolean;
} = {}): ArtifactObjectStorage {
	const url = options.url ?? env.SUPABASE_URL ?? '';
	const serviceRoleKey = options.serviceRoleKey ?? env.SUPABASE_SERVICE_ROLE_KEY ?? '';
	const bucketName = options.bucket ?? env.NEWSCRAFT_ARTIFACT_STORAGE_BUCKET ?? '';
	const loader = options.loadModule ?? loadSupabase;
	const allowLoopbackHttp = options.allowLoopbackHttp ?? dev;
	let clientPromise: Promise<SupabaseClient> | undefined;

	async function client(): Promise<SupabaseClient> {
		if (!url || !serviceRoleKey || bucketName !== ARTIFACT_STORAGE_BUCKET) throw unavailable();
		clientPromise ??= loader()
			.then((supabase) => supabase.createClient(url, serviceRoleKey, {
				auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
			}))
			.catch(() => { throw unavailable(); });
		return clientPromise;
	}

	async function bucket(): Promise<SupabaseBucket> {
		return (await client()).storage.from(bucketName);
	}

	async function info(key: string): Promise<StoredArtifactObject | null> {
		safeKey(key);
		const result = await (await bucket()).info(key);
		if (result.error || !result.data) return null;
		return supabaseObjectMetadata(key, result.data);
	}

	return {
		async createSignedUpload(key) {
			safeKey(key);
			const result = await (await bucket()).createSignedUploadUrl(key, { upsert: false });
			if (
				result.error || !result.data?.token || !result.data.signedUrl ||
				!isAllowedSignedStorageUrl(result.data.signedUrl, url, allowLoopbackHttp)
			) throw unavailable();
			return { path: result.data.path || key, token: result.data.token, signedUrl: result.data.signedUrl };
		},
		async putStaged(key, bytes, contentType) {
			safeKey(key);
			if (!ARTIFACT_STORAGE_MIME_TYPES.includes(contentType as (typeof ARTIFACT_STORAGE_MIME_TYPES)[number])) {
				throw new ArtifactValidationError('mime_mismatch', 'artifact content type is unsupported');
			}
			if (bytes.byteLength < 1 || bytes.byteLength > ARTIFACT_MAX_ASSET_BYTES) {
				throw new ArtifactValidationError('asset_too_large', 'asset is too large');
			}
			const checksumSha256 = createHash('sha256').update(bytes).digest('hex');
			const result = await (await bucket()).upload(key, bytes, {
				contentType,
				upsert: false,
				metadata: { sha256: checksumSha256 }
			});
			if (result.error) throw unavailable();
			const stored = await info(key);
			if (!stored) throw unavailable();
			return { ...stored, bytes: bytes.byteLength, checksumSha256, contentType };
		},
		async stat(key, version) {
			const current = await info(key);
			return current && current.version === version ? current : null;
		},
		async statLatest(key) {
			return info(key);
		},
		async get(key, version) {
			const current = await info(key);
			if (!current || current.version !== version) throw new ArtifactValidationError('object_version_changed', 'uploaded object version changed');
			const result = await (await bucket()).download(key);
			if (result.error || !result.data) throw unavailable();
			return new Uint8Array(await result.data.arrayBuffer());
		},
		async remove(key) {
			safeKey(key);
			const result = await (await bucket()).remove([key]);
			if (result.error) throw unavailable();
		},
		async verifyPrivateBucket() {
			const result = await (await client()).storage.getBucket(bucketName);
			const allowed = [...(result.data?.allowed_mime_types ?? [])].sort();
			const expected = [...ARTIFACT_STORAGE_MIME_TYPES].sort();
			if (
				result.error || !result.data || result.data.public ||
				result.data.file_size_limit !== ARTIFACT_MAX_ASSET_BYTES ||
				allowed.length !== expected.length || allowed.some((value, index) => value !== expected[index])
			) throw unavailable();
		}
	};
}

export type ArtifactStorageMode = 'local' | 'supabase' | 'disabled';

/** Select local storage only when explicitly enabled; never silently fall
 * back to a filesystem path when production credentials are absent. */
export function artifactStorageMode(): ArtifactStorageMode {
	if (localArtifactStorageEnabled()) return 'local';
	if (
		env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY &&
		env.NEWSCRAFT_ARTIFACT_STORAGE_BUCKET === ARTIFACT_STORAGE_BUCKET
	) return 'supabase';
	return 'disabled';
}

export function createArtifactObjectStorage(): ArtifactObjectStorage {
	const mode = artifactStorageMode();
	if (mode === 'local') return createLocalArtifactStorage();
	if (mode === 'supabase') return createSupabaseArtifactStorage();
	throw unavailable();
}

export function maxBytesForRole(role: ArtifactAssetRole): number {
	return role === 'preview' ? ARTIFACT_MAX_PREVIEW_BYTES : ARTIFACT_MAX_ASSET_BYTES;
}

function allowedMagic(bytes: Uint8Array, mimeType: string): boolean {
	if (mimeType === 'image/png') return bytes.length >= 8 && bytes.slice(0, 8).every((byte, index) => byte === [137, 80, 78, 71, 13, 10, 26, 10][index]);
	if (mimeType === 'image/jpeg') return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
	if (mimeType === 'text/csv' || mimeType === 'text/markdown' || mimeType === 'application/json') return !bytes.slice(0, 1024).some((byte) => byte === 0);
	return false;
}

function pngDimensions(bytes: Uint8Array): { width: number; height: number } | null {
	if (bytes.length < 24 || !allowedMagic(bytes, 'image/png')) return null;
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const width = view.getUint32(16);
	const height = view.getUint32(20);
	if (!width || !height || width > 10_000 || height > 10_000) return null;
	return { width, height };
}

export interface VerifiedArtifactObject extends StoredArtifactObject {
	dimensions?: { width: number; height: number };
}

/**
 * Server-owned verification. This reads the object from storage, not from a
 * tenant workspace, and must run before the short metadata finalization tx.
 */
export async function verifyArtifactObject(
	storage: ArtifactObjectStorage,
	input: { key: string; version: string; allowedMime: string; maxBytes: number; exactBytes?: number | null; expectedSha256?: string | null; role?: ArtifactAssetRole }
): Promise<VerifiedArtifactObject> {
	const metadata = await storage.stat(input.key, input.version);
	if (!metadata) throw new ArtifactValidationError('object_missing', 'uploaded object is missing');
	const bytes = await storage.get(input.key, input.version);
	if (bytes.byteLength !== metadata.bytes || bytes.byteLength > input.maxBytes || (input.role === 'preview' && bytes.byteLength > ARTIFACT_MAX_PREVIEW_BYTES)) throw new ArtifactValidationError('asset_too_large', 'uploaded object exceeds its bound');
	if (input.exactBytes !== undefined && input.exactBytes !== null && bytes.byteLength !== input.exactBytes) throw new ArtifactValidationError('file_mismatch', 'uploaded object has the wrong length');
	const checksumSha256 = createHash('sha256').update(bytes).digest('hex');
	if (input.expectedSha256 && checksumSha256 !== input.expectedSha256) throw new ArtifactValidationError('file_mismatch', 'uploaded object checksum did not match');
	if (metadata.checksumSha256 && checksumSha256 !== metadata.checksumSha256) throw new ArtifactValidationError('file_mismatch', 'uploaded object checksum changed');
	if (!allowedMagic(bytes, input.allowedMime)) throw new ArtifactValidationError('mime_mismatch', 'uploaded object type did not match');
	const dimensions = input.allowedMime === 'image/png' ? pngDimensions(bytes) : undefined;
	if (input.allowedMime === 'image/png' && !dimensions) throw new ArtifactValidationError('image_invalid', 'PNG dimensions are invalid');
	return { ...metadata, bytes: bytes.byteLength, checksumSha256, ...(dimensions ? { dimensions } : {}) };
}

export function artifactStorageRoot(): string {
	return LOCAL_ROOT;
}
