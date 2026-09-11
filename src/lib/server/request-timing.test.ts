import { describe, expect, it } from 'vitest';
import { measureRequest, serverTimingHeader, type RequestTiming } from './request-timing';

describe('request timing', () => {
	it('keeps concurrent request timings isolated and preserves return values', async () => {
		const first = { requestTimings: [] as RequestTiming[] };
		const second = { requestTimings: [] as RequestTiming[] };
		let release!: () => void;
		const pending = measureRequest(first, 'auth', () => new Promise<string>((resolve) => {
			release = () => resolve('first account');
		}));
		expect(await measureRequest(second, 'messages', async () => 'second account')).toBe('second account');
		expect(first.requestTimings).toEqual([]);
		release();
		expect(await pending).toBe('first account');
		expect(first.requestTimings.map((entry) => entry.name)).toEqual(['auth']);
		expect(second.requestTimings.map((entry) => entry.name)).toEqual(['messages']);
		expect(serverTimingHeader(first.requestTimings)).toMatch(/^auth;dur=\d+\.\d$/);
		expect(serverTimingHeader(first.requestTimings)).not.toContain('account');
	});

	it('records failed operations without changing the error or exposing it in the header', async () => {
		const locals = { requestTimings: [] as RequestTiming[] };
		const failure = new Error('private query details');
		await expect(measureRequest(locals, 'ownership', async () => { throw failure; })).rejects.toBe(failure);
		expect(serverTimingHeader(locals.requestTimings)).toMatch(/^ownership;dur=\d+\.\d$/);
	});

	it('does not collect timings for requests without instrumentation', async () => {
		const locals = {};
		expect(await measureRequest(locals, 'auth', async () => 42)).toBe(42);
		expect(locals).toEqual({});
		expect(serverTimingHeader([{name:'total',duration:NaN}])).toBe('');
	});
});
