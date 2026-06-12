import type { Handle } from '@sveltejs/kit';
import { redirect } from '@sveltejs/kit';
import { verifySessionCookie, SESSION_COOKIE_NAME } from '$lib/server/auth/cookie';
import { ensureMigrated } from '$lib/server/db';
import { accountCount, getAccount } from '$lib/server/db/accounts';

const PUBLIC_PATHS = new Set(['/login', '/signup', '/setup']);
// /api/e2e is only active when E2E_SECRET is set (dev/test only); it self-
// authenticates via the secret so it must be reachable without a session.
const PUBLIC_PREFIXES = ['/api/health', '/api/agent/channel-posts', '/account-setup', '/api/e2e'];

export const handle: Handle = async ({ event, resolve }) => {
	await ensureMigrated();
	const cookie = event.cookies.get(SESSION_COOKIE_NAME);
	const session = verifySessionCookie(cookie);
	const account = session ? await getAccount(session.accountId) : undefined;
	event.locals.user = account
		? { id: account.id, email: account.email, name: account.name, role: account.role }
		: null;

	const path = event.url.pathname;
	const isPublic = PUBLIC_PATHS.has(path) || PUBLIC_PREFIXES.some((p) => path.startsWith(p));
	const hasAccounts = (await accountCount()) > 0;

	if (
		!hasAccounts &&
		path !== '/setup' &&
		path !== '/signup' &&
		!PUBLIC_PREFIXES.some((p) => path.startsWith(p))
	) {
		throw redirect(303, '/setup');
	}
	if (hasAccounts && path === '/setup') {
		throw redirect(303, event.locals.user ? '/' : '/login');
	}

	if (!event.locals.user && !isPublic) {
		const dest = path === '/' ? '/' : path + event.url.search;
		throw redirect(303, `/login?next=${encodeURIComponent(dest)}`);
	}
	if (event.locals.user && (path === '/login' || path === '/signup')) {
		throw redirect(303, '/');
	}

	return resolve(event);
};
