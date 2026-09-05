import { error, json, type RequestHandler } from '@sveltejs/kit';
import { getConversation } from '$lib/server/db/conversations';
import { getArtifactDetail } from '$lib/server/db/artifacts';

export const GET: RequestHandler = async ({ params, locals, url }) => {
	if (!locals.user) throw error(401, 'unauthorized');
	const conversationId = params.id?.trim();
	const artifactId = params.artifactId?.trim();
	if (!conversationId || !artifactId) throw error(400, 'artifact id required');
	const conversation = await getConversation(locals.user.id, conversationId);
	if (!conversation) throw error(404, 'not found');
	const detail = await getArtifactDetail(locals.user.id, conversationId, artifactId, url.searchParams.get('revision_id'));
	if (!detail) throw error(404, 'not found');
	return json({ artifact: detail }, { headers: { 'cache-control': 'private, no-store' } });
};
