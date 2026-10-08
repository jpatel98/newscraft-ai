import { error, json, type RequestHandler } from '@sveltejs/kit';
import { authBackend } from '$lib/server/auth/backend';
import { checkRateLimit } from '$lib/server/rate-limit';
export const POST: RequestHandler = async ({ request, locals, cookies }) => {
    if (!locals.user) throw error(401, 'unauthorized');
    if (!checkRateLimit(`password:${locals.user.id}`, { limit: 5, windowMs: 600_000 }).allowed) throw error(429, 'Try again later.');
    let body;
    try { body = await request.json(); } catch { throw error(400, 'invalid json'); }
    const current = String(body?.current ?? '');
    const next = String(body?.new ?? '');
    if (next.length < 8 || next === current) throw error(400, 'Choose a different password with at least 8 characters.');
    await (await authBackend()).changePassword(locals.user, current, next, cookies);
    return json({ ok: true });
};
