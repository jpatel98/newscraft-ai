import { describe, expect, it, vi } from 'vitest';

vi.mock('$env/dynamic/private', () => ({ env: process.env }));
vi.mock('node:child_process', () => ({
	execFile: vi.fn((_bin, _args, _opts, cb) => cb(new Error('hermes unavailable')))
}));

describe('Hermes bridge fallbacks', () => {
	it('keeps local slash commands available when the legacy Hermes bridge is unavailable', async () => {
		const { listHermesCommands } = await import('./bridge');

		const commands = await listHermesCommands();

		expect(commands.map((command) => command.slash)).toEqual(
			expect.arrayContaining(['/help', '/commands', '/reasoning', '/status', '/profile'])
		);
		expect(commands.every((command) => command.enabled)).toBe(true);
	});
});
