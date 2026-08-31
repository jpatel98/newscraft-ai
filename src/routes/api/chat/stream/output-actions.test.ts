import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { NEWSCRAFT_OCVO_WRITING_GUIDE } from '$lib/server/agent/prompts';

describe('chat output action prompts', () => {
	it('enforces the NewsCraft OC/VO house style for the 30-second script action', () => {
		const routeSource = readFileSync(new URL('./+server.ts', import.meta.url), 'utf8');

		expect(routeSource).toContain('thirty_second_script: NEWSCRAFT_OCVO_WRITING_GUIDE');
		expect(NEWSCRAFT_OCVO_WRITING_GUIDE).toContain('Lead with the actual news');
		expect(NEWSCRAFT_OCVO_WRITING_GUIDE).toContain('{ON CAM}');
		expect(NEWSCRAFT_OCVO_WRITING_GUIDE).toContain('{VO}');
		expect(NEWSCRAFT_OCVO_WRITING_GUIDE).toContain('three to five short sentences that add');
		expect(NEWSCRAFT_OCVO_WRITING_GUIDE).toContain('one main thought per sentence');
		expect(NEWSCRAFT_OCVO_WRITING_GUIDE).toContain('publication-ban or youth-identity safeguards');
		expect(NEWSCRAFT_OCVO_WRITING_GUIDE).toContain('every relevant citation marker');
		expect(NEWSCRAFT_OCVO_WRITING_GUIDE).toContain('Do not invent pictures, sound, quotes, or facts');
		expect(NEWSCRAFT_OCVO_WRITING_GUIDE).toContain('Do not add a BANNER');
		expect(NEWSCRAFT_OCVO_WRITING_GUIDE).toContain('NEEDS EDITORIAL CHECK:');
		expect(NEWSCRAFT_OCVO_WRITING_GUIDE).not.toContain('**ON CAM**');
		expect(NEWSCRAFT_OCVO_WRITING_GUIDE).not.toContain('**BANNER**');
	});
});
