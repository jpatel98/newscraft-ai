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
			'conversationContext.currentTurn?.researchAllowed === true'
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
		expect(NEWSCRAFT_STANDALONE_OUTPUT_GUIDE).toContain('name the gap in one line instead of guessing');
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
		expect(NEWSCRAFT_OCVO_WRITING_GUIDE).toContain('Spoken lines carry no citation markers');
		expect(NEWSCRAFT_OCVO_WRITING_GUIDE).toContain('Sources: [n] [m]');
		expect(NEWSCRAFT_OCVO_WRITING_GUIDE).not.toContain('Citation markers are not spoken words');
		expect(NEWSCRAFT_OCVO_WRITING_GUIDE).toContain('Do not invent pictures, sound, quotes, or facts');
		expect(NEWSCRAFT_OCVO_WRITING_GUIDE).toContain('Banner:');
		expect(NEWSCRAFT_OCVO_WRITING_GUIDE).toContain('CHECK: [EXACT MISSING FACT.]');
		expect(NEWSCRAFT_OCVO_WRITING_GUIDE).not.toContain('**ON CAM**');
		expect(NEWSCRAFT_OCVO_WRITING_GUIDE).not.toContain('**BANNER**');
		expect(NEWSCRAFT_OCVO_WRITING_GUIDE).not.toContain('Use only the selected answer');
	});

	it('adds rundown line and tease actions that only transform the selected answer', () => {
		const routeSource = readFileSync(new URL('./+server.ts', import.meta.url), 'utf8');
		const clientSource = readFileSync(new URL('../../../../lib/client/stream.ts', import.meta.url), 'utf8');
		const pageSource = readFileSync(new URL('../../../c/[id]/+page.svelte', import.meta.url), 'utf8');

		expect(routeSource).toContain("| 'rundown_line'");
		expect(routeSource).toContain("| 'tease'");
		expect(routeSource).toContain('rundown_line: RUNDOWN_LINE_PROMPT');
		expect(routeSource).toContain('tease: TEASE_PROMPT');
		expect(routeSource).toContain("rundown_line: 'Write a rundown line from this answer.'");
		expect(routeSource).toContain("tease: 'Write a tease from this answer.'");
		expect(clientSource).toContain("| 'rundown_line'");
		expect(clientSource).toContain("| 'tease'");
		expect(pageSource).toContain("rundown_line: 'Write a rundown line from this answer.'");
		expect(pageSource).toContain("tease: 'Write a tease from this answer.'");
		// Neither prompt reuses the gap-research guide.
		expect(routeSource.match(/NEWSCRAFT_STANDALONE_OUTPUT_GUIDE/g)).toHaveLength(4);

		const rundown = routeSource.slice(
			routeSource.indexOf('const RUNDOWN_LINE_PROMPT'),
			routeSource.indexOf('const TEASE_PROMPT')
		);
		expect(rundown).toContain('SLUG · one-sentence summary (20 words or fewer) · FORMAT · :DURATION · STATUS');
		expect(rundown).toContain('VO, VO-SOT, PKG, READER, or LIVE');
		expect(rundown).toContain('confirmed, developing, or needs check');
		expect(rundown).toContain('Sources: [n] [m]');
		expect(rundown).toContain('Do not search');
		expect(rundown).toContain('No markdown');
		expect(rundown).toContain('no closing offer');

		const tease = routeSource.slice(
			routeSource.indexOf('const TEASE_PROMPT'),
			routeSource.indexOf('const OUTPUT_ACTION_PROMPTS')
		);
		expect(tease).toContain('12 words or fewer');
		expect(tease).toContain('without stating an unconfirmed fact as fact');
		expect(tease).toContain('Alt:');
		expect(tease).toContain('Sources: [n]');
		expect(tease).toContain('Do not search');
	});
});
