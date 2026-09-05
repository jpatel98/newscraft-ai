import { error, json, type RequestHandler } from '@sveltejs/kit';
import { getConversation } from '$lib/server/db/conversations';
import { listArtifactLibrary } from '$lib/server/db/artifacts';

function decodeCursor(value: string | null): { updatedAt: number; id: string } | null {
	if (!value) return null;
	try {
		const parsed = JSON.parse(Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4), 'base64').toString('utf8')) as { updatedAt?: unknown; id?: unknown };
		if (!Number.isSafeInteger(parsed.updatedAt) || typeof parsed.id !== 'string' || !parsed.id || parsed.id.length > 256) throw new Error('invalid');
		return { updatedAt: parsed.updatedAt as number, id: parsed.id };
	} catch {
		throw error(400, 'cursor is invalid');
	}
}

export const GET: RequestHandler = async ({ params, locals, url }) => {
	if (!locals.user) throw error(401, 'unauthorized');
	const conversationId = params.id?.trim();
	if (!conversationId) throw error(400, 'conversation id required');
	const conversation = await getConversation(locals.user.id, conversationId);
	if (!conversation) throw error(404, 'not found');
	const rawLimit = Number(url.searchParams.get('limit') || '30');
	const limit = Number.isSafeInteger(rawLimit) ? Math.min(Math.max(rawLimit, 1), 50) : 30;
	const result = await listArtifactLibrary(locals.user.id, conversationId, decodeCursor(url.searchParams.get('cursor')), limit);
	const nextCursor = result.nextCursor ? Buffer.from(JSON.stringify(result.nextCursor)).toString('base64url') : null;
	return json({ artifacts: result.artifacts, nextCursor }, { headers: { 'cache-control': 'private, no-store' } });
};
