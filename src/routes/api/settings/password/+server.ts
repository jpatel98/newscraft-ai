import { error, json, type RequestHandler } from '@sveltejs/kit';
import { setPassword, verifyPassword } from '$lib/server/auth/password';

interface Body {
	current?: string;
	new?: string;
}

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) throw error(401, 'unauthorized');

	let body: Body;
	try {
		body = (await request.json()) as Body;
	} catch {
		throw error(400, 'invalid json');
	}

	const current = String(body.current ?? '');
	const next = String(body.new ?? '');

	if (next.length < 8) throw error(400, 'new password must be at least 8 characters');
	if (next === current) throw error(400, 'new password must differ from current');

	const ok = await verifyPassword(current);
	if (!ok) throw error(401, 'current password is incorrect');

	await setPassword(next);
	return json({ ok: true });
};
