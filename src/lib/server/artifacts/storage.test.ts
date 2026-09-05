import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ArtifactValidationError } from './contracts';
import { verifyArtifactObject, type ArtifactObjectStorage, type StoredArtifactObject } from './storage';

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
