import { describe, expect, it } from 'vitest';
import { parseSlashCommand } from './slash';

describe('parseSlashCommand', () => {
	it('parses a skill command with arguments', () => {
		expect(parseSlashCommand('/codex fix the bug')).toEqual({
			raw: '/codex fix the bug',
			slash: '/codex',
			name: 'codex',
			args: 'fix the bug'
		});
	});

	it('parses hyphenated and underscored commands', () => {
		expect(parseSlashCommand('/headline-writer draft')).toMatchObject({
			slash: '/headline-writer',
			args: 'draft'
		});
		expect(parseSlashCommand('/headline_writer draft')).toMatchObject({
			slash: '/headline-writer',
			args: 'draft'
		});
	});

	it('ignores ordinary text with slashes', () => {
		expect(parseSlashCommand('open https://example.com/a/b')).toBeNull();
		expect(parseSlashCommand('Use /codex later')).toBeNull();
	});

	it('ignores empty slash input', () => {
		expect(parseSlashCommand('/')).toBeNull();
		expect(parseSlashCommand('/  ')).toBeNull();
	});

	it('parses unknown-looking commands so the server can respond helpfully', () => {
		expect(parseSlashCommand('/does-not-exist please')).toMatchObject({
			slash: '/does-not-exist',
			args: 'please'
		});
	});
});
