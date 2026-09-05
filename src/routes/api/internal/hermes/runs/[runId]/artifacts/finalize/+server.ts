import { json, type RequestHandler } from '@sveltejs/kit';
import { verifyHermesRunCallback } from '$lib/server/hermes-durable';
import {
	ArtifactRepositoryError,
	getArtifactGrant,
	getFinalizedArtifactForGrant,
	markArtifactFailed,
	finalizeArtifactReady,
	recordArtifactVerification
} from '$lib/server/db/artifacts';
import { ArtifactValidationError } from '$lib/server/artifacts/contracts';
import {
	createLocalArtifactStorage,
	verifyArtifactObject,
	localArtifactStorageEnabled
} from '$lib/server/artifacts/storage';
import { getHermesRun } from '$lib/server/db/hermes-runs';

type FinalizeBody = {
	account_id?: string;
	tenant_key?: string;
	lease_owner?: string;
	lease_token?: string;
	grant_id?: string;
};

export const POST: RequestHandler = async ({ params, request }) => {
	if (!verifyHermesRunCallback(request)) return json({ detail: 'unauthorized' }, { status: 401 });
	if (!localArtifactStorageEnabled()) return json({ detail: 'local artifact storage is disabled' }, { status: 503 });
	const runId = params.runId?.trim();
	if (!runId) return json({ detail: 'run id required' }, { status: 400 });
	let body: FinalizeBody;
	try {
		body = (await request.json()) as FinalizeBody;
	} catch {
		return json({ detail: 'invalid json' }, { status: 400 });
	}
	const accountId = body.account_id?.trim();
	const tenantKey = body.tenant_key?.trim();
	const leaseOwner = body.lease_owner?.trim();
	const leaseToken = body.lease_token?.trim();
	const grantId = body.grant_id?.trim();
	if (!accountId || !tenantKey || !leaseOwner || !leaseToken || !grantId) {
		return json({ detail: 'finalize fields are required' }, { status: 400 });
	}
	const run = await getHermesRun(accountId, runId);
	if (!run || run.tenantKey !== tenantKey) return json({ detail: 'run not found' }, { status: 404 });
	const grant = await getArtifactGrant(accountId, grantId);
	if (!grant || grant.runId !== runId) return json({ detail: 'uploaded grant not found' }, { status: 404 });
	const lease = { runId, tenantKey, leaseOwner, leaseToken };
	if (grant.state === 'consumed') {
		try {
			const artifact = await getFinalizedArtifactForGrant(accountId, grantId, lease);
			if (artifact) return json({ artifact });
			return json({ detail: 'artifact grant has no finalized asset' }, { status: 409 });
		} catch (cause) {
			if (cause instanceof ArtifactRepositoryError) {
				return json(
					{ detail: cause.message, code: cause.code },
					{ status: cause.code === 'not_found' ? 404 : 409 }
				);
			}
			throw cause;
		}
	}
	if (!grant.uploadedObjectVersion) return json({ detail: 'uploaded grant not found' }, { status: 404 });

	const storage = createLocalArtifactStorage();
	let copiedObject: { key: string; version: string } | null = null;
	try {
		const staged = await verifyArtifactObject(storage, {
			key: grant.stagingKey,
			version: grant.uploadedObjectVersion,
			allowedMime: grant.allowedMime,
			maxBytes: grant.maxBytes,
			exactBytes: grant.exactBytes,
			expectedSha256: grant.expectedSha256,
			role: grant.role
		});
		await recordArtifactVerification({
			grantId,
			verified: true,
			objectKey: grant.stagingKey,
			objectVersion: grant.uploadedObjectVersion,
			result: staged
		});
		const bytes = await storage.get(grant.stagingKey, grant.uploadedObjectVersion);
		const finalObject = await storage.putStaged(grant.finalKey, bytes, staged.contentType);
		copiedObject = { key: finalObject.key, version: finalObject.version };
		const verified = await verifyArtifactObject(storage, {
			key: grant.finalKey,
			version: finalObject.version,
			allowedMime: grant.allowedMime,
			maxBytes: grant.maxBytes,
			exactBytes: grant.exactBytes,
			expectedSha256: grant.expectedSha256,
			role: grant.role
		});
		const summary = await finalizeArtifactReady({
			accountId,
			grantId,
			objectKey: grant.finalKey,
			objectVersion: finalObject.version,
			verified,
			lease
		});
		await storage.remove(grant.stagingKey, grant.uploadedObjectVersion);
		return json({ artifact: summary });
	} catch (cause) {
		const message = cause instanceof Error ? cause.message : 'artifact finalization failed';
		// Another finalizer may have won the grant lock and removed the staging
		// object while this request was verifying it. A consumed grant with its
		// immutable asset is an idempotent success; discard our unreferenced copy.
		const latestGrant = await getArtifactGrant(accountId, grantId).catch(() => null);
		if (latestGrant?.runId === runId && latestGrant.state === 'consumed') {
			const artifact = await getFinalizedArtifactForGrant(accountId, grantId, lease).catch(() => null);
			if (artifact) {
				if (copiedObject) await storage.remove(copiedObject.key, copiedObject.version).catch(() => undefined);
				return json({ artifact });
			}
		}
		if (copiedObject) await storage.remove(copiedObject.key, copiedObject.version).catch(() => undefined);
		if (cause instanceof ArtifactRepositoryError) {
			// Do not delete the staged generation or mark the revision failed for a
			// lease/cancellation/turnover race. The current lease may retry it.
			return json({ detail: message, code: cause.code }, { status: cause.code === 'not_found' ? 404 : 409 });
		}
		if (cause instanceof ArtifactValidationError) {
			// Only a verifier rejection closes this publication generation. Database
			// and object-store failures remain retryable by the current run.
			await storage.remove(grant.stagingKey, grant.uploadedObjectVersion).catch(() => undefined);
			await recordArtifactVerification({
				grantId,
				verified: false,
				objectKey: grant.stagingKey,
				objectVersion: grant.uploadedObjectVersion,
				reasonCode: cause.code
			}).catch(() => undefined);
			await markArtifactFailed(
				accountId,
				grant.revisionId,
				'verification_failed',
				'The artifact could not be verified.',
				Date.now(),
				{
					grantId,
					stagingKey: grant.stagingKey,
					uploadedObjectVersion: grant.uploadedObjectVersion
				}
			).catch(() => undefined);
			return json({ detail: message }, { status: 422 });
		}
		return json({ detail: 'artifact finalization is temporarily unavailable' }, { status: 503 });
	}
};
