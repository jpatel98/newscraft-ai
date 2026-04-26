import { error, json, type RequestHandler } from '@sveltejs/kit';
import {
	deleteConversation,
	getConversation,
	renameConversation,
	setConversationPinned
} from '$lib/server/db/conversations';

interface PatchBody {
	title?: string;
	pinned?: 0 | 1;
}

export const PATCH: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.user) throw error(401, 'unauthorized');
	const id = params.id;
	if (!id) throw error(400, 'id required');

	const existing = getConversation(id);
	if (!existing) throw error(404, 'not found');

	let body: PatchBody;
	try {
		body = (await request.json()) as PatchBody;
	} catch {
		throw error(400, 'invalid json');
	}

	let row = existing;

	if (body.title !== undefined) {
		const trimmed = String(body.title).trim();
		if (trimmed.length < 1 || trimmed.length > 200) {
			throw error(400, 'title must be 1..200 chars');
		}
		row = renameConversation(id, trimmed) ?? row;
	}

	if (body.pinned !== undefined) {
		const next = body.pinned ? 1 : 0;
		row = setConversationPinned(id, next) ?? row;
	}

	return json({
		id: row.id,
		title: row.title,
		pinned: row.pinned,
		updatedAt: row.updatedAt
	});
};

export const DELETE: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) throw error(401, 'unauthorized');
	const id = params.id;
	if (!id) throw error(400, 'id required');
	const existing = getConversation(id);
	if (!existing) throw error(404, 'not found');
	deleteConversation(id);
	return json({ ok: true });
};
