import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('chat output action prompts', () => {
	it('enforces the newsroom OC/VO format for the 30-second script action', () => {
		const source = readFileSync(new URL('./+server.ts', import.meta.url), 'utf8');

		expect(source).toContain('write a broadcast television OC/VO package');
		expect(source).toContain('**ON CAM**');
		expect(source).toContain('**VO**');
		expect(source).toContain('**BANNER**');
		expect(source).toContain('3-to-5 concise sentences total');
		expect(source).toContain('5-to-7-word lower-third');
		expect(source).toContain('Do not add facts, speculate, editorialize');
		expect(source).toContain('Preserve attribution, uncertainty, and every relevant citation marker');
	});
});
