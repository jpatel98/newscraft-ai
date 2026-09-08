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
export const PREFERRED_ADDRESS_TTL_MS = 30_000;
/** Delay between TCP candidate launches during the bounded fallback race. */
export const TCP_CANDIDATE_STAGGER_MS = 150;
const MAX_ACTIVE_TCP_CANDIDATES = 2;
const INITIAL_HOSTNAME_TIMEOUT_CAP_MS = 1_000;
// Reserve time for later candidates after the initial hostname attempt. The
// fallback race itself caps in-flight sockets at MAX_ACTIVE_TCP_CANDIDATES.
const INITIAL_CONNECTION_ATTEMPT_SLOTS = 3;
const RETRYABLE_CONNECTION_ERROR_CODES = new Set([
	'ETIMEDOUT',
	'ECONNREFUSED',
	'EHOSTUNREACH',
	'ENETUNREACH'
]);
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
	connect?: (hostname: string, port: number, timeoutMs: number, signal?: AbortSignal) => Promise<net.Socket>;
	resolve4?: (hostname: string) => Promise<string[]>;
	createResolver?: () => ResolverLike;
	now?: () => number;
}

export interface Ipv4ResolutionOptions {
	/** Cap the complete default and public-resolver lookup sequence. */
	timeoutMs?: number;
	/** Dependency seams keep DNS behavior deterministic in tests. */
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
 * The first attempt uses the configured hostname. A bounded address retry is
 * allowed after a DNS lookup failure or a retryable TCP connection failure;
 * it resolves fresh A records and races candidates with a small stagger within
 * the same caller-owned deadline. Returned sockets retain the original
 * hostname so postgres.js performs certificate validation against the database
 * hostname.
 */
export function createDatabaseSocketFactory(
	endpoint: DatabaseEndpoint,
	options: DatabaseSocketFactoryOptions = {}
): (postgresOptions?: PostgresSocketOptions) => Promise<DatabaseSocket> {
	const connect =
		options.connect ?? ((hostname, port, timeoutMs, signal) => connectWithTimeout(hostname, port, timeoutMs, undefined, signal));
	const resolve4 = options.resolve4 ?? ((hostname) => dns.resolve4(hostname));
	const createResolver =
		options.createResolver ??
		(() => new dns.Resolver({ timeout: FALLBACK_DNS_TIMEOUT_MS, tries: FALLBACK_DNS_TRIES }));
	const now = options.now ?? Date.now;
	const configuredTimeoutMs = normalizeTimeout(options.timeoutMs, DEFAULT_DATABASE_SOCKET_TIMEOUT_MS);
	let preferredAddress: PreferredAddress | null = null;
	const rememberFreshSocket = (socket: net.Socket): DatabaseSocket => {
		const marked = markSocket(socket, endpoint);
		const remoteAddress = marked.remoteAddress;
		if (typeof remoteAddress === 'string' && net.isIP(remoteAddress) === 4) {
			preferredAddress = {
				address: remoteAddress,
				expiresAt: now() + PREFERRED_ADDRESS_TTL_MS
			};
		}
		return marked;
	};

	return async (postgresOptions = {}) => {
		const timeoutMs = resolveFactoryTimeout(postgresOptions.connect_timeout, configuredTimeoutMs);
		const deadline = now() + timeoutMs;
		// Keep the cold hostname probe bounded without applying that cap to a
		// previously healthy cached address.
		const initialAttemptTimeout = Math.min(
			connectionAttemptSlice(timeoutMs, INITIAL_CONNECTION_ATTEMPT_SLOTS),
			INITIAL_HOSTNAME_TIMEOUT_CAP_MS
		);
		const cachedAttemptTimeout = connectionAttemptSlice(timeoutMs, INITIAL_CONNECTION_ATTEMPT_SLOTS);
		const cached = preferredAddress;
		if (cached && cached.expiresAt <= now()) {
			if (preferredAddress === cached) preferredAddress = null;
		} else if (cached) {
			const timeout = Math.min(remaining(deadline, now), cachedAttemptTimeout);
			if (timeout <= 0) throw socketTimeoutError(endpoint.hostname, timeoutMs);
			try {
				// Cache reuse intentionally does not call rememberFreshSocket: the
				// expiry is measured from discovery and never extended by a hit.
				return markSocket(await connect(cached.address, endpoint.port, timeout), endpoint);
			} catch (error) {
				// Only a TCP-level failure may invalidate and fall through to the
				// existing hostname/DNS failover. TLS, auth, and protocol failures
				// remain terminal and do not trigger another address.
				if (!isRetryableConnectionError(error)) throw error;
				if (preferredAddress === cached) preferredAddress = null;
			}
		}

		try {
			const timeout = Math.min(remaining(deadline, now), initialAttemptTimeout);
			if (timeout <= 0) throw socketTimeoutError(endpoint.hostname, timeoutMs);
			return rememberFreshSocket(await connect(endpoint.hostname, endpoint.port, timeout));
		} catch (error) {
			if (!isDnsLookupError(error) && !isRetryableConnectionError(error)) throw error;

			const addresses = await resolveIpv4WithFallback(endpoint.hostname, {
				timeoutMs: remaining(deadline, now),
				resolve4,
				createResolver,
				now
			});
			return connectToCandidates({
				addresses,
				endpoint,
				deadline,
				now,
				connect,
				initialError: error,
				timeoutMs,
				fallbackBudgetMs: Math.max(0, timeoutMs - initialAttemptTimeout),
				markFreshSocket: rememberFreshSocket
			});
		}
	};
}

interface PreferredAddress {
	address: string;
	expiresAt: number;
}

interface CandidateConnectionInput {
	addresses: string[];
	endpoint: DatabaseEndpoint;
	deadline: number;
	now: () => number;
	connect: (hostname: string, port: number, timeoutMs: number, signal?: AbortSignal) => Promise<net.Socket>;
	initialError: unknown;
	timeoutMs: number;
	fallbackBudgetMs: number;
	markFreshSocket: (socket: net.Socket) => DatabaseSocket;
}

interface CandidateAttempt {
	controller: AbortController;
	finished: boolean;
	timer: ReturnType<typeof setTimeout>;
}

async function connectToCandidates({
	addresses,
	endpoint,
	deadline,
	now,
	connect,
	initialError,
	timeoutMs,
	fallbackBudgetMs,
	markFreshSocket
}: CandidateConnectionInput): Promise<DatabaseSocket> {
	const candidates = uniqueIpv4(addresses);
	if (candidates.length === 0) throw initialError;

	return new Promise<DatabaseSocket>((resolve, reject) => {
		let settled = false;
		let active = 0;
		let nextIndex = 0;
		let lastError: unknown = initialError;
		let staggerTimer: ReturnType<typeof setTimeout> | undefined;
		let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
		const attempts = new Set<CandidateAttempt>();

		const clearTimers = () => {
			if (staggerTimer !== undefined) clearTimeout(staggerTimer);
			if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
			staggerTimer = undefined;
			deadlineTimer = undefined;
		};

		const cancelAttempts = () => {
			for (const attempt of attempts) {
				attempt.finished = true;
				clearTimeout(attempt.timer);
				abortAttempt(attempt.controller);
			}
			attempts.clear();
		};

		const finish = (error: unknown) => {
			if (settled) return;
			settled = true;
			clearTimers();
			cancelAttempts();
			reject(error);
		};

		const scheduleNext = () => {
			if (
				settled ||
				nextIndex >= candidates.length ||
				active >= MAX_ACTIVE_TCP_CANDIDATES ||
				staggerTimer !== undefined
			)
				return;
			const available = Math.min(remaining(deadline, now), Math.max(0, fallbackBudgetMs));
			if (available <= 0) {
				if (active === 0) finish(socketTimeoutError(endpoint.hostname, timeoutMs));
				return;
			}
			staggerTimer = setTimeout(() => {
				staggerTimer = undefined;
				launchNext();
				scheduleNext();
			}, Math.min(TCP_CANDIDATE_STAGGER_MS, available));
		};

		const onConnectionError = (error: unknown) => {
			active -= 1;
			if (settled) return;
			lastError = error;
			// Connection-only failover is deliberately narrow. A TLS, auth, or
			// protocol error must escape without trying another address.
			if (!isRetryableConnectionError(error)) {
				finish(error);
				return;
			}
			// An immediate TCP refusal should advance without waiting for the
			// stagger; a black-holed connection keeps the next candidate staggered.
			if (nextIndex < candidates.length) launchNext();
			else if (active === 0) finish(lastError);
		};

		const onConnectionSuccess = (socket: net.Socket) => {
			active -= 1;
			if (settled) {
				destroySocket(socket);
				return;
			}
			settled = true;
			clearTimers();
			cancelAttempts();
			resolve(markFreshSocket(socket));
		};

		function launchNext() {
			if (settled || nextIndex >= candidates.length || active >= MAX_ACTIVE_TCP_CANDIDATES) return;
			const available = Math.min(remaining(deadline, now), Math.max(0, fallbackBudgetMs));
			if (available <= 0) {
				if (active === 0) finish(socketTimeoutError(endpoint.hostname, timeoutMs));
				return;
			}
			const candidateIndex = nextIndex;
			const address = candidates[nextIndex++];
			const attemptTimeout = connectionAttemptSlice(available, candidates.length - candidateIndex);
			const controller = new AbortController();
			const attempt: CandidateAttempt = {
				controller,
				finished: false,
				timer: setTimeout(() => {
					if (attempt.finished || settled) return;
					attempt.finished = true;
					attempts.delete(attempt);
					abortAttempt(controller);
					onConnectionError(socketTimeoutError(endpoint.hostname, attemptTimeout));
				}, attemptTimeout)
			};
			attempts.add(attempt);
			active += 1;
			let connection: Promise<net.Socket>;
			try {
				connection = Promise.resolve(connect(address, endpoint.port, attemptTimeout, controller.signal));
			} catch (error) {
				connection = Promise.reject(error);
			}
			connection.then(
				(socket) => {
					if (attempt.finished) {
						destroySocket(socket);
						return;
					}
					attempt.finished = true;
					clearTimeout(attempt.timer);
					attempts.delete(attempt);
					onConnectionSuccess(socket);
				},
				(error) => {
					if (attempt.finished) return;
					attempt.finished = true;
					clearTimeout(attempt.timer);
					attempts.delete(attempt);
					onConnectionError(error);
				}
			);
		}

		launchNext();
		scheduleNext();
		const deadlineMs = remaining(deadline, now);
		if (deadlineMs <= 0) {
			if (active === 0) finish(socketTimeoutError(endpoint.hostname, timeoutMs));
		} else {
			deadlineTimer = setTimeout(() => {
				if (!settled) finish(socketTimeoutError(endpoint.hostname, timeoutMs));
			}, deadlineMs);
		}
	});
}

/**
 * Resolve A records with the configured resolver first, then one isolated
 * public-DNS resolver when the configured resolver reports a DNS failure.
 * Both attempts share one caller-owned deadline and no global resolver state
 * is changed.
 */
export async function resolveIpv4WithFallback(
	hostname: string,
	options: Ipv4ResolutionOptions = {}
): Promise<string[]> {
	const now = options.now ?? Date.now;
	const timeoutMs = normalizeResolutionTimeout(options.timeoutMs);
	if (timeoutMs <= 0) throw socketTimeoutError(hostname, timeoutMs);
	const resolve4 = options.resolve4 ?? ((value: string) => dns.resolve4(value));
	const createResolver =
		options.createResolver ??
		(() => new dns.Resolver({ timeout: FALLBACK_DNS_TIMEOUT_MS, tries: FALLBACK_DNS_TRIES }));
	const addresses = await resolveAddresses(hostname, now() + timeoutMs, { resolve4, createResolver, now });
	return uniqueIpv4(addresses);
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
		net.connect({ host, port: socketPort }),
	signal?: AbortSignal
): Promise<net.Socket> {
	const timeout = normalizeTimeout(timeoutMs, DEFAULT_DATABASE_SOCKET_TIMEOUT_MS);
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(socketAbortError(hostname));
			return;
		}
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
			signal?.removeEventListener('abort', onAbort);
			socket.setTimeout(0);
			resolve(socket);
		};
		const onError = (error: Error) => {
			fail(error);
		};
		const onAbort = () => {
			fail(socketAbortError(hostname));
		};
		const fail = (error: Error) => {
			if (settled) return;
			settled = true;
			socket.removeListener('connect', onConnect);
			signal?.removeEventListener('abort', onAbort);
			socket.setTimeout(0);
			// Keep the error listener until close so destroy() cannot surface an
			// unhandled late connection error after the promise has rejected.
			socket.once('close', () => socket.removeListener('error', onError));
			socket.destroy();
			reject(error);
		};

		socket.once('connect', onConnect);
		socket.once('error', onError);
		signal?.addEventListener('abort', onAbort, { once: true });
		socket.setTimeout(timeout, () => fail(socketTimeoutError(hostname, timeout)));
	});
}

async function resolveAddresses(
	hostname: string,
	deadline: number,
	dependencies: Pick<Required<Ipv4ResolutionOptions>, 'resolve4' | 'createResolver' | 'now'>
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

function normalizeResolutionTimeout(value: number | undefined): number {
	if (value === undefined) return FALLBACK_DNS_TIMEOUT_MS;
	return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
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

function destroySocket(socket: net.Socket): void {
	try {
		if (typeof socket.destroy === 'function') socket.destroy();
	} catch {
		// A losing candidate is best-effort cleanup; its connection promise is
		// already observed and must not mask the winning socket.
	}
}

function abortAttempt(controller: AbortController): void {
	try {
		controller.abort();
	} catch {
		// Abort listeners belong to the connector seam; one faulty listener must
		// not prevent other losing candidates from being cancelled.
	}
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

function connectionAttemptSlice(availableMs: number, attemptsRemaining: number): number {
	if (availableMs <= 0) return 0;
	const slots = Math.max(1, Math.floor(attemptsRemaining));
	return Math.max(1, Math.min(availableMs, Math.floor(availableMs / slots)));
}

function uniqueIpv4(addresses: string[]): string[] {
	return [...new Set(addresses.filter((address) => net.isIP(address) === 4))];
}

function isDnsLookupError(error: unknown): boolean {
	return errorCode(error) === 'ENOTFOUND' || errorCode(error) === 'EAI_AGAIN';
}

function isRetryableConnectionError(error: unknown): boolean {
	return RETRYABLE_CONNECTION_ERROR_CODES.has(errorCode(error) ?? '');
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

function socketAbortError(hostname: string): Error & { code: string } {
	const error = new Error(`Cancelled database connection attempt for ${hostname}`) as Error & { code: string };
	error.name = 'AbortError';
	error.code = 'ABORT_ERR';
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
