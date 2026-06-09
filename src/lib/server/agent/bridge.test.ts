import { describe, expect, it } from 'vitest';

describe('Agent command registry', () => {
	it('keeps local slash commands available', async () => {
		const { listAgentCommands } = await import('./bridge');

		const commands = await listAgentCommands();

		expect(commands.map((command) => command.slash)).toEqual(
			expect.arrayContaining(['/help', '/commands', '/reasoning', '/status', '/profile', '/feedback'])
		);
		expect(commands.every((command) => command.enabled)).toBe(true);
	});
});
