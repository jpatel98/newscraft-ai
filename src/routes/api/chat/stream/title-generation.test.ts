import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('chat stream title generation telemetry', () => {
	it('logs title generation failures without failing the stream', () => {
		const source = readFileSync(new URL('./+server.ts', import.meta.url), 'utf8');

		expect(source).toContain("console.warn('NewsCraft title generation failed', err);");
		expect(source).not.toContain('/* title generation is best-effort; never fails the stream */');
	});
});
