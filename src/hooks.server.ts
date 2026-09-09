import type { Handle } from '@sveltejs/kit';
import { redirect } from '@sveltejs/kit';
import { verifySessionCookie, SESSION_COOKIE_NAME } from '$lib/server/auth/cookie';
import { accountCount } from '$lib/server/db/accounts';
import { getActiveSessionAccount } from '$lib/server/db/sessions';
import { newId } from '$lib/utils/id';

const PUBLIC_PATHS = new Set(['/login', '/signup', '/setup']);
// /api/e2e is only active when E2E_SECRET is set (dev/test only); it self-
// authenticates via the secret so it must be reachable without a session.
const PUBLIC_PREFIXES = [
	'/api/health',
	'/api/agent/channel-posts',
	'/api/internal/hermes/runs',
	'/api/internal/artifacts/upload',
	'/account-setup',
	'/api/e2e'
];
let knownHasAccounts = false;
let accountCountInFlight: Promise<number> | null = null;
const MARKETING_HOSTS = new Set(['newscraftai.com', 'www.newscraftai.com']);

async function hasAnyAccounts(): Promise<boolean> {
	if (knownHasAccounts) return true;
	// Several unauthenticated browser requests can arrive together on a fresh
	// process (health, login, static data). Share the first count query instead
	// of queueing one database read per request.
	accountCountInFlight ??= accountCount().finally(() => {
		accountCountInFlight = null;
	});
	const count = await accountCountInFlight;
	if (count > 0) knownHasAccounts = true;
	return count > 0;
}

function hostnameWithoutPort(host: string): string {
	return host.toLowerCase().replace(/:\d+$/, '');
}

function isMarketingHost(host: string): boolean {
	return MARKETING_HOSTS.has(hostnameWithoutPort(host));
}

export const handle: Handle = async ({ event, resolve }) => {
	// The browser may replay or forge request headers. Generate the correlation
	// id at the authenticated NewsCraft boundary and pass it downstream only
	// through server-owned state.
	const traceId = newId();
	event.locals.traceId = traceId;
	event.locals.isMarketingHost = isMarketingHost(event.url.host);
	const cookie = event.cookies.get(SESSION_COOKIE_NAME);
	const session = verifySessionCookie(cookie);
	const authenticated = session
		? await getActiveSessionAccount(session.sessionId, session.accountId)
		: null;
	if (cookie && !authenticated) {
		event.cookies.delete(SESSION_COOKIE_NAME, { path: '/' });
	}
	const account = authenticated?.account;
	event.locals.user = account
		? { id: account.id, email: account.email, name: account.name, role: account.role }
		: null;

	const path = event.url.pathname;
	const isMarketingHome = event.locals.isMarketingHost && path === '/';
	const isPublic = isMarketingHome || PUBLIC_PATHS.has(path) || PUBLIC_PREFIXES.some((p) => path.startsWith(p));
	// A valid session already proves that at least one account exists. This
	// avoids an extra account-count query on the first authenticated request.
	const hasAccounts = event.locals.user ? true : await hasAnyAccounts();
	if (event.locals.user) knownHasAccounts = true;

	if (
		!hasAccounts &&
		!isMarketingHome &&
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

	const response = await resolve(event);
	response.headers.set('x-trace-id', traceId);
	return response;
};
