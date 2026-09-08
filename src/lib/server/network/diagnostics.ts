import net from 'node:net';

const DNS_HOSTNAME_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/iu;

export interface BoundedNetworkError {
	name: string;
	code: string | null;
	hostname: string | null;
}

/**
 * Return only bounded, non-sensitive fields from a network error. Some Node
 * fetch errors put the useful DNS code and hostname on `cause`, so inspect a
 * short cause chain without ever logging messages, URLs, headers, or bodies.
 */
export function boundedNetworkError(error: unknown, configuredHostname?: unknown): BoundedNetworkError {
	let name = 'unknown';
	let code: string | null = null;
	let hostname: string | null = null;
	const seen = new Set<object>();
	let current: unknown = error;

	for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth += 1) {
		if (seen.has(current)) break;
		seen.add(current);
		const value = current as {
			name?: unknown;
			code?: unknown;
			hostname?: unknown;
			cause?: unknown;
		};
		if (name === 'unknown' && typeof value.name === 'string') name = value.name.slice(0, 64);
		if (code === null && typeof value.code === 'string') code = value.code.slice(0, 32);
		if (hostname === null) hostname = safeNetworkHostname(value.hostname);
		current = value.cause;
	}

	return { name, code, hostname: hostname || safeNetworkHostname(configuredHostname) };
}

export function safeNetworkHostname(value: unknown): string | null {
	if (typeof value !== 'string') return null;
	const hostname = value.trim().replace(/^\[|\]$/gu, '').replace(/\.$/u, '').toLowerCase();
	if (!hostname || hostname.length > 253) return null;
	return net.isIP(hostname) > 0 || DNS_HOSTNAME_RE.test(hostname) ? hostname : null;
}
