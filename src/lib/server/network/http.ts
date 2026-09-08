import dns from 'node:dns';
import type { LookupAddress, LookupOptions } from 'node:dns';
import { Agent } from 'undici';
import {
	FALLBACK_DNS_TIMEOUT_MS,
	resolveIpv4WithFallback,
	type ResolverLike
} from '$lib/server/db/socket';

export type NewsCraftLookupCallback = (
	error: NodeJS.ErrnoException | null,
	address: string | LookupAddress[],
	family?: number
) => void;

export type NewsCraftLookup = (
	hostname: string,
	options: LookupOptions,
	callback: NewsCraftLookupCallback
) => void;

export interface NewsCraftLookupDependencies {
	/** The operating-system resolver used for the first attempt. */
	lookup?: NewsCraftLookup;
	resolve4?: (hostname: string) => Promise<string[]>;
	createResolver?: () => ResolverLike;
	now?: () => number;
	timeoutMs?: number;
}

const defaultLookup = dns.lookup as unknown as NewsCraftLookup;

/**
 * Build a net.connect-compatible resolver. The OS resolver remains the first
 * attempt; only ENOTFOUND/EAI_AGAIN trigger the bounded A-record fallback.
 * Successful OS results are passed through unchanged, including IPv6 and
 * `{ all: true }` dual-stack results.
 */
export function createNewsCraftDnsLookup(
	dependencies: NewsCraftLookupDependencies = {}
): NewsCraftLookup {
	const lookup = dependencies.lookup ?? defaultLookup;
	return (hostname, options, callback) => {
		lookup(hostname, options, (error, address, family) => {
			if (!error) {
				callback(null, address, family);
				return;
			}
			if (!isFallbackDnsError(error) || isIpv6Lookup(options)) {
				callback(error, options.all ? [] : '', family);
				return;
			}

			void resolveIpv4WithFallback(hostname, {
				timeoutMs: dependencies.timeoutMs ?? FALLBACK_DNS_TIMEOUT_MS,
				resolve4: dependencies.resolve4,
				createResolver: dependencies.createResolver,
				now: dependencies.now
			})
				.then((addresses) => {
					const fallbackAddresses = addresses.map((value) => ({ address: value, family: 4 }));
					if (!fallbackAddresses.length) {
						callback(error, options.all ? [] : '', family);
					} else if (options.all) {
						callback(null, fallbackAddresses);
					} else {
						callback(null, fallbackAddresses[0]!.address, 4);
					}
				})
				.catch((fallbackError) => {
					callback(asErrnoException(fallbackError), options.all ? [] : '', family);
				});
		});
	};
}

export const newsCraftDnsLookup = createNewsCraftDnsLookup();

/** One server-owned dispatcher used only by the explicit NewsCraft HTTP clients. */
export const newsCraftHttpAgent = new Agent({
	connect: { lookup: newsCraftDnsLookup }
});

/**
 * Fetch with the NewsCraft HTTP dispatcher while preserving every caller-owned
 * RequestInit field (including body streams and AbortSignal).
 */
export function fetchWithNewsCraftDns(
	input: Parameters<typeof globalThis.fetch>[0],
	init?: Parameters<typeof globalThis.fetch>[1]
): Promise<Response> {
	const requestInit = {
		...(init ?? {}),
		dispatcher:
			(init as (RequestInit & { dispatcher?: unknown }) | undefined)?.dispatcher ?? newsCraftHttpAgent
	} as Parameters<typeof globalThis.fetch>[1] & { dispatcher: Agent };
	return globalThis.fetch(input, requestInit as Parameters<typeof globalThis.fetch>[1]);
}

function isFallbackDnsError(error: unknown): error is NodeJS.ErrnoException {
	return errorCode(error) === 'ENOTFOUND' || errorCode(error) === 'EAI_AGAIN';
}

function isIpv6Lookup(options: LookupOptions): boolean {
	return options.family === 6 || options.family === 'IPv6';
}

function errorCode(error: unknown): string | undefined {
	return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
		? error.code
		: undefined;
}

function asErrnoException(error: unknown): NodeJS.ErrnoException {
	if (error instanceof Error) return error as NodeJS.ErrnoException;
	return new Error('DNS resolution failed') as NodeJS.ErrnoException;
}
