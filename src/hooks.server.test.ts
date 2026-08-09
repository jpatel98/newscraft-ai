import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('request bootstrap boundary', () => {
	it('does not run schema DDL from the normal SvelteKit request hook', () => {
		const source = readFileSync(new URL('./hooks.server.ts', import.meta.url), 'utf8');

		expect(source).not.toContain('ensureMigrated');
		expect(source).not.toMatch(/CREATE\s+(?:TABLE|INDEX)|ALTER\s+TABLE/i);
	});
});
