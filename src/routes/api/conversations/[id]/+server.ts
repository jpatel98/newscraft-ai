import { error, json, type RequestHandler } from '@sveltejs/kit';
import {
	deleteConversation,
	getConversation,
	renameConversation,
	setConversationPinned,
	setConversationSystemPrompt
} from '$lib/server/db/conversations';

const MAX_SYSTEM_PROMPT_CHARS = 8000;

interface PatchBody {
	title?: string;
	pinned?: 0 | 1;
	systemPrompt?: string | null;
}

export const PATCH: RequestHandler = async ({ params, request, locals }) => {
	if (!locals.user) throw error(401, 'unauthorized');
	const id = params.id;
	if (!id) throw error(400, 'id required');

	const existing = await getConversation(locals.user.id, id);
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
		row = (await renameConversation(locals.user.id, id, trimmed)) ?? row;
	}

	if (body.pinned !== undefined) {
		const next = body.pinned ? 1 : 0;
		row = (await setConversationPinned(locals.user.id, id, next)) ?? row;
	}

	if (body.systemPrompt !== undefined) {
		const raw = body.systemPrompt;
		if (raw !== null && typeof raw !== 'string') {
			throw error(400, 'systemPrompt must be string or null');
		}
		const nextPrompt = typeof raw === 'string' ? raw.trim() || null : raw;
		if (typeof nextPrompt === 'string' && nextPrompt.length > MAX_SYSTEM_PROMPT_CHARS) {
			throw error(400, `systemPrompt must be ≤ ${MAX_SYSTEM_PROMPT_CHARS} chars`);
		}
		row = (await setConversationSystemPrompt(locals.user.id, id, nextPrompt)) ?? row;
	}

	return json({
		id: row.id,
		title: row.title,
		pinned: row.pinned,
		systemPrompt: row.systemPrompt,
		updatedAt: row.updatedAt
	});
};

export const DELETE: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) throw error(401, 'unauthorized');
	const id = params.id;
	if (!id) throw error(400, 'id required');
	const existing = await getConversation(locals.user.id, id);
	if (!existing) throw error(404, 'not found');
	await deleteConversation(locals.user.id, id);
	return json({ ok: true });
};
