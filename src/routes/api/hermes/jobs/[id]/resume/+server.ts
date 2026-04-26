import { error, json, type RequestHandler } from '@sveltejs/kit';
import { runJobAction } from '$lib/server/hermes/board';

export const POST: RequestHandler = async ({ locals, params }) => {
	if (!locals.user) throw error(401, 'unauthorized');
	try {
		const job = await runJobAction(params.id ?? '', 'resume');
		return json({ ok: true, job });
	} catch (err) {
		throw error(502, err instanceof Error ? err.message : String(err));
	}
};
