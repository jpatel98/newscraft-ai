import type { Handle } from '@sveltejs/kit';
import { redirect } from '@sveltejs/kit';
import { verifySessionCookie, SESSION_COOKIE_NAME } from '$lib/server/auth/cookie';
import { ensureMigrated } from '$lib/server/db';

ensureMigrated();

const PUBLIC_PATHS = new Set(['/login']);
const PUBLIC_PREFIXES = ['/api/health'];

export const handle: Handle = async ({ event, resolve }) => {
	const cookie = event.cookies.get(SESSION_COOKIE_NAME);
	const authed = verifySessionCookie(cookie);
	event.locals.user = authed ? { authed: true } : null;

	const path = event.url.pathname;
	const isPublic = PUBLIC_PATHS.has(path) || PUBLIC_PREFIXES.some((p) => path.startsWith(p));

	if (!authed && !isPublic) {
		const dest = path === '/' ? '/' : path + event.url.search;
		throw redirect(303, `/login?next=${encodeURIComponent(dest)}`);
	}
	if (authed && path === '/login') {
		throw redirect(303, '/');
	}

	return resolve(event);
};
