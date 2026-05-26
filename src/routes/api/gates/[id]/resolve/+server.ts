import { error, json, type RequestHandler } from '@sveltejs/kit';
import { resolveEditorialGate } from '$lib/server/agent/gates';

export const POST: RequestHandler = async ({ locals, params, request }) => {
	if (!locals.user) throw error(401, 'unauthorized');
	const id = params.id?.trim();
	if (!id) throw error(400, 'gate id is required');
	const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
	const action = typeof body?.action === 'string' ? body.action.trim() : '';
	const notes = typeof body?.notes === 'string' ? body.notes.trim() : null;
	if (!action) throw error(400, 'gate action is required');

	try {
		return json({ ok: true, ...(await resolveEditorialGate(locals.user.id, id, { action, notes })) });
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (/not found/i.test(message)) throw error(404, 'Gate not found');
		throw error(502, message);
	}
};
