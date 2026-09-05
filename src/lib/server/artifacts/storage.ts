import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { env } from '$env/dynamic/private';
import { dev } from '$app/environment';
import {
	ARTIFACT_MAX_ASSET_BYTES,
	ARTIFACT_MAX_PREVIEW_BYTES,
	ArtifactValidationError,
	type ArtifactAssetRole
} from './contracts';

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
	if (checksumSha256 !== metadata.checksumSha256) throw new ArtifactValidationError('file_mismatch', 'uploaded object checksum changed');
	if (!allowedMagic(bytes, input.allowedMime)) throw new ArtifactValidationError('mime_mismatch', 'uploaded object type did not match');
	const dimensions = input.allowedMime === 'image/png' ? pngDimensions(bytes) : undefined;
	if (input.allowedMime === 'image/png' && !dimensions) throw new ArtifactValidationError('image_invalid', 'PNG dimensions are invalid');
	return { ...metadata, bytes: bytes.byteLength, checksumSha256, ...(dimensions ? { dimensions } : {}) };
}

export function artifactStorageRoot(): string {
	return LOCAL_ROOT;
}
