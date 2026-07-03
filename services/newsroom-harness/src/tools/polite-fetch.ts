import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { nowIso } from '../util/ids.js';

export const NEWSCRAFT_USER_AGENT = 'NewsCraft newsroom-harness/0.0.1 (+https://newscraft.ai)';

const DEFAULT_HOST_DELAY_MS = 250;
const MAX_BACKOFF_MS = 30_000;

interface HostState {
	nextAllowedAt: number;
	failureCount: number;
}

const hostStates = new Map<string, HostState>();
const archivedUrls = new Set<string>();

export interface PoliteFetchCacheMetadata {
	contentHash: string;
	etag: string | null;
	lastModified: string | null;
	cacheControl: string | null;
	expires: string | null;
	contentLength: string | null;
}

export interface PoliteFetchCachedEntry {
	url: string;
	fetchedAt: string;
	statusCode: number;
	contentType: string | null;
	body: string;
	cache: PoliteFetchCacheMetadata;
	archiveSnapshot?: PoliteFetchArchiveResult | null;
}

export interface PoliteFetchCacheStore {
	read(url: string): Promise<PoliteFetchCachedEntry | null>;
	write(entry: PoliteFetchCachedEntry): Promise<void>;
}

export type PoliteFetchCacheStatus = 'bypass' | 'miss' | 'stored' | 'revalidated';

export interface PoliteFetchBackoffEvent {
	url: string;
	host: string;
	statusCode: number;
	backoffMs: number;
	retryAfter: string | null;
}

export interface PoliteFetchRateLimitOptions {
	hostDelayMs?: number;
	retryAfterMs?: number;
	wait?: (ms: number) => Promise<void>;
	minDelayMs?: number;
	now?: () => number;
	sleep?: (ms: number, signal: AbortSignal | undefined) => Promise<void>;
	onBackoff?: (event: PoliteFetchBackoffEvent) => void;
}

export interface PoliteFetchArchiveSnapshot {
	url: string;
	fetchedAt: string;
	statusCode: number;
	contentType: string | null;
	contentHash: string;
	body: string;
	cache: PoliteFetchCacheMetadata;
}

export interface PoliteFetchArchiveResult {
	attempted: boolean;
	ok: boolean;
	snapshotUrl: string | null;
	error?: string;
}

export interface PoliteFetchRobotsResult {
	checked: boolean;
	allowed: boolean;
	override: boolean;
	robotsUrl: string | null;
	matchedRule: string | null;
	error?: string;
}

export interface PoliteFetchOptions {
	signal?: AbortSignal;
	fetchImpl?: typeof fetch;
	headers?: HeadersInit;
	etag?: string | null;
	lastModified?: string | null;
	rateLimit?: PoliteFetchRateLimitOptions;
	robots?: {
		respect?: boolean;
		override?: boolean;
		userAgent?: string;
		fetchImpl?: typeof fetch;
	};
	cache?: {
		store?: PoliteFetchCacheStore;
		read?: boolean;
		write?: boolean;
	};
	archive?: {
		snapshot?: (snapshot: PoliteFetchArchiveSnapshot) => Promise<void> | void;
		webArchive?: boolean;
		fetchImpl?: typeof fetch;
	};
	ssrf?: {
		protect?: boolean;
		allowPrivateNetwork?: boolean;
		resolveHost?: (hostname: string) => Promise<string[]>;
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
	cacheStatus: PoliteFetchCacheStatus;
	archiveSnapshot: PoliteFetchArchiveResult;
	robots: PoliteFetchRobotsResult;
}

export function createFilePoliteFetchCache(rootDir = path.join(process.cwd(), '.data', 'source-cache')): PoliteFetchCacheStore {
	return {
		async read(url) {
			const paths = cachePaths(rootDir, url);

			try {
				const rawMetadata = await readFile(paths.metadata, 'utf8');
				const record = JSON.parse(rawMetadata) as Omit<PoliteFetchCachedEntry, 'body'>;
				const body = await readFile(contentPath(rootDir, record.cache.contentHash), 'utf8');

				return {
					...record,
					body,
				};
			} catch (error) {
				if (isNotFoundError(error)) {
					return null;
				}

				throw error;
			}
		},
		async write(entry) {
			const paths = cachePaths(rootDir, entry.url);
			const content = contentPath(rootDir, entry.cache.contentHash);
			const { body: _body, ...metadata } = entry;

			await mkdir(path.dirname(paths.metadata), { recursive: true });
			await mkdir(path.dirname(content), { recursive: true });
			await writeFile(content, entry.body, 'utf8');
			await writeFile(paths.metadata, `${JSON.stringify(metadata, null, 2)}\n`, 'utf8');
		},
	};
}

export function resetPoliteFetchStateForTests(): void {
	hostStates.clear();
	archivedUrls.clear();
}

export async function politeFetch(url: string, options: PoliteFetchOptions = {}): Promise<PoliteFetchResult> {
	const parsed = new URL(url);
	await assertSafeFetchTarget(parsed, options);
	const fetchImpl = options.fetchImpl ?? fetch;
	const cacheStore = options.cache?.store;
	const cachedEntry = options.cache?.read === false || !cacheStore ? null : await cacheStore.read(url);
	const robots = await checkRobots(url, options);

	if (!robots.allowed) {
		const fetchedAt = nowIso();
		const body = '';
		const response = new Response(body, {
			status: 451,
			statusText: 'Blocked by robots.txt',
			headers: {
				'content-type': 'text/plain; charset=utf-8',
			},
		});
		const cache = cacheMetadata(response, body);

		return {
			url,
			fetchedAt,
			response,
			body,
			contentType: response.headers.get('content-type'),
			statusCode: response.status,
			ok: false,
			cache,
			cacheStatus: 'bypass',
			archiveSnapshot: noArchiveSnapshot(),
			robots,
		};
	}

	const requestHeaders = buildRequestHeaders(options, cachedEntry);
	await waitForHost(parsed, options);

	let response: Response;
	try {
		response = await fetchImpl(url, {
			headers: requestHeaders,
			signal: options.signal,
		});
	} catch (error) {
		throw error;
	}

	updateHostState(parsed, response, options);

	if (response.status === 304 && cachedEntry) {
		return {
			url,
			fetchedAt: nowIso(),
			response: new Response(cachedEntry.body, {
				status: 200,
				headers: {
					'content-type': cachedEntry.contentType ?? 'text/plain; charset=utf-8',
				},
			}),
			body: cachedEntry.body,
			contentType: cachedEntry.contentType,
			statusCode: 200,
			ok: true,
			cache: cachedEntry.cache,
			cacheStatus: 'revalidated',
			archiveSnapshot: cachedEntry.archiveSnapshot ?? noArchiveSnapshot(),
			robots,
		};
	}

	const fetchedAt = nowIso();
	const body = await response.text();
	const cache = cacheMetadata(response, body);
	const contentType = response.headers.get('content-type');
	const archiveSnapshot = await archiveFetchedDocument(url, fetchedAt, response.status, contentType, cache, body, options, cachedEntry);
	const result: PoliteFetchResult = {
		url,
		fetchedAt,
		response,
		body,
		contentType,
		statusCode: response.status,
		ok: response.ok,
		cache,
		cacheStatus: cacheStore ? (response.ok ? 'stored' : 'miss') : 'bypass',
		archiveSnapshot,
		robots,
	};

	if (cacheStore && options.cache?.write !== false && response.ok) {
		await cacheStore.write({
			url,
			fetchedAt,
			statusCode: response.status,
			contentType: result.contentType,
			body,
			cache,
			archiveSnapshot,
		});
	}

	return result;
}

function buildRequestHeaders(options: PoliteFetchOptions, cachedEntry: PoliteFetchCachedEntry | null): Headers {
	const headers = new Headers(options.headers);
	headers.set('user-agent', headers.get('user-agent') ?? NEWSCRAFT_USER_AGENT);
	headers.set('accept', headers.get('accept') ?? 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5');

	const etag = options.etag ?? cachedEntry?.cache.etag;
	const lastModified = options.lastModified ?? cachedEntry?.cache.lastModified;

	if (etag) {
		headers.set('if-none-match', etag);
	}

	if (lastModified) {
		headers.set('if-modified-since', lastModified);
	}

	return headers;
}

async function waitForHost(parsed: URL, options: PoliteFetchOptions): Promise<void> {
	const rateLimit = options.rateLimit;
	const host = hostKey(parsed);
	const state = hostStates.get(host) ?? { nextAllowedAt: 0, failureCount: 0 };
	const now = rateLimit?.now?.() ?? Date.now();
	const waitMs = Math.max(0, state.nextAllowedAt - now);

	if (waitMs > 0) {
		if (rateLimit?.wait) {
			await rateLimit.wait(waitMs);
		} else {
			await (rateLimit?.sleep ?? sleep)(waitMs, options.signal);
		}
	}
}

function updateHostState(parsed: URL, response: Response, options: PoliteFetchOptions): void {
	const rateLimit = options.rateLimit;
	const host = hostKey(parsed);
	const state = hostStates.get(host) ?? { nextAllowedAt: 0, failureCount: 0 };
	const retryAfterHeader = response.headers.get('retry-after');
	const retryAfter = parseRetryAfter(retryAfterHeader);
	const retryAfterMs = rateLimit?.retryAfterMs ?? retryAfter;
	const hostDelayMs = rateLimit?.hostDelayMs ?? rateLimit?.minDelayMs ?? DEFAULT_HOST_DELAY_MS;

	if (response.status === 429 || response.status >= 500) {
		state.failureCount += 1;
	} else if (response.ok) {
		state.failureCount = 0;
	}

	const backoffMs = state.failureCount > 0
		? Math.min(MAX_BACKOFF_MS, hostDelayMs * 2 ** state.failureCount)
		: hostDelayMs;
	const nextDelayMs = Math.max(retryAfterMs ?? 0, backoffMs);

	state.nextAllowedAt = (rateLimit?.now?.() ?? Date.now()) + nextDelayMs;
	hostStates.set(host, state);

	if (state.failureCount > 0) {
		rateLimit?.onBackoff?.({
			url: parsed.toString(),
			host,
			statusCode: response.status,
			backoffMs: nextDelayMs,
			retryAfter: retryAfterHeader,
		});
	}
}

function cacheMetadata(response: Response, body: string): PoliteFetchCacheMetadata {
	return {
		contentHash: createHash('sha256').update(body).digest('hex'),
		etag: response.headers.get('etag'),
		lastModified: response.headers.get('last-modified'),
		cacheControl: response.headers.get('cache-control'),
		expires: response.headers.get('expires'),
		contentLength: response.headers.get('content-length'),
	};
}

async function archiveFetchedDocument(
	url: string,
	fetchedAt: string,
	statusCode: number,
	contentType: string | null,
	cache: PoliteFetchCacheMetadata,
	body: string,
	options: PoliteFetchOptions,
	cachedEntry: PoliteFetchCachedEntry | null,
): Promise<PoliteFetchArchiveResult> {
	if (cachedEntry?.archiveSnapshot?.ok) {
		return cachedEntry.archiveSnapshot;
	}

	if (options.archive?.snapshot) {
		try {
			await options.archive.snapshot({
				url,
				fetchedAt,
				statusCode,
				contentType,
				contentHash: cache.contentHash,
				body,
				cache,
			});

			return {
				attempted: true,
				ok: true,
				snapshotUrl: null,
			};
		} catch (error) {
			return {
				attempted: true,
				ok: false,
				snapshotUrl: null,
				error: error instanceof Error ? error.message : 'archive snapshot failed',
			};
		}
	}

	if (options.archive?.webArchive !== true || archivedUrls.has(url)) {
		return noArchiveSnapshot();
	}

	archivedUrls.add(url);

	try {
		const archiveUrl = `https://web.archive.org/save/${encodeURIComponent(url)}`;
		const archiveFetch = options.archive.fetchImpl ?? fetch;
		const response = await archiveFetch(archiveUrl, {
			method: 'GET',
			headers: {
				'user-agent': NEWSCRAFT_USER_AGENT,
			},
			signal: options.signal,
		});
		const snapshotUrl = response.headers.get('content-location') ?? response.headers.get('location');

		return {
			attempted: true,
			ok: response.ok,
			snapshotUrl: snapshotUrl ? new URL(snapshotUrl, 'https://web.archive.org').toString() : archiveUrl,
			error: response.ok ? undefined : `web.archive.org returned ${response.status}`,
		};
	} catch (error) {
		return {
			attempted: true,
			ok: false,
			snapshotUrl: null,
			error: error instanceof Error ? error.message : 'web.archive.org snapshot failed',
		};
	}
}

function noArchiveSnapshot(): PoliteFetchArchiveResult {
	return {
		attempted: false,
		ok: false,
		snapshotUrl: null,
	};
}

async function checkRobots(url: string, options: PoliteFetchOptions): Promise<PoliteFetchRobotsResult> {
	const parsed = new URL(url);
	await assertSafeFetchTarget(parsed, options);
	const robotsUrl = new URL('/robots.txt', parsed.origin).toString();
	const respectRobots = options.robots?.respect !== false;
	const override = options.robots?.override === true;

	if (!respectRobots || override) {
		return {
			checked: respectRobots,
			allowed: true,
			override,
			robotsUrl: respectRobots ? robotsUrl : null,
			matchedRule: null,
		};
	}

	try {
		const robotsFetch = options.robots?.fetchImpl ?? options.fetchImpl ?? fetch;
		const response = await robotsFetch(robotsUrl, {
			headers: {
				'user-agent': options.robots?.userAgent ?? NEWSCRAFT_USER_AGENT,
				accept: 'text/plain,*/*;q=0.5',
			},
			signal: options.signal,
		});

		if (response.status === 404 || response.status === 410 || !response.ok) {
			return {
				checked: true,
				allowed: true,
				override,
				robotsUrl,
				matchedRule: null,
			};
		}

		const body = await response.text();
		const decision = robotsAllows(body, parsed.pathname + parsed.search, options.robots?.userAgent ?? NEWSCRAFT_USER_AGENT);

		return {
			checked: true,
			allowed: decision.allowed,
			override,
			robotsUrl,
			matchedRule: decision.rule,
		};
	} catch (error) {
		return {
			checked: true,
			allowed: true,
			override,
			robotsUrl,
			matchedRule: null,
			error: error instanceof Error ? error.message : 'robots.txt fetch failed',
		};
	}
}

async function assertSafeFetchTarget(parsed: URL, options: PoliteFetchOptions): Promise<void> {
	if (options.ssrf?.protect === false) return;
	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
		throw new Error(`Blocked URL scheme: ${parsed.protocol.replace(':', '')}`);
	}

	const hostname = parsed.hostname.replace(/^\[(.*)\]$/, '$1').toLowerCase();
	if (isUnsafeHostname(hostname)) throw new Error(`Blocked private fetch target: ${hostname}`);

	const literalKind = net.isIP(hostname);
	if (literalKind) {
		if (!options.ssrf?.allowPrivateNetwork && isPrivateIp(hostname)) {
			throw new Error(`Blocked private fetch target: ${hostname}`);
		}
		return;
	}

	const resolveHost = options.ssrf?.resolveHost;
	if (!resolveHost && options.fetchImpl) return;
	const addresses = resolveHost
		? await resolveHost(hostname)
		: await lookup(hostname, { all: true })
				.then((items) => items.map((item) => item.address))
				.catch(() => []);
	if (!options.ssrf?.allowPrivateNetwork && addresses.some(isPrivateIp)) {
		throw new Error(`Blocked private fetch target: ${hostname}`);
	}
}

function isUnsafeHostname(hostname: string): boolean {
	return hostname === 'localhost' || hostname.endsWith('.localhost') || hostname === '0';
}

function isPrivateIp(address: string): boolean {
	const kind = net.isIP(address);
	if (kind === 4) return isPrivateIpv4(address);
	if (kind === 6) return isPrivateIpv6(address);
	return false;
}

function isPrivateIpv4(address: string): boolean {
	const parts = address.split('.').map((part) => Number(part));
	if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
	const [a, b] = parts;
	return (
		a === 0 ||
		a === 10 ||
		a === 127 ||
		(a === 169 && b === 254) ||
		(a === 172 && b >= 16 && b <= 31) ||
		(a === 192 && b === 168) ||
		a >= 224
	);
}

function isPrivateIpv6(address: string): boolean {
	const normalized = address.toLowerCase();
	return (
		normalized === '::' ||
		normalized === '::1' ||
		normalized.startsWith('fc') ||
		normalized.startsWith('fd') ||
		normalized.startsWith('fe80:') ||
		normalized.startsWith('::ffff:127.') ||
		normalized.startsWith('::ffff:10.') ||
		normalized.startsWith('::ffff:192.168.')
	);
}

interface RobotsRule {
	type: 'allow' | 'disallow';
	path: string;
}

interface RobotsGroup {
	agents: string[];
	rules: RobotsRule[];
}

function robotsAllows(body: string, requestPath: string, userAgent: string): { allowed: boolean; rule: string | null } {
	const groups = parseRobots(body);
	const matchingGroups = groups
		.map((group) => ({
			group,
			matchLength: Math.max(0, ...group.agents.map((agent) => robotAgentMatchLength(agent, userAgent)))
		}))
		.filter((entry) => entry.matchLength > 0);
	const maxMatchLength = Math.max(0, ...matchingGroups.map((entry) => entry.matchLength));
	const matchingRules = matchingGroups
		.filter((entry) => entry.matchLength === maxMatchLength)
		.map((entry) => entry.group)
		.flatMap((group) => group.rules)
		.filter((rule) => rule.path === '' || pathMatchesRobotsRule(rule.path, requestPath))
		.sort((a, b) => b.path.length - a.path.length || (a.type === 'allow' ? -1 : 1));

	const rule = matchingRules[0];

	if (!rule || rule.path === '') {
		return {
			allowed: true,
			rule: null,
		};
	}

	return {
		allowed: rule.type === 'allow',
		rule: `${rule.type}: ${rule.path}`,
	};
}

function parseRobots(body: string): RobotsGroup[] {
	const groups: RobotsGroup[] = [];
	let current: RobotsGroup | null = null;
	let currentHasRules = false;

	for (const rawLine of body.split(/\r?\n/)) {
		const line = rawLine.split('#')[0]?.trim();
		if (!line) {
			current = null;
			currentHasRules = false;
			continue;
		}

		const separator = line.indexOf(':');
		if (separator === -1) {
			continue;
		}

		const field = line.slice(0, separator).trim().toLowerCase();
		const value = line.slice(separator + 1).trim();

		if (field === 'user-agent') {
			if (!current || currentHasRules) {
				current = { agents: [], rules: [] };
				groups.push(current);
				currentHasRules = false;
			}

			current.agents.push(value.toLowerCase());
			continue;
		}

		if ((field === 'allow' || field === 'disallow') && current) {
			current.rules.push({ type: field, path: value });
			currentHasRules = true;
		}
	}

	return groups;
}

function robotAgentMatchLength(agent: string, userAgent: string): number {
	if (agent === '*') {
		return 1;
	}

	return userAgent.toLowerCase().includes(agent) ? agent.length : 0;
}

function pathMatchesRobotsRule(rulePath: string, requestPath: string): boolean {
	if (rulePath === '') {
		return true;
	}

	const escaped = rulePath
		.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
		.replace(/\*/g, '.*')
		.replace(/\\\$$/, '$');
	const source = escaped.endsWith('$') ? `^${escaped}` : `^${escaped}`;

	return new RegExp(source).test(requestPath);
}

function cachePaths(rootDir: string, url: string): { metadata: string } {
	const parsed = new URL(url);
	const safeHost = parsed.host.replace(/[^a-zA-Z0-9.-]/g, '_');
	const urlHash = createHash('sha256').update(url).digest('hex');

	return {
		metadata: path.join(rootDir, 'hosts', safeHost, `${urlHash}.json`),
	};
}

function contentPath(rootDir: string, contentHash: string): string {
	return path.join(rootDir, 'content', `${contentHash}.txt`);
}

function isNotFoundError(error: unknown): boolean {
	return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

function parseRetryAfter(value: string | null): number | null {
	if (!value) {
		return null;
	}

	const seconds = Number(value);
	if (Number.isFinite(seconds)) {
		return seconds * 1000;
	}

	const dateMs = Date.parse(value);
	return Number.isFinite(dateMs) ? Math.max(0, dateMs - Date.now()) : null;
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
			{ once: true },
		);
	});
}
