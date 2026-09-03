import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
	NEWSCRAFT_OCVO_WRITING_GUIDE,
	NEWSCRAFT_STANDALONE_OUTPUT_GUIDE
} from '$lib/server/agent/prompts';

describe('chat output action prompts', () => {
	it('makes every output action self-contained and permits focused gap research', () => {
		const routeSource = readFileSync(new URL('./+server.ts', import.meta.url), 'utf8');

		expect(routeSource.match(/NEWSCRAFT_STANDALONE_OUTPUT_GUIDE/g)).toHaveLength(4);
		expect(routeSource).toContain('webExtractConfigured: researchToolsEnabled');
		expect(routeSource).toContain(
			'enableWebExtraction: conversationContext.currentTurn?.researchAllowed === true'
		);
		expect(NEWSCRAFT_STANDALONE_OUTPUT_GUIDE).toContain(
			'viewer or reader who has not followed this story before'
		);
		expect(NEWSCRAFT_STANDALONE_OUTPUT_GUIDE).toContain(
			'Establish the essential who, what, where, and when'
		);
		expect(NEWSCRAFT_STANDALONE_OUTPUT_GUIDE).toContain(
			'Research only those missing facts'
		);
		expect(NEWSCRAFT_STANDALONE_OUTPUT_GUIDE).toContain(
			'Directly verify each new source'
		);
		expect(NEWSCRAFT_STANDALONE_OUTPUT_GUIDE).toContain('not as background the audience already knows');
		expect(NEWSCRAFT_STANDALONE_OUTPUT_GUIDE).toContain('state the exact gap for editorial review');
		expect(NEWSCRAFT_STANDALONE_OUTPUT_GUIDE).not.toContain('Do not search');
	});

	it('enforces the NewsCraft OC/VO house style for the 30-second script action', () => {
		const routeSource = readFileSync(new URL('./+server.ts', import.meta.url), 'utf8');

		expect(routeSource).toContain('thirty_second_script: NEWSCRAFT_OCVO_WRITING_GUIDE');
		expect(NEWSCRAFT_OCVO_WRITING_GUIDE).toContain('Lead with the actual news');
		expect(NEWSCRAFT_OCVO_WRITING_GUIDE).toContain(NEWSCRAFT_STANDALONE_OUTPUT_GUIDE);
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
		expect(NEWSCRAFT_OCVO_WRITING_GUIDE).not.toContain('Use only the selected answer');
	});
});
