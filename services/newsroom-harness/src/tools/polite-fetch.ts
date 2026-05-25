import { createHash } from 'node:crypto';
import { nowIso } from '../util/ids.js';

export const NEWSCRAFT_USER_AGENT = 'NewsCraft newsroom-harness/0.0.1 (+https://newscraft.ai)';

const DEFAULT_HOST_DELAY_MS = 250;
const MAX_BACKOFF_MS = 30_000;

interface HostState {
	nextAllowedAt: number;
	failureCount: number;
}

const hostStates = new Map<string, HostState>();

export interface PoliteFetchCacheMetadata {
	contentHash: string;
	etag: string | null;
	lastModified: string | null;
	cacheControl: string | null;
	expires: string | null;
	contentLength: string | null;
}

export interface PoliteFetchBackoffEvent {
	url: string;
	host: string;
	statusCode: number;
	backoffMs: number;
	retryAfter: string | null;
}

export interface PoliteFetchArchiveSnapshot {
	url: string;
	fetchedAt: string;
	statusCode: number;
	contentType: string | null;
	body: string;
	cache: PoliteFetchCacheMetadata;
}

export interface PoliteFetchArchiveResult {
	attempted: boolean;
	ok: boolean;
	error?: string;
}

export interface PoliteFetchRateLimitOptions {
	minDelayMs?: number;
	now?: () => number;
	sleep?: (ms: number, signal: AbortSignal | undefined) => Promise<void>;
	onBackoff?: (event: PoliteFetchBackoffEvent) => void;
}

export interface PoliteFetchOptions {
	signal?: AbortSignal;
	fetchImpl?: typeof fetch;
	headers?: HeadersInit;
	etag?: string | null;
	lastModified?: string | null;
	rateLimit?: PoliteFetchRateLimitOptions;
	archive?: {
		snapshot?: (snapshot: PoliteFetchArchiveSnapshot) => Promise<void> | void;
	};
}

export interface PoliteFetchResult {
	url: string;
	fetchedAt: string;
	response: Response;
	body: string;
	contentType: string | null;
	statusCode: number;
	ok: boolean;
	cache: PoliteFetchCacheMetadata;
	archiveSnapshot: PoliteFetchArchiveResult;
}

export async function politeFetch(url: string, options: PoliteFetchOptions = {}): Promise<PoliteFetchResult> {
	const parsedUrl = new URL(url);
	await waitForHost(parsedUrl, options);

	const response = await (options.fetchImpl ?? fetch)(url, {
		headers: requestHeaders(options),
		signal: options.signal
	});
	const body = await response.text();
	const fetchedAt = nowIso();
	const cache = cacheMetadata(response.headers, body);
	const contentType = response.headers.get('content-type');
	const result: PoliteFetchResult = {
		url,
		fetchedAt,
		response,
		body,
		contentType,
		statusCode: response.status,
		ok: response.ok,
		cache,
		archiveSnapshot: { attempted: false, ok: false }
	};

	updateHostState(parsedUrl, response, options);
	result.archiveSnapshot = await snapshotArchiveBestEffort(result, options);
	return result;
}

export function resetPoliteFetchStateForTests(): void {
	hostStates.clear();
}

function requestHeaders(options: PoliteFetchOptions): Headers {
	const headers = new Headers(options.headers);
	if (!headers.has('user-agent')) headers.set('user-agent', NEWSCRAFT_USER_AGENT);
	if (options.etag) headers.set('if-none-match', options.etag);
	if (options.lastModified) headers.set('if-modified-since', options.lastModified);
	return headers;
}

async function waitForHost(url: URL, options: PoliteFetchOptions): Promise<void> {
	const minDelayMs = options.rateLimit?.minDelayMs ?? DEFAULT_HOST_DELAY_MS;
	if (minDelayMs <= 0) return;
	const now = options.rateLimit?.now?.() ?? Date.now();
	const state = hostStates.get(hostKey(url));
	if (!state || state.nextAllowedAt <= now) return;
	await (options.rateLimit?.sleep ?? sleep)(state.nextAllowedAt - now, options.signal);
}

function updateHostState(url: URL, response: Response, options: PoliteFetchOptions): void {
	const minDelayMs = options.rateLimit?.minDelayMs ?? DEFAULT_HOST_DELAY_MS;
	const now = options.rateLimit?.now?.() ?? Date.now();
	const key = hostKey(url);
	const previous = hostStates.get(key) ?? { nextAllowedAt: now, failureCount: 0 };
	const retryAfter = response.headers.get('retry-after');
	const backoffMs = backoffDelayMs(response.status, previous.failureCount, retryAfter);
	const nextDelayMs = Math.max(minDelayMs, backoffMs);
	const failureCount = backoffMs > 0 ? previous.failureCount + 1 : 0;

	hostStates.set(key, {
		nextAllowedAt: now + nextDelayMs,
		failureCount
	});

	if (backoffMs > 0) {
		options.rateLimit?.onBackoff?.({
			url: url.toString(),
			host: key,
			statusCode: response.status,
			backoffMs,
			retryAfter
		});
	}
}

function backoffDelayMs(statusCode: number, failureCount: number, retryAfter: string | null): number {
	if (statusCode !== 429 && statusCode !== 503) return 0;
	const retryAfterMs = retryAfterDelayMs(retryAfter);
	if (retryAfterMs !== null) return retryAfterMs;
	return Math.min(MAX_BACKOFF_MS, 1000 * 2 ** failureCount);
}

function retryAfterDelayMs(value: string | null): number | null {
	if (!value) return null;
	const seconds = Number(value);
	if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
	const date = Date.parse(value);
	if (!Number.isFinite(date)) return null;
	return Math.max(0, date - Date.now());
}

function cacheMetadata(headers: Headers, body: string): PoliteFetchCacheMetadata {
	return {
		contentHash: createHash('sha256').update(body).digest('hex'),
		etag: headers.get('etag'),
		lastModified: headers.get('last-modified'),
		cacheControl: headers.get('cache-control'),
		expires: headers.get('expires'),
		contentLength: headers.get('content-length')
	};
}

async function snapshotArchiveBestEffort(
	result: PoliteFetchResult,
	options: PoliteFetchOptions
): Promise<PoliteFetchArchiveResult> {
	const snapshot = options.archive?.snapshot;
	if (!snapshot) return { attempted: false, ok: false };
	try {
		await snapshot({
			url: result.url,
			fetchedAt: result.fetchedAt,
			statusCode: result.statusCode,
			contentType: result.contentType,
			body: result.body,
			cache: result.cache
		});
		return { attempted: true, ok: true };
	} catch (err) {
		return {
			attempted: true,
			ok: false,
			error: err instanceof Error ? err.message : String(err)
		};
	}
}

function hostKey(url: URL): string {
	return url.host.toLowerCase();
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
	if (signal?.aborted) return Promise.reject(signal.reason);
	return new Promise((resolve, reject) => {
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener(
			'abort',
			() => {
				clearTimeout(timer);
				reject(signal.reason);
			},
			{ once: true }
		);
	});
}
