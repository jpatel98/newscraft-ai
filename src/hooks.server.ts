import type { Handle } from '@sveltejs/kit';
import { redirect } from '@sveltejs/kit';
import { authenticateRequest } from '$lib/server/auth/backend';
import { newId } from '$lib/utils/id';
import { measureRequest, serverTimingHeader } from '$lib/server/request-timing';

const PUBLIC_PATHS = new Set(['/login', '/signup', '/setup', '/auth/callback']);
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
const MARKETING_HOSTS = new Set(['newscraftai.com', 'www.newscraftai.com']);

function hostnameWithoutPort(host: string): string {
	return host.toLowerCase().replace(/:\d+$/, '');
}

function isMarketingHost(host: string): boolean {
	return MARKETING_HOSTS.has(hostnameWithoutPort(host));
}

export const handle: Handle = async ({ event, resolve }) => {
	const requestStart = performance.now();
	// Instrument the chat page and its SvelteKit data request only. The header
	// is emitted after authentication and contains fixed labels and durations.
	if (event.route.id === '/c/[id]') event.locals.requestTimings = [];
	// The browser may replay or forge request headers. Generate the correlation
	// id at the authenticated NewsCraft boundary and pass it downstream only
	// through server-owned state.
	const traceId = newId();
	event.locals.traceId = traceId;
	event.locals.isMarketingHost = isMarketingHost(event.url.host);
	event.locals.user = await measureRequest(event.locals, 'auth', () => authenticateRequest(event.cookies));

	const path = event.url.pathname;
	const isMarketingHome = event.locals.isMarketingHost && path === '/';
	const isPublic = isMarketingHome || PUBLIC_PATHS.has(path) || PUBLIC_PREFIXES.some((p) => path.startsWith(p));

	if (!event.locals.user && !isPublic) {
		const dest = path === '/' ? '/' : path + event.url.search;
		throw redirect(303, `/login?next=${encodeURIComponent(dest)}`);
	}
	if (event.locals.user && (path === '/login' || path === '/signup')) {
		throw redirect(303, '/');
	}

	const response = await measureRequest(event.locals, 'resolve', () => resolve(event));
	if (event.locals.user || path.startsWith('/auth') || PUBLIC_PATHS.has(path)) {
		response.headers.set('cache-control', 'private, no-store');
	}
	response.headers.set('x-trace-id', traceId);
	if (event.locals.user && event.locals.requestTimings) {
		event.locals.requestTimings.push({ name: 'total', duration: performance.now() - requestStart });
		response.headers.append('server-timing', serverTimingHeader(event.locals.requestTimings));
	}
	return response;
};
