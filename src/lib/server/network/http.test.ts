import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	createNewsCraftDnsLookup,
	fetchWithNewsCraftDns,
	newsCraftHttpAgent,
	type NewsCraftLookup
} from './http';

function codedError(code: string): NodeJS.ErrnoException {
	return Object.assign(new Error(code), { code });
}

function lookupResult(lookup: NewsCraftLookup, options: Parameters<NewsCraftLookup>[1]): Promise<{
	error: NodeJS.ErrnoException | null;
	address: string | Array<{ address: string; family: number }>;
	family?: number;
}> {
	return new Promise((resolve) => {
		lookup('hermes.example.test', options, (error, address, family) => resolve({ error, address, family }));
	});
}

describe('NewsCraft HTTP DNS fallback', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('passes successful dual-stack OS results through when all addresses are requested', async () => {
		const defaultLookup = vi.fn<NewsCraftLookup>((_hostname, _options, callback) => {
			callback(null, [
				{ address: '2001:db8::10', family: 6 },
				{ address: '203.0.113.10', family: 4 }
			]);
		});
		const resolve4 = vi.fn();
		const lookup = createNewsCraftDnsLookup({ lookup: defaultLookup, resolve4 });

		await expect(lookupResult(lookup, { all: true })).resolves.toEqual({
			error: null,
			address: [
				{ address: '2001:db8::10', family: 6 },
				{ address: '203.0.113.10', family: 4 }
			],
			family: undefined
		});
		expect(resolve4).not.toHaveBeenCalled();
	});

	it('falls back to bounded A records only after ENOTFOUND', async () => {
		const defaultLookup = vi.fn<NewsCraftLookup>((_hostname, _options, callback) => {
			callback(codedError('ENOTFOUND'), '', 0);
		});
		const resolve4 = vi.fn(async () => ['203.0.113.10', '203.0.113.10', 'not-an-ip']);
		const lookup = createNewsCraftDnsLookup({
			lookup: defaultLookup,
			resolve4,
			timeoutMs: 100
		});

		await expect(lookupResult(lookup, { all: false })).resolves.toEqual({
			error: null,
			address: '203.0.113.10',
			family: 4
		});
		expect(resolve4).toHaveBeenCalledWith('hermes.example.test');
	});

	it('does not replace a non-DNS error or an IPv6-only lookup', async () => {
		const resolve4 = vi.fn(async () => ['203.0.113.10']);
		const defaultLookup = vi.fn<NewsCraftLookup>((_hostname, options, callback) => {
			callback(codedError(options.family === 6 ? 'ENOTFOUND' : 'ECONNREFUSED'), '', 0);
		});
		const lookup = createNewsCraftDnsLookup({ lookup: defaultLookup, resolve4 });

		await expect(lookupResult(lookup, { all: false, family: 4 })).resolves.toMatchObject({
			error: { code: 'ECONNREFUSED' }
		});
		await expect(lookupResult(lookup, { all: false, family: 6 })).resolves.toMatchObject({
			error: { code: 'ENOTFOUND' }
		});
		expect(resolve4).not.toHaveBeenCalled();
	});

	it('adds only the server dispatcher and preserves caller request fields', async () => {
		const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response('ok'));
		vi.stubGlobal('fetch', fetchMock);
		const controller = new AbortController();
		const body = JSON.stringify({ hello: 'world' });

		await fetchWithNewsCraftDns('https://hermes.example.test/', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body,
			signal: controller.signal
		});

		const init = fetchMock.mock.calls[0]?.[1] as RequestInit & { dispatcher?: unknown };
		expect(init).toMatchObject({
			method: 'POST',
			body,
			signal: controller.signal,
			dispatcher: newsCraftHttpAgent
		});
	});
});
