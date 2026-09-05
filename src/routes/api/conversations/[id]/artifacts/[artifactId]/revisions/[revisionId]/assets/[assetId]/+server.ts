import { error, json, type RequestHandler } from '@sveltejs/kit';
import { getConversation } from '$lib/server/db/conversations';
import { getArtifactAssetOwner } from '$lib/server/db/artifacts';
import { createLocalArtifactStorage, localArtifactStorageEnabled } from '$lib/server/artifacts/storage';

export const GET: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) throw error(401, 'unauthorized');
	const conversationId = params.id?.trim();
	const artifactId = params.artifactId?.trim();
	const revisionId = params.revisionId?.trim();
	const assetId = params.assetId?.trim();
	if (!conversationId || !artifactId || !revisionId || !assetId) throw error(400, 'asset id required');
	const conversation = await getConversation(locals.user.id, conversationId);
	if (!conversation) throw error(404, 'not found');
	const asset = await getArtifactAssetOwner(locals.user.id, conversationId, artifactId, revisionId, assetId);
	if (!asset) throw error(404, 'not found');
	if (!localArtifactStorageEnabled()) return json({ detail: 'asset delivery is not enabled' }, { status: 503 });
	try {
		const bytes = await createLocalArtifactStorage().get(asset.key, asset.version);
		return new Response(bytes as unknown as BodyInit, {
			headers: {
				'content-type': asset.mimeType,
				'content-length': String(bytes.byteLength),
				'content-disposition': `${asset.mimeType.startsWith('image/') ? 'inline' : 'attachment'}; filename="${asset.filename.replaceAll('"', '')}"`,
				'cache-control': 'private, no-store'
			}
		});
	} catch {
		throw error(404, 'not found');
	}
};
