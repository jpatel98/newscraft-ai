import { redirect, type RequestHandler } from '@sveltejs/kit';
import { SESSION_COOKIE_NAME, verifySessionCookie } from '$lib/server/auth/cookie';
import { revokeSession } from '$lib/server/db/sessions';

export const POST: RequestHandler = async ({ cookies }) => {
	const session = verifySessionCookie(cookies.get(SESSION_COOKIE_NAME));
	if (session) await revokeSession(session.sessionId, session.accountId);
	cookies.delete(SESSION_COOKIE_NAME, { path: '/' });
	throw redirect(303, '/login');
};
