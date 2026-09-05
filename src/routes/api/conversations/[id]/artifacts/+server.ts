import { error, json, type RequestHandler } from '@sveltejs/kit';
import { dev } from '$app/environment';
import { getConversation } from '$lib/server/db/conversations';
import {
	ArtifactRepositoryError,
	createArtifactRevision,
	getArtifactDetail,
	listArtifactSummariesForMessages,
	markInlineArtifactReady
} from '$lib/server/db/artifacts';
import { ArtifactValidationError, parseArtifactSpec } from '$lib/server/artifacts/contracts';
import { env } from '$env/dynamic/private';

const MAX_IDS = 100;

export const GET: RequestHandler = async ({ params, locals, url }) => {
	if (!locals.user) throw error(401, 'unauthorized');
	const conversationId = params.id?.trim();
	if (!conversationId) throw error(400, 'conversation id required');
	const conversation = await getConversation(locals.user.id, conversationId);
	if (!conversation) throw error(404, 'not found');
	const ids = [...url.searchParams.getAll('message_ids').flatMap((value) => value.split(',')), ...url.searchParams.getAll('message_id')]
		.map((id) => id.trim()).filter(Boolean).slice(0, MAX_IDS);
	const artifacts = await listArtifactSummariesForMessages(locals.user.id, conversationId, ids);
	return json({ artifacts, messageIds: ids }, { headers: { 'cache-control': 'private, no-store' } });
};

export const POST: RequestHandler = async ({ params, locals, request }) => {
	if (!locals.user) throw error(401, 'unauthorized');
	// Demo fixtures are an explicit local-only mode. Ordinary chat and even a
	// normal development server must never seed synthetic artifacts.
	if (!dev || env.NEWSCRAFT_ARTIFACT_DEMO !== '1') throw error(404, 'not found');
	const conversationId = params.id?.trim();
	if (!conversationId) throw error(400, 'conversation id required');
	const conversation = await getConversation(locals.user.id, conversationId);
	if (!conversation) throw error(404, 'not found');
	let body: { source_message_id?: string; spec?: unknown; title?: string };
	try {
		const parsed = await request.json();
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('body must be an object');
		body = parsed as typeof body;
	} catch {
		throw error(400, 'invalid json');
	}
	if (typeof body.source_message_id !== 'string' || !body.source_message_id.trim() || body.spec === undefined) {
		throw error(400, 'source_message_id and spec are required');
	}
	let spec;
	try {
		spec = parseArtifactSpec(body.spec);
	} catch (cause) {
		if (cause instanceof ArtifactValidationError) throw error(422, cause.message);
		throw cause;
	}
	const title = typeof body.title === 'string' && body.title.trim() ? body.title.trim() : spec.title;
	let created;
	try {
		created = await createArtifactRevision({
			accountId: locals.user.id,
			conversationId,
			sourceMessageId: body.source_message_id,
			kind: spec.kind,
			title,
			spec
		});
	} catch (cause) {
		if (cause instanceof ArtifactRepositoryError) {
			throw error(cause.code === 'not_found' ? 404 : 409, cause.message);
		}
		throw cause;
	}
	if (spec.kind !== 'image') await markInlineArtifactReady(locals.user.id, created.revision.id);
	const detail = await getArtifactDetail(locals.user.id, conversationId, created.family.id);
	return json({ artifact: detail }, { status: 201, headers: { 'cache-control': 'private, no-store' } });
};
