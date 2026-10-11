import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { cacheControlFor } from './hooks.server';

describe('request bootstrap boundary', () => {
	it('does not run schema DDL from the normal SvelteKit request hook', () => {
		const source = readFileSync(new URL('./hooks.server.ts', import.meta.url), 'utf8');

		expect(source).not.toContain('ensureMigrated');
		expect(source).not.toMatch(/CREATE\s+(?:TABLE|INDEX)|ALTER\s+TABLE/i);
		expect(source).toContain('const traceId = newId();');
		expect(source).not.toContain("headers.get('x-request-id')");
		expect(source).not.toContain("headers.get('x-trace-id')");
	});
});

describe('cacheControlFor', () => {
	it('keeps no-store and adds no-transform for event streams', () => {
		expect(cacheControlFor('text/event-stream; charset=utf-8')).toBe('private, no-store, no-transform');
		expect(cacheControlFor('Text/Event-Stream')).toBe('private, no-store, no-transform');
	});

	it('uses plain private no-store for everything else', () => {
		expect(cacheControlFor('application/json')).toBe('private, no-store');
		expect(cacheControlFor(null)).toBe('private, no-store');
	});
});
