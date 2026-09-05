import { error, json, type RequestHandler } from '@sveltejs/kit';
import { localArtifactStorageEnabled } from '$lib/server/artifacts/storage';
import { createArtifactUploadGrant } from '$lib/server/db/artifacts';
import { getHermesRun } from '$lib/server/db/hermes-runs';
import { verifyHermesRunCallback } from '$lib/server/hermes-durable';

type GrantBody = {
	account_id?: string;
	tenant_key?: string;
	lease_owner?: string;
	lease_token?: string;
	revision_id?: string;
	role?: 'source' | 'preview' | 'data';
	allowed_mime?: string;
	max_bytes?: number;
	exact_bytes?: number | null;
	expected_sha256?: string | null;
};

const HERMES_ARTIFACT_PRODUCER_KEY = 'hermes-publish-artifact';

export const POST: RequestHandler = async ({ params, request, url }) => {
	if (!verifyHermesRunCallback(request)) return json({ detail: 'unauthorized' }, { status: 401 });
	// Only the local storage implementation is available in this service. Do
	// not advertise an unimplemented backend based on an environment flag.
	if (!localArtifactStorageEnabled()) {
		return json({ detail: 'artifact publication is disabled until a storage backend is approved' }, { status: 503 });
	}
	const runId = params.runId?.trim();
	if (!runId) throw error(400, 'run id required');
	let body: GrantBody;
	try {
		body = (await request.json()) as GrantBody;
	} catch {
		throw error(400, 'invalid json');
	}
	const accountId = body.account_id?.trim();
	const tenantKey = body.tenant_key?.trim();
	const leaseOwner = body.lease_owner?.trim();
	const leaseToken = body.lease_token?.trim();
	if (!accountId || !tenantKey || !leaseOwner || !leaseToken || !body.revision_id || !body.role || !body.allowed_mime) {
		throw error(400, 'grant fields are required');
	}
	const run = await getHermesRun(accountId, runId);
	if (!run || run.tenantKey !== tenantKey) throw error(404, 'run not found');
	try {
		const result = await createArtifactUploadGrant({
			accountId,
			revisionId: body.revision_id,
			runId,
			role: body.role,
			producerKey: HERMES_ARTIFACT_PRODUCER_KEY,
			lease: { tenantKey, leaseOwner, leaseToken },
			allowedMime: body.allowed_mime,
			maxBytes: body.max_bytes,
			exactBytes: body.exact_bytes,
			expectedSha256: body.expected_sha256
		});
		const uploadUrl = new URL(`/api/internal/artifacts/upload/${encodeURIComponent(result.grant.id)}`, url);
		uploadUrl.searchParams.set('token', result.token);
		return json({
			grant_id: result.grant.id,
			upload_url: uploadUrl.toString(),
			staging_key: result.grant.stagingKey,
			final_key: result.grant.finalKey,
			allowed_mime: result.grant.allowedMime,
			max_bytes: result.grant.maxBytes,
			expires_at: result.grant.expiresAt
		});
	} catch (cause) {
		if (cause instanceof Error && 'code' in cause) {
			const code = String((cause as { code?: unknown }).code);
			return json({ detail: cause.message, code }, { status: code === 'not_found' ? 404 : 409 });
		}
		throw cause;
	}
};
