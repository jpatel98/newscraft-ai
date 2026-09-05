import { json, type RequestHandler } from '@sveltejs/kit';
import { getHermesRun } from '$lib/server/db/hermes-runs';
import { verifyHermesRunCallback } from '$lib/server/hermes-durable';
import { createArtifactRevisionForRun, getArtifactDetail } from '$lib/server/db/artifacts';
import { parseArtifactSpec } from '$lib/server/artifacts/contracts';

type RevisionBody = {
	account_id?: string;
	tenant_key?: string;
	lease_owner?: string;
	lease_token?: string;
	title?: string;
	spec?: unknown;
};

/** Server-issued artifact identity for the active durable Hermes run. */
export const POST: RequestHandler = async ({ params, request }) => {
	if (!verifyHermesRunCallback(request)) return json({ detail: 'unauthorized' }, { status: 401 });
	const runId = params.runId?.trim();
	if (!runId) return json({ detail: 'run id required' }, { status: 400 });
	let body: RevisionBody;
	try {
		body = (await request.json()) as RevisionBody;
	} catch {
		return json({ detail: 'invalid json' }, { status: 400 });
	}
	const accountId = body.account_id?.trim();
	const tenantKey = body.tenant_key?.trim();
	const leaseOwner = body.lease_owner?.trim();
	const leaseToken = body.lease_token?.trim();
	if (!accountId || !tenantKey || !leaseOwner || !leaseToken || body.spec === undefined) {
		return json({ detail: 'revision fields are required' }, { status: 400 });
	}
	try {
		// This read gives callers a stable 404 for an account/tenant mismatch;
		// createArtifactRevisionForRun repeats the binding inside its transaction.
		const run = await getHermesRun(accountId, runId);
		if (!run || run.tenantKey !== tenantKey) return json({ detail: 'run not found' }, { status: 404 });
		const spec = parseArtifactSpec(body.spec);
		const created = await createArtifactRevisionForRun({
			accountId,
			runId,
			tenantKey,
			leaseOwner,
			leaseToken,
			title: body.title,
			spec,
			readyInline: spec.kind !== 'image'
		});
		const artifact = await getArtifactDetail(accountId, created.family.conversationId, created.family.id, created.revision.id);
		return json({
			revision_id: created.revision.id,
			family_id: created.family.id,
			artifact
		}, { status: 201, headers: { 'cache-control': 'no-store' } });
	} catch (cause) {
		if (cause instanceof Error && 'code' in cause) {
			const code = String((cause as { code?: unknown }).code);
			return json({ detail: cause.message, code }, { status: code === 'not_found' ? 404 : 409 });
		}
		return json({ detail: 'artifact revision could not be created' }, { status: 422 });
	}
};
