import { json, type RequestHandler } from '@sveltejs/kit';
import { getArtifactGrantByToken, markArtifactGrantUploadedForToken } from '$lib/server/db/artifacts';
import { createLocalArtifactStorage, localArtifactStorageEnabled } from '$lib/server/artifacts/storage';

const MAX_BODY_BYTES = 20 * 1024 * 1024;

async function readBoundedBody(request: Request, maxBytes: number): Promise<Uint8Array> {
	if (!request.body) return new Uint8Array();
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		while (true) {
			const next = await reader.read();
			if (next.done) break;
			const chunk = next.value;
			total += chunk.byteLength;
			if (total > maxBytes) throw new Error('body too large');
			chunks.push(chunk);
		}
	} finally {
		reader.releaseLock();
	}
	const result = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		result.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return result;
}

export const PUT: RequestHandler = async ({ params, request, url }) => {
	if (!localArtifactStorageEnabled()) return json({ detail: 'local artifact storage is disabled' }, { status: 503 });
	const grantId = params.grantId?.trim();
	const token = url.searchParams.get('token')?.trim();
	if (!grantId || !token) return json({ detail: 'grant token is required' }, { status: 401 });
	const grant = await getArtifactGrantByToken(grantId, token);
	if (!grant) return json({ detail: 'grant not found' }, { status: 404 });
	if (grant.expiresAt <= Date.now() || grant.state !== 'issued') return json({ detail: 'grant is expired or already consumed' }, { status: 409 });
	const contentType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
	if (!contentType || contentType !== grant.allowedMime) return json({ detail: 'content type does not match grant' }, { status: 415 });
	const rawLength = request.headers.get('content-length');
	const declaredLength = rawLength === null ? null : Number(rawLength);
	if (
		declaredLength !== null &&
		(!Number.isSafeInteger(declaredLength) || declaredLength < 0 || declaredLength > grant.maxBytes ||
			(grant.exactBytes !== null && declaredLength !== grant.exactBytes))
	) {
		return json({ detail: 'content length is outside the grant bound' }, { status: 413 });
	}
	let bytes: Uint8Array;
	try {
		bytes = await readBoundedBody(request, Math.min(grant.maxBytes, MAX_BODY_BYTES));
	} catch {
		return json({ detail: 'upload exceeds the grant bound' }, { status: 413 });
	}
	if (grant.exactBytes !== null && bytes.byteLength !== grant.exactBytes) return json({ detail: 'uploaded byte count does not match grant' }, { status: 422 });
	try {
		const stored = await createLocalArtifactStorage().putStaged(grant.stagingKey, bytes, contentType);
		const accepted = await markArtifactGrantUploadedForToken(grant.id, token, grant.stagingKey, stored.version);
		if (!accepted) {
			await createLocalArtifactStorage().remove(grant.stagingKey, stored.version);
			return json({ detail: 'grant was refreshed or already consumed' }, { status: 409 });
		}
		return json({ grant_id: grant.id, object_version: stored.version, bytes: stored.bytes });
	} catch {
		return json({ detail: 'artifact upload failed' }, { status: 503 });
	}
};
