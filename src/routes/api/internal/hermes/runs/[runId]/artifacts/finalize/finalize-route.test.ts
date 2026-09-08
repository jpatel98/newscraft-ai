import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
	class TestArtifactRepositoryError extends Error {
		code: 'not_found' | 'conflict' | 'stale' | 'invalid_input';
		constructor(code: 'not_found' | 'conflict' | 'stale' | 'invalid_input', message: string) {
			super(message);
			this.code = code;
		}
	}
	return {
		TestArtifactRepositoryError,
		getArtifactGrant: vi.fn(),
		getFinalizedArtifactForGrant: vi.fn(),
		getFinalizedArtifactObjectForGrant: vi.fn(),
		markArtifactFailed: vi.fn(),
		finalizeArtifactReady: vi.fn(),
		recordArtifactVerification: vi.fn(),
		getHermesRun: vi.fn(),
		verifyHermesRunCallback: vi.fn(),
		artifactStorageMode: vi.fn(),
		createArtifactObjectStorage: vi.fn()
	};
});

vi.mock('$lib/server/db/artifacts', () => ({
	ArtifactRepositoryError: mocks.TestArtifactRepositoryError,
	getArtifactGrant: mocks.getArtifactGrant,
	getFinalizedArtifactForGrant: mocks.getFinalizedArtifactForGrant,
	getFinalizedArtifactObjectForGrant: mocks.getFinalizedArtifactObjectForGrant,
	markArtifactFailed: mocks.markArtifactFailed,
	finalizeArtifactReady: mocks.finalizeArtifactReady,
	recordArtifactVerification: mocks.recordArtifactVerification
}));
vi.mock('$lib/server/db/hermes-runs', () => ({ getHermesRun: mocks.getHermesRun }));
vi.mock('$lib/server/hermes-durable', () => ({ verifyHermesRunCallback: mocks.verifyHermesRunCallback }));
vi.mock('$lib/server/artifacts/storage', async () => {
	const actual = await vi.importActual<typeof import('$lib/server/artifacts/storage')>('$lib/server/artifacts/storage');
	return {
		...actual,
		artifactStorageMode: mocks.artifactStorageMode,
		createArtifactObjectStorage: mocks.createArtifactObjectStorage
	};
});

import { POST } from './+server';

const grant = {
	id: 'grant-1',
	revisionId: 'revision-1',
	runId: 'run-1',
	role: 'source' as const,
	producerKey: 'hermes-publish-artifact',
	tokenHash: 'hash',
	stagingKey: 'staging/run-1/source.json',
	finalKey: 'artifacts/family-1/revision-1/source.json',
	uploadedObjectVersion: 'a'.repeat(32),
	allowedMime: 'application/json',
	maxBytes: 1024,
	exactBytes: null,
	expectedSha256: null,
	expiresAt: Date.now() + 60_000,
	state: 'uploaded' as const,
	createdAt: Date.now(),
	uploadedAt: Date.now(),
	consumedAt: null
};

const summary = { id: 'family-1', revisionId: 'revision-1', revision: 1, kind: 'chart' as const, title: 'A chart', status: 'ready' as const, sourceMessageId: 'message-1', createdAt: 1, updatedAt: 2, preview: null, error: null };
const bytes = new TextEncoder().encode('{"ok":true}');

function request() {
	return new Request('http://localhost/api/internal/hermes/runs/run-1/artifacts/finalize', {
		method: 'POST',
		body: JSON.stringify({ account_id: 'account-1', tenant_key: 'tenant-1', lease_owner: 'owner-1', lease_token: 'lease-1', grant_id: grant.id }),
		headers: { 'content-type': 'application/json' }
	});
}

function storage(remove: (key: string, version?: string) => Promise<void>) {
	return {
		stat: vi.fn().mockResolvedValue({ key: grant.stagingKey, version: grant.uploadedObjectVersion, bytes: bytes.byteLength, checksumSha256: '', contentType: 'application/json', path: grant.stagingKey }),
		get: vi.fn().mockResolvedValue(bytes),
		putStaged: vi.fn().mockResolvedValue({ key: grant.finalKey, version: 'b'.repeat(32), bytes: bytes.byteLength, checksumSha256: '', contentType: 'application/json', path: grant.finalKey }),
		remove,
		verifyPrivateBucket: vi.fn()
	};
}

function resetBase() {
	vi.clearAllMocks();
	mocks.verifyHermesRunCallback.mockReturnValue(true);
	mocks.artifactStorageMode.mockReturnValue('local');
	mocks.getHermesRun.mockResolvedValue({ id: 'run-1', tenantKey: 'tenant-1' });
	mocks.getArtifactGrant.mockResolvedValue(grant);
	mocks.recordArtifactVerification.mockResolvedValue(undefined);
	mocks.markArtifactFailed.mockResolvedValue(undefined);
	mocks.getFinalizedArtifactObjectForGrant.mockResolvedValue(null);
}

describe('artifact finalization cleanup', () => {
	it('retains the committed winner when staging cleanup is transiently unavailable', async () => {
		resetBase();
		const remove = vi.fn().mockRejectedValue(new Error('temporary storage delete failure'));
		const fakeStorage = storage(remove);
		mocks.createArtifactObjectStorage.mockReturnValue(fakeStorage);
		mocks.finalizeArtifactReady.mockResolvedValue(summary);

		const response = await POST({ params: { runId: 'run-1' }, request: request() } as never);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ artifact: summary });
		expect(mocks.finalizeArtifactReady).toHaveBeenCalledOnce();
		expect(remove).toHaveBeenCalledWith(grant.stagingKey, grant.uploadedObjectVersion);
		expect(remove).not.toHaveBeenCalledWith(grant.finalKey, 'b'.repeat(32));
	});

	it('cleans an unreferenced losing copy after another finalizer wins', async () => {
		resetBase();
		const remove = vi.fn().mockResolvedValue(undefined);
		const fakeStorage = storage(remove);
		mocks.createArtifactObjectStorage.mockReturnValue(fakeStorage);
		mocks.finalizeArtifactReady.mockRejectedValue(new mocks.TestArtifactRepositoryError('conflict', 'artifact asset is already finalized'));
		mocks.getArtifactGrant.mockResolvedValueOnce(grant).mockResolvedValueOnce({ ...grant, state: 'consumed' });
		mocks.getFinalizedArtifactObjectForGrant.mockResolvedValue({ artifact: summary, objectKey: grant.finalKey, objectVersion: 'c'.repeat(32) });

		const response = await POST({ params: { runId: 'run-1' }, request: request() } as never);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ artifact: summary });
		expect(remove).toHaveBeenCalledWith(grant.finalKey, 'b'.repeat(32));
		expect(remove).not.toHaveBeenCalledWith(grant.stagingKey, grant.uploadedObjectVersion);
	});

	it('preserves a copy when consumed state has no readable object identity', async () => {
		resetBase();
		const remove = vi.fn().mockResolvedValue(undefined);
		const fakeStorage = storage(remove);
		mocks.createArtifactObjectStorage.mockReturnValue(fakeStorage);
		mocks.finalizeArtifactReady.mockRejectedValue(new Error('database response was lost after commit'));
		mocks.getArtifactGrant.mockResolvedValueOnce(grant).mockResolvedValueOnce({ ...grant, state: 'consumed' });
		mocks.getFinalizedArtifactObjectForGrant.mockResolvedValue(null);

		const response = await POST({ params: { runId: 'run-1' }, request: request() } as never);
		expect(response.status).toBe(503);
		expect(remove).not.toHaveBeenCalled();
	});
});
