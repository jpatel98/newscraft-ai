import dns from 'node:dns/promises';
import net from 'node:net';

/**
 * Keep the socket hook bounded independently of postgres.js. postgres.js starts
 * its own connect timer only after an async `socket` hook has resolved.
 */
export const DEFAULT_DATABASE_SOCKET_TIMEOUT_MS = 10_000;
export const FALLBACK_DNS_TIMEOUT_MS = 1_500;
export const FALLBACK_DNS_TRIES = 1;
export const FALLBACK_DNS_SERVERS = ['1.1.1.1', '8.8.8.8'] as const;
const RESOLVER_LOOKUP_ERROR_CODES = new Set([
	'ENOTFOUND',
	'EAI_AGAIN',
	'EAI_FAIL',
	'ENODATA',
	'ESERVFAIL',
	'ECONNREFUSED',
	'ETIMEOUT'
]);

export interface DatabaseEndpoint {
	hostname: string;
	port: number;
}

export interface DatabaseSocket extends net.Socket {
	/** Original database hostname, used by postgres.js for TLS SNI. */
	host?: string;
	/** Original database port, retained for diagnostics. */
	port?: number;
}

export interface ResolverLike {
	resolve4(hostname: string): Promise<string[]>;
	setServers(servers: string[]): void;
	cancel?(): void;
}

export interface DatabaseSocketFactoryOptions {
	/** Optional cap for the complete socket hook, including DNS fallback. */
	timeoutMs?: number;
	/** Dependency seams keep DNS/socket behavior deterministic in tests. */
	connect?: (hostname: string, port: number, timeoutMs: number) => Promise<net.Socket>;
	resolve4?: (hostname: string) => Promise<string[]>;
	createResolver?: () => ResolverLike;
	now?: () => number;
}

export interface ParsedDatabaseUrl extends DatabaseEndpoint {
	strictTls: boolean;
	directTls: boolean;
}

type PostgresSocketOptions = { connect_timeout?: unknown };

/**
 * Parse only the endpoint metadata needed by the socket hook. Credentials and
 * query parameters are intentionally not returned from this function.
 */
export function parseDatabaseUrl(value: string | undefined): ParsedDatabaseUrl | null {
	if (!value) return null;
	try {
		const url = new URL(value);
		if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') return null;
		const hostname = url.hostname.replace(/^\[|\]$/g, '');
		if (!hostname) return null;
		const port = url.port ? Number.parseInt(url.port, 10) : 5432;
		if (!Number.isInteger(port) || port < 1 || port > 65_535) return null;
		const sslMode = url.searchParams.get('sslmode');
		const directTls = url.searchParams.get('sslnegotiation') === 'direct';
		return { hostname, port, strictTls: sslMode === 'verify-full', directTls };
	} catch {
		return null;
	}
}

/**
 * Create the postgres.js async socket hook for one database endpoint.
 *
 * The first attempt uses the configured hostname. A TCP retry is allowed only
 * after ENOTFOUND/EAI_AGAIN; it resolves A records and connects to those
 * addresses while retaining the original hostname on the returned socket so
 * postgres.js performs certificate validation against the database hostname.
 */
export function createDatabaseSocketFactory(
	endpoint: DatabaseEndpoint,
	options: DatabaseSocketFactoryOptions = {}
): (postgresOptions?: PostgresSocketOptions) => Promise<DatabaseSocket> {
	const connect = options.connect ?? ((hostname, port, timeoutMs) => connectWithTimeout(hostname, port, timeoutMs));
	const resolve4 = options.resolve4 ?? ((hostname) => dns.resolve4(hostname));
	const createResolver =
		options.createResolver ??
		(() => new dns.Resolver({ timeout: FALLBACK_DNS_TIMEOUT_MS, tries: FALLBACK_DNS_TRIES }));
	const now = options.now ?? Date.now;
	const configuredTimeoutMs = normalizeTimeout(options.timeoutMs, DEFAULT_DATABASE_SOCKET_TIMEOUT_MS);

	return async (postgresOptions = {}) => {
		const timeoutMs = resolveFactoryTimeout(postgresOptions.connect_timeout, configuredTimeoutMs);
		const deadline = now() + timeoutMs;

		try {
			const timeout = remaining(deadline, now);
			if (timeout <= 0) throw socketTimeoutError(endpoint.hostname, timeoutMs);
			return markSocket(await connect(endpoint.hostname, endpoint.port, timeout), endpoint);
		} catch (error) {
			if (!isDnsLookupError(error)) throw error;

			const addresses = await resolveAddresses(endpoint.hostname, deadline, {
				resolve4,
				createResolver,
				now
			});
			let lastError: unknown = error;
			for (const address of uniqueIpv4(addresses)) {
				const timeout = remaining(deadline, now);
				if (timeout <= 0) throw socketTimeoutError(endpoint.hostname, timeoutMs);
				try {
					return markSocket(await connect(address, endpoint.port, timeout), endpoint);
				} catch (fallbackError) {
					lastError = fallbackError;
					if (isSocketTimeoutError(fallbackError)) throw fallbackError;
				}
			}
			throw lastError;
		}
	};
}

/**
 * Connect a TCP socket with a timeout owned by this module. This is exported
 * for deterministic tests of timeout cleanup; production callers use the
 * default connector through createDatabaseSocketFactory.
 */
export function connectWithTimeout(
	hostname: string,
	port: number,
	timeoutMs: number,
	createConnection: (options: { host: string; port: number }) => net.Socket = ({ host, port: socketPort }) =>
		net.connect({ host, port: socketPort })
): Promise<net.Socket> {
	const timeout = normalizeTimeout(timeoutMs, DEFAULT_DATABASE_SOCKET_TIMEOUT_MS);
	return new Promise((resolve, reject) => {
		let socket: net.Socket;
		try {
			socket = createConnection({ host: hostname, port });
		} catch (error) {
			reject(error);
			return;
		}

		let settled = false;
		const onConnect = () => {
			if (settled) return;
			settled = true;
			socket.removeListener('error', onError);
			socket.removeListener('connect', onConnect);
			socket.setTimeout(0);
			resolve(socket);
		};
		const onError = (error: Error) => {
			fail(error);
		};
		const fail = (error: Error) => {
			if (settled) return;
			settled = true;
			socket.removeListener('connect', onConnect);
			socket.setTimeout(0);
			// Keep the error listener until close so destroy() cannot surface an
			// unhandled late connection error after the promise has rejected.
			socket.once('close', () => socket.removeListener('error', onError));
			socket.destroy();
			reject(error);
		};

		socket.once('connect', onConnect);
		socket.once('error', onError);
		socket.setTimeout(timeout, () => fail(socketTimeoutError(hostname, timeout)));
	});
}

async function resolveAddresses(
	hostname: string,
	deadline: number,
	dependencies: {
		resolve4: (hostname: string) => Promise<string[]>;
		createResolver: () => ResolverLike;
		now: () => number;
	}
): Promise<string[]> {
	const timeoutMs = remaining(deadline, dependencies.now);
	if (timeoutMs <= 0) throw socketTimeoutError(hostname, 0);

	try {
		return await withTimeout(dependencies.resolve4(hostname), timeoutMs, socketTimeoutError(hostname, timeoutMs));
	} catch (error) {
		if (isSocketTimeoutError(error) || !isResolverLookupError(error)) throw error;
		const resolver = dependencies.createResolver();
		resolver.setServers([...FALLBACK_DNS_SERVERS]);
		const fallbackTimeout = Math.min(FALLBACK_DNS_TIMEOUT_MS, remaining(deadline, dependencies.now));
		if (fallbackTimeout <= 0) throw socketTimeoutError(hostname, timeoutMs);
		try {
			return await withTimeout(
				resolver.resolve4(hostname),
				fallbackTimeout,
				socketTimeoutError(hostname, fallbackTimeout),
				() => resolver.cancel?.()
			);
		} catch (fallbackError) {
			if (isSocketTimeoutError(fallbackError)) throw fallbackError;
			throw withCause(fallbackError, error);
		}
	}
}

function withTimeout<T>(
	promise: Promise<T>,
	timeoutMs: number,
	timeoutError: Error,
	onTimeout?: () => void
): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	return new Promise<T>((resolve, reject) => {
		timer = setTimeout(() => {
			onTimeout?.();
			reject(timeoutError);
		}, Math.max(1, timeoutMs));
		promise.then(
			(value) => {
				if (timer) clearTimeout(timer);
				resolve(value);
			},
			(error) => {
				if (timer) clearTimeout(timer);
				reject(error);
			}
		);
	});
}

function markSocket(socket: net.Socket, endpoint: DatabaseEndpoint): DatabaseSocket {
	const tagged = socket as DatabaseSocket;
	tagged.host = endpoint.hostname;
	tagged.port = endpoint.port;
	return tagged;
}

function resolveFactoryTimeout(value: unknown, configuredTimeoutMs: number): number {
	const driverSeconds = typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
	if (driverSeconds === null) return configuredTimeoutMs;
	return Math.max(1, Math.min(configuredTimeoutMs, Math.floor(driverSeconds * 1_000)));
}

function normalizeTimeout(value: number | undefined, fallback: number): number {
	return Number.isFinite(value) && (value as number) > 0 ? Math.floor(value as number) : fallback;
}

function remaining(deadline: number, now: () => number): number {
	return Math.max(0, deadline - now());
}

function uniqueIpv4(addresses: string[]): string[] {
	return [...new Set(addresses.filter((address) => net.isIP(address) === 4))];
}

function isDnsLookupError(error: unknown): boolean {
	return errorCode(error) === 'ENOTFOUND' || errorCode(error) === 'EAI_AGAIN';
}

function isResolverLookupError(error: unknown): boolean {
	return RESOLVER_LOOKUP_ERROR_CODES.has(errorCode(error) ?? '');
}

function isSocketTimeoutError(error: unknown): boolean {
	return errorCode(error) === 'ETIMEDOUT';
}

function errorCode(error: unknown): string | undefined {
	return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
		? error.code
		: undefined;
}

function socketTimeoutError(hostname: string, timeoutMs: number): Error & { code: string } {
	const error = new Error(`Timed out connecting to database host ${hostname} after ${timeoutMs}ms`) as Error & {
		code: string;
	};
	error.code = 'ETIMEDOUT';
	return error;
}

function withCause(error: unknown, cause: unknown): Error & { cause?: unknown } {
	if (error instanceof Error) {
		if (!('cause' in error)) Object.defineProperty(error, 'cause', { value: cause, enumerable: false });
		return error as Error & { cause?: unknown };
	}
	const wrapped = new Error('Database DNS resolution failed', { cause });
	return wrapped;
}
