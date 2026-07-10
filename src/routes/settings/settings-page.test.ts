import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const pageSource = readFileSync(
	fileURLToPath(new URL('./+page.svelte', import.meta.url)),
	'utf8'
);

describe('settings page source', () => {
	it('keeps the default settings flow centered on account, data, security, and sessions', () => {
		const headings = ['settings-account', 'settings-data', 'settings-security', 'settings-session'];
		const positions = headings.map((heading) => pageSource.indexOf(`id="${heading}"`));

		expect(positions.every((position) => position > -1)).toBe(true);
		expect(positions).toEqual([...positions].sort((a, b) => a - b));
	});

	it('does not surface agent skill internals in settings', () => {
		expect(pageSource).not.toMatch(
			/newsroom-agent|settings-skills|Installed skills|Supporting files|JSONL/i
		);
	});

	it('keeps the wipe action gated by the typed phrase and confirmation dialog', () => {
		expect(pageSource).toContain("const PHRASE = 'WIPE-EVERYTHING'");
		expect(pageSource).toContain('disabled={!wipeArmed || wipeBusy}');
		expect(pageSource).toContain('aria-modal="true"');
		expect(pageSource).toContain('body: JSON.stringify({ confirm: PHRASE })');
	});
});
